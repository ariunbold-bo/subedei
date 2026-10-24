import mongoose, { type InferSchemaType, Schema, type Types } from "mongoose";

const { ObjectId } = Schema.Types;

const classroomSchema = new Schema(
  {
    name: { type: String, required: true },
    teacherName: { type: String, default: "" },
    teacherPhone: { type: String, default: "" },
    // Local "HH:mm" in env.TIMEZONE.
    classStartTime: { type: String, default: "08:00" },
    pickupTime: { type: String, default: "17:00" },
  },
  { timestamps: true },
);

const guardianSchema = new Schema(
  {
    name: { type: String, required: true },
    relation: { type: String, default: "эцэг эх" },
    phone: { type: String, required: true, index: true },
    canPickup: { type: Boolean, default: true },
    erxesCustomerId: { type: String },
  },
  { timestamps: true },
);

const studentSchema = new Schema(
  {
    firstName: { type: String, required: true },
    lastName: { type: String, default: "" },
    classroomId: { type: ObjectId, ref: "Classroom", required: true, index: true },
    // Call order: the first guardian is called first.
    guardianIds: [{ type: ObjectId, ref: "Guardian" }],
  },
  { timestamps: true },
);

export const ATTENDANCE = ["unknown", "present", "absent", "late", "excused"] as const;
export const PICKUP = [
  "waiting",
  "contacting",
  "informed",
  "coming",
  "someone_else",
  "cannot_come",
  "unreachable",
  "picked_up",
] as const;

// One document per student per school day.
const dayRecordSchema = new Schema(
  {
    studentId: { type: ObjectId, ref: "Student", required: true },
    classroomId: { type: ObjectId, ref: "Classroom", required: true },
    date: { type: String, required: true },
    attendance: { type: String, enum: ATTENDANCE, default: "unknown" },
    attendanceNote: { type: String, default: "" },
    markedAt: { type: Date },
    absenceNotifiedAt: { type: Date },
    pickup: {
      status: { type: String, enum: PICKUP, default: "waiting" },
      etaMinutes: { type: Number },
      expectedAt: { type: Date },
      pickupPerson: { type: String },
      note: { type: String },
      pickedUpAt: { type: Date },
      pickedUpBy: { type: String },
      flowStartedAt: { type: Date },
    },
  },
  { timestamps: true },
);
dayRecordSchema.index({ studentId: 1, date: 1 }, { unique: true });

export const PURPOSES = ["late_pickup", "absence", "meeting"] as const;
export const OUTCOMES = [
  "coming",
  "someone_else",
  "cannot_come",
  "already_picked",
  "absent_reason",
  "attending",
  "not_attending",
  "unknown",
] as const;

const intentSchema = new Schema(
  {
    outcome: { type: String, enum: OUTCOMES, default: "unknown" },
    etaMinutes: { type: Number },
    pickupPerson: { type: String },
    reason: { type: String },
    summary: { type: String },
    engine: { type: String, enum: ["llm", "rules"] },
    // LLM_MODEL that produced the result, e.g. "gemma4" or "oyuLLM".
    model: { type: String },
  },
  { _id: false },
);

// A call flow tries guardians one after another until someone answers.
const callFlowSchema = new Schema(
  {
    purpose: { type: String, enum: PURPOSES, required: true },
    studentId: { type: ObjectId, ref: "Student" },
    meetingId: { type: ObjectId, ref: "Meeting" },
    date: { type: String, required: true },
    guardianIds: [{ type: ObjectId, ref: "Guardian" }],
    index: { type: Number, default: 0 },
    status: { type: String, enum: ["active", "done", "unreachable", "cancelled"], default: "active" },
  },
  { timestamps: true },
);

