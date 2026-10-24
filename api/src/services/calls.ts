import type { Types } from "mongoose";
import { env } from "../config.ts";
import {
  type CallDoc,
  CallFlows,
  type CallFlowDoc,
  Calls,
  Classrooms,
  DayRecords,
  type GuardianDoc,
  Guardians,
  Meetings,
  type MeetingDoc,
  type Purpose,
  SmsMessages,
  type StudentDoc,
  Students,
} from "../models.ts";
import { localTime, mongolianDateTime, today } from "../time.ts";
import { logToErxes } from "./erxes.ts";
import { notifyConsole, notifyPhone } from "./events.ts";
import { type Intent, interpretReply } from "./intent.ts";
import { sendSms } from "./sms.ts";
import { synthesize, transcribe } from "./speech.ts";
import { callProvider, hangupCall, placeCall } from "./twilio.ts";

// Call orchestration. A flow calls the guardians of a child one by one:
// ring -> (answered -> spoken script -> guardian reply -> LLM intent)
//      -> (no answer / declined -> next guardian) -> nobody reached -> SMS.
//
// Telephony: with Twilio configured, `ring()` dials the real phone and the
// webhooks in twilio-routes.ts drive the call. Otherwise (or if dialing fails)
// the call goes to the browser phone simulator over SSE (`incoming_call`).

/** Extra seconds a Twilio call may ring before we time it out ourselves (Twilio reports it first). */
const TWILIO_RING_GRACE_SEC = 45;

const studentName = (student: Pick<StudentDoc, "firstName">) => student.firstName;

/** The call moved on (answered elsewhere, timed out, cancelled): HTTP 409. */
const conflict = (message: string) => Object.assign(new Error(message), { status: 409 });

type ScriptContext = {
  purpose: Purpose;
  guardian: GuardianDoc;
  student?: StudentDoc | null;
  meeting?: MeetingDoc | null;
  classroomName?: string;
  pickupTime?: string;
};

export const scriptFor = ({ purpose, guardian, student, meeting, classroomName, pickupTime }: ScriptContext) => {
  // Phrased so names never need Mongolian case suffixes.
  const greeting = `Сайн байна уу, ${guardian.name}. Энэ бол ${env.SCHOOL_NAME}, ${classroomName ? `${classroomName} ангийн ` : ""}багшийн автомат туслах байна.`;
  if (purpose === "late_pickup" && student) {
    return `${greeting} Таны хүүхэд ${studentName(student)} хичээлээ ${pickupTime ?? ""} цагт тараад, одоо сургууль дээр таныг хүлээж байна. Хэзээ ирж авах, эсвэл өөр хэн авахыг хэлнэ үү.`;
  }
  if (purpose === "absence" && student) {
    return `${greeting} Таны хүүхэд ${studentName(student)} өнөөдөр хичээлдээ ирээгүй байна. Шалтгааныг хэлж өгнө үү.`;
  }
  if (purpose === "meeting" && meeting) {
    return `${greeting} ${meeting.title} ${mongolianDateTime(meeting.startsAt)} цагт${meeting.location ? ` ${meeting.location}-д` : ""} болно. Ирэх эсэхээ хэлнэ үү.`;
  }
  return greeting;
};

const smsFallbackFor = ({ purpose, guardian, student, meeting, pickupTime, teacher }: ScriptContext & { teacher: string }) => {
  if (purpose === "late_pickup" && student) {
    return `[${env.SCHOOL_NAME}] ${guardian.name}, таны хүүхэд ${studentName(student)} сургууль дээр таныг хүлээж байна (хичээл ${pickupTime ?? ""}-д тарсан). Утсаа авсангүй. Хэзээ ирэхээ хариу бичнэ үү.${teacher}`;
  }
  if (purpose === "absence" && student) {
    return `[${env.SCHOOL_NAME}] Таны хүүхэд ${studentName(student)} өнөөдөр хичээлдээ ирээгүй байна. Шалтгааныг хариу бичнэ үү.${teacher}`;
  }
  if (purpose === "meeting" && meeting) {
    return meetingReminderText(meeting);
  }
  return `[${env.SCHOOL_NAME}] Багш тантай холбогдохыг хүсэж байна.${teacher}`;
};

