import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { env } from "../config.ts";

// Oyu speech services (https://dev.oyu.so), Bearer OYU_API_KEY:
//   TTS (tsuurAI): POST /v1/audio/speech         JSON {text ≤ 800, voice}  -> audio/wav
//   STT (Anir):    POST /v1/audio/transcriptions multipart file (WAV/MP3/OGG) -> {"text": "..."}
// Without a key the phone page speaks and listens with the browser's Web Speech API.

export const DATA_DIR = env.DATA_DIR
  ? `${env.DATA_DIR.replace(/[\\/]+$/, "")}/`
  : fileURLToPath(new URL("../../../data/", import.meta.url));
const AUDIO_DIR = `${DATA_DIR}audio/`;
const RECORDINGS_DIR = `${DATA_DIR}recordings/`;
const TTS_MAX_CHARS = 800;

const baseUrl = () => env.OYU_BASE_URL.replace(/\/+$/, "");

export const speechStatus = () => ({
  tts: env.OYU_API_KEY ? "oyu" : "browser",
  stt: env.OYU_API_KEY ? "oyu" : "browser",
  voice: env.OYU_VOICE,
});

const authHeaders = (): Record<string, string> => ({ Authorization: `Bearer ${env.OYU_API_KEY ?? ""}` });

const extensionFor = (contentType: string) => {
  if (contentType.includes("mpeg") || contentType.includes("mp3")) return "mp3";
  if (contentType.includes("ogg")) return "ogg";
  if (contentType.includes("webm")) return "webm";
  return "wav";
};

/**
 * Synthesizes Mongolian speech and returns a URL under /media, or null when
 * TTS is not configured or fails (the phone then speaks in the browser).
 * Results are cached by voice + text, so repeated scripts cost nothing.
 */
export const synthesize = async (text: string): Promise<string | null> => {
  if (!env.OYU_API_KEY) return null;

  const spoken = text.length > TTS_MAX_CHARS ? `${text.slice(0, TTS_MAX_CHARS - 1)}…` : text;
  const key = createHash("sha1").update(`${env.OYU_VOICE}|${spoken}`).digest("hex").slice(0, 20);
  const file = `${AUDIO_DIR}${key}.wav`;
  if (existsSync(file)) return `/media/audio/${key}.wav`;

  try {
    const response = await fetch(`${baseUrl()}/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({ text: spoken, voice: env.OYU_VOICE }),
    });
    if (!response.ok) throw new Error(`TTS ${response.status}: ${(await response.text()).slice(0, 200)}`);

    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length) throw new Error("TTS returned no audio");

    mkdirSync(AUDIO_DIR, { recursive: true });
    writeFileSync(file, bytes);
    return `/media/audio/${key}.wav`;
  } catch (error) {
    console.warn("[tts] falling back to browser speech:", (error as Error).message);
    return null;
  }
};

/** Stores a guardian's recorded reply and returns its /media URL. */
export const saveRecording = (audio: Buffer, contentType: string) => {
  mkdirSync(RECORDINGS_DIR, { recursive: true });
  const name = `${randomUUID()}.${extensionFor(contentType)}`;
  writeFileSync(`${RECORDINGS_DIR}${name}`, audio);
  return `/media/recordings/${name}`;
};

/** Transcribes Mongolian audio (WAV/MP3/OGG) with Oyu Anir; null when unavailable. */
export const transcribe = async (audio: Buffer, contentType: string): Promise<string | null> => {
  if (!env.OYU_API_KEY) return null;

  try {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(audio)], { type: contentType }), `reply.${extensionFor(contentType)}`);
    if (env.OYU_STT_MODEL) form.append("model", env.OYU_STT_MODEL);

    const response = await fetch(`${baseUrl()}/audio/transcriptions`, {
      method: "POST",
      headers: authHeaders(),
      signal: AbortSignal.timeout(60_000),
      body: form,
    });
    if (!response.ok) throw new Error(`STT ${response.status}: ${(await response.text()).slice(0, 200)}`);

    const json = (await response.json()) as { text?: string };
    const text = (json.text ?? "").trim();
    return text || null;
  } catch (error) {
    console.warn("[stt] failed:", (error as Error).message);
    return null;
  }
};
