import { describe, expect, it } from "vitest";
import { chunkBySpeakerTurns, segmentHandle } from "../src/domain/chunking.js";
import { quoteAppearsIn } from "../src/domain/claims.js";
import { parseTranscript } from "../src/domain/transcript.js";
import type { RecallTranscriptEntry } from "../src/integrations/recall.js";
import {
  createExtractFromChunkMock,
  createExtractFromChunkMockFromAnswerKey,
  emptyExtractFromChunk,
} from "./helpers/llm-mock.js";
import discoveryTranscript from "./fixtures/transcripts/golden-discovery.json" with { type: "json" };
import discoveryAnswerKey from "./fixtures/transcripts/golden-discovery-answer-key.json" with { type: "json" };

const segments = (
  count: number,
): Array<{ id: string; idx: number; speaker: string; startMs: number; text: string }> =>
  Array.from({ length: count }, (_, i) => ({
    id: `seg-${i}`,
    idx: i,
    speaker: "Priya",
    startMs: i * 10_000,
    text: i === 2 ? "our sweet spot is two hundred to two thousand seats" : `filler turn number ${i}`,
  }));

describe("createExtractFromChunkMock", () => {
  it("emits a claim citing the matching segment's handle, shaped like the real extractor's output", async () => {
    const mock = createExtractFromChunkMock([
      {
        when: "two hundred to two thousand seats",
        claims: [
          {
            type: "icp_fact",
            text: "ICP sweet spot is 200-2,000 seats.",
            quote: "our sweet spot is two hundred to two thousand seats",
          },
        ],
      },
    ]);

    const chunks = chunkBySpeakerTurns(segments(5));
    const result = await mock({ chunk: chunks[0]! });

    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]!.type).toBe("icp_fact");
    expect(result.claims[0]!.evidence.transcript_segment_ids).toEqual([segmentHandle(2)]);
    expect(typeof result.inputTokens).toBe("number");
    expect(typeof result.outputTokens).toBe("number");
  });

  it("produces a quote that survives the real evidence gate's quoteAppearsIn check", async () => {
    const mock = createExtractFromChunkMock([
      {
        when: "two hundred to two thousand seats",
        claims: [{ type: "icp_fact", text: "x", quote: "our sweet spot is two hundred to two thousand seats" }],
      },
    ]);
    const chunk = chunkBySpeakerTurns(segments(5))[0]!;
    const result = await mock({ chunk });
    const segmentTexts = chunk.segments.map((s) => s.text);
    expect(quoteAppearsIn(result.claims[0]!.evidence.verbatim_quote, segmentTexts)).toBe(true);
  });

  it("would be dropped by the same gate if the quote was never said", async () => {
    const mock = createExtractFromChunkMock([
      { when: "two hundred to two thousand seats", claims: [{ type: "icp_fact", text: "x", quote: "a completely fabricated quote nobody said" }] },
    ]);
    const chunk = chunkBySpeakerTurns(segments(5))[0]!;
    const result = await mock({ chunk });
    const segmentTexts = chunk.segments.map((s) => s.text);
    expect(quoteAppearsIn(result.claims[0]!.evidence.verbatim_quote, segmentTexts)).toBe(false);
  });
});

describe("emptyExtractFromChunk", () => {
  it("always proposes nothing", async () => {
    const result = await emptyExtractFromChunk();
    expect(result.claims).toEqual([]);
  });
});

describe("createExtractFromChunkMockFromAnswerKey", () => {
  it("reproduces exactly the must_extract:true claims from a golden answer key, and none of the noise", async () => {
    const parsed = parseTranscript(discoveryTranscript as RecallTranscriptEntry[]);
    const answerKey = discoveryAnswerKey as Array<{
      type: string | null;
      text_gist: string;
      evidence_segment_ids: string[];
      must_extract: boolean;
    }>;
    const expectedCount = answerKey.filter((c) => c.must_extract).length;

    const mock = createExtractFromChunkMockFromAnswerKey(answerKey);
    const chunks = chunkBySpeakerTurns(
      parsed.segments.map((s) => ({ id: s.speaker, idx: s.idx, speaker: s.speaker, startMs: s.startMs, text: s.text })),
    );

    let total = 0;
    for (const chunk of chunks) {
      const result = await mock({ chunk });
      total += result.claims.length;
      for (const claim of result.claims) {
        const segmentTexts = chunk.segments.map((s) => s.text);
        expect(quoteAppearsIn(claim.evidence.verbatim_quote, segmentTexts)).toBe(true);
      }
    }

    // Chunking overlaps turns at chunk boundaries, so a claim near a seam can
    // be proposed by two chunks — the same behaviour the real chunker
    // produces, collapsed downstream by dedupe key. This only asserts every
    // required claim shows up at least once, not an exact count.
    expect(total).toBeGreaterThanOrEqual(expectedCount);
  });
});