export const meetingReminderText = (meeting: MeetingDoc) =>
  `[${env.SCHOOL_NAME}] Сануулга: ${meeting.title} — ${mongolianDateTime(meeting.startsAt)}${meeting.location ? `, ${meeting.location}` : ""}. Ирэх бол 1, ирэхгүй бол 2 гэж хариулна уу.`;

const confirmationFor = (intent: Intent) => {
  switch (intent.outcome) {
    case "coming":
      return intent.etaMinutes !== undefined
        ? `Баярлалаа. Таныг ${intent.etaMinutes} минутын дараа ирнэ гэж багшид мэдэгдлээ.`
        : "Баярлалаа. Таныг ирж байгаа гэж багшид мэдэгдлээ.";
    case "someone_else":
      return `Баярлалаа. ${intent.pickupPerson ?? "Өөр хүн"} авахаар ирнэ гэж багшид мэдэгдлээ.`;
    case "cannot_come":
      return "Ойлголоо. Бусад асран хамгаалагчтай холбогдож, багшид мэдэгдэнэ.";
    case "absent_reason":
      return "Баярлалаа. Шалтгааныг багшид дамжууллаа.";
    case "attending":
      return "Баярлалаа. Таныг хуралд ирнэ гэж бүртгэлээ.";
    case "not_attending":
      return "Ойлголоо. Таныг хуралд ирэхгүй гэж бүртгэлээ.";
    default:
      return "Баярлалаа. Таны хариуг багшид дамжууллаа.";
  }
};

const loadContext = async (flow: CallFlowDoc, guardian: GuardianDoc): Promise<ScriptContext & { teacher: string }> => {
  const student = flow.studentId ? await Students.findById(flow.studentId).lean<StudentDoc>() : null;
  const meeting = flow.meetingId ? await Meetings.findById(flow.meetingId).lean<MeetingDoc>() : null;
  const classroom = student
    ? await Classrooms.findById(student.classroomId).lean()
    : meeting?.classroomId
      ? await Classrooms.findById(meeting.classroomId).lean()
      : null;
  const teacher = classroom?.teacherName
    ? ` Багш ${classroom.teacherName}${classroom.teacherPhone ? ` ${classroom.teacherPhone}` : ""}`
    : "";
  return {
    purpose: flow.purpose,
    guardian,
    student,
    meeting,
    classroomName: classroom?.name,
    pickupTime: classroom?.pickupTime,
    teacher,
  };
};

type StartFlowOptions = {
  purpose: Purpose;
  studentId?: string | Types.ObjectId;
  meetingId?: string | Types.ObjectId;
  guardianIds?: (string | Types.ObjectId)[];
  date?: string;
};

/** Starts calling a child's guardians (or the given guardians) in order. */
export const startFlow = async ({ purpose, studentId, meetingId, guardianIds, date = today() }: StartFlowOptions) => {
  let ids = guardianIds?.map(String) ?? [];

  if (!ids.length && studentId) {
    const student = await Students.findById(studentId).lean<StudentDoc>();
    if (!student) throw new Error("Сурагч олдсонгүй");
    const guardians = await Guardians.find({ _id: { $in: student.guardianIds } }).lean<GuardianDoc[]>();
    const byId = new Map(guardians.map((g) => [String(g._id), g]));
    ids = student.guardianIds
      .map(String)
      .filter((id) => {
        const guardian = byId.get(id);
        return guardian && (purpose !== "late_pickup" || guardian.canPickup);
      });
  }
  if (!ids.length) throw new Error("Залгах асран хамгаалагч алга");

  if (studentId) {
    // One active flow per child and purpose.
    const active = await CallFlows.findOne({ studentId, purpose, date, status: "active" });
    if (active) return active;
  }

  const flow = await CallFlows.create({ purpose, studentId, meetingId, guardianIds: ids, date });

  if (studentId && purpose === "late_pickup") {
    await DayRecords.updateOne(
      { studentId, date },
      { $set: { "pickup.status": "contacting", "pickup.flowStartedAt": new Date() } },
    );
  }
  if (studentId && purpose === "absence") {
    await DayRecords.updateOne({ studentId, date }, { $set: { absenceNotifiedAt: new Date() } });
  }

  await ring(flow.toObject());
  return flow;
};

