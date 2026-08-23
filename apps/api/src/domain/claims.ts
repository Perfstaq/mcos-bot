import crypto from "node:crypto";
import { ClaimType } from "@prisma/client";

export const CLAIM_TYPES = [
  ClaimType.positioning_statement,
  ClaimType.icp_fact,
  ClaimType.pain_point,
  ClaimType.objection,
  ClaimType.messaging_decision,
  ClaimType.competitor_mention,
  ClaimType.proof_point,
] as const;

export const CLAIM_TYPE_LABEL: Record<ClaimType, string> = {
  positioning_statement: "Positioning statement",
  icp_fact: "ICP fact",
  pain_point: "Pain point",
  objection: "Objection",
  messaging_decision: "Messaging decision",
  competitor_mention: "Competitor mention",
  proof_point: "Proof point",
};

export function isClaimType(value: string): value is ClaimType {
  return (CLAIM_TYPES as readonly string[]).includes(value);
}

/**
 * Deduplication is deterministic, not a second model call.
 *
 * Chunk overlap means the same claim is genuinely proposed twice, phrased
 * near-identically. Normalising to lowercase alphanumerics and hashing with
 * the claim type collapses those without an LLM in the loop, and the unique
 * index on (tenant_id, dedupe_key) makes the collapse a database guarantee
 * rather than an application convention.
 *
 * This deliberately will NOT merge two claims that say the same thing in
 * different words. That is a judgement call, and judgement calls belong to the
 * reviewer, not to a hash.
 */
export function normalizeClaimText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function dedupeKey(type: ClaimType, text: string): string {
  const normalized = normalizeClaimText(text);
  return crypto.createHash("sha256").update(`${type}::${normalized}`).digest("hex").slice(0, 32);
}

/** Loose containment check used to validate a quote against its cited segments. */
export function quoteAppearsIn(quote: string, segmentTexts: string[]): boolean {
  const needle = normalizeClaimText(quote);
  if (needle.length < 8) return false;
  const haystack = normalizeClaimText(segmentTexts.join(" "));
  if (haystack.includes(needle)) return true;

  // Transcription is noisy and the model sometimes tidies a quote while
  // keeping its substance. Accept a high word-overlap match rather than
  // discarding an otherwise well-evidenced claim over a dropped filler word.
  const needleWords = needle.split(" ").filter((w) => w.length > 2);
  if (needleWords.length === 0) return false;
  const haystackWords = new Set(haystack.split(" "));
  const hits = needleWords.filter((w) => haystackWords.has(w)).length;
  return hits / needleWords.length >= 0.8;
}
