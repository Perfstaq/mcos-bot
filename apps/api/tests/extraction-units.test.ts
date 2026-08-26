import { ClaimType } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { chunkBySpeakerTurns, estimateTokens, segmentHandle } from "../src/domain/chunking.js";
import {
  dedupeKey,
  dedupeNearIdenticalClaims,
  normalizeClaimText,
  quoteAppearsIn,
} from "../src/domain/claims.js";
import { parseTranscript } from "../src/domain/transcript.js";
import { formatTimestamp } from "../src/domain/transcript.js";
import transcriptDownload from "./fixtures/transcript-download.json" with { type: "json" };

const segments = (count: number, wordsEach = 20) =>
  Array.from({ length: count }, (_, i) => ({
    id: `seg-${i}`,
    idx: i,
    speaker: i % 2 === 0 ? "Priya" : "Daniel",
    startMs: i * 10_000,
    text: Array.from({ length: wordsEach }, (_, w) => `word${w}`).join(" "),
  }));

describe("transcript parsing", () => {
  it("turns the recorded Recall download into speaker segments", () => {
    const parsed = parseTranscript(transcriptDownload as never);
    expect(parsed.segments).toHaveLength(9);
    expect(parsed.languageCode).toBe("en");
    expect(parsed.wordCount).toBe(244);
    expect(parsed.segments[0]!.speaker).toBe("Priya Raman");
    expect(parsed.segments[0]!.startMs).toBe(4_000);
    expect(parsed.segments[0]!.text.startsWith("Right so the reason")).toBe(true);
    expect(parsed.durationMs).toBeGreaterThan(134_000);
  });

  it("names an anonymous participant by id rather than dropping the turn", () => {
    const parsed = parseTranscript([
      {
        participant: { id: 7, name: null, is_host: false, platform: null, extra_data: null },
        words: [{ text: "hello", start_timestamp: { absolute: null, relative: 1 }, end_timestamp: { absolute: null, relative: 2 } }],
      },
    ] as never);
    expect(parsed.segments[0]!.speaker).toBe("Speaker 7");
  });

  it("skips turns with no words instead of emitting empty evidence", () => {
    const parsed = parseTranscript([
      { participant: { id: 1, name: "A", is_host: true, platform: null, extra_data: null }, words: [] },
    ] as never);
    expect(parsed.segments).toHaveLength(0);
  });

  it("formats timestamps for the review card", () => {
    expect(formatTimestamp(97_600)).toBe("1:37");
    expect(formatTimestamp(3_723_000)).toBe("1:02:03");
  });
});

