import express, { type NextFunction, type Request, type Response, Router } from "express";
import { env } from "./config.ts";
import { Calls } from "./models.ts";
import { answerCall, keypadPrompt, markUnanswered, replyToCall, replyWithKeypad } from "./services/calls.ts";
import { saveRecording, synthesize } from "./services/speech.ts";
import {
  HANGUP,
  downloadRecording,
  gatherReply,
  recordReply,
  redirectNoReply,
  speak,
  twiml,
  verifyWebhook,
} from "./services/twilio.ts";

const THANKS = "Баярлалаа. Таны хариуг багшид дамжууллаа.";

// Twilio webhooks. Each URL carries ?callId=…&token=… (HMAC of the call id);
// requests without a valid token are rejected.

const callIdOf = (req: Request) => {
  const callId = String(req.query.callId ?? "");
  const token = String(req.query.token ?? "");
  if (!/^[a-f\d]{24}$/i.test(callId) || !verifyWebhook(callId, token)) {
    throw Object.assign(new Error("Invalid webhook token"), { status: 403 });
  }
  return callId;
};

const sendTwiml = (res: Response, body: string) => {
  res.type("text/xml").send(body);
};

/** Finishes the call with whatever we have and thanks the guardian. */
const finish = async (res: Response, callId: string, input: Parameters<typeof replyToCall>[1]) => {
  let done;
  try {
    done = await replyToCall(callId, input);
  } catch (error) {
    // STT could not understand the audio: record it as "no usable reply".
    if ((error as { status?: number }).status !== 422) throw error;
    done = await replyToCall(callId, { text: "", recordingUrl: input.recordingUrl });
  }
  sendTwiml(res, twiml(speak(done.confirmationAudioUrl, done.confirmation ?? ""), HANGUP));
};

export const createTwilioRouter = () => {
  const router = Router();
  router.use(express.urlencoded({ extended: false }));

  // The guardian picked up: play the school's message, then collect the answer —
  // keypad on trial accounts (<Record> is blocked there), a recording otherwise.
  router.post("/voice", async (req, res) => {
    const callId = callIdOf(req);
    try {
      const call = await answerCall(callId);
      const message = speak(call.audioUrl, call.script);
      if (env.TWILIO_TRIAL) {
        const prompt = keypadPrompt(call.purpose);
        const menu = speak(await synthesize(prompt), prompt);
        sendTwiml(res, twiml(gatherReply(callId, message + menu), redirectNoReply(callId)));
      } else {
        sendTwiml(res, twiml(message, recordReply(callId), redirectNoReply(callId)));
      }
    } catch {
      sendTwiml(res, twiml(HANGUP));
    }
  });

  // Keypad digits (or Twilio speech text) from <Gather>.
  router.post("/gather", async (req, res) => {
    const callId = callIdOf(req);
    const digits = String(req.body.Digits ?? "").trim();
    const speech = String(req.body.SpeechResult ?? "").trim();
    try {
      if (digits) {
        const done = await replyWithKeypad(callId, digits);
        sendTwiml(res, twiml(speak(done.confirmationAudioUrl, done.confirmation ?? THANKS), HANGUP));
      } else if (speech) {
        // The LLM + TTS can exceed the trial 5-second webhook limit: thank now, think after.
        sendTwiml(res, twiml(speak(await synthesize(THANKS), THANKS), HANGUP));
        void replyToCall(callId, { text: speech }).catch((e) => console.warn("[twilio] speech:", e.message));
      } else {
        await finish(res, callId, { text: "" });
      }
    } catch (error) {
      console.warn("[twilio] gather:", (error as Error).message);
      if (!res.headersSent) sendTwiml(res, twiml(HANGUP));
    }
  });

  // The recorded answer: Oyu STT -> intent -> spoken confirmation.
  router.post("/recording", async (req, res) => {
    const callId = callIdOf(req);
    const recordingUrl = typeof req.body.RecordingUrl === "string" ? req.body.RecordingUrl : "";
    const duration = Number(req.body.RecordingDuration ?? 0);
    try {
      if (!recordingUrl || duration <= 0) {
        await finish(res, callId, { text: "" });
        return;
      }
      const audio = await downloadRecording(recordingUrl);
      const saved = saveRecording(audio, "audio/wav");
      await finish(res, callId, { audio, contentType: "audio/wav", recordingUrl: saved });
    } catch (error) {
      console.warn("[twilio] recording:", (error as Error).message);
      sendTwiml(res, twiml(HANGUP));
    }
  });

  // <Record> heard nothing.
  router.post("/no-reply", async (req, res) => {
    const callId = callIdOf(req);
    try {
      await finish(res, callId, { text: "" });
    } catch {
      sendTwiml(res, twiml(HANGUP));
    }
  });

  // Call progress. Unanswered calls move the flow to the next guardian.
  router.post("/status", async (req, res) => {
    const callId = callIdOf(req);
    const status = String(req.body.CallStatus ?? "");
    if (status === "busy") {
      await markUnanswered(callId, "declined");
    } else if (["no-answer", "failed", "canceled"].includes(status)) {
      await markUnanswered(callId, "no_answer");
    } else if (status === "completed") {
      const call = await Calls.findById(callId).lean();
      // Hung up before the trial "press any key" prompt or before speaking.
      if (call?.status === "ringing") await markUnanswered(callId, "no_answer");
      else if (call?.status === "answered") await replyToCall(callId, { text: "" }).catch(() => undefined);
    }
    res.sendStatus(204);
  });

  router.use((error: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    const status = error.status ?? 500;
    if (status >= 500) console.error("[twilio]", error);
    res.status(status).end();
  });

  return router;
};
