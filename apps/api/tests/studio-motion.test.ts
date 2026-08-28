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
  BANNER_ANCHOR,
  BANNER_TOP_MARGIN_RATIO,
  CAPTION_POSITIONS,
  MAX_WORDS_PER_CHUNK,
  TYPE_SCALE,
  anchorFor,
  buildBanner,
  buildCaptionTrack,
  buildEmphasisContext,
  captionWordAppearance,
  chunkWords,
  fontSizePx,
  g9Violations,
  handleAnchor,
  handleCornerForShot,
  isContrastWord,
  isNumberOrProperNoun,
  isStopword,
  contentRegion,
  FACE_FLOOR_RATIO,
  LINE_HEIGHT,
  faceFloorOriginY,
  faceFloorViolationsForBlock,
  regionContainmentViolations,
  letterboxVideoBand,
  pickEmphasis,
  positionForShot,
  rmsStats,
  textBoxBounds,
  textBoxVerticalExtent,
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

  it("makes consecutive shots visibly different framings", () => {
    // The name and threshold used to say "or G1b can never pass". That claim
    // is FALSE and measurement disproved it (§12.14): with alternating base
    // framing in place the render still scores 2/29 on G1b, because a scene
    // detector needs content discontinuity and reframing continuous footage
    // is not that. Real jump cuts need footage removal plus an output-time
    // grid (§12.3, §12.13) — neither of which is this constant.
    //
    // What the alternation genuinely buys is that a hard cut reads as a
    // change rather than as nothing, so that is all this asserts. The bound
    // dropped with REFRAME_STEP 0.18 → 0.10 (§12.16 item 2), which stopped
    // the zoom pushing a face across a fixed caption line.
    for (let shot = 0; shot < 8; shot++) {
      const a = shotCamera(shot, 45, 42);
      const b = shotCamera(shot + 1, 45, 42);
      const step = Math.abs(a.toScale - b.fromScale);
      expect(step, `boundary ${shot}->${shot + 1}`).toBeGreaterThan(0.05);
    }
  });

  it("keeps the reframe out of the per-shot delta, so G7 measures drift alone", () => {
    // The alternating base is applied to BOTH ends of the range. If it leaked
    // into one end only, G7 would read the reframe as micro-motion and a
    // genuinely static shot could pass.
    for (let shot = 0; shot < 8; shot++) {
      const delta = scaleDelta(shotCamera(shot, 45, 42));
      expect(delta).toBeLessThanOrEqual(MAX_GROW + 1e-9);
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

  it("does not auto-emphasise a single-word chunk — max() over one candidate is still a threshold test", () => {
    // A one-word chunk is the case where an unguarded argmax would always
    // return that word. The demo render put a lone "IT" on screen; the scorer
    // was right to refuse it (stopword -2.0 against an RMS z of +0.82 leaves
    // -0.77, well under the 1.0 bar) and this pins that.
    const words: ScoredWord[] = [{ word: "it", startMs: 3340, endMs: 3500, rms: 0.1971 }];
    const corpus: ScoredWord[] = [
      ...words,
      { word: "dedication", startMs: 3500, endMs: 3940, rms: 0.1628 },
      { word: "quiet", startMs: 4000, endMs: 4300, rms: 0.1 },
      { word: "louder", startMs: 4300, endMs: 4600, rms: 0.21 },
    ];
    expect(pickEmphasis(words, ctx([], corpus))).toBeNull();

    const track = buildCaptionTrack({ words, cutTimesMs: [], claimTexts: [] });
    expect(track).toHaveLength(1);
    expect(track[0]!.emphasisWordIndex).toBeNull();
    expect(track[0]!.words[0]!.isEmphasis).toBe(false);
  });

  it("reserves the accent colour for emphasis — an active word is not an emphasised word", () => {
    // 02 §2.2 asks for accent on the word being spoken and 02 §3 gives accent
    // to the emphasis word; rendered literally an orange word means two
    // different things, and on a one-word chunk the active word is orange for
    // its whole life on screen. 01 §4 records the karaoke layer as white and
    // 01 §8 forbids adding effects the reference lacks, so accent is
    // emphasis-only and "active" is carried by opacity.
    for (const state of ["pending", "active", "spoken"] as const) {
      expect(captionWordAppearance(state, false).colorRole, state).toBe("primary");
      expect(captionWordAppearance(state, true).colorRole, state).toBe("accent");
    }
    expect(captionWordAppearance("active", false).opacity).toBe(1);
    expect(captionWordAppearance("spoken", false).opacity).toBeLessThan(1);
    // Emphasis keeps 02 §3's 1.35× treatment and never recedes.
    expect(captionWordAppearance("spoken", true).opacity).toBe(1);
    expect(TYPE_SCALE.emphasis / TYPE_SCALE.karaoke).toBeCloseTo(1.35, 2);
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

  it("bounds every layer's VERTICAL extent too — top, bottom, and the block, not the anchor (G9)", () => {
    // The horizontal half of this test is why the clipped handle was caught.
    // Its absence on the vertical axis is why a banner at y=0.09, whose ink
    // reaches 7.2%, shipped unnoticed (ARCHITECTURE §12.7).
    const karaokeSize = fontSizePx("karaoke");
    const emphasisSize = fontSizePx("emphasis");
    for (const position of CAPTION_POSITIONS) {
      // ONE line, at either size. The two-line case this used to assert is
      // unreachable since §12.43: every default position is inside the bottom
      // bar, the bar is 129.6px, and the chunker's fit predicate splits any
      // chunk that would wrap. A second line there fails G9's bottom margin,
      // which the sibling test below now pins as the expected rejection.
      for (const size of [karaokeSize, emphasisSize] as const) {
        expect(g9Violations("karaoke", anchorFor(position), size, 1), `${position} @${size}px`).toEqual([]);
      }
      // And the bar really cannot take a second line — asserted, not assumed.
      expect(
        g9Violations("karaoke", anchorFor(position), emphasisSize, 2).length,
        `${position} must reject 2 lines`,
      ).toBeGreaterThan(0);
    }
    const handleSize = fontSizePx("handle");
    expect(g9Violations("handle", handleAnchor("upper_right"), handleSize)).toEqual([]);
    expect(g9Violations("handle", handleAnchor("upper_left"), handleSize)).toEqual([]);
  });

  it("exempts ONLY the banner's top edge, only to 8% — the carve-out is named, not absent", () => {
    // ARCHITECTURE §12.7: G9 stays strict on left/right/bottom; the top edge
    // is exempt for the persistent banner alone, to 8%. An exemption nothing
    // tests is indistinguishable from a bug, so this pins all three halves:
    // the banner passes, the SAME geometry fails for any other layer, and the
    // exemption does not extend past 8%.
    const bannerSize = fontSizePx("banner");
    expect(BANNER_TOP_MARGIN_RATIO).toBe(0.08);
    expect(g9Violations("banner", BANNER_ANCHOR, bannerSize)).toEqual([]);

    // The very same box is a violation for a non-banner layer.
    const asKaraoke = g9Violations("karaoke", BANNER_ANCHOR, bannerSize);
    expect(asKaraoke.length).toBeGreaterThan(0);
    expect(asKaraoke.join(" ")).toContain("top");

    // And the carve-out really is bounded at 8%: 01 §4's measured ~9% anchor
    // puts the block's top at ~7.2%, which the exemption must still reject.
    const tooHigh = { x: 0.5, y: 0.09, align: "center" as const };
    const violations = g9Violations("banner", tooHigh, bannerSize);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.join(" ")).toContain("top");

    const { top } = textBoxVerticalExtent(BANNER_ANCHOR, bannerSize);
    expect(top / 1920).toBeGreaterThanOrEqual(BANNER_TOP_MARGIN_RATIO);
    expect(top / 1920).toBeLessThan(0.12); // still inside what plain G9 forbids
  });

  it("keeps the rendered TEXT BOX inside the margins, not just its anchor (G9)", () => {
    // The anchor being safe does not make the box safe. Rendering caught it:
    // the left-aligned handle at x=0.2, laid out in a centred 0.76·W box,
    // started at -194px and lost its first character off-frame.
    const boxes = [
      ...CAPTION_POSITIONS.map((p) => [p, anchorFor(p)] as const),
      ["handle upper_right", handleAnchor("upper_right")] as const,
      ["handle upper_left", handleAnchor("upper_left")] as const,
      ["banner", { x: 0.5, y: 0.09, align: "center" as const }] as const,
    ];
    for (const [label, anchor] of boxes) {
      const { left, right } = textBoxBounds(anchor, 1080);
      expect(left, `${label} left`).toBeGreaterThanOrEqual(0.12 * 1080 - 1e-9);
      expect(right, `${label} right`).toBeLessThanOrEqual(0.88 * 1080 + 1e-9);
      expect(right, `${label} width`).toBeGreaterThan(left);
    }
  });

  it("puts every caption position below the measured face floor (§12.16)", () => {
    // This test used to assert that three of four positions sat in the black
    // bars, on R2's claim that bars "structurally cannot occlude a face".
    // A rendered frame falsified that claim — a caption crossed a subject's
    // mouth in all three templates — and §12.16 replaced the argument with a
    // measurement: cover-cropped into the 0.625 content region, the chin
    // lands at y ≈ 0.717. The bound is now that number, not a region.
    const region = contentRegion();
    expect(region.top).toBeCloseTo(360, 6);
    expect(region.bottom).toBeCloseTo(1560, 6);

    const emphasisSize = fontSizePx("emphasis");
    for (const position of CAPTION_POSITIONS) {
      const anchor = anchorFor(position);
      // One line is the height real chunks reach since §12.43 — the fit
      // predicate guarantees it, and the bar has room for nothing else.
      const oneLine = textBoxVerticalExtent(anchor, emphasisSize, 1);
      expect(anchor.y, `${position} anchor below the face floor`).toBeGreaterThan(FACE_FLOOR_RATIO);
      expect(oneLine.bottom, `${position} bottom margin`).toBeLessThanOrEqual(0.88 * 1920 + 1e-6);
      // §12.43 — and wholly inside the bottom bar, not straddling its edge.
      expect(
        regionContainmentViolations(anchor, emphasisSize * LINE_HEIGHT),
        `${position} region containment`,
      ).toEqual([]);
      expect(oneLine.top, `${position} sits below the content region`).toBeGreaterThanOrEqual(region.bottom - 1e-6);
    }
  });

  it("bounds the block's TOP against the face, not just its anchor (§12.19)", () => {
    // The assertion above is on `anchor.y` — the block's CENTRE, which is by
    // construction the half of the block furthest from the face. A block grows
    // upward too, and the bound that matters is where its top edge lands.
    //
    // The gap between the two is not hypothetical: at 1080×1920 a three-line
    // chunk is 284.6px, so at `center` its top sits at 0.711 — eleven pixels
    // ABOVE the chin — while the anchor at 0.785 sails past the check above.
    const emphasisSize = fontSizePx("emphasis");
    const floorPx = FACE_FLOOR_RATIO * 1920;

    for (const position of CAPTION_POSITIONS) {
      const anchor = anchorFor(position);
      // One and two lines are what real chunks reach, and both must clear.
      // Only one line is reachable since §12.43; the 2-line case is kept as a
      // bound that must ALSO hold, since the face floor does not depend on the
      // bar's capacity and a future opt-in `center` template would use it.
      for (const lines of [1, 2]) {
        const { top } = textBoxVerticalExtent(anchor, emphasisSize, lines);
        expect(top, `${position} ${lines}-line top vs face floor`).toBeGreaterThanOrEqual(floorPx);
        expect(
          faceFloorViolationsForBlock(anchor, emphasisSize * LINE_HEIGHT * lines),
          `${position} ${lines}-line`,
        ).toEqual([]);
      }
    }

    // And the check has teeth: the case that used to pass silently must fail.
    const centre = anchorFor("center");
    const threeLine = faceFloorViolationsForBlock(centre, 284.6);
    expect(threeLine.length, "a three-line chunk at center must be caught").toBeGreaterThan(0);
    expect(threeLine.join(" ")).toContain("face floor");
  });

  it("anchors the zoom on the chin so no composed scale can displace it (§12.19)", () => {
    // §12.19's finding: the anchors are derived from the chin at scale 1.0,
    // but the renderer composes drift × punch up to 1.18 × 1.06 ≈ 1.25. About
    // the region's CENTRE that walked the chin from 0.717 to 0.771, through
    // one-line emphasis tops at 0.755. `camera.ts` now anchors the zoom on the
    // chin line itself, which makes it the transform's exact fixed point.
    const region = contentRegion();
    const originY = faceFloorOriginY();

    // Where the chin sits in the region's own coordinates.
    const chinRel = (FACE_FLOOR_RATIO * 1920 - region.top) / region.height;
    expect(originY).toBeCloseTo(chinRel, 12);
    expect(originY).toBeCloseTo(0.8472, 4);

    // A point scaled about itself does not move — at ANY scale, which is the
    // property that makes FACE_FLOOR_RATIO true of the render and not just of
    // a still. The worst case §12.19 measured is 1.18 × 1.06; 2.0 is included
    // so this is asserting the invariant rather than one measured number.
    const composed = (s: number) => (region.top + (originY + s * (chinRel - originY)) * region.height) / 1920;
    for (const scale of [1, 1.1, 1.18, 1.18 * 1.06, 2]) {
      expect(composed(scale), `chin at composed scale ${scale}`).toBeCloseTo(FACE_FLOOR_RATIO, 10);
    }

    // Every shot gets it, not just the reframed odd ones: an even shot still
    // grows 5–8%, which is enough to move a centre-anchored chin 33px down.
    for (let shot = 0; shot < 6; shot++) {
      expect(shotCamera(shot, 45, 42).originY, `shot ${shot}`).toBeCloseTo(originY, 12);
    }

    // Cover is the one thing about the zoom that must not change: both ends of
    // every shot's range stay ≥1, and a scale ≥1 about an origin inside the
    // element always contains the unscaled box, so no source edge is revealed.
    for (let shot = 0; shot < 6; shot++) {
      const cam = shotCamera(shot, 45, 42);
      expect(Math.min(cam.fromScale, cam.toScale), `shot ${shot} cover`).toBeGreaterThanOrEqual(1);
    }
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
    expect(handleCornerForShot(1)).toBe("upper_left");
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
