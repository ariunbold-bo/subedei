import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

// Twilio trial accounts: the REST call may only carry To/Url/StatusCallback and
// <Record> is blocked, so guardians answer with the keypad. Twilio and Oyu are
// faked at the fetch level; no real call is placed.
const dataDir = mkdtempSync(join(tmpdir(), "subedei-trial-"));
process.env.DATA_DIR = dataDir;
process.env.LLM_ENABLED = "false";
process.env.AUTO_PICKUP_CALLS = "false";
process.env.CALL_PROVIDER = "twilio";
process.env.TWILIO_TRIAL = "true";
process.env.PUBLIC_URL = "https://subedei.example.test";
process.env.TWILIO_ACCOUNT_SID = "AC00000000000000000000000000000000";
process.env.TWILIO_API_KEY = "SK00000000000000000000000000000000";
process.env.TWILIO_API_SECRET = "test-secret";
delete process.env.TWILIO_PHONE_NUMBER;
process.env.OYU_API_KEY = "test-oyu";
if (process.env.TEST_MONGO_URL) process.env.MONGO_URL = process.env.TEST_MONGO_URL.replace(/\/[^/]*$/, "/subedei_trial");

const realFetch = globalThis.fetch;
const dialed: URLSearchParams[] = [];
const WAV = Buffer.from("RIFF0000WAVEfmt fake-audio");

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.endsWith("/Calls.json")) {
    dialed.push(new URLSearchParams(String(init?.body)));
    return Response.json({ sid: `CA${dialed.length}` }, { status: 201 });
  }
  if (url.includes("api.twilio.com")) return Response.json({ status: "completed" });
  if (url.endsWith("/audio/speech")) return new Response(WAV, { headers: { "Content-Type": "audio/wav" } });
  return realFetch(input, init);
}) as typeof fetch;

const { connectDb, disconnectDb } = await import("../src/db.ts");
const { seedDemo } = await import("../src/seed.ts");
const { Calls, DayRecords, Students } = await import("../src/models.ts");
const { startFlow } = await import("../src/services/calls.ts");
const { callStatus, webhookToken } = await import("../src/services/twilio.ts");
const { createTwilioRouter } = await import("../src/twilio-routes.ts");
const { today } = await import("../src/time.ts");
const express = (await import("express")).default;

let server: Server;
let base = "";

const webhook = (kind: string, callId: string, body: Record<string, string> = {}) =>
  realFetch(`${base}/twilio/${kind}?callId=${callId}&token=${webhookToken(callId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });

const ringingFor = async (studentId: unknown) => Calls.findOne({ studentId, status: "ringing" }).lean();
const boldId = async () => (await Students.findOne({ firstName: "Болд" }).lean())!._id;

describe("Twilio trial calls", () => {
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
  });

  it("is ready without a From number", () => {
    assert.deepEqual(callStatus().problems, []);
    assert.equal(callStatus().provider, "twilio");
  });

  it("sends only the parameters a trial account accepts", async () => {
    await startFlow({ purpose: "late_pickup", studentId: await boldId() });
    assert.equal(dialed.length, 1);
    assert.deepEqual([...dialed[0]!.keys()].sort(), ["StatusCallback", "To", "Url"]);
    assert.equal(dialed[0]!.get("To"), "+97699001101");
  });

  it("plays the message and keypad menu inside <Gather>, never <Record>", async () => {
    const bold = await boldId();
    await startFlow({ purpose: "late_pickup", studentId: bold });
    const call = await ringingFor(bold);
    const voice = await (await webhook("voice", String(call!._id))).text();
    assert.match(voice, /<Gather input="dtmf" numDigits="1" timeout="7" action="https:\/\/subedei\.example\.test\/twilio\/gather\?callId=/);
    assert.equal((voice.match(/<Play>/g) ?? []).length, 2);
    assert.doesNotMatch(voice, /<Record/);
  });

  it("turns keypad 3 into 'someone else picks up' and thanks the guardian", async () => {
    const bold = await boldId();
    await startFlow({ purpose: "late_pickup", studentId: bold });
    const call = await ringingFor(bold);
    await webhook("voice", String(call!._id));
    const twiml = await (await webhook("gather", String(call!._id), { Digits: "3" })).text();
    assert.match(twiml, /<Play>.*\.wav<\/Play><Hangup\/>/);

    const done = await Calls.findById(call!._id).lean();
    assert.equal(done?.status, "completed");
    assert.equal(done?.intent?.outcome, "someone_else");
    const record = await DayRecords.findOne({ studentId: bold, date: today() }).lean();
    assert.equal(record?.pickup?.status, "someone_else");
  });

  it("keypad 1 means coming within 15 minutes", async () => {
    const bold = await boldId();
    await startFlow({ purpose: "late_pickup", studentId: bold });
    const call = await ringingFor(bold);
    await webhook("voice", String(call!._id));
    await webhook("gather", String(call!._id), { Digits: "1" });
    const record = await DayRecords.findOne({ studentId: bold, date: today() }).lean();
    assert.equal(record?.pickup?.status, "coming");
    assert.equal(record?.pickup?.etaMinutes, 15);
  });
});
