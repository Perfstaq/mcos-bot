import { describe, expect, it } from "vitest";
import {
  assertValidBeatGrid,
  assertValidWordsResult,
  BeatGridResultSchema,
  WordsResultSchema,
} from "../src/domain/studio/media-analysis-schema.js";

/**
 * The Python sidecar (services/analyzer) writes words.json/beats.json; these
 * loud loaders are the only thing standing between that JSON and a Postgres
 * `MediaAnalysis` row (ARCHITECTURE.md §5: "zod-validated on the Node side
 * via the ported io.ts loaders"). Written against the real shapes
 * `analyzer.py` emits — verified manually against the reference reel
 * (tempo 112.347bpm, 97 beats, matching 01_REFERENCE_ANALYSIS's 112.3bpm/97).
 */

const VALID_WORDS = {
  language: "en",
  durationSec: 20.014,
  segments: [
    {
      start: 0,
      end: 2.56,
      text: "the moment you start working harder than the people around you,",
      words: [
        { word: "the", start: 0, end: 0.22, score: 0.1312 },
        { word: "moment", start: 0.22, end: 0.28, score: 0.9725 },
      ],
    },
  ],
};

const VALID_BEATS = {
  method: "beat_track",
  tempoBpm: 112.347,
  beatTimesMs: [650, 1184, 1649],
  gridQuality: 2.2003,
};

describe("media analysis schema (words.json)", () => {
  it("accepts the shape analyzer.py's words stage emits", () => {
    expect(() => assertValidWordsResult(VALID_WORDS)).not.toThrow();
    const parsed = assertValidWordsResult(VALID_WORDS);
    expect(parsed.segments[0]?.words).toHaveLength(2);
  });

  it("rejects a negative word timestamp — never a silent bad boundary", () => {
    const bad = { ...VALID_WORDS, segments: [{ ...VALID_WORDS.segments[0], words: [{ word: "x", start: -1, end: 0 }] }] };
    expect(() => assertValidWordsResult(bad)).toThrow(/validation failed/i);
  });

  it("allows a null/absent per-word score (faster-whisper omits it rarely)", () => {
    const noScore = { ...VALID_WORDS, segments: [{ ...VALID_WORDS.segments[0], words: [{ word: "x", start: 0, end: 0.1 }] }] };
    expect(() => WordsResultSchema.parse(noScore)).not.toThrow();
  });
});

describe("media analysis schema (beats.json)", () => {
  it("accepts the camelCase shape analyzer.py's beats stage emits", () => {
    const parsed = assertValidBeatGrid(VALID_BEATS);
    expect(parsed.method).toBe("beat_track");
    expect(parsed.beatTimesMs).toHaveLength(3);
  });

  it("accepts a null tempo/gridQuality — the honest 'couldn't tell' case, not a fabricated 0", () => {
    const empty = { method: "beat_track", tempoBpm: null, beatTimesMs: [], gridQuality: null };
    expect(() => BeatGridResultSchema.parse(empty)).not.toThrow();
  });

  it("rejects an unknown beat method", () => {
    const bad = { ...VALID_BEATS, method: "vibes" };
    expect(() => assertValidBeatGrid(bad)).toThrow(/validation failed/i);
  });

  it("rejects a non-integer beat time (ADR-8: distances compared as integer milliseconds)", () => {
    const bad = { ...VALID_BEATS, beatTimesMs: [650.5] };
    expect(() => assertValidBeatGrid(bad)).toThrow();
  });
});
