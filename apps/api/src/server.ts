import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { fromNodeHeaders } from "better-auth/node";
import { auth } from "./auth.js";
import { allowedOrigins, authBaseUrl, env } from "./env.js";
import { registerCore } from "./http.js";
import { meetingRoutes } from "./routes/meetings.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { reviewRoutes } from "./routes/review.js";
import { briefRoutes } from "./routes/brief.js";
import { disconnect, rawPrisma } from "./db.js";
import { closeQueues, newRedis } from "./queue.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export async function buildServer() {
  const app = Fastify({
    logger: { level: env.LOG_LEVEL },
    // Recall's presigned URLs and payloads are small, but transcripts posted
    // through the replay fixtures are not.
    bodyLimit: 8 * 1024 * 1024,
    trustProxy: true,
  });

  // In production the API serves the built SPA, so the whole product is one
  // origin and one container. In dev the frontend runs on Vite and proxies here.
  const webDist = path.resolve(here, "../../web/dist");
  const serveSpa = fs.existsSync(path.join(webDist, "index.html"));

  await app.register(helmet, {
    // The SPA is same-origin in production; CSP is set on the static handler
    // below rather than here so the API's JSON responses are not affected.
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  });

  await app.register(cors, {
    origin: allowedOrigins,
    credentials: true,
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["content-type", "authorization", "x-tenant-slug", "x-reviewer-email"],
    maxAge: 86_400,
  });

  await app.register(rateLimit, {
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW,
    // Recall retries non-2xx, so rate limiting the webhook endpoint would turn
    // one burst into an escalating retry storm. It is signature-gated already.
    allowList: (request) => request.url.startsWith("/api/v1/webhooks/"),
    keyGenerator: (request) => request.actor?.userId ?? request.ip,
  });

  registerCore(app, { spa: serveSpa });

  // Better Auth owns everything under /api/auth. Mounted before the versioned
  // API because it is not versioned — session cookies outlive an API major.
  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    async handler(request, reply) {
      const url = new URL(request.url, `${authBaseUrl}`);
      const req = new Request(url.toString(), {
        method: request.method,
        headers: fromNodeHeaders(request.headers),
        ...(request.body ? { body: JSON.stringify(request.body) } : {}),
      });
      const response = await auth.handler(req);
      reply.status(response.status);
      response.headers.forEach((value, key) => reply.header(key, value));
      return reply.send(response.body ? await response.text() : null);
    },
  });

  app.get("/healthz", async () => {
    const redis = newRedis();
    try {
      const [, pong] = await Promise.all([rawPrisma.$queryRaw`SELECT 1`, redis.ping()]);
      return { ok: true, db: true, redis: pong === "PONG" };
    } finally {
      redis.disconnect();
    }
  });

  await app.register(
    async (api) => {
      await api.register(meetingRoutes);
      await api.register(webhookRoutes);
      await api.register(reviewRoutes);
      await api.register(briefRoutes);
    },
    { prefix: "/api/v1" },
  );

  if (serveSpa) {
    // wildcard: false leaves unmatched paths to the not-found handler above,
    // which is what turns them into client-side routes.
    await app.register(fastifyStatic, { root: webDist, prefix: "/", wildcard: false });
  }

  return app;
}

const isEntrypoint = process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`;

if (isEntrypoint) {
  const app = await buildServer();

  const close = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    await closeQueues();
    await disconnect();
    process.exit(0);
  };
  process.on("SIGTERM", () => void close("SIGTERM"));
  process.on("SIGINT", () => void close("SIGINT"));

  await app.listen({ port: env.PORT, host: env.HOST });
  app.log.info(
    {
      recallRegion: env.RECALL_REGION,
      model: env.OPENAI_MODEL,
      webhookUrl: `${env.APP_BASE_URL}/api/v1/webhooks/recall`,
    },
    "MCOS API listening",
  );
}
