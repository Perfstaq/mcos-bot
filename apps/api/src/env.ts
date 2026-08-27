import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";

// One .env at the repo root feeds docker-compose, the API and the workers.
// Real environments inject variables directly; the file is a local convenience
// and never overrides what is already set.
const here = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.resolve(here, "../../../.env") });
loadDotenv();

/**
 * Config comes from the environment, only. Validated once at boot so a missing
 * secret is a startup failure with a named field, not a 500 three hours later
 * when the first webhook lands.
 */
/**
 * An unset variable and a variable set to "" mean the same thing here: absent.
 * Without this, `FOO=` in a .env file satisfies `.optional()` as an empty
 * string — so a blank OAuth client id reads as "configured" and the provider
 * registers with empty credentials.
 */
const optional = <T extends z.ZodTypeAny>(inner: T) =>
  z.preprocess((v) => (v === "" ? undefined : v), inner.optional());

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  ALLOWED_ORIGINS: z.string().default("http://localhost:5173"),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),

  APP_BASE_URL: z.string().url(),

  RECALL_REGION: z.enum(["us-east-1", "us-west-2", "eu-central-1", "ap-northeast-1"]),
  RECALLAI_API_KEY: z.string().min(1),
  RECALL_WEBHOOK_SECRET: z.string().min(1),
  RECALL_SVIX_WEBHOOK_SECRET: optional(z.string()),
  RECALL_BOT_NAME: z.string().default("Perfstaq Notetaker"),
  RECALL_JOIN_MESSAGE: z.string().default(""),
  RECALL_CAPTURE_VIDEO: z
    .string()
    .default("false")
    .transform((v) => v === "true"),

  CF_ACCOUNT_ID: z.string().min(1),
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
  R2_BUCKET: z.string().min(1),

  OPENAI_API_KEY: z.string().min(1),
  // gpt-5.6 ships as three tiers: sol (flagship), terra (balanced), luna
  // (fast/cheap). Extraction is judgement-heavy but mechanical, so terra is the
  // default; sol is the lever to pull if recall on messy transcripts is poor.
  OPENAI_MODEL: z.string().default("gpt-5.6-terra"),
  OPENAI_REASONING_EFFORT: z.enum(["minimal", "low", "medium", "high"]).default("low"),
  // The one-line title + 3-sentence digest generated at transcript_ready is a
  // convenience, not an analysis — it never needs the extraction tier's
  // judgement, so it defaults to the cheapest one. Still its own knob, and
  // still OpenAI: this milestone does not switch providers.
  DIGEST_MODEL: z.string().default("gpt-5.6-luna"),

  // --- Authentication ------------------------------------------------------
  // Better Auth requires >=32 chars. Rotating it invalidates every session and
  // every pending verification token, which is the point.
  BETTER_AUTH_SECRET: z.string().min(32, "must be at least 32 characters"),
  // Where the auth handler is reachable. Defaults to APP_BASE_URL below.
  BETTER_AUTH_URL: optional(z.string().url()),
  // The SPA origin users are returned to after an OAuth round-trip.
  WEB_ORIGIN: z.string().url().default("http://localhost:5173"),

  // Social providers are optional: unset means the button is not rendered and
  // the provider is not registered, rather than a half-configured 500.
  GOOGLE_CLIENT_ID: optional(z.string()),
  GOOGLE_CLIENT_SECRET: optional(z.string()),
  MICROSOFT_CLIENT_ID: optional(z.string()),
  MICROSOFT_CLIENT_SECRET: optional(z.string()),
  MICROSOFT_TENANT_ID: z.string().default("common"),

  // --- Ops -----------------------------------------------------------------
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_WINDOW: z.string().default("1 minute"),
  TRUST_PROXY: z.string().default("true").transform((v) => v === "true"),

  /// Accept X-Tenant-Slug / X-Reviewer-Email instead of a session. For the
  /// demo seed and the pipeline tests only — refused in production regardless.
  AUTH_DEV_HEADERS: z
    .string()
    .default("false")
    .transform((v) => v === "true"),

  DEFAULT_TENANT_SLUG: z.string().default("freshworks-demo"),
  DEFAULT_REVIEWER_EMAIL: z.string().default("demo@freshworks.example"),

  // --- Content Studio media sidecar (additive) ------------------------------
  // Unset in dev: jobs/media-analyze.ts and scripts/qc-render.ts fall back to
  // the repo-relative services/analyzer/.venv. Dockerfile.media sets both to
  // the baked-in venv (ARCHITECTURE.md §5/ADR-3).
  ANALYZER_PYTHON: optional(z.string()),
  ANALYZER_SCRIPT: optional(z.string()),
  // Compiled scripts/qc-render.ts (tsc -p scripts/tsconfig.build.json — run
  // with `node`, never `tsx`; tsx is stripped from the production image by
  // `npm prune --omit=dev`, see Dockerfile.media/render-qc.ts). Unset in
  // dev: jobs/render-qc.ts falls back to the repo-relative scripts/dist.
  QC_RENDER_SCRIPT: optional(z.string()),
  // faster-whisper model size for the `words` stage — in an env var, not
  // hardcoded (CLAUDE.md convention, same as OPENAI_MODEL above), because
  // MediaAnalysis.analyzerVersion's calibration provenance depends on
  // knowing exactly which model produced a given row's word timings.
  WHISPER_MODEL_SIZE: z.string().default("base"),
});

export type Env = z.infer<typeof schema>;

function load(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const missing = parsed.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    // eslint-disable-next-line no-console
    console.error(`Invalid environment. See .env.example.\n${missing}`);
    process.exit(1);
  }
  return parsed.data;
}

export const env = load();

export const recallBaseUrl = `https://${env.RECALL_REGION}.recall.ai/api/v1`;

export const allowedOrigins = [
  ...env.ALLOWED_ORIGINS.split(",").map((s) => s.trim()),
  env.WEB_ORIGIN,
].filter((v, i, all) => Boolean(v) && all.indexOf(v) === i);

export const authBaseUrl = env.BETTER_AUTH_URL ?? env.APP_BASE_URL;

/**
 * A provider counts as configured only when both halves are present AND neither
 * is a placeholder.
 *
 * The emptiness check alone was not enough. Secrets Manager entries are created
 * ahead of their values and hold a literal "REPLACE_ME", which is perfectly
 * non-empty — so the deployment advertised Google as available, rendered the
 * button, and sent Google a nonsense client id. The user got
 * "Error 401: invalid_client" from Google itself, which points at their OAuth
 * setup rather than at our unset secret.
 */
const PLACEHOLDER = /^(replace[-_ ]?me|changeme|todo|placeholder|dev-placeholder|xxx+|<.*>)/i;

const configured = (...parts: (string | undefined)[]): boolean =>
  parts.every((v) => Boolean(v) && !PLACEHOLDER.test(v!.trim()));

export const googleConfigured = configured(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET);
export const microsoftConfigured = configured(env.MICROSOFT_CLIENT_ID, env.MICROSOFT_CLIENT_SECRET);
