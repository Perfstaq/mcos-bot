import { segmentHandle } from "../../src/domain/chunking.js";

/**
 * Deterministic replacements for `integrations/openai.ts#extractFromChunk`.
 *
 * The real function calls the model and returns
 * `{ claims: ProposedClaim[], inputTokens, outputTokens }` — see
 * jobs/extract.ts and integrations/openai.ts for the exact contract this
 * mirrors. Nothing here talks to a network; every claim is computed from the
 * chunk's own segments, so `jobs/extract.ts`'s evidence gate (unknown segment
 * ids get dropped, quotes that were never said get dropped) still runs for
 * real against these outputs. A rule that cites text the segment does not
 * contain will be rejected by the pipeline exactly like a bad real model
 * output would — this module does not special-case tests to make that gate a
 * no-op.
 *
 * Use it the same way pipeline.test.ts wires the real integration:
 *
 * ```ts
 * vi.mock("../src/integrations/openai.js", async () => {
 *   const { segmentHandle } = await import("../src/domain/chunking.js");
 *   const { createExtractFromChunkMock } = await import("./helpers/llm-mock.js");
 *   return {
 *     PROMPT_VERSION: "propose_claims/v2-openai",
 *     segmentHandle,
 *     extractFromChunk: createExtractFromChunkMock([
 *       { when: "our sweet spot is two hundred to two thousand seats", claims: [{
 *         type: "icp_fact",
 *         text: "ICP sweet spot is 200-2,000 seats.",
 *         quote: "our sweet spot is two hundred to two thousand seats",
 *       }] },
 *     ]),
 *   };
 * });
 * ```
 */

export type MockChunkSegment = { idx: number; speaker: string; startMs: number; text: string };
export type MockChunk = { index: number; segments: MockChunkSegment[]; overlapCount: number };
export type MockExtractArgs = { chunk: MockChunk; meetingTitle?: string | null };

/** One claim a rule proposes when it matches. `quote` must be a real
 *  substring of the triggering segment's text (loose whitespace/case/accent
 *  matching is fine — see `quoteAppearsIn` in domain/claims.ts) or the
 *  pipeline's evidence gate will drop it, same as it would for a live model. */
export type CannedClaim = {
  type: string;
  text: string;
  confidence?: number;
  quote: string;
  speaker?: string;
  timestampMs?: number;
};

export type ExtractRule = {
  /** A rule fires once per segment in a chunk whose `text` includes this substring. */
  when: string;
  claims: CannedClaim[];
};

export type MockExtraction = {
  claims: Array<{
    type: string;
    text: string;
    confidence: number;
    evidence: {
      transcript_segment_ids: string[];
      verbatim_quote: string;
      speaker: string;
      timestamp_ms: number;
    };
  }>;
  inputTokens: number;
  outputTokens: number;
};

/**
 * General-purpose rule-based mock: fires `claims` whenever a chunk segment's
 * text contains `when`. Good for hand-written scenarios (see
 * pipeline.test.ts for the pattern this generalises).
 */
export function createExtractFromChunkMock(
  rules: ExtractRule[],
  tokenCost: { inputTokens?: number; outputTokens?: number } = {},
): (args: MockExtractArgs) => Promise<MockExtraction> {
  return async ({ chunk }) => {
    const claims: MockExtraction["claims"] = [];
    for (const segment of chunk.segments) {
      for (const rule of rules) {
        if (!segment.text.includes(rule.when)) continue;
        for (const c of rule.claims) {
          claims.push({
            type: c.type,
            text: c.text,
            confidence: c.confidence ?? 0.9,
            evidence: {
              transcript_segment_ids: [segmentHandle(segment.idx)],
              verbatim_quote: c.quote,
              speaker: c.speaker ?? segment.speaker,
              timestamp_ms: c.timestampMs ?? segment.startMs,
            },
          });
        }
      }
    }
    return {
      claims,
      inputTokens: tokenCost.inputTokens ?? 1_000,
      outputTokens: tokenCost.outputTokens ?? claims.length * 60 + 120,
    };
  };
}

/** An extractor that always proposes nothing — useful for exercising the
 *  "extraction ran, found nothing" path without a real model call. */
export function emptyExtractFromChunk(): Promise<MockExtraction> {
  return Promise.resolve({ claims: [], inputTokens: 200, outputTokens: 8 });
}

export type AnswerKeyEntry = {
  type: string | null;
  text_gist: string;
  evidence_segment_ids: string[];
  must_extract: boolean;
};

/**
 * Turnkey mock wired straight to one of the golden answer keys
 * (tests/fixtures/transcripts/golden-answer-key.json or
 * golden-discovery-answer-key.json).
 *
 * Every `must_extract: true` entry becomes a proposed claim citing exactly
 * the segment handles the answer key names, with `text` set to the entry's
 * `text_gist` (written to read as a standalone assertion already) and
 * `verbatim_quote` set to the cited segment's own full text — which trivially
 * satisfies `quoteAppearsIn`, so the real evidence gate in jobs/extract.ts
 * still runs and still passes. `must_extract: false` (noise) entries are
 * never emitted, matching what a correctly-behaving model should do.
 *
 * This lets downstream extraction/review/brief tests run the REAL
 * `runExtraction` job against a golden meeting (seeded via
 * `seedGoldenMeetings` in src/seed-golden.ts) and get exactly the claims the
 * answer key documents, with no live model call.
 */
export function createExtractFromChunkMockFromAnswerKey(
  answerKey: AnswerKeyEntry[],
  tokenCost: { inputTokens?: number; outputTokens?: number } = {},
): (args: MockExtractArgs) => Promise<MockExtraction> {
  const bySegmentHandle = new Map<string, AnswerKeyEntry[]>();
  for (const entry of answerKey) {
    if (!entry.must_extract || !entry.type) continue;
    for (const handle of entry.evidence_segment_ids) {
      const existing = bySegmentHandle.get(handle);
      if (existing) existing.push(entry);
      else bySegmentHandle.set(handle, [entry]);
    }
  }

  return async ({ chunk }) => {
    const claims: MockExtraction["claims"] = [];
    for (const segment of chunk.segments) {
      const handle = segmentHandle(segment.idx);
      const hits = bySegmentHandle.get(handle);
      if (!hits) continue;
      for (const hit of hits) {
        claims.push({
          type: hit.type as string,
          text: hit.text_gist,
          confidence: 0.9,
          evidence: {
            // Cite every handle the answer key names for this entry, not just
            // the one that triggered this iteration — an entry with several
            // evidence_segment_ids must not be under-linked to only its first
            // matching segment.
            transcript_segment_ids: hit.evidence_segment_ids,
            verbatim_quote: segment.text,
            speaker: segment.speaker,
            timestamp_ms: segment.startMs,
          },
        });
      }
    }
    return {
      claims,
      inputTokens: tokenCost.inputTokens ?? 1_000,
      outputTokens: tokenCost.outputTokens ?? claims.length * 60 + 120,
    };
  };
}