const ring = async (flow: CallFlowDoc) => {
  const guardianId = flow.guardianIds[flow.index];
  const guardian = guardianId ? await Guardians.findById(guardianId).lean<GuardianDoc>() : null;
  if (!guardian) return finishUnreachable(flow);

  const context = await loadContext(flow, guardian);
  const script = scriptFor(context);
  const audioUrl = (await synthesize(script)) ?? undefined;

  const call = await Calls.create({
    flowId: flow._id,
    purpose: flow.purpose,
    studentId: flow.studentId,
    meetingId: flow.meetingId,
    guardianId: guardian._id,
    attempt: flow.index + 1,
    script,
    audioUrl,
    status: "ringing",
    ringingAt: new Date(),
  });

  if (callProvider() === "twilio") {
    try {
      const twilioSid = await placeCall(String(call._id), guardian.phone);
      await Calls.updateOne({ _id: call._id }, { channel: "twilio", twilioSid });
      notifyConsole("call", { _id: call._id, status: call.status, channel: "twilio" });
      return call;
    } catch (error) {
      // e.g. an unverified number on a Twilio trial account: keep the demo going.
      const providerError = (error as Error).message;
      console.warn("[twilio] dial failed, using the phone simulator:", providerError);
      await Calls.updateOne({ _id: call._id }, { providerError });
    }
  }

  notifyPhone(guardian._id, "incoming_call", {
    callId: call._id,
    from: `${env.SCHOOL_NAME}${context.classroomName ? ` · ${context.classroomName}` : ""}`,
    purpose: flow.purpose,
  });
  notifyConsole("call", { _id: call._id, status: call.status });
  return call;
};

/** Moves the flow to the next guardian, or falls back to SMS. */
const advance = async (flowId: Types.ObjectId) => {
  const flow = await CallFlows.findOneAndUpdate(
    { _id: flowId, status: "active" },
    { $inc: { index: 1 } },
    { new: true },
  ).lean<CallFlowDoc>();
  if (!flow) return;
  if (flow.index < flow.guardianIds.length) {
    await ring(flow);
  } else {
    await finishUnreachable(flow);
  }
};

const finishUnreachable = async (flow: CallFlowDoc) => {
  await CallFlows.updateOne({ _id: flow._id }, { status: "unreachable" });

  const guardians = await Guardians.find({ _id: { $in: flow.guardianIds } }).lean<GuardianDoc[]>();
  for (const guardian of guardians) {
    const context = await loadContext(flow, guardian);
    await sendSms({
      guardian,
      text: smsFallbackFor(context),
      purpose: flow.purpose === "meeting" ? "meeting_reminder" : flow.purpose,
      studentId: flow.studentId ?? undefined,
      meetingId: flow.meetingId ?? undefined,
    });
  }

  if (flow.studentId && flow.purpose === "late_pickup") {
    await DayRecords.updateOne(
      { studentId: flow.studentId, date: flow.date, "pickup.status": { $ne: "picked_up" } },
      { $set: { "pickup.status": "unreachable" } },
    );
  }
  notifyConsole("alert", {
    level: "warning",
    message: "Асран хамгаалагчид утсаа авсангүй — SMS илгээлээ",
    studentId: flow.studentId,
    purpose: flow.purpose,
  });
};

