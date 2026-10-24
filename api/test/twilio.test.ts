import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

// Twilio + Oyu are faked at the fetch level: no real call is placed, no credit is used.
// Fake audio goes to a temporary DATA_DIR, never into the real TTS cache.
const dataDir = mkdtempSync(join(tmpdir(), "subedei-test-"));
process.env.DATA_DIR = dataDir;
process.env.LLM_ENABLED = "false";
process.env.AUTO_PICKUP_CALLS = "false";
process.env.CALL_PROVIDER = "twilio";
process.env.PUBLIC_URL = "https://subedei.example.test";
process.env.TWILIO_ACCOUNT_SID = "AC00000000000000000000000000000000";
process.env.TWILIO_API_KEY = "SK00000000000000000000000000000000";
process.env.TWILIO_API_SECRET = "test-secret";
process.env.TWILIO_PHONE_NUMBER = "+15550001111";
process.env.OYU_API_KEY = "test-oyu";
if (process.env.TEST_MONGO_URL) process.env.MONGO_URL = process.env.TEST_MONGO_URL.replace(/\/[^/]*$/, "/subedei_twilio");

const realFetch = globalThis.fetch;
const dialed: { to: string; url: string }[] = [];
let sttText = "Эмээ нь арван минутын дараа авна";
const WAV = Buffer.from("RIFF0000WAVEfmt fake-audio");

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.endsWith("/Calls.json")) {
    const form = new URLSearchParams(String(init?.body));
    dialed.push({ to: form.get("To") ?? "", url: form.get("Url") ?? "" });
    return Response.json({ sid: `CA${dialed.length}` }, { status: 201 });
  }
  if (url.includes("api.twilio.com") && url.includes("/Calls/CA")) return Response.json({ status: "completed" });
  if (url.includes("/Recordings/")) return new Response(WAV, { headers: { "Content-Type": "audio/wav" } });
  if (url.endsWith("/audio/speech")) return new Response(WAV, { headers: { "Content-Type": "audio/wav" } });
  if (url.endsWith("/audio/transcriptions")) return Response.json({ text: sttText });
  return realFetch(input, init);
}) as typeof fetch;

const { connectDb, disconnectDb } = await import("../src/db.ts");
const { seedDemo } = await import("../src/seed.ts");
const { Calls, DayRecords, Students } = await import("../src/models.ts");
const { startFlow } = await import("../src/services/calls.ts");
const { toE164, webhookToken } = await import("../src/services/twilio.ts");
const { createTwilioRouter } = await import("../src/twilio-routes.ts");
const { today } = await import("../src/time.ts");
const express = (await import("express")).default;

let server: Server;
let base = "";

const webhook = (kind: string, callId: string, body: Record<string, string> = {}, token = webhookToken(callId)) =>
  realFetch(`${base}/twilio/${kind}?callId=${callId}&token=${token}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });

const ringingFor = async (studentId: unknown) => Calls.findOne({ studentId, status: "ringing" }).lean();

describe("Twilio calls", () => {
  before(async () => {
    await connectDb({ memory: !process.env.TEST_MONGO_URL });
    const app = express();
    app.use("/twilio", createTwilioRouter());
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.close();
    await disconnectDb();
    globalThis.fetch = realFetch;
    rmSync(dataDir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await seedDemo({ reset: true });
    dialed.length = 0;
    sttText = "Эмээ нь арван минутын дараа авна";
  });

  it("formats Mongolian numbers for dialing", () => {
    assert.equal(toE164("99112233"), "+97699112233");
    assert.equal(toE164("9911 2233"), "+97699112233");
    assert.equal(toE164("+15550001111"), "+15550001111");
  });

  it("dials, plays Oyu audio, records and understands the reply", async () => {
    const bold = (await Students.findOne({ firstName: "Болд" }).lean())!._id;
    await startFlow({ purpose: "late_pickup", studentId: bold });

    assert.equal(dialed.length, 1);
    assert.equal(dialed[0]!.to, "+97699001101");
    const call = await ringingFor(bold);
    assert.equal(call?.channel, "twilio");
    assert.equal(call?.twilioSid, "CA1");
    assert.ok(dialed[0]!.url.startsWith(`https://subedei.example.test/twilio/voice?callId=${call!._id}`));

    const voice = await (await webhook("voice", String(call!._id))).text();
    assert.match(voice, /<Play>https:\/\/subedei\.example\.test\/media\/audio\/[\w]+\.wav<\/Play>/);
    assert.match(voice, /<Record action="https:\/\/subedei\.example\.test\/twilio\/recording\?callId=/);

    const reply = await webhook("recording", String(call!._id), {
      RecordingUrl: "https://api.twilio.com/2010-04-01/Accounts/AC0/Recordings/RE1",
      RecordingDuration: "3",
    });
    const twiml = await reply.text();
    assert.match(twiml, /<Play>.*\.wav<\/Play><Hangup\/>/);

    const done = await Calls.findById(call!._id).lean();
    assert.equal(done?.status, "completed");
    assert.equal(done?.transcript, sttText);
    assert.equal(done?.intent?.outcome, "someone_else");
    const record = await DayRecords.findOne({ studentId: bold, date: today() }).lean();
    assert.equal(record?.pickup?.status, "someone_else");
    assert.equal(record?.pickup?.etaMinutes, 10);
  });

  it("rejects webhooks without a valid token", async () => {
    const bold = (await Students.findOne({ firstName: "Болд" }).lean())!._id;
    await startFlow({ purpose: "late_pickup", studentId: bold });
    const call = await ringingFor(bold);
    const res = await webhook("voice", String(call!._id), {}, "forged-token-forged-token-forged");
    assert.equal(res.status, 403);
    assert.equal((await Calls.findById(call!._id).lean())?.status, "ringing");
  });

  it("calls the next guardian when Twilio reports no answer", async () => {
    const bold = (await Students.findOne({ firstName: "Болд" }).lean())!._id;
    await startFlow({ purpose: "late_pickup", studentId: bold });
    const first = await ringingFor(bold);
    const res = await webhook("status", String(first!._id), { CallStatus: "no-answer" });
    assert.equal(res.status, 204);

    assert.equal(dialed.length, 2);
    assert.equal(dialed[1]!.to, "+97699001102");
    assert.equal((await Calls.findById(first!._id).lean())?.status, "no_answer");
    assert.equal((await ringingFor(bold))?.attempt, 2);
  });

  it("records a call answered in silence as heard without a reply", async () => {
    const bold = (await Students.findOne({ firstName: "Болд" }).lean())!._id;
    await startFlow({ purpose: "late_pickup", studentId: bold });
    const call = await ringingFor(bold);
    await webhook("voice", String(call!._id));
    const res = await webhook("no-reply", String(call!._id));
    assert.match(await res.text(), /<Hangup\/>/);
    const done = await Calls.findById(call!._id).lean();
    assert.equal(done?.status, "completed");
    assert.equal(done?.intent?.outcome, "unknown");
  });
});
