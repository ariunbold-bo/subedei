import express, { type NextFunction, type Request, type Response, Router } from "express";
import { z } from "zod";
import { env, manifest } from "./config.ts";
import {
  ATTENDANCE,
  Calls,
  Classrooms,
  type GuardianDoc,
  Guardians,
  Meetings,
  type MeetingDoc,
  PURPOSES,
  SmsMessages,
  Students,
} from "./models.ts";
import { seedDemo } from "./seed.ts";
import {
  answerCall,
  declineCall,
  handleInboundSms,
  meetingReminderText,
  replyToCall,
  startFlow,
} from "./services/calls.ts";
import { erxesStatus, syncGuardian } from "./services/erxes.ts";
import { subscribe } from "./services/events.ts";
import { llmStatus } from "./services/llm.ts";
import { checkLatePickups } from "./services/scheduler.ts";
import {
  dayView,
  daySummary,
  draftSms,
  markAttendance,
  markPickedUp,
  resetPickup,
} from "./services/school.ts";
import {
  addGuardianToStudent,
  addStudent,
  clearRoster,
  deleteStudent,
  importRoster,
  moveGuardian,
  removeGuardianFromStudent,
  rosterView,
  updateGuardian,
  updateStudent,
} from "./services/roster.ts";
import { sendBulkSms, smsStatus } from "./services/sms.ts";
import { saveRecording, speechStatus } from "./services/speech.ts";
import { callStatus } from "./services/twilio.ts";
import { parseHHmm } from "./time.ts";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Буруу ID");
const param = (req: Request, name: string) => objectId.parse(req.params[name]);

// Phone format is checked (and normalized) by the roster service.
const guardianInput = z.object({
  name: z.string().min(1, "Асран хамгаалагчийн нэр хоосон").max(80),
  relation: z.string().max(30).default("асран хамгаалагч"),
  phone: z.string().min(1, "Утасны дугаар хоосон").max(20),
  canPickup: z.boolean().optional(),
});

export const statusPayload = async () => ({
  plugin: manifest.name,
  version: manifest.version,
  school: env.SCHOOL_NAME,
  timezone: env.TIMEZONE,
  llm: await llmStatus(),
  speech: speechStatus(),
  calls: callStatus(),
  sms: smsStatus(),
  erxes: erxesStatus(),
  ringTimeoutSec: env.RING_TIMEOUT_SEC,
  pickupGraceMin: env.PICKUP_GRACE_MIN,
  autoPickupCalls: env.AUTO_PICKUP_CALLS,
});

