import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { ApolloServer } from "@apollo/server";
import { ApolloServerPluginDrainHttpServer } from "@apollo/server/plugin/drainHttpServer";
import { buildSubgraphSchema } from "@apollo/subgraph";
import { expressMiddleware } from "@as-integrations/express5";
import express from "express";
import { env, manifest } from "./config.ts";
import { type Context, createContext } from "./context.ts";
import { connectDb, disconnectDb } from "./db.ts";
import { joinErxesGateway } from "./gateway.ts";
import { resolvers, typeDefs } from "./graphql/schema.ts";
import { createRestRouter } from "./routes.ts";
import { seedDemo } from "./seed.ts";
import { startScheduler, stopScheduler } from "./services/scheduler.ts";
import { DATA_DIR } from "./services/speech.ts";
import { callStatus } from "./services/twilio.ts";
import { createTwilioRouter } from "./twilio-routes.ts";

const WEB_DIR = fileURLToPath(new URL("../../web/", import.meta.url));

const db = await connectDb({ memory: env.MONGO_MEMORY || process.argv.includes("--memory") });
console.log(`MongoDB: ${db.memory ? "in-memory (data is lost on exit)" : db.url}`);

// A fresh database gets the demo class so the console is never empty.
const seeded = await seedDemo({ reset: false });
if (seeded.seeded) console.log("Seeded the demo class (2б)");

const app = express();
app.disable("x-powered-by");

// The public tunnel (PUBLIC_URL) exists for Twilio only: through it, serve the
// webhooks and the synthesized audio Twilio plays — never the teacher console,
// the API or recorded replies.
const publicHost = env.PUBLIC_URL ? new URL(env.PUBLIC_URL).hostname : undefined;
app.use((req, res, next) => {
  const viaTunnel = Boolean(req.headers["cf-connecting-ip"]) || (publicHost !== undefined && req.hostname === publicHost);
  if (!viaTunnel || req.path.startsWith("/twilio/") || req.path.startsWith("/media/audio/")) {
    next();
    return;
  }
  res.status(404).end();
});

const httpServer = createServer(app);

const apollo = new ApolloServer<Context>({
  schema: buildSubgraphSchema([{ typeDefs, resolvers }]),
  plugins: [ApolloServerPluginDrainHttpServer({ httpServer })],
});
await apollo.start();

app.get(manifest.api.health, (_req, res) => {
  res.json({ ok: true });
});

app.use(
  manifest.api.graphql,
  express.json({ limit: "15mb" }),
  expressMiddleware(apollo, { context: async ({ req }) => createContext(req.headers) }),
);

// Standalone web console (teacher) and phone simulator (guardian).
app.use("/api", createRestRouter());
app.use("/twilio", createTwilioRouter());
app.use("/media", express.static(DATA_DIR, { fallthrough: false }));
app.use(express.static(WEB_DIR));

await new Promise<void>((resolve) => httpServer.listen(env.PORT, resolve));
console.log(`${manifest.name} console:   http://localhost:${env.PORT}/`);
console.log(`${manifest.name} phone:     http://localhost:${env.PORT}/phone.html`);
console.log(`${manifest.name} GraphQL:   http://localhost:${env.PORT}${manifest.api.graphql}`);

startScheduler();

const calls = callStatus();
console.log(
  calls.provider === "twilio"
    ? `calls: Twilio from ${calls.from}, webhooks at ${env.PUBLIC_URL}/twilio`
    : `calls: phone simulator${calls.problems.length ? ` (Twilio: ${calls.problems.join("; ")})` : ""}`,
);

if (env.ERXES_ENABLED) {
  try {
    const address = await joinErxesGateway();
    console.log(`${manifest.name} joined the erxes gateway as ${address}`);
  } catch (error) {
    console.error("Could not join the erxes gateway (is Redis running?):", (error as Error).message);
  }
} else {
  console.log("erxes: standalone mode (set ERXES_ENABLED=true to join the gateway)");
}

const shutdown = async () => {
  stopScheduler();
  await apollo.stop();
  await disconnectDb();
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
