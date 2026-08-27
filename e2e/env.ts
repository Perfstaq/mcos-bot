/**
 * Environment for the self-contained e2e stack.
 *
 * Same Postgres and Redis SERVERS the dev stack uses by default
 * (localhost:5433 / :6380 — see docker-compose.yml), because those
 * containers are already running for the person developing this repo and
 * this suite must never ask them to stand up a second pair. But a DIFFERENT
 * database name (`mcos_e2e`, not `mcos`) and a DIFFERENT Redis logical
 * database (14, not the dev default 0 or the unit suite's 15), so this stack
 * can never collide with `npm run dev`, a running worker, or
 * `VITEST_DB_SUFFIX=e npm test`. The API's own port (8790) is also this
 * stack's own — never the dev port 8787.
 *
 * CI has no docker-compose stack — its Postgres/Redis service containers
 * publish on whatever ports the workflow gives them (see
 * .github/workflows/ci.yml), so the host and ports are overridable via
 * E2E_PG_HOST/E2E_PG_PORT/E2E_REDIS_HOST/E2E_REDIS_PORT. Local development
 * needs to set none of them.
 *
 * There is no separate "web" port: `apps/api/src/server.ts` serves the built
 * SPA from the same origin as the API whenever `apps/web/dist/index.html`
 * exists (exactly how it behaves in production), so the e2e ring runs the
 * built app on one origin rather than adding a second dev-server process and
 * a proxy in front of it. See global-setup.ts.
 */
export const E2E_DB_NAME = "mcos_e2e";
export const E2E_REDIS_DB = 14;
export const E2E_API_PORT = 8790;
export const E2E_BASE_URL = `http://localhost:${E2E_API_PORT}`;

const PG_HOST = process.env.E2E_PG_HOST ?? "localhost";
const PG_PORT = process.env.E2E_PG_PORT ?? "5433";
const REDIS_HOST = process.env.E2E_REDIS_HOST ?? "localhost";
const REDIS_PORT = process.env.E2E_REDIS_PORT ?? "6380";

export function e2eDatabaseUrl(): string {
  return `postgresql://mcos:mcos@${PG_HOST}:${PG_PORT}/${E2E_DB_NAME}?schema=public`;
}

export function e2eAdminDatabaseUrl(): string {
  return `postgresql://mcos:mcos@${PG_HOST}:${PG_PORT}/postgres?schema=public`;
}

export function e2eRedisUrl(): string {
  return `redis://${REDIS_HOST}:${REDIS_PORT}/${E2E_REDIS_DB}`;
}

export const E2E_TENANT_SLUG = "freshworks-demo";
export const E2E_REVIEWER_EMAIL = "demo@freshworks.example";
export const E2E_PASSWORD = "e2e-demo-password-not-a-secret";

/**
 * Sets every variable `apps/api/src/env.ts` requires, to e2e-safe values.
 * Idempotent and side-effect-free beyond `process.env` — safe to call from
 * more than one entry point (global-setup.ts, a vitest setupFile, or a
 * subprocess spawned by either) without coordination.
 *
 * `AUTH_DEV_HEADERS` stays false: unlike the unit suite, this ring signs in
 * through the real Better Auth flow, in the real browser, the way a person
 * would — that is the point of an *end-to-end* test.
 */
export function applyE2eEnv(): void {
  process.env.NODE_ENV = "development";
  process.env.DATABASE_URL = e2eDatabaseUrl();
  process.env.REDIS_URL = e2eRedisUrl();
  process.env.PORT = String(E2E_API_PORT);
  process.env.HOST = "127.0.0.1";
  process.env.LOG_LEVEL = process.env.E2E_LOG_LEVEL ?? "warn";
  process.env.APP_BASE_URL = E2E_BASE_URL;
  process.env.ALLOWED_ORIGINS = E2E_BASE_URL;
  process.env.WEB_ORIGIN = E2E_BASE_URL;

  process.env.RECALL_REGION = "us-east-1";
  process.env.RECALLAI_API_KEY = "e2e-fake-recall-key";
  process.env.RECALL_WEBHOOK_SECRET = "whsec_ZTJlLXRlc3Qtd2ViaG9vay1zZWNyZXQ=";
  process.env.RECALL_SVIX_WEBHOOK_SECRET = "";
  process.env.RECALL_CAPTURE_VIDEO = "false";
  process.env.RECALL_JOIN_MESSAGE = "";

  process.env.CF_ACCOUNT_ID = "e2e-account";
  process.env.R2_ACCESS_KEY_ID = "e2e-key";
  process.env.R2_SECRET_ACCESS_KEY = "e2e-secret";
  process.env.R2_BUCKET = "mcos-e2e";

  // Never actually called: the running server and this ring never enqueue a
  // real extraction or digest job (see global-setup.ts) — both golden
  // meetings are extracted directly, in-process, against the deterministic
  // answer-key mock, the same way tests/brief.test.ts does it.
  process.env.OPENAI_API_KEY = "e2e-fake-openai-key";
  process.env.OPENAI_MODEL = "gpt-5.6-terra";
  process.env.OPENAI_REASONING_EFFORT = "low";
  process.env.DIGEST_MODEL = "gpt-5.6-luna";

  process.env.AUTH_DEV_HEADERS = "false";
  process.env.BETTER_AUTH_SECRET = "e2e-secret-at-least-thirty-two-characters-long";
  process.env.DEFAULT_TENANT_SLUG = E2E_TENANT_SLUG;
  process.env.DEFAULT_REVIEWER_EMAIL = E2E_REVIEWER_EMAIL;
  process.env.SEED_PASSWORD = E2E_PASSWORD;

  // A keyboard-driven review of two dozen claims is a lot of requests in a
  // short window; the dev-tuned default is not what this suite is testing.
  process.env.RATE_LIMIT_MAX = "100000";
  process.env.TRUST_PROXY = "false";
}
