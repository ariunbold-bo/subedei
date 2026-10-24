import { readFileSync } from "node:fs";
import { z } from "zod";

// erxes.json sits at the repository root, two levels above both src/ and dist/.
const manifestSchema = z.object({
  name: z.string(),
  title: z.string(),
  version: z.string(),
  api: z.object({
    port: z.number().int(),
    graphql: z.string(),
    health: z.string(),
  }),
});

export const manifest = manifestSchema.parse(
  JSON.parse(readFileSync(new URL("../../erxes.json", import.meta.url), "utf8")),
);

const optional = z
  .string()
  .optional()
  .transform((value) => value || undefined);

// z.coerce.boolean() treats "false" as true, so flags are parsed explicitly.
const flag = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((value) =>
      value ? ["1", "true", "yes", "on"].includes(value.toLowerCase()) : fallback,
    );

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().default(manifest.api.port),
  REDIS_HOST: z.string().default("localhost"),
  REDIS_PORT: z.coerce.number().int().default(6379),
  REDIS_PASSWORD: optional,
  MONGO_URL: z.string().default("mongodb://127.0.0.1:27017/subedei"),
  // Start an in-memory MongoDB instead of MONGO_URL (demo without installing Mongo).
  MONGO_MEMORY: flag(false),
  // Synthesized audio cache and recorded replies (default: <repo>/data).
  DATA_DIR: optional,
  UI_ENTRY_URL: optional,
  LOAD_BALANCER_ADDRESS: optional,
  RELEASE_VERSION: optional,

  // erxes: join the gateway through Redis and sync guardians into core Contacts.
  ERXES_ENABLED: flag(false),
  ERXES_SUBDOMAIN: z.string().default("localhost"),
  // An active erxes user id; enables call/SMS notes on the customer timeline.
  ERXES_USER_ID: optional,

  SCHOOL_NAME: z.string().default("Жишээ сургууль"),
  TIMEZONE: z.string().default("Asia/Ulaanbaatar"),
  // Seconds a call may ring before it counts as unanswered.
  RING_TIMEOUT_SEC: z.coerce.number().int().positive().default(25),
  // Seconds after answering to wait for the guardian's reply.
  REPLY_TIMEOUT_SEC: z.coerce.number().int().positive().default(90),
  // Minutes after the class pickup time before late-pickup calls start.
  PICKUP_GRACE_MIN: z.coerce.number().int().nonnegative().default(10),
  AUTO_PICKUP_CALLS: flag(true),
  SCHEDULER_INTERVAL_MS: z.coerce.number().int().positive().default(5000),

  // Gemma 4 through any OpenAI-compatible endpoint (Ollama, DigitalOcean, vLLM…).
  LLM_ENABLED: flag(true),
  LLM_BASE_URL: z.string().default("http://localhost:11434/v1"),
  LLM_MODEL: z.string().default("gemma4"),
  LLM_API_KEY: optional,
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(20000),

  // Oyu speech (https://dev.oyu.so): tsuurAI TTS and Anir STT. Without a key
  // the phone page falls back to the browser's Web Speech API.
  OYU_API_KEY: optional,
  OYU_BASE_URL: z.string().default("https://api.oyu.so/v1"),
  // "female" or "mbspeech" (male).
  OYU_VOICE: z.string().default("female"),
  // Anir model, e.g. "v4"; unset = Oyu's default.
  OYU_STT_MODEL: optional,

  // Phone calls: "auto" = Twilio when fully configured, otherwise the browser
  // phone simulator. Twilio reaches this server through PUBLIC_URL (a tunnel).
  CALL_PROVIDER: z.enum(["auto", "simulator", "twilio"]).default("auto"),
  PUBLIC_URL: optional,
  TWILIO_ACCOUNT_SID: optional,
  // Either an API key (SK…) + secret, or the account auth token.
  TWILIO_API_KEY: optional,
  TWILIO_API_SECRET: optional,
  TWILIO_AUTH_TOKEN: optional,
  TWILIO_PHONE_NUMBER: optional,
  // Trial accounts: only To/Url/StatusCallback on the REST call, no <Record>;
  // guardians answer with the keypad (<Gather>). Set false after upgrading.
  TWILIO_TRIAL: flag(true),
  // e.g. "mn-MN": also accept spoken answers through <Gather input="speech">.
  TWILIO_SPEECH_LANGUAGE: optional,
  // Added to 8-digit local numbers when dialing (+976 = Mongolia).
  PHONE_COUNTRY_CODE: z.string().default("976"),

  // SMS gateway. Unset = simulator (messages appear on the phone page).
  SMS_HTTP_URL: optional,
  SMS_HTTP_TOKEN: optional,
  SMS_SENDER: optional,
  // Send Cyrillic text transliterated to Latin (cheaper, fits 160 chars).
  SMS_LATIN: flag(false),
});

export const env = envSchema.parse(process.env);

export const redisConnection = {
  host: env.REDIS_HOST,
  port: env.REDIS_PORT,
  password: env.REDIS_PASSWORD,
};
