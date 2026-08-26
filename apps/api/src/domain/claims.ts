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

/**
 * The floor is for transcription drift, not paraphrase. 0.85 admits a dropped
 * filler word, a "the" heard as "a", punctuation the model tidied away — and
 * nothing that changes what was said. Raising it rejects real quotes off noisy
 * transcripts; lowering it starts admitting rewrites. Neither is free.
 */
export const QUOTE_SIMILARITY_FLOOR = 0.85;

/**
 * Minimum single-character edits turning `needle` into SOME substring of
 * `haystack` — semi-global alignment, so unmatched haystack before and after
 * the quote is free. Character-level on purpose: a bag-of-words overlap check
 * cannot tell "we position as the layer that keeps cost flat" from the same
 * words in a different order, and word order is exactly what makes a quote a
 * quote.
 */
function approximateSubstringDistance(needle: string, haystack: string): number {
  const n = needle.length;
  const m = haystack.length;
  if (n === 0) return 0;
  if (m === 0) return n;

  let prev: number[] = new Array(m + 1).fill(0); // row 0: a match may start anywhere
  let curr: number[] = new Array(m + 1).fill(0);

  for (let i = 1; i <= n; i++) {
    curr[0] = i;
    const nc = needle.charCodeAt(i - 1);
    for (let j = 1; j <= m; j++) {
      const cost = nc === haystack.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }

  let best = n;
  for (let j = 0; j <= m; j++) if (prev[j]! < best) best = prev[j]!; // a match may end anywhere
  return best;
}

/** 1 = verbatim (after normalisation), 0 = nothing in common. */
export function quoteSimilarity(quote: string, segmentTexts: string[]): number {
  const needle = normalizeClaimText(quote);
  if (needle.length === 0) return 0;
  const haystack = normalizeClaimText(segmentTexts.join(" "));
  if (haystack.includes(needle)) return 1;
  return Math.max(0, 1 - approximateSubstringDistance(needle, haystack) / needle.length);
}

/** The evidence gate's quote check: fuzzy containment, floored at 0.85. */
export function quoteAppearsIn(quote: string, segmentTexts: string[]): boolean {
  const needle = normalizeClaimText(quote);
  if (needle.length < 8) return false;
  return quoteSimilarity(quote, segmentTexts) >= QUOTE_SIMILARITY_FLOOR;
}
