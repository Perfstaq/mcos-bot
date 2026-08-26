import { ClaimType } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { parseTranscript } from "../src/domain/transcript.js";
import type { RecallTranscriptEntry } from "../src/integrations/recall.js";
import { createExtractFromChunkMockFromAnswerKey } from "./helpers/llm-mock.js";
import {
  runDbFreeExtraction,
  scoreAgainstAnswerKey,
  type AnswerKeyEntry,
  type PredictedClaim,
} from "./eval/score.js";
import freshworksTranscript from "./fixtures/transcripts/golden-freshworks.json" with { type: "json" };
import freshworksAnswerKey from "./fixtures/transcripts/golden-answer-key.json" with { type: "json" };

/**
 * The scorer is only trustworthy if a model that behaves perfectly scores
 * perfectly — and if every metric moves when its failure mode appears. Both
 * halves are pinned here, DB-free, so `npm run eval:extraction -- --mock`
 * proves the harness before a live run spends a single token.
 */

const answerKey = freshworksAnswerKey as AnswerKeyEntry[];

describe("eval pipeline + scorer calibration (golden freshworks, mock model)", () => {
  it("scores a perfectly-behaving model at recall 1.0 with zero noise FPs", async () => {
    const parsed = parseTranscript(freshworksTranscript as unknown as RecallTranscriptEntry[]);
    const result = await runDbFreeExtraction({
      segments: parsed.segments,
      extract: createExtractFromChunkMockFromAnswerKey(answerKey),
      meetingTitle: "Freshworks positioning sync",
    });

    // Multi-segment answer-key entries make the mock propose the same claim
    // once per cited segment; the pipeline must collapse those to one kept
    // claim, not double-count them. (Duplicate collapse across the chunk-seam
    // overlap is pinned by the dedupeNearIdenticalClaims unit tests — on this
    // fixture the seam segments carry no answer-key evidence.)
    expect(result.duplicates).toBeGreaterThan(0);
    const scores = scoreAgainstAnswerKey(result.predicted, answerKey);
    expect(scores.recall).toBe(1);
    expect(scores.falsePositives).toBe(0);
    expect(scores.typeAccuracy).toBe(1);
    expect(scores.evidenceAccuracy).toBe(1);
    expect(scores.missed).toEqual([]);
    expect(scores.matched).toBe(scores.mustExtract);
    expect(result.dropped).toBe(0);
  });
});

describe("scorer metrics move when their failure mode appears", () => {
  const key: AnswerKeyEntry[] = [
    {
      type: "icp_fact",
      text_gist: "ICP sweet spot is 200-2,000 seats.",
      evidence_segment_ids: ["s0001", "s0002"],
      must_extract: true,
    },
    {
      type: "pain_point",
      text_gist: "Ticket backlog grows because nobody owns the queue.",
      evidence_segment_ids: ["s0005"],
      must_extract: true,
    },
    { type: null, text_gist: "Small talk.", evidence_segment_ids: ["s0009"], must_extract: false },
  ];

  const claim = (over: Partial<PredictedClaim>): PredictedClaim => ({
    type: ClaimType.icp_fact,
    text: "ICP sweet spot is 200-2,000 seats.",
    confidence: 0.9,
    segmentIds: ["s0001", "s0002"],
    quote: "sweet spot",
    ...over,
  });

  const painClaim = claim({
    type: ClaimType.pain_point,
    text: "Ticket backlog grows because nobody owns the queue.",
    segmentIds: ["s0005"],
  });

  it("a missed entry lowers recall and is named in `missed`", () => {
    const scores = scoreAgainstAnswerKey([claim({})], key);
    expect(scores.recall).toBe(0.5);
    expect(scores.missed).toEqual(["Ticket backlog grows because nobody owns the queue."]);
  });

  it("a claim citing a noise segment counts as a false positive", () => {
    const noise = claim({ type: ClaimType.messaging_decision, text: "We joked about renaming.", segmentIds: ["s0009"] });
    const scores = scoreAgainstAnswerKey([claim({}), painClaim, noise], key);
    expect(scores.falsePositives).toBe(1);
    expect(scores.recall).toBe(1);
  });

  it("a matched claim with the wrong type lowers type accuracy only", () => {
    const wrongType = claim({ type: ClaimType.positioning_statement });
    const scores = scoreAgainstAnswerKey([wrongType, painClaim], key);
    expect(scores.recall).toBe(1);
    expect(scores.typeAccuracy).toBe(0.5);
    expect(scores.typeMisses).toHaveLength(1);
  });

  it("citing less than the expected evidence lowers evidence accuracy", () => {
    const underCited = claim({ segmentIds: ["s0001"] }); // expected s0001 AND s0002
    const scores = scoreAgainstAnswerKey([underCited, painClaim], key);
    expect(scores.recall).toBe(1);
    expect(scores.evidenceAccuracy).toBe(0.5);
    expect(scores.evidenceMisses).toHaveLength(1);
  });

  it("citing MORE than the expected evidence is not punished", () => {
    const overCited = claim({ segmentIds: ["s0001", "s0002", "s0003"] });
    const scores = scoreAgainstAnswerKey([overCited, painClaim], key);
    expect(scores.evidenceAccuracy).toBe(1);
  });

  it("an extra claim on an unlisted segment is counted but not scored", () => {
    const extra = claim({ text: "Something else entirely.", segmentIds: ["s0042"] });
    const scores = scoreAgainstAnswerKey([claim({}), painClaim, extra], key);
    expect(scores.falsePositives).toBe(0);
    expect(scores.unscoredExtras).toBe(1);
    expect(scores.recall).toBe(1);
  });
});