const endUnanswered = async (callId: string | Types.ObjectId, status: "no_answer" | "declined") => {
  const call = await Calls.findOneAndUpdate(
    { _id: callId, status: "ringing" },
    { status, endedAt: new Date() },
    { new: true },
  ).lean<CallDoc>();
  if (!call) return null;
  if (call.twilioSid) void hangupCall(call.twilioSid);
  notifyPhone(call.guardianId, "call_ended", { callId: call._id, status });
  notifyConsole("call", { _id: call._id, status });
  await advance(call.flowId);
  return call;
};

export const declineCall = (callId: string) => endUnanswered(callId, "declined");

/** Twilio reported no-answer/busy/failed: try the next guardian. */
export const markUnanswered = endUnanswered;

/** Guardian picked up: returns what to play. */
export const answerCall = async (callId: string) => {
  const call = await Calls.findOneAndUpdate(
    { _id: callId, status: "ringing" },
    { status: "answered", answeredAt: new Date() },
    { new: true },
  ).lean<CallDoc>();
  if (!call) throw conflict("Дуудлага дууссан байна");
  notifyConsole("call", { _id: call._id, status: call.status });
  return call;
};

type ReplyInput = { text?: string; audio?: Buffer; contentType?: string; recordingUrl?: string };

/** Handles the guardian's spoken (or typed) reply to an answered call. */
export const replyToCall = async (callId: string, { text, audio, contentType, recordingUrl }: ReplyInput) => {
  const call = await Calls.findOne({ _id: callId, status: "answered" }).lean<CallDoc>();
  if (!call) throw conflict("Хариу хүлээж буй дуудлага олдсонгүй");

  let transcript = text?.trim() ?? "";
  if (!transcript && audio) {
    transcript = (await transcribe(audio, contentType ?? "audio/webm")) ?? "";
    if (!transcript) {
      const error = new Error("Яриаг танисангүй. Дахин хэлэх эсвэл бичнэ үү.");
      Object.assign(error, { status: 422 });
      throw error;
    }
  }

  const [guardian, student] = await Promise.all([
    Guardians.findById(call.guardianId).lean<GuardianDoc>(),
    call.studentId ? Students.findById(call.studentId).lean<StudentDoc>() : null,
  ]);

  const intent = await interpretReply(transcript, {
    purpose: call.purpose,
    studentName: student?.firstName ?? "",
    guardianRelation: guardian?.relation ?? "асран хамгаалагч",
    nowTime: localTime(new Date()),
  });

  return completeCall(call, transcript, intent, recordingUrl);
};

const completeCall = async (call: CallDoc, transcript: string, intent: Intent, recordingUrl?: string) => {
  const confirmation = confirmationFor(intent);
  const confirmationAudioUrl = (await synthesize(confirmation)) ?? undefined;

  const updated = await Calls.findOneAndUpdate(
    { _id: call._id, status: "answered" },
    {
      status: "completed",
      endedAt: new Date(),
      transcript,
      recordingUrl,
      intent,
      confirmation,
      confirmationAudioUrl,
    },
    { new: true },
  ).lean<CallDoc>();
  if (!updated) throw conflict("Дуудлага аль хэдийн дууссан");

  const continueFlow = await applyIntent(
    {
      purpose: updated.purpose,
      studentId: updated.studentId ?? undefined,
      guardianId: updated.guardianId,
      meetingId: updated.meetingId ?? undefined,
      flowId: updated.flowId,
      date: today(updated.ringingAt),
    },
    intent,
  );
  if (continueFlow) {
    await advance(updated.flowId);
  } else {
    await CallFlows.updateOne({ _id: updated.flowId, status: "active" }, { status: "done" });
  }

  const guardian = await Guardians.findById(updated.guardianId).lean<GuardianDoc>();
  if (guardian) {
    void logToErxes(guardian, `Дуудлага (${updated.purpose}): "${transcript || "хариугүй"}" → ${intent.summary}`);
  }
  notifyConsole("call", { _id: updated._id, status: updated.status, summary: intent.summary });
  return updated;
};

type ReplyTarget = {
  purpose: Purpose;
  studentId?: Types.ObjectId;
  guardianId: Types.ObjectId;
  meetingId?: Types.ObjectId;
  /** Set for calls; SMS replies have no flow to continue. */
  flowId?: Types.ObjectId;
  date: string;
};

