import { ClaimType } from "@prisma/client";
import {
  claimTextSimilarity,
  dedupeNearIdenticalClaims,
  gateClaimEvidence,
  isClaimType,
} from "../../src/domain/claims.js";
import { chunkBySpeakerTurns, segmentHandle, type Chunk } from "../../src/domain/chunking.js";

/**
 * DB-free extraction pipeline + scorer for the golden-transcript eval.
 *
 * The pipeline half runs the same domain machinery as jobs/extract.ts — same
 * chunking, the same `gateClaimEvidence` gate, the same near-identical dedupe
 * — against in-memory segments, with the model call injected. Nothing here
 * touches Postgres, Redis, or src/db.ts; a live dev stack on the machine is
 * never written to by an eval run.
 *
 * The scorer half compares what came out against an answer key and reports
 * the four numbers §5B is accepted on: recall of must_extract entries, false
 * positives against noise, type accuracy, and evidence accuracy.
 */

export type EvalSegment = { idx: number; speaker: string; startMs: number; text: string };

export type RawExtractedClaim = {
  type: string;
  text: string;
  confidence: number;
  evidence: {
    transcript_segment_ids: string[];
    verbatim_quote: string;
    speaker: string;
    timestamp_ms: number;
  };
};

export type ExtractFn = (args: {
  chunk: Chunk;
  meetingTitle: string | null;
}) => Promise<{ claims: RawExtractedClaim[]; inputTokens: number; outputTokens: number }>;

export type PredictedClaim = {
  type: ClaimType;
  text: string;
  confidence: number;
  segmentIds: string[];
  quote: string;
};

export type PipelineResult = {
  predicted: PredictedClaim[];
  chunkCount: number;
  proposed: number;
  dropped: number;
  duplicates: number;
  inputTokens: number;
  outputTokens: number;
};

export async function runDbFreeExtraction(args: {
  segments: EvalSegment[];
  extract: ExtractFn;
  meetingTitle?: string;
}): Promise<PipelineResult> {
  const chunks = chunkBySpeakerTurns(
    args.segments.map((s) => ({ id: segmentHandle(s.idx), ...s })),
  );
  const byHandle = new Map(args.segments.map((s) => [segmentHandle(s.idx), s]));

  let proposed = 0;
  let dropped = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  const gated: PredictedClaim[] = [];

  for (const chunk of chunks) {
    const result = await args.extract({ chunk, meetingTitle: args.meetingTitle ?? null });
    inputTokens += result.inputTokens;
    outputTokens += result.outputTokens;
    proposed += result.claims.length;

    for (const claim of result.claims) {
      if (!isClaimType(claim.type)) {
        dropped += 1;
        continue;
      }
      const resolved = gateClaimEvidence(claim, byHandle);
      if (!resolved) {
        dropped += 1;
        continue;
      }
      gated.push({
        type: claim.type,
        text: claim.text,
        confidence: claim.confidence,
        segmentIds: claim.evidence.transcript_segment_ids
          .map((h) => h.trim())
          .filter((h) => byHandle.has(h)),
        quote: claim.evidence.verbatim_quote,
      });
    }
  }

  const { kept, duplicates } = dedupeNearIdenticalClaims(gated);
  return {
    predicted: kept,
    chunkCount: chunks.length,
    proposed,
    dropped,
    duplicates,
    inputTokens,
    outputTokens,
  };
}

export type AnswerKeyEntry = {
  type: string | null;
  text_gist: string;
  evidence_segment_ids: string[];
  must_extract: boolean;
};

export type EvalScores = {
  /** must_extract entries matched by at least one predicted claim / all of them. */
  recall: number;
  /** Predicted claims that matched no entry and cite a noise segment. */
  falsePositives: number;
  /** Of matched pairs, how many predicted the entry's type. */
  typeAccuracy: number;
  /** Of matched pairs, how many cite a superset of the entry's evidence. */
  evidenceAccuracy: number;
  mustExtract: number;
  matched: number;
  predictedCount: number;
  /** Gists the model missed entirely — the prompt-iteration worklist. */
  missed: string[];
  /** The false positives themselves, for reading, not for scoring. */
  falsePositiveClaims: Array<{ type: string; text: string }>;
  /** Matched but with the wrong type: expected vs got, for iteration. */
  typeMisses: Array<{ gist: string; expected: string; got: string }>;
  /** Matched but citing less than the expected evidence. */
  evidenceMisses: Array<{ gist: string; expected: string[]; cited: string[] }>;
  /** Unmatched predictions that cite non-noise segments — not scored either way. */
  unscoredExtras: number;
};

/**
 * Match each must_extract entry to its best unused predicted claim, judged by
 * evidence overlap first (that is what makes it the SAME claim), then type
 * agreement, then text similarity to the gist as a tie-break. Greedy and
 * order-stable, so a score is reproducible run to run.
 */
export function scoreAgainstAnswerKey(
  predicted: PredictedClaim[],
  answerKey: AnswerKeyEntry[],
): EvalScores {
  const must = answerKey.filter((e) => e.must_extract);
  const noiseSegments = new Set(
    answerKey.filter((e) => !e.must_extract).flatMap((e) => e.evidence_segment_ids),
  );

  const used = new Set<number>();
  const pairs: Array<{ entry: AnswerKeyEntry; claim: PredictedClaim }> = [];
  const missed: string[] = [];

  for (const entry of must) {
    const expected = new Set(entry.evidence_segment_ids);
    let bestIdx = -1;
    let bestScore = 0;

    predicted.forEach((claim, idx) => {
      if (used.has(idx)) return;
      const overlap = claim.segmentIds.filter((id) => expected.has(id)).length;
      if (overlap === 0) return;
      const score =
        overlap +
        (claim.type === entry.type ? 0.5 : 0) +
        claimTextSimilarity(claim.text, entry.text_gist) * 0.25;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = idx;
      }
    });

    if (bestIdx === -1) {
      missed.push(entry.text_gist);
      continue;
    }
    used.add(bestIdx);
    pairs.push({ entry, claim: predicted[bestIdx]! });
  }

  const typeMisses = pairs
    .filter((p) => p.claim.type !== p.entry.type)
    .map((p) => ({ gist: p.entry.text_gist, expected: p.entry.type ?? "?", got: p.claim.type }));

  const evidenceMisses = pairs
    .filter((p) => !p.entry.evidence_segment_ids.every((id) => p.claim.segmentIds.includes(id)))
    .map((p) => ({
      gist: p.entry.text_gist,
      expected: p.entry.evidence_segment_ids,
      cited: p.claim.segmentIds,
    }));

  const falsePositiveClaims: Array<{ type: string; text: string }> = [];
  let unscoredExtras = 0;
  predicted.forEach((claim, idx) => {
    if (used.has(idx)) return;
    if (claim.segmentIds.some((id) => noiseSegments.has(id))) {
      falsePositiveClaims.push({ type: claim.type, text: claim.text });
    } else {
      unscoredExtras += 1;
    }
  });

  return {
    recall: must.length === 0 ? 1 : pairs.length / must.length,
    falsePositives: falsePositiveClaims.length,
    typeAccuracy: pairs.length === 0 ? 0 : (pairs.length - typeMisses.length) / pairs.length,
    evidenceAccuracy: pairs.length === 0 ? 0 : (pairs.length - evidenceMisses.length) / pairs.length,
    mustExtract: must.length,
    matched: pairs.length,
    predictedCount: predicted.length,
    missed,
    falsePositiveClaims,
    typeMisses,
    evidenceMisses,
    unscoredExtras,
  };
}
