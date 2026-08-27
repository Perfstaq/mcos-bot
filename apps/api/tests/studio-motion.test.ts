import { describe, expect, it } from "vitest";
import {
  MAX_GROW,
  MIN_GROW,
  MIN_VISIBLE_SCALE_DELTA,
  SPRINGS,
  SPRING_FRAMES,
  driftDurationInFrames,
  duckGain,
  effectiveMotion,
  exitFrames,
  passesMicroMotionGate,
  scaleAt,
  scaleDelta,
  shotCamera,
} from "@mcos/render/motion";
import {
  CAPTION_POSITIONS,
  MAX_WORDS_PER_CHUNK,
  anchorFor,
  buildBanner,
  buildCaptionTrack,
  buildEmphasisContext,
  chunkWords,
  fontSizePx,
  handleCornerForShot,
  isContrastWord,
  isNumberOrProperNoun,
  isStopword,
  letterboxVideoBand,
  pickEmphasis,
  positionForShot,
  rmsStats,
  withinSafeMargins,
  type ScoredWord,
} from "@mcos/render/captions";
import { EPSILON, isMidWord, snapToEdge, snapsToEdge, speechGaps, wordEdges } from "@mcos/render/edl";

/**
 * Agent M's motion system (02_MOTION_SYSTEM) — the parts that are pure math
 * and therefore gateable without a render. The beat-snap planner has its own
 * suite (studio-planner.test.ts); this covers the springs, the ported camera
 * and ducking math, the word-edge core, and the three caption layers.
 */

describe("SPRINGS — the house springs (02 §1)", () => {
  it("has exactly the four configs the spec names, with the spec's values", () => {
    expect(Object.keys(SPRINGS).sort()).toEqual(["drift", "out", "pop", "punch"]);
    expect(SPRINGS.pop).toEqual({ damping: 12, mass: 0.5, stiffness: 200 });
    expect(SPRINGS.punch).toEqual({ damping: 20, mass: 0.3, stiffness: 400 });
    expect(SPRINGS.drift).toEqual({ damping: 200, mass: 3, stiffness: 40 });
    expect(SPRINGS.out).toEqual({ damping: 18, mass: 0.4, stiffness: 260 });
  });

  it("makes exits ~40% faster than entrances as a DURATION rule (ARCHITECTURE §11.3)", () => {
    // 02 §1 states this as if it were a config property; it is not — with
    // durationInFrames driving every spring, only the frame count decides.
    expect(exitFrames(SPRING_FRAMES.popEnter)).toBe(7);
    expect(exitFrames(20)).toBe(12);
    expect(exitFrames(1)).toBe(1); // never zero — Remotion rejects a 0-frame spring
  });

  it("rescales drift to the shot, which is what keeps G7 passable on short shots", () => {
    // The failure ARCHITECTURE §11.3 describes: an overdamped spring left at
    // natural speed traverses ~11% of its range in a 0.6s shot, turning a 5%
    // scale move into ~0.57% and failing G7's ">1% on 100% of shots". The fix
    // is that durationInFrames is the shot's own frame count, so the spring
    // completes inside the shot however short it is.
    expect(driftDurationInFrames(18)).toBe(18); // 0.6s at 30fps — G4's minimum
    expect(driftDurationInFrames(150)).toBe(150);
    expect(driftDurationInFrames(0)).toBe(1);
  });
});