/** Updates attendance/pickup/RSVP from a reply. Returns true to call the next guardian. */
const applyIntent = async (call: ReplyTarget, intent: Intent) => {
  const { date } = call;

  if (call.purpose === "late_pickup" && call.studentId) {
    const flow = call.flowId ? await CallFlows.findById(call.flowId).lean<CallFlowDoc>() : null;
    const hasNext = flow ? flow.index + 1 < flow.guardianIds.length : false;
    const filter = { studentId: call.studentId, date, "pickup.status": { $ne: "picked_up" } };
    const eta = intent.etaMinutes;
    const expectedAt = eta !== undefined ? new Date(Date.now() + eta * 60_000) : undefined;

    if (intent.outcome === "coming" || intent.outcome === "someone_else") {
      await DayRecords.updateOne(filter, {
        $set: {
          "pickup.status": intent.outcome,
          "pickup.etaMinutes": eta,
          "pickup.expectedAt": expectedAt,
          "pickup.pickupPerson": intent.pickupPerson,
          "pickup.note": intent.summary,
        },
      });
      return false;
    }
    if (intent.outcome === "cannot_come") {
      if (hasNext) {
        await DayRecords.updateOne(filter, { $set: { "pickup.note": intent.summary } });
        return true;
      }
      await DayRecords.updateOne(filter, { $set: { "pickup.status": "cannot_come", "pickup.note": intent.summary } });
      notifyConsole("alert", { level: "danger", message: `${intent.summary}`, studentId: call.studentId });
      return false;
    }
    await DayRecords.updateOne(filter, { $set: { "pickup.status": "informed", "pickup.note": intent.summary } });
    return false;
  }

  if (call.purpose === "absence" && call.studentId) {
    const filter = { studentId: call.studentId, date };
    if (intent.outcome === "absent_reason") {
      await DayRecords.updateOne(filter, { $set: { attendance: "excused", attendanceNote: intent.reason ?? intent.summary } });
    } else if (intent.outcome === "coming") {
      await DayRecords.updateOne(filter, { $set: { attendance: "late", attendanceNote: intent.summary } });
    } else {
      await DayRecords.updateOne(filter, { $set: { attendanceNote: intent.summary } });
    }
    return false;
  }

  if (call.purpose === "meeting" && call.meetingId) {
    if (intent.outcome === "attending" || intent.outcome === "not_attending") {
      await recordRsvp(call.meetingId, call.guardianId, intent.outcome === "attending" ? "yes" : "no");
    }
    return false;
  }
  return false;
};

const normalizePhone = (phone: string) => phone.replace(/[^\d]/g, "").replace(/^976(?=\d{8}$)/, "");

/**
 * An SMS reply from a guardian (gateway webhook or the phone simulator):
 * "1"/"2" answers the next meeting; anything else is read as a reply about
 * today's late pickup or absence of their child.
 */