const callSchema = new Schema(
  {
    flowId: { type: ObjectId, ref: "CallFlow", required: true, index: true },
    purpose: { type: String, enum: PURPOSES, required: true },
    studentId: { type: ObjectId, ref: "Student" },
    guardianId: { type: ObjectId, ref: "Guardian", required: true, index: true },
    meetingId: { type: ObjectId, ref: "Meeting" },
    attempt: { type: Number, default: 1 },
    script: { type: String, required: true },
    audioUrl: { type: String },
    status: {
      type: String,
      enum: ["ringing", "answered", "completed", "no_answer", "declined", "failed", "cancelled"],
      default: "ringing",
    },
    ringingAt: { type: Date, default: () => new Date() },
    answeredAt: { type: Date },
    endedAt: { type: Date },
    transcript: { type: String },
    recordingUrl: { type: String },
    confirmation: { type: String },
    confirmationAudioUrl: { type: String },
    intent: { type: intentSchema },
    // Where the call actually rang: a real phone (Twilio) or the browser simulator.
    channel: { type: String, enum: ["simulator", "twilio"], default: "simulator" },
    twilioSid: { type: String },
    // Why dialing a real phone failed (the call then rang in the simulator).
    providerError: { type: String },
  },
  { timestamps: true },
);

const smsSchema = new Schema(
  {
    guardianId: { type: ObjectId, ref: "Guardian", index: true },
    phone: { type: String, required: true },
    text: { type: String, required: true },
    sentText: { type: String },
    purpose: {
      type: String,
      enum: ["late_pickup", "absence", "meeting_reminder", "bulk", "inbound"],
      required: true,
    },
    direction: { type: String, enum: ["outbound", "inbound"], default: "outbound" },
    status: { type: String, enum: ["sent", "simulated", "failed", "received"], required: true },
    provider: { type: String },
    error: { type: String },
    batchId: { type: String, index: true },
    meetingId: { type: ObjectId, ref: "Meeting" },
    studentId: { type: ObjectId, ref: "Student" },
  },
  { timestamps: true },
);

const meetingSchema = new Schema(
  {
    title: { type: String, required: true },
    startsAt: { type: Date, required: true },
    location: { type: String, default: "" },
    note: { type: String, default: "" },
    classroomId: { type: ObjectId, ref: "Classroom" },
    guardianIds: [{ type: ObjectId, ref: "Guardian" }],
    reminders: [
      {
        at: { type: Date, required: true },
        label: { type: String },
        sentAt: { type: Date },
      },
    ],
    rsvps: [
      {
        guardianId: { type: ObjectId, ref: "Guardian" },
        response: { type: String, enum: ["yes", "no"] },
        at: { type: Date },
        _id: false,
      },
    ],
  },
  { timestamps: true },
);

export type ClassroomDoc = InferSchemaType<typeof classroomSchema> & { _id: Types.ObjectId };
export type GuardianDoc = InferSchemaType<typeof guardianSchema> & { _id: Types.ObjectId };
export type StudentDoc = InferSchemaType<typeof studentSchema> & { _id: Types.ObjectId };
export type DayRecordDoc = InferSchemaType<typeof dayRecordSchema> & { _id: Types.ObjectId };
export type CallFlowDoc = InferSchemaType<typeof callFlowSchema> & { _id: Types.ObjectId };
export type CallDoc = InferSchemaType<typeof callSchema> & { _id: Types.ObjectId };
export type SmsDoc = InferSchemaType<typeof smsSchema> & { _id: Types.ObjectId };
export type MeetingDoc = InferSchemaType<typeof meetingSchema> & { _id: Types.ObjectId };

export type Purpose = (typeof PURPOSES)[number];
export type Outcome = (typeof OUTCOMES)[number];
export type Attendance = (typeof ATTENDANCE)[number];
export type PickupStatus = (typeof PICKUP)[number];

export const Classrooms = mongoose.model("Classroom", classroomSchema);
export const Guardians = mongoose.model("Guardian", guardianSchema);
export const Students = mongoose.model("Student", studentSchema);
export const DayRecords = mongoose.model("DayRecord", dayRecordSchema);
export const CallFlows = mongoose.model("CallFlow", callFlowSchema);
export const Calls = mongoose.model("Call", callSchema);
export const SmsMessages = mongoose.model("SmsMessage", smsSchema);
export const Meetings = mongoose.model("Meeting", meetingSchema);