describe("camera — ported motion.ts, pruned per the ledger (ARCHITECTURE §1.1)", () => {
  it("alternates push and pull so no reel pushes in on every shot (02 §4.1)", () => {
    expect(effectiveMotion(0)).toBe("push");
    expect(effectiveMotion(1)).toBe("pull");
    expect(effectiveMotion(2)).toBe("push");
    expect(effectiveMotion(1, "push")).toBe("push"); // explicit override wins
  });

  it("passes G7 on EVERY shot length, including the 0.6s floor", () => {
    for (const shotFrames of [18, 21, 30, 36, 45, 90, 150]) {
      for (let shotIndex = 0; shotIndex < 8; shotIndex++) {
        const cam = shotCamera(shotIndex, shotFrames, 42);
        expect(passesMicroMotionGate(cam), `shot ${shotIndex} @ ${shotFrames}f`).toBe(true);
        expect(scaleDelta(cam)).toBeGreaterThan(MIN_VISIBLE_SCALE_DELTA);
        expect(cam.durationInFrames).toBe(shotFrames);
      }
    }
  });

  it("keeps growth inside 01 §5's measured 0.05-0.08 band", () => {
    for (let i = 0; i < 40; i++) {
      const delta = scaleDelta(shotCamera(i, 45, 7));
      expect(delta).toBeGreaterThanOrEqual(MIN_GROW - 1e-9);
      expect(delta).toBeLessThanOrEqual(MAX_GROW + 1e-9);
    }
  });

  it("never lets scale dip below 1 — the 9:16 cover-crop must not reveal frame edges", () => {
    for (let i = 0; i < 20; i++) {
      const cam = shotCamera(i, 60, 3);
      expect(Math.min(cam.fromScale, cam.toScale)).toBeGreaterThanOrEqual(1);
      expect(scaleAt(cam, 0)).toBeGreaterThanOrEqual(1);
      expect(scaleAt(cam, 1)).toBeGreaterThanOrEqual(1);
      expect(scaleAt(cam, 0.5)).toBeGreaterThanOrEqual(1);
    }
  });

  it("is seed-deterministic (G13 precondition — no Math.random in the package)", () => {
    expect(shotCamera(3, 45, 42)).toEqual(shotCamera(3, 45, 42));
    expect(shotCamera(3, 45, 42)).not.toEqual(shotCamera(3, 45, 43));
  });
});

describe("duck — ported as-is (ARCHITECTURE §1.1, audio infrastructure)", () => {
  const windows = [{ start: 1, end: 2 }];

  it("is at full gain outside any speech window and ducked inside one", () => {
    expect(duckGain(0, windows)).toBe(1);
    expect(duckGain(1.5, windows)).toBe(0.45);
    expect(duckGain(5, windows)).toBe(1);
  });

  it("ramps rather than clicks, and never resolves louder than 1", () => {
    const preAttack = duckGain(0.96, windows);
    expect(preAttack).toBeGreaterThan(0.45);
    expect(preAttack).toBeLessThan(1);
    const release = duckGain(2.08, windows);
    expect(release).toBeGreaterThan(0.45);
    expect(release).toBeLessThan(1);
    for (const t of [0, 0.5, 1, 1.5, 2, 2.1, 3]) {
      expect(duckGain(t, [...windows, { start: 1.2, end: 1.8 }])).toBeLessThanOrEqual(1);
    }
  });
});

describe("edl — the word-edge invariant core (G10)", () => {
  const words = [
    { start: 0.0, end: 0.4 },
    { start: 0.4, end: 0.9 }, // abuts the previous word: no pause at all
    { start: 1.6, end: 2.0 }, // 700ms gap before it
  ];

  it("treats every word start AND end as a legal boundary, gap or not", () => {
    expect(wordEdges(words, 3)).toEqual([0, 0.4, 0.9, 1.6, 2.0, 3]);
    // The boundary at 0.4 sits inside a continuous speech run. It is legal —
    // it is the jump cut the reference reel is built from (01 §8), and 30
    // shots in 55s is unreachable from real silences alone.
    expect(isMidWord(0.4, words)).toBe(false);
    expect(isMidWord(0.2, words)).toBe(true);
    expect(isMidWord(1.2, words)).toBe(false); // inside the gap
  });

  it("snaps within EPSILON and leaves anything further alone", () => {
    const edges = wordEdges(words, 3);
    expect(EPSILON).toBe(0.05);
    expect(snapToEdge(0.42, edges)).toBe(0.4);
    expect(snapToEdge(0.6, edges)).toBe(0.6);
    expect(snapsToEdge(0.42, edges)).toBe(true);
    expect(snapsToEdge(0.6, edges)).toBe(false);
  });

  it("reports silences, including the clip's head and tail", () => {
    expect(speechGaps(words, 3)).toEqual([
      { start: 0.9, end: 1.6 },
      { start: 2.0, end: 3 },
    ]);
  });
});

