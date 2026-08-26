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

/** The evidence gate's quote check: fuzzy containment, floored at 0.85. */
export function quoteAppearsIn(quote: string, segmentTexts: string[]): boolean {
  const needle = normalizeClaimText(quote);
  if (needle.length < 8) return false;
  const haystack = normalizeClaimText(segmentTexts.join(" "));

  // Edits close the length gap one character at a time, so the distance is at
  // least (needle − haystack). When that gap alone puts similarity under the
  // floor, the DP cannot possibly rescue the quote — skip it.
  if (1 - Math.max(0, needle.length - haystack.length) / needle.length < QUOTE_SIMILARITY_FLOOR) {
    return false;
  }
  if (haystack.includes(needle)) return true;

  const similarity = 1 - approximateSubstringDistance(needle, haystack) / needle.length;
  return similarity >= QUOTE_SIMILARITY_FLOOR;
}

/**
 * The whole evidence gate as one pure function, so the extraction job and the
 * eval harness run the SAME gate rather than two copies that drift. A claim
 * fails when it cites a handle that does not resolve, cites nothing after
 * unknown handles are removed, or quotes text that does not appear in the
 * segments it cites. Returns the resolved segments, or null for "drop".
 */
export function gateClaimEvidence<S extends { text: string }>(
  claim: { evidence: { transcript_segment_ids: string[]; verbatim_quote: string } },
  byHandle: ReadonlyMap<string, S>,
): S[] | null {
  const resolved = claim.evidence.transcript_segment_ids
    .map((handle) => byHandle.get(handle.trim()))
    .filter((s): s is S => Boolean(s));

  if (resolved.length === 0) return null;
  if (!quoteAppearsIn(claim.evidence.verbatim_quote, resolved.map((s) => s.text))) return null;

  return resolved;
}

/**
 * Two claims count as the same claim when their normalised texts are ≥0.9
 * similar. That collapses chunk-overlap re-proposals that drifted a word —
 * "pricing page" vs "pricing pages" — which the exact dedupe hash cannot.
 * It stays far above the point where two genuinely different observations
 * could collide; merging those is a judgement call and belongs to the
 * reviewer, not to a ratio.
 */
export const CLAIM_DEDUPE_SIMILARITY = 0.9;

function levenshtein(a: string, b: string): number {
  const n = a.length;
  const m = b.length;
  if (n === 0) return m;
  if (m === 0) return n;

  let prev: number[] = Array.from({ length: m + 1 }, (_, j) => j);
  let curr: number[] = new Array(m + 1).fill(0);

  for (let i = 1; i <= n; i++) {
    curr[0] = i;
    const ac = a.charCodeAt(i - 1);
    for (let j = 1; j <= m; j++) {
      const cost = ac === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[m]!;
}

function normalizedSimilarity(na: string, nb: string): number {
  if (na === nb) return na.length === 0 ? 0 : 1;
  const longest = Math.max(na.length, nb.length);
  if (longest === 0) return 0;
  return Math.max(0, 1 - levenshtein(na, nb) / longest);
}

/** Whole-text similarity of two claims after normalisation. 1 = identical. */
export function claimTextSimilarity(a: string, b: string): number {
  return normalizedSimilarity(normalizeClaimText(a), normalizeClaimText(b));
}

/**
 * Collapse near-identical claims within one extraction run, keeping the
 * highest-confidence copy of each. Order-stable: the survivor sits where the
 * first copy of its claim appeared. The exact-hash dedupe key and its unique
 * index remain the cross-run guarantee; this handles what a hash cannot —
 * the same claim re-proposed across a chunk seam with a word of drift.
 */
export function dedupeNearIdenticalClaims<
  T extends { type: ClaimType; text: string; confidence: number },
>(claims: T[], threshold: number = CLAIM_DEDUPE_SIMILARITY): { kept: T[]; duplicates: number } {
  const kept: T[] = [];
  const keptNorm: string[] = [];
  let duplicates = 0;

  outer: for (const claim of claims) {
    const norm = normalizeClaimText(claim.text);
    for (let i = 0; i < kept.length; i++) {
      const existing = kept[i]!;
      if (existing.type !== claim.type) continue;
      const other = keptNorm[i]!;
      const longest = Math.max(norm.length, other.length);
      // Distance is at least the length gap; when the gap alone breaks the
      // threshold, skip the O(n·m) comparison outright.
      if (longest === 0 || 1 - Math.abs(norm.length - other.length) / longest < threshold) continue;
      if (normalizedSimilarity(norm, other) < threshold) continue;
      duplicates += 1;
      if (claim.confidence > existing.confidence) {
        kept[i] = claim;
        keptNorm[i] = norm;
      }
      continue outer;
    }
    kept.push(claim);
    keptNorm.push(norm);
  }

  return { kept, duplicates };
}