export const handleInboundSms = async (phone: string, text: string) => {
  const digits = normalizePhone(phone);
  const guardian = await Guardians.findOne({ phone: { $in: [phone, digits] } }).lean<GuardianDoc>();
  await SmsMessages.create({
    guardianId: guardian?._id,
    phone,
    text,
    purpose: "inbound",
    direction: "inbound",
    status: "received",
  });
  notifyConsole("sms", { inbound: true });
  if (!guardian) return { matched: false as const };

  const date = today();
  const nowTime = localTime(new Date());
  const trimmed = text.trim();

  const meeting = await Meetings.findOne({ guardianIds: guardian._id, startsAt: { $gte: new Date() } })
    .sort({ startsAt: 1 })
    .lean<MeetingDoc>();
  if (meeting && /^[12]$/.test(trimmed)) {
    await recordRsvp(meeting._id, guardian._id, trimmed === "1" ? "yes" : "no");
    return { matched: true as const, kind: "meeting" as const };
  }

  const students = await Students.find({ guardianIds: guardian._id }).lean<StudentDoc[]>();
  for (const student of students) {
    const record = await DayRecords.findOne({ studentId: student._id, date }).lean();
    if (!record) continue;
    const pickupOpen = ["contacting", "informed", "unreachable", "cannot_come"].includes(record.pickup?.status ?? "");
    const purpose: Purpose | null = pickupOpen ? "late_pickup" : record.attendance === "absent" ? "absence" : null;
    if (!purpose) continue;

    const intent = await interpretReply(trimmed, {
      purpose,
      studentName: student.firstName,
      guardianRelation: guardian.relation,
      nowTime,
    });
    await applyIntent({ purpose, studentId: student._id, guardianId: guardian._id, date }, intent);
    if (purpose === "late_pickup" && (intent.outcome === "coming" || intent.outcome === "someone_else")) {
      await cancelFlowsForStudent(student._id, "late_pickup", date);
    }
    notifyConsole("today", { studentId: student._id });
    return { matched: true as const, kind: purpose, intent };
  }

  if (meeting) {
    const intent = await interpretReply(trimmed, { purpose: "meeting", studentName: "", guardianRelation: guardian.relation, nowTime });
    if (intent.outcome === "attending" || intent.outcome === "not_attending") {
      await recordRsvp(meeting._id, guardian._id, intent.outcome === "attending" ? "yes" : "no");
      return { matched: true as const, kind: "meeting" as const, intent };
    }
  }
  return { matched: true as const, kind: "note" as const };
};

export const recordRsvp = async (
  meetingId: Types.ObjectId | string,
  guardianId: Types.ObjectId | string,
  response: "yes" | "no",
) => {
  await Meetings.updateOne({ _id: meetingId }, { $pull: { rsvps: { guardianId } } });
  await Meetings.updateOne({ _id: meetingId }, { $push: { rsvps: { guardianId, response, at: new Date() } } });
  notifyConsole("meeting", { _id: meetingId });
};

/** Stops ringing calls for a child, e.g. once the child has been picked up. */
export const cancelFlowsForStudent = async (studentId: string | Types.ObjectId, purpose: Purpose, date = today()) => {
  const flows = await CallFlows.find({ studentId, purpose, date, status: "active" }).lean<CallFlowDoc[]>();
  for (const flow of flows) {
    await CallFlows.updateOne({ _id: flow._id }, { status: "cancelled" });
    const ringing = await Calls.find({ flowId: flow._id, status: "ringing" }).lean<CallDoc[]>();
    for (const call of ringing) {
      await Calls.updateOne({ _id: call._id }, { status: "cancelled", endedAt: new Date() });
      if (call.twilioSid) void hangupCall(call.twilioSid);
      notifyPhone(call.guardianId, "call_ended", { callId: call._id, status: "cancelled" });
    }
  }
};

/** Times out unanswered and silent calls; driven by the scheduler. */
export const checkCallTimeouts = async (now = new Date()) => {
  const ringDeadline = now.getTime() - env.RING_TIMEOUT_SEC * 1000;
  const ringing = await Calls.find({ status: "ringing", ringingAt: { $lt: new Date(ringDeadline) } }).lean<CallDoc[]>();
  for (const call of ringing) {
    // Twilio calls take time to connect and report their own no-answer.
    const grace = call.channel === "twilio" ? TWILIO_RING_GRACE_SEC * 1000 : 0;
    if (call.ringingAt.getTime() < ringDeadline - grace) await endUnanswered(call._id, "no_answer");
  }

  const replyDeadline = new Date(now.getTime() - env.REPLY_TIMEOUT_SEC * 1000);
  const silent = await Calls.find({ status: "answered", answeredAt: { $lt: replyDeadline } }).lean<CallDoc[]>();
  for (const call of silent) {
    // The guardian heard the message but said nothing we could use.
    await completeCall(call, "", { outcome: "unknown", summary: "Мэдээллийг сонссон, хариу өгөөгүй", engine: "rules" }).catch(() => undefined);
  }
};