describe("caption chunking (02 §2.2) — never a sentence", () => {
  const w = (word: string, startMs: number, endMs: number): ScoredWord => ({ word, startMs, endMs });

  it("breaks at 3 words max — G5", () => {
    const words = Array.from({ length: 7 }, (_, i) => w(`word${i}`, i * 200, i * 200 + 180));
    const chunks = chunkWords(words);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(MAX_WORDS_PER_CHUNK);
    expect(chunks.flat()).toHaveLength(7); // nothing dropped
  });

  it("breaks on punctuation even when the chunk is not full", () => {
    const chunks = chunkWords([w("stop.", 0, 200), w("next", 300, 500), w("one", 520, 700)]);
    expect(chunks[0]!.map((x) => x.word)).toEqual(["stop."]);
    expect(chunks[1]!.map((x) => x.word)).toEqual(["next", "one"]);
  });

  it("breaks at any gap >280ms", () => {
    const chunks = chunkWords([w("a", 0, 200), w("b", 700, 900), w("c", 920, 1100)]);
    expect(chunks[0]!.map((x) => x.word)).toEqual(["a"]);
    expect(chunks[1]!.map((x) => x.word)).toEqual(["b", "c"]);
  });
});

describe("emphasis scorer (02 §3) — pick the ONE word", () => {
  const ctx = (claims: string[], words: ScoredWord[]) => buildEmphasisContext(words, claims);

  it("classifies the four signal terms the way the spec means them", () => {
    expect(isStopword("the")).toBe(true);
    expect(isStopword("Obsession")).toBe(false);
    expect(isContrastWord("but")).toBe(true);
    expect(isContrastWord("never")).toBe(true);
    expect(isNumberOrProperNoun("40%", 2)).toBe(true);
    expect(isNumberOrProperNoun("Freshworks", 2)).toBe(true);
    expect(isNumberOrProperNoun("The", 0)).toBe(false); // sentence-initial capital proves nothing
  });

  it("weights the approved claim's own words highest (2.0) — it is the payload", () => {
    const words: ScoredWord[] = [
      { word: "our", startMs: 0, endMs: 100 },
      { word: "retention", startMs: 100, endMs: 400 },
      { word: "is", startMs: 400, endMs: 500 },
    ];
    const index = pickEmphasis(words, ctx(["retention is the moat"], words));
    expect(index).toBe(1);
    expect(words[index!]!.word).toBe("retention");
  });

  it("uses real per-word RMS as a z-score, not a raw level (ARCHITECTURE §11.1 R1)", () => {
    const words: ScoredWord[] = [
      { word: "alpha", startMs: 0, endMs: 200, rms: 0.02 },
      { word: "bravo", startMs: 200, endMs: 400, rms: 0.02 },
      { word: "charlie", startMs: 400, endMs: 600, rms: 0.02 },
      { word: "delta", startMs: 600, endMs: 800, rms: 0.2 }, // the stressed one
    ];
    const stats = rmsStats(words);
    expect(stats.stdDev).toBeGreaterThan(0);
    const index = pickEmphasis(words, ctx([], words));
    expect(index).not.toBeNull();
    expect(words[index!]!.word).toBe("delta");
  });

  it("emphasises NOTHING when nothing clears the threshold — restraint over decoration", () => {
    const words: ScoredWord[] = [
      { word: "and", startMs: 0, endMs: 100 },
      { word: "the", startMs: 100, endMs: 200 },
      { word: "of", startMs: 200, endMs: 300 },
    ];
    expect(pickEmphasis(words, ctx([], words))).toBeNull();
  });

  it("never marks more than one word per chunk — G8, enforced not assumed", () => {
    const words: ScoredWord[] = [
      { word: "Freshworks", startMs: 0, endMs: 300, rms: 0.3 },
      { word: "never", startMs: 300, endMs: 600, rms: 0.29 },
      { word: "42%", startMs: 600, endMs: 900, rms: 0.31 },
    ];
    const track = buildCaptionTrack({
      words,
      cutTimesMs: [],
      claimTexts: ["Freshworks never loses 42% of accounts"],
    });
    for (const chunk of track) {
      expect(chunk.words.filter((x) => x.isEmphasis).length).toBeLessThanOrEqual(1);
      if (chunk.emphasisWordIndex !== null) {
        expect(chunk.emphasisWordIndex).toBeLessThan(chunk.words.length);
        expect(chunk.words[chunk.emphasisWordIndex]!.isEmphasis).toBe(true);
      }
    }
  });
});

