import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../config.ts";

// Real phone calls through Twilio Programmable Voice (REST + TwiML webhooks).
//   1. ring()      -> POST Calls.json {To, From, Url: /twilio/voice, StatusCallback: /twilio/status}
//   2. answered    -> /twilio/voice returns TwiML: <Play> Oyu audio, <Record> the reply
//   3. reply       -> /twilio/recording: download WAV -> Oyu STT -> intent -> <Play> thanks
//   4. no answer   -> /twilio/status (no-answer/busy/failed) -> next guardian
// Webhooks carry an HMAC token per call, so only Twilio (which got the URL from
// us) can drive a call. PUBLIC_URL must reach this server, e.g. a tunnel.

const API = "https://api.twilio.com/2010-04-01";

export const twilioProblems = () => {
  const problems: string[] = [];
  if (!env.TWILIO_ACCOUNT_SID) problems.push("TWILIO_ACCOUNT_SID (AC…) хоосон");
  else if (!env.TWILIO_ACCOUNT_SID.startsWith("AC")) problems.push("TWILIO_ACCOUNT_SID нь AC…-ээр эхлэх ёстой");
  if (!(env.TWILIO_API_KEY && env.TWILIO_API_SECRET) && !env.TWILIO_AUTH_TOKEN) {
    problems.push("TWILIO_API_KEY + TWILIO_API_SECRET (эсвэл TWILIO_AUTH_TOKEN) хоосон");
  }
  if (!env.TWILIO_PHONE_NUMBER) problems.push("TWILIO_PHONE_NUMBER хоосон");
  if (!env.PUBLIC_URL) problems.push("PUBLIC_URL (tunnel-ийн https хаяг) хоосон");
  return problems;
};

export const callProvider = (): "twilio" | "simulator" =>
  env.CALL_PROVIDER !== "simulator" && twilioProblems().length === 0 ? "twilio" : "simulator";

export const callStatus = () => ({
  provider: callProvider(),
  requested: env.CALL_PROVIDER,
  problems: env.CALL_PROVIDER === "simulator" ? [] : twilioProblems(),
  from: env.TWILIO_PHONE_NUMBER ?? null,
});

const authorization = () => {
  const user = env.TWILIO_API_KEY ?? env.TWILIO_ACCOUNT_SID ?? "";
  const pass = env.TWILIO_API_SECRET ?? env.TWILIO_AUTH_TOKEN ?? "";
  return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
};

/** "99112233" -> "+97699112233"; numbers already starting with "+" are kept. */
export const toE164 = (phone: string) => {
  const compact = phone.replace(/[^\d+]/g, "");
  if (compact.startsWith("+")) return compact;
  if (/^\d{8}$/.test(compact)) return `+${env.PHONE_COUNTRY_CODE}${compact}`;
  return `+${compact}`;
};

const webhookSecret = () => env.TWILIO_API_SECRET ?? env.TWILIO_AUTH_TOKEN ?? "subedei";

export const webhookToken = (callId: string) =>
  createHmac("sha256", webhookSecret()).update(callId).digest("base64url").slice(0, 32);

export const verifyWebhook = (callId: string, token: string) => {
  const expected = Buffer.from(webhookToken(callId));
  const given = Buffer.from(token);
  return expected.length === given.length && timingSafeEqual(expected, given);
};

export const publicUrl = (path: string) => `${(env.PUBLIC_URL ?? "").replace(/\/+$/, "")}${path}`;

const webhookUrl = (kind: "voice" | "status" | "recording" | "no-reply", callId: string) =>
  publicUrl(`/twilio/${kind}?callId=${callId}&token=${webhookToken(callId)}`);

type TwilioError = { code?: number; message?: string; more_info?: string };

const twilioRequest = async (path: string, form: URLSearchParams) => {
  const response = await fetch(`${API}/Accounts/${env.TWILIO_ACCOUNT_SID}${path}`, {
    method: "POST",
    headers: { Authorization: authorization(), "Content-Type": "application/x-www-form-urlencoded" },
    signal: AbortSignal.timeout(20_000),
    body: form,
  });
  const json = (await response.json().catch(() => ({}))) as TwilioError & { sid?: string };
  if (!response.ok) throw new Error(`Twilio ${json.code ?? response.status}: ${json.message ?? "error"}`);
  return json;
};

/** Dials the guardian; returns the Twilio call SID. */
export const placeCall = async (callId: string, phone: string) => {
  const form = new URLSearchParams({
    To: toE164(phone),
    From: env.TWILIO_PHONE_NUMBER ?? "",
    Url: webhookUrl("voice", callId),
    Method: "POST",
    StatusCallback: webhookUrl("status", callId),
    StatusCallbackMethod: "POST",
    Timeout: String(env.RING_TIMEOUT_SEC),
  });
  for (const event of ["ringing", "answered", "completed"]) form.append("StatusCallbackEvent", event);
  const call = await twilioRequest("/Calls.json", form);
  if (!call.sid) throw new Error("Twilio returned no call SID");
  return call.sid;
};

/** Hangs up or cancels a call; best-effort. */
export const hangupCall = async (sid: string) => {
  for (const status of ["completed", "canceled"]) {
    try {
      await twilioRequest(`/Calls/${sid}.json`, new URLSearchParams({ Status: status }));
      return;
    } catch {
      // try the other status (canceled is for calls that are still queued/ringing)
    }
  }
};

/** Downloads a call recording as WAV (works whether or not media auth is enforced). */
export const downloadRecording = async (recordingUrl: string) => {
  const response = await fetch(`${recordingUrl}.wav`, {
    headers: { Authorization: authorization() },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Recording download ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
};

// ---- TwiML ---------------------------------------------------------------

const xml = (value: string) =>
  value.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c] ?? c);

export const twiml = (...verbs: string[]) => `<?xml version="1.0" encoding="UTF-8"?><Response>${verbs.join("")}</Response>`;

/** Plays the Oyu audio; without it, Twilio's Russian voice reads the Cyrillic text (understandable, not ideal). */
export const speak = (audioUrl: string | null | undefined, text: string) =>
  audioUrl ? `<Play>${xml(publicUrl(audioUrl))}</Play>` : `<Say language="ru-RU">${xml(text)}</Say>`;

export const recordReply = (callId: string) =>
  `<Record action="${xml(webhookUrl("recording", callId))}" method="POST" maxLength="20" timeout="3" playBeep="true" trim="trim-silence"/>`;

export const redirectNoReply = (callId: string) => `<Redirect method="POST">${xml(webhookUrl("no-reply", callId))}</Redirect>`;

export const HANGUP = "<Hangup/>";
