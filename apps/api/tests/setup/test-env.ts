/**
 * Test configuration, applied before any module (and therefore src/env.ts)
 * loads. dotenv never overrides an already-set variable, so these win over the
 * developer's .env.
 */
export function testDatabaseUrl(): string {
  const base =
    process.env.TEST_DATABASE_URL ??
    process.env.DATABASE_URL ??
    "postgresql://mcos:mcos@localhost:5433/mcos?schema=public";
  // Same server, separate database — tests truncate aggressively and must
  // never be pointed at a database someone is developing against.
  //
  // VITEST_DB_SUFFIX gives concurrent runs their own database. Without it two
  // `vitest` processes share mcos_test and truncate each other's fixtures
  // mid-assertion, which surfaces as deadlocks and foreign-key violations
  // scattered across unrelated suites — failures that look like real
  // regressions and are not.
  const suffix = process.env.VITEST_DB_SUFFIX ? `_${process.env.VITEST_DB_SUFFIX}` : "";
  return base.replace(/\/([^/?]+)(\?|$)/, `/mcos_test${suffix}$2`);
}

export function adminDatabaseUrl(): string {
  return testDatabaseUrl().replace(/\/([^/?]+)(\?|$)/, "/postgres$2");
}

/**
 * Tests get their own Redis logical database.
 *
 * Without this, a `npm run dev:worker` left running in another terminal
 * silently consumes the jobs the tests just enqueued — the suite then fails
 * with "expected 1 to be 0" on queue depth and no state transitions, which
 * looks like an application bug and is not one. Same Redis server, database 15.
 */
export function testRedisUrl(): string {
  const base = process.env.TEST_REDIS_URL ?? process.env.REDIS_URL ?? "redis://localhost:6380";
  const url = new URL(base);
  url.pathname = "/15";
  return url.toString();
}

export function applyTestEnv(): void {
  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = testDatabaseUrl();
  process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL ?? "silent";
  process.env.REDIS_URL = testRedisUrl();
  process.env.APP_BASE_URL = "https://mcos.test";
  process.env.RECALL_REGION = "us-east-1";
  process.env.RECALLAI_API_KEY = "test-recall-key";
  // "whsec_" + base64. The signing helper in tests/helpers.ts uses the same
  // value, so fixtures are verified by the production code path, not around it.
  process.env.RECALL_WEBHOOK_SECRET = "whsec_dGVzdC13ZWJob29rLXNlY3JldC12YWx1ZQ==";
  process.env.RECALL_SVIX_WEBHOOK_SECRET = "";
  process.env.RECALL_CAPTURE_VIDEO = "false";
  process.env.RECALL_JOIN_MESSAGE = "";
  process.env.CF_ACCOUNT_ID = "test-account";
  process.env.R2_ACCESS_KEY_ID = "test-key";
  process.env.R2_SECRET_ACCESS_KEY = "test-secret";
  process.env.R2_BUCKET = "mcos-test";
  process.env.OPENAI_API_KEY = "test-openai-key";
  process.env.OPENAI_MODEL = "gpt-5.6-terra";
  process.env.OPENAI_REASONING_EFFORT = "low";
  // The pipeline suite is about webhooks, artifacts and the review gate, not
  // about logging in. Header identity keeps those tests testing one thing.
  process.env.AUTH_DEV_HEADERS = "true";
  process.env.BETTER_AUTH_SECRET = "test-secret-at-least-thirty-two-characters-long";
  process.env.WEB_ORIGIN = "http://localhost:5173";
  process.env.DEFAULT_TENANT_SLUG = "freshworks-demo";
  process.env.DEFAULT_REVIEWER_EMAIL = "reviewer@test.example";
}

applyTestEnv();
