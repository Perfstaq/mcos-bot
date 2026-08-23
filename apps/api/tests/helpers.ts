import crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { testDatabaseUrl } from "./setup/test-env.js";

export const db = new PrismaClient({ datasourceUrl: testDatabaseUrl() });

const TABLES = [
  "brief_claims",
  "brief_versions",
  "review_decisions",
  "claim_segments",
  "candidate_claims",
  "extraction_runs",
  "transcript_segments",
  "transcripts",
  "evidence_sources",
  "artifacts",
  "state_transitions",
  "webhook_events",
  "meetings",
  "tenants",
];

export async function resetDb(): Promise<void> {
  await db.$executeRawUnsafe(`TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(", ")} CASCADE`);
}

export async function seedTenant(slug = "freshworks-demo") {
  return db.tenant.upsert({
    where: { slug },
    create: { slug, name: "Test tenant" },
    update: {},
  });
}

/**
 * Sign a payload exactly the way Recall does, so fixtures go through the real
 * verifier. A test that stubbed verification out would be testing nothing.
 */
export function signWebhook(args: {
  body: string;
  secret?: string;
  msgId?: string;
  timestamp?: number;
  headerStyle?: "standard" | "svix";
}): Record<string, string> {
  const secret = args.secret ?? process.env.RECALL_WEBHOOK_SECRET ?? "";
  const msgId = args.msgId ?? `msg_${crypto.randomUUID()}`;
  const timestamp = String(args.timestamp ?? Math.floor(Date.now() / 1000));

  const key = Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");
  const signature = crypto
    .createHmac("sha256", key)
    .update(`${msgId}.${timestamp}.${args.body}`)
    .digest("base64");

  const prefix = args.headerStyle === "svix" ? "svix" : "webhook";
  return {
    [`${prefix}-id`]: msgId,
    [`${prefix}-timestamp`]: timestamp,
    [`${prefix}-signature`]: `v1,${signature}`,
    "content-type": "application/json",
  };
}