export const createRestRouter = () => {
  const api = Router();
  api.use(express.json({ limit: "1mb" }));

  api.get("/status", async (_req, res) => {
    res.json(await statusPayload());
  });

  api.get("/events", (_req, res) => subscribe("console", res));

  // ---- Today: attendance and pickup -------------------------------------
  api.get("/today", async (req, res) => {
    const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().parse(req.query.date);
    res.json(await dayView(date));
  });

  api.post("/attendance", async (req, res) => {
    const body = z
      .object({ studentId: objectId, status: z.enum(ATTENDANCE), note: z.string().max(200).optional() })
      .parse(req.body);
    res.json(await markAttendance(body.studentId, body.status, body.note));
  });

  api.post("/attendance/bulk", async (req, res) => {
    const body = z.object({ studentIds: z.array(objectId).max(200), status: z.enum(ATTENDANCE) }).parse(req.body);
    for (const id of body.studentIds) await markAttendance(id, body.status);
    res.json({ ok: true, count: body.studentIds.length });
  });

  api.post("/students/:id/picked-up", async (req, res) => {
    const body = z.object({ by: z.string().max(60).optional() }).parse(req.body ?? {});
    res.json(await markPickedUp(param(req, "id"), body.by));
  });

  api.post("/students/:id/pickup-reset", async (req, res) => {
    await resetPickup(param(req, "id"));
    res.json({ ok: true });
  });

  api.post("/pickup/check-now", async (_req, res) => {
    res.json({ started: await checkLatePickups(new Date(), { force: true }) });
  });

  api.post("/absence/notify", async (_req, res) => {
    const view = await dayView();
    let started = 0;
    for (const { student, record } of view.rows) {
      if (record.attendance === "absent" && !record.absenceNotifiedAt) {
        await startFlow({ purpose: "absence", studentId: student._id });
        started++;
      }
    }
    res.json({ started });
  });

  // ---- Calls ------------------------------------------------------------
  api.get("/calls", async (req, res) => {
    const limit = z.coerce.number().int().min(1).max(200).default(50).parse(req.query.limit);
    const calls = await Calls.find().sort({ ringingAt: -1 }).limit(limit).lean();
    res.json(calls);
  });

  api.post("/calls", async (req, res) => {
    const body = z
      .object({
        purpose: z.enum(PURPOSES),
        studentId: objectId.optional(),
        meetingId: objectId.optional(),
        guardianIds: z.array(objectId).max(200).optional(),
      })
      .parse(req.body);
    const flow = await startFlow(body);
    res.json(flow);
  });

  // ---- Phone simulator (the guardian's side) ------------------------------
  api.get("/phone/:guardianId/events", (req, res) => subscribe(`phone:${param(req, "guardianId")}`, res));

  api.get("/phone/:guardianId/inbox", async (req, res) => {
    const guardianId = param(req, "guardianId");
    const [guardian, sms, calls] = await Promise.all([
      Guardians.findById(guardianId).lean(),
      SmsMessages.find({ guardianId }).sort({ createdAt: -1 }).limit(50).lean(),
      Calls.find({ guardianId }).sort({ ringingAt: -1 }).limit(20).lean(),
    ]);
    res.json({ guardian, sms, calls, ringing: calls.find((c) => c.status === "ringing") ?? null });
  });

  api.post("/calls/:id/answer", async (req, res) => {
    res.json(await answerCall(param(req, "id")));
  });

  api.post("/calls/:id/decline", async (req, res) => {
    res.json(await declineCall(param(req, "id")));
  });

  // Body: JSON {text} or raw audio (audio/webm, audio/wav, …) from MediaRecorder.
  api.post(
    "/calls/:id/reply",
    express.raw({ type: ["audio/*", "application/octet-stream"], limit: "10mb" }),
    async (req, res) => {
      const id = param(req, "id");
      if (Buffer.isBuffer(req.body)) {
        const contentType = req.get("content-type") ?? "audio/webm";
        const recordingUrl = saveRecording(req.body, contentType);
        const text = typeof req.query.text === "string" ? req.query.text : undefined;
        res.json(await replyToCall(id, { audio: req.body, contentType, recordingUrl, text }));
        return;
      }
      const body = z.object({ text: z.string().min(1).max(500) }).parse(req.body);
      res.json(await replyToCall(id, { text: body.text }));
    },
  );

  api.post("/phone/:guardianId/sms", async (req, res) => {
    const guardian = await Guardians.findById(param(req, "guardianId")).lean();
    if (!guardian) throw Object.assign(new Error("Асран хамгаалагч олдсонгүй"), { status: 404 });
    const body = z.object({ text: z.string().min(1).max(500) }).parse(req.body);
    res.json(await handleInboundSms(guardian.phone, body.text));
  });

  // ---- SMS ----------------------------------------------------------------
  api.get("/sms", async (req, res) => {
    const limit = z.coerce.number().int().min(1).max(500).default(100).parse(req.query.limit);
    res.json(await SmsMessages.find().sort({ createdAt: -1 }).limit(limit).lean());
  });

  api.post("/sms/bulk", async (req, res) => {
    const body = z.object({ guardianIds: z.array(objectId).min(1).max(500), text: z.string().min(1).max(600) }).parse(req.body);
    const guardians = await Guardians.find({ _id: { $in: body.guardianIds } }).lean<GuardianDoc[]>();
    const { batchId, results } = await sendBulkSms(guardians, body.text);
    res.json({
      batchId,
      sent: results.filter((r) => r.status !== "failed").length,
      failed: results.filter((r) => r.status === "failed").length,
    });
  });

  api.post("/sms/draft", async (req, res) => {
    const body = z.object({ note: z.string().min(1).max(500) }).parse(req.body);
    const classroom = await Classrooms.findOne().lean();
    res.json(await draftSms(body.note, classroom?.teacherName ?? ""));
  });

  // SMS gateway webhook: {from|phone, text|message}.
  api.post("/sms/inbound", async (req, res) => {
    const body = z
      .object({ from: z.string().optional(), phone: z.string().optional(), text: z.string().optional(), message: z.string().optional() })
      .parse(req.body);
    const phone = body.from ?? body.phone;
    const text = body.text ?? body.message;
    if (!phone || !text) throw Object.assign(new Error("phone/text шаардлагатай"), { status: 400 });
    res.json(await handleInboundSms(phone, text));
  });

  // ---- Meetings -----------------------------------------------------------
  api.get("/meetings", async (_req, res) => {
    res.json(await Meetings.find().sort({ startsAt: -1 }).lean());
  });

  api.post("/meetings", async (req, res) => {
    const body = z
      .object({
        title: z.string().min(1).max(120),
        startsAt: z.coerce.date(),
        location: z.string().max(120).default(""),
        note: z.string().max(500).default(""),
        guardianIds: z.array(objectId).min(1).max(500),
        remindMinutesBefore: z.array(z.number().int().min(0).max(14 * 24 * 60)).max(5).default([24 * 60, 120]),
      })
      .parse(req.body);
    const classroom = await Classrooms.findOne().lean();
    const meeting = await Meetings.create({
      title: body.title,
      startsAt: body.startsAt,
      location: body.location,
      note: body.note,
      classroomId: classroom?._id,
      guardianIds: body.guardianIds,
      reminders: body.remindMinutesBefore
        .map((m) => ({ at: new Date(body.startsAt.getTime() - m * 60_000), label: m >= 60 ? `${Math.round(m / 60)} цагийн өмнө` : `${m} минутын өмнө` }))
        .filter((r) => r.at.getTime() > Date.now() - 60_000),
    });
    res.json(meeting);
  });

  api.post("/meetings/:id/remind-now", async (req, res) => {
    const meeting = await Meetings.findById(param(req, "id")).lean<MeetingDoc>();
    if (!meeting) throw Object.assign(new Error("Хурал олдсонгүй"), { status: 404 });
    const guardians = await Guardians.find({ _id: { $in: meeting.guardianIds } }).lean<GuardianDoc[]>();
    const { results } = await sendBulkSms(guardians, meetingReminderText(meeting), "meeting_reminder", { meetingId: meeting._id });
    res.json({ sent: results.length });
  });

  api.post("/meetings/:id/call", async (req, res) => {
    const meeting = await Meetings.findById(param(req, "id")).lean<MeetingDoc>();
    if (!meeting) throw Object.assign(new Error("Хурал олдсонгүй"), { status: 404 });
    const answered = new Set(meeting.rsvps.map((r) => String(r.guardianId)));
    let started = 0;
    for (const guardianId of meeting.guardianIds) {
      if (answered.has(String(guardianId))) continue;
      await startFlow({ purpose: "meeting", meetingId: meeting._id, guardianIds: [guardianId] });
      started++;
    }
    res.json({ started });
  });

  // ---- Class setup --------------------------------------------------------
  api.get("/guardians", async (_req, res) => {
    res.json(await Guardians.find().sort({ name: 1 }).lean());
  });

  // ---- Roster: students and guardians entered by the teacher ---------------
  api.get("/roster", async (_req, res) => {
    res.json(await rosterView());
  });

  api.post("/students", async (req, res) => {
    const body = z
      .object({
        firstName: z.string().min(1, "Сурагчийн нэр хоосон").max(60),
        lastName: z.string().max(60).default(""),
        guardians: z.array(guardianInput).min(1, "Дор хаяж нэг асран хамгаалагч оруулна уу").max(6),
      })
      .parse(req.body);
    res.json(await addStudent(body));
  });

  api.patch("/students/:id", async (req, res) => {
    const body = z.object({ firstName: z.string().max(60).optional(), lastName: z.string().max(60).optional() }).parse(req.body);
    res.json(await updateStudent(param(req, "id"), body));
  });

  api.delete("/students/:id", async (req, res) => {
    await deleteStudent(param(req, "id"));
    res.json({ ok: true });
  });

  api.post("/students/:id/guardians", async (req, res) => {
    res.json(await addGuardianToStudent(param(req, "id"), guardianInput.parse(req.body)));
  });

  api.delete("/students/:id/guardians/:guardianId", async (req, res) => {
    await removeGuardianFromStudent(param(req, "id"), param(req, "guardianId"));
    res.json({ ok: true });
  });

  api.post("/students/:id/guardians/:guardianId/move", async (req, res) => {
    const body = z.object({ direction: z.enum(["up", "down"]) }).parse(req.body);
    res.json({ guardianIds: await moveGuardian(param(req, "id"), param(req, "guardianId"), body.direction) });
  });

  // No defaults in a partial update: changing only the phone must keep the relation.
  const guardianPatch = guardianInput.extend({ relation: z.string().max(30) }).partial();
  api.patch("/guardians/:id", async (req, res) => {
    res.json(await updateGuardian(param(req, "id"), guardianPatch.parse(req.body)));
  });

  api.post("/roster/import", async (req, res) => {
    const body = z.object({ text: z.string().min(1, "Хоосон байна").max(100_000) }).parse(req.body);
    res.json(await importRoster(body.text));
  });

  api.post("/roster/clear", async (_req, res) => {
    await clearRoster();
    res.json({ ok: true });
  });

  api.patch("/classrooms/:id", async (req, res) => {
    const body = z
      .object({
        name: z.string().min(1).max(30).optional(),
        teacherName: z.string().max(80).optional(),
        teacherPhone: z.string().max(20).optional(),
        pickupTime: z.string().refine((v) => parseHHmm(v) !== null, "HH:mm").optional(),
        classStartTime: z.string().refine((v) => parseHHmm(v) !== null, "HH:mm").optional(),
      })
      .parse(req.body);
    res.json(await Classrooms.findByIdAndUpdate(param(req, "id"), body, { new: true }).lean());
  });

  // ---- AI and integrations --------------------------------------------------
  api.get("/summary", async (_req, res) => {
    res.json(await daySummary());
  });

  api.post("/erxes/sync", async (_req, res) => {
    const guardians = await Guardians.find().lean<GuardianDoc[]>();
    const students = await Students.find().lean();
    const results = [];
    for (const guardian of guardians) {
      const children = students.filter((s) => s.guardianIds.some((id) => String(id) === String(guardian._id)));
      try {
        results.push({ guardianId: guardian._id, ...(await syncGuardian(guardian, children.map((c) => c.firstName))) });
      } catch (error) {
        results.push({ guardianId: guardian._id, synced: false, reason: (error as Error).message });
      }
    }
    res.json({ total: results.length, synced: results.filter((r) => r.synced).length, results });
  });

  api.post("/demo/reset", async (_req, res) => {
    res.json(await seedDemo({ reset: true }));
  });

  api.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  api.use((error: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues.map((i) => i.message).join("; ") });
      return;
    }
    const status = error.status ?? 500;
    if (status >= 500) console.error(error);
    res.status(status).json({ error: error.message });
  });

  return api;
};