describe("caption layout — letterbox only, no luminance (ARCHITECTURE §11.1 R2)", () => {
  it("rotates position per shot and never repeats one back to back (G6)", () => {
    const seen = new Set<string>();
    for (let shot = 0; shot < 12; shot++) {
      const pos = positionForShot(shot);
      seen.add(pos);
      expect(pos).not.toBe(positionForShot(shot - 1 < 0 ? 11 : shot - 1));
    }
    expect(seen.size).toBeGreaterThanOrEqual(3); // G6
    expect(seen.size).toBe(CAPTION_POSITIONS.length);
  });

  it("keeps every caption anchor inside the 12% safe margins (G9)", () => {
    for (const position of CAPTION_POSITIONS) {
      expect(withinSafeMargins(anchorFor(position)), position).toBe(true);
    }
  });

  it("places three of the four positions in the letterbox bars, and the fourth below the face", () => {
    // R2 descopes face detection by shipping letterbox only: the bars cannot
    // occlude a face. `center` is the one anchor over the video and it sits
    // in the band's bottom sixth, below a seated subject's face.
    const band = letterboxVideoBand();
    const toPx = (y: number) => y * 1920;
    expect(toPx(anchorFor("upper_third").y)).toBeLessThan(band.top);
    expect(toPx(anchorFor("center_low").y)).toBeGreaterThan(band.bottom);
    expect(toPx(anchorFor("lower_left").y)).toBeGreaterThan(band.bottom);
    const center = toPx(anchorFor("center").y);
    expect(center).toBeGreaterThan(band.top + (band.bottom - band.top) * 0.8);
    expect(center).toBeLessThan(band.bottom);
  });

  it("sizes type as a proportion of frame width, never a px constant (02 §7)", () => {
    expect(fontSizePx("banner")).toBeCloseTo(66.96, 2);
    expect(fontSizePx("karaoke")).toBeCloseTo(81, 2);
    expect(fontSizePx("emphasis")).toBeCloseTo(109.08, 2);
    // Same tokens, half the frame ⇒ half the size.
    expect(fontSizePx("banner", 540)).toBeCloseTo(fontSizePx("banner") / 2, 6);
  });

  it("alternates the handle across corners — a static bug reads as a watermark (02 §2.3)", () => {
    expect(handleCornerForShot(0)).toBe("upper_right");
    expect(handleCornerForShot(1)).toBe("mid_left");
    expect(handleCornerForShot(2)).toBe("upper_right");
  });
});

describe("banner — one coloured word, from the brief (02 §2.1)", () => {
  it("colours exactly the word the brief names", () => {
    const banner = buildBanner("THE POWER OF OBSESSION", "obsession");
    expect(banner.emphasisWordIndex).toBe(3);
    expect(banner.text.split(/\s+/)[banner.emphasisWordIndex!]).toBe("OBSESSION");
  });

  it("colours nothing rather than guessing when the word is absent", () => {
    expect(buildBanner("THE POWER OF OBSESSION", "discipline").emphasisWordIndex).toBeNull();
    expect(buildBanner("THE POWER OF OBSESSION", null).emphasisWordIndex).toBeNull();
  });
});