describe("chunking", () => {
  it("never splits inside a speaker turn", () => {
    const input = segments(60);
    const chunks = chunkBySpeakerTurns(input, 400);
    const seen = chunks.flatMap((c) => c.segments.map((s) => s.text));
    for (const text of seen) expect(input.some((s) => s.text === text)).toBe(true);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("overlaps consecutive chunks so a claim at the seam still has context", () => {
    const chunks = chunkBySpeakerTurns(segments(60), 400);
    for (let i = 1; i < chunks.length; i++) {
      const previousTail = chunks[i - 1]!.segments.slice(-2).map((s) => s.id);
      const head = chunks[i]!.segments.slice(0, 2).map((s) => s.id);
      expect(head).toEqual(previousTail);
      expect(chunks[i]!.overlapCount).toBe(2);
    }
  });

  it("covers every segment at least once", () => {
    const input = segments(37);
    const covered = new Set(chunkBySpeakerTurns(input, 300).flatMap((c) => c.segments.map((s) => s.id)));
    expect(covered.size).toBe(input.length);
  });

  it("emits an over-budget turn alone rather than cutting it in half", () => {
    const huge = { id: "big", idx: 0, speaker: "Priya", startMs: 0, text: "x ".repeat(20_000) };
    const chunks = chunkBySpeakerTurns([huge, ...segments(3).map((s, i) => ({ ...s, idx: i + 1 }))], 500);
    expect(chunks[0]!.segments).toEqual([huge]);
  });

  it("returns nothing for an empty transcript", () => {
    expect(chunkBySpeakerTurns([])).toEqual([]);
  });

  it("estimates tokens and builds stable handles", () => {
    expect(estimateTokens("abcd".repeat(100))).toBe(100);
    expect(segmentHandle(12)).toBe("s0012");
  });
});

describe("claim dedupe", () => {
  it("collapses the same claim proposed twice across an overlap", () => {
    const a = "Mid-market buyers find the pricing page confusing.";
    const b = "  mid-market buyers find the PRICING page confusing!!  ";
    expect(dedupeKey(ClaimType.pain_point, a)).toBe(dedupeKey(ClaimType.pain_point, b));
  });

  it("keeps claims of different types apart even when worded identically", () => {
    const text = "Zendesk does not get cheaper as you grow.";
    expect(dedupeKey(ClaimType.objection, text)).not.toBe(
      dedupeKey(ClaimType.competitor_mention, text),
    );
  });

  it("does NOT merge two differently-worded claims — that is the reviewer's call", () => {
    expect(dedupeKey(ClaimType.pain_point, "Support costs scale linearly with volume.")).not.toBe(
      dedupeKey(ClaimType.pain_point, "每 extra ticket costs the same as the last."),
    );
  });

  it("normalises accents and punctuation", () => {
    expect(normalizeClaimText("Café — 41% deflection!")).toBe("cafe 41 deflection");
  });
});

describe("near-identical claim dedupe", () => {
  const claim = (type: ClaimType, text: string, confidence = 0.9) => ({ type, text, confidence });

  it("collapses an exact duplicate and counts it", () => {
    const { kept, duplicates } = dedupeNearIdenticalClaims([
      claim(ClaimType.pain_point, "Mid-market buyers find the pricing page confusing."),
      claim(ClaimType.pain_point, "  mid-market buyers find the PRICING page confusing!  "),
    ]);
    expect(kept).toHaveLength(1);
    expect(duplicates).toBe(1);
  });

  it("collapses near-identical wording drift across chunk overlap", () => {
    const { kept, duplicates } = dedupeNearIdenticalClaims([
      claim(ClaimType.pain_point, "Mid-market buyers find the pricing page confusing at the tier boundaries."),
      claim(ClaimType.pain_point, "Mid-market buyers find the pricing pages confusing at tier boundaries."),
    ]);
    expect(kept).toHaveLength(1);
    expect(duplicates).toBe(1);
  });

  it("keeps the highest-confidence copy even when it arrives second", () => {
    const low = claim(ClaimType.icp_fact, "ICP sweet spot is companies with 200-2,000 seats.", 0.6);
    const high = claim(ClaimType.icp_fact, "The ICP sweet spot is companies with 200-2,000 seats.", 0.9);
    const { kept, duplicates } = dedupeNearIdenticalClaims([low, high]);
    expect(kept).toEqual([high]);
    expect(duplicates).toBe(1);
  });

  it("does NOT merge genuinely different claims — that is the reviewer's call", () => {
    const { kept, duplicates } = dedupeNearIdenticalClaims([
      claim(ClaimType.pain_point, "Support costs scale linearly with ticket volume."),
      claim(ClaimType.pain_point, "Nobody owns the ticket queue full-time, so the backlog grows."),
    ]);
    expect(kept).toHaveLength(2);
    expect(duplicates).toBe(0);
  });

  it("keeps identical wording apart across claim types", () => {
    const { kept } = dedupeNearIdenticalClaims([
      claim(ClaimType.objection, "Zendesk does not get cheaper as you grow."),
      claim(ClaimType.competitor_mention, "Zendesk does not get cheaper as you grow."),
    ]);
    expect(kept).toHaveLength(2);
  });

  it("counts every collapsed copy, not just the first", () => {
    const text = "Buying trigger is a compliance audit deadline.";
    const { kept, duplicates } = dedupeNearIdenticalClaims([
      claim(ClaimType.icp_fact, text),
      claim(ClaimType.icp_fact, text),
      claim(ClaimType.icp_fact, text),
    ]);
    expect(kept).toHaveLength(1);
    expect(duplicates).toBe(2);
  });
});

describe("evidence validation", () => {
  const segmentTexts = [
    "Then let us stop positioning against Zendesk on features we should position as the layer that makes support cost curve flat not as a better help desk",
  ];

  it("accepts a quote copied out of the cited segment", () => {
    expect(
      quoteAppearsIn("we should position as the layer that makes support cost curve flat", segmentTexts),
    ).toBe(true);
  });

  it("tolerates light tidying of a noisy transcript", () => {
    expect(
      quoteAppearsIn("we should position as the layer that makes the support cost curve flat", segmentTexts),
    ).toBe(true);
  });

  it("rejects a quote that was never said", () => {
    expect(
      quoteAppearsIn("we guarantee a ninety percent reduction in support headcount", segmentTexts),
    ).toBe(false);
  });

  it("rejects a quote too short to verify anything", () => {
    expect(quoteAppearsIn("flat", segmentTexts)).toBe(false);
  });

  // --- Adversarial cases: the fuzzy floor is for transcription drift, not
  // --- paraphrase. Each of these reuses real vocabulary from the segment and
  // --- must still be dropped.

  it("rejects a quote that reorders the segment's own words", () => {
    // Every content word here appears in the segment — a bag-of-words overlap
    // check would wave it through. It was never said in this order.
    expect(
      quoteAppearsIn(
        "the layer that makes support position as we should cost curve flat",
        segmentTexts,
      ),
    ).toBe(false);
  });

  it("rejects a paraphrase that keeps the substance but not the words", () => {
    expect(
      quoteAppearsIn("we ought to frame ourselves as keeping the support budget level", segmentTexts),
    ).toBe(false);
  });

  it("rejects a quote corrupted well past the similarity floor", () => {
    expect(
      quoteAppearsIn(
        "we could position as the platform which keeps support spending curves flatter",
        segmentTexts,
      ),
    ).toBe(false);
  });

  it("accepts punctuation, casing and whitespace drift", () => {
    expect(
      quoteAppearsIn(
        "  We should position as the layer that makes support-cost-curve flat!  ",
        segmentTexts,
      ),
    ).toBe(true);
  });

  it("accepts a single-word transcription slip in a long quote", () => {
    // "the" transcribed as "a" — the kind of drift the 0.85 floor exists for.
    expect(
      quoteAppearsIn("we should position as a layer that makes support cost curve flat", segmentTexts),
    ).toBe(true);
  });
});
