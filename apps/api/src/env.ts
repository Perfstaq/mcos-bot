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
  RECALL_SVIX_WEBHOOK_SECRET: z.string().optional(),
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

  DEFAULT_TENANT_SLUG: z.string().default("freshworks-demo"),
  DEFAULT_REVIEWER_EMAIL: z.string().default("demo@freshworks.example"),
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

export const allowedOrigins = env.ALLOWED_ORIGINS.split(",")
  .map((s) => s.trim())
  .filter(Boolean);
