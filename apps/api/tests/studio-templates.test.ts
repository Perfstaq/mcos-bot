import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BANNER_ANCHOR,
  BANNER_TOP_MARGIN_RATIO,
  CAPTION_POSITIONS,
  CONTENT_REGION_RATIO,
  LINE_HEIGHT,
  SAFE_MARGIN_RATIO,
  TYPE_SCALE,
  anchorFor,
  blockHeightPx,
  faceFloorViolationsForBlock,
  regionContainmentViolations,
  splitChunksToFit,
  buildEmphasisContext,
  pickEmphasis,
  scoreWord,
  claimTokenSet,
  EMPHASIS_THRESHOLD,
  BAR_CAPTION_POSITIONS,
  g9Violations,
  g9ViolationsForBlock,
  handleAnchor,
  textBoxBounds,
  textWidthPx,
  wrapLines,
  wrapWords,
} from "@mcos/render/captions";
import { FONT_FAMILIES, FONT_STACKS, embeddedFamilies, fontFaceCss } from "@mcos/render/fonts";
import { RenderPlanSchema, type RenderPlan } from "@mcos/render/plan";
import {
  TEMPLATES,
  TEMPLATE_IDS,
  getTemplate,
  templateHandleCornerForShot,
  templatePositionForShot,
  type Template,
} from "@mcos/render/templates";
import {
  BannerFitError,
  PUNCH_SCALE,
  captionFitPredicate,
  maxBannerLines,
  measureBannerLines,
  resolveTemplateStyle,
  worstCaseHookChars,
} from "@mcos/render/templates/resolve";
import { buildTemplatePlan } from "../../../scripts/studio/build-template-plan.js";
import {
  gateG2,
  gateG3,
  gateG4,
  gateG5,
  gateG6,
  gateG7,
  gateG8,
  gateG9,
} from "../../../scripts/qc-render.js";
import { gateG1a } from "@mcos/render/gates/g1a";

/**
 * Agent T's three templates (00_MASTER §6) — everything decidable without a
 * render. The renders themselves live under `docs/studio/evidence/`, produced
 * by `scripts/studio/render-evidence.ts` (ARCHITECTURE §12.10).
 *
 * The heart of this file is the last two describes: every gate that can be
 * scored from a plan, scored on a plan built from the SAME committed analyzer
 * output the evidence renders use. That is what stops a template from
 * regressing into an un-renderable state between renders — a render is slow
 * and manual, a plan is 0.5s.
 */

const WIDTH = 1080;
const HEIGHT = 1920;

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const inputsDir = path.join(repoRoot, "docs/studio/evidence/inputs");

type WordsJson = {
  durationSec: number;
  segments: { words: { word: string; start: number; end: number; rms?: number | null }[] }[];
};

function referenceInputs(): {
  words: { word: string; start: number; end: number; rms?: number | null }[];
  beats: { method: "beat_track" | "onset_env" | "constant_grid"; tempoBpm: number | null; beatTimesMs: number[]; gridQuality: number | null };
} {
  const words = JSON.parse(readFileSync(path.join(inputsDir, "reference-words.json"), "utf8")) as WordsJson;
  const beats = JSON.parse(readFileSync(path.join(inputsDir, "reference-beats.json"), "utf8"));
  return { words: words.segments.flatMap((s) => s.words), beats };
}

/** The clip's true container duration (01 §1). faster-whisper reports the
 *  duration it DECODED, which trails when the tail is silent. */
const REFERENCE_DURATION_SEC = 54.87;

function planFor(templateId: string, seed = 42): RenderPlan {
  const { words, beats } = referenceInputs();
  return buildTemplatePlan({
    templateId,
    words,
    durationSec: REFERENCE_DURATION_SEC,
    beats,
    seed,
    hook: "THE POWER OF OBSESSION",
    emphasisWord: "OBSESSION",
    handleText: "@PERFSTAQ",
    footage: { assetId: "reference-proxy", r2Key: "demo/reference-16x9-proxy.mp4" },
  });
}

describe("template registry", () => {
  it("ships exactly three templates, keyed by their own ids", () => {
    expect(TEMPLATE_IDS).toHaveLength(3);
    for (const id of TEMPLATE_IDS) expect(TEMPLATES[id].id).toBe(id);
  });

  it("is letterbox-only — §11.1 R2 defers `fill` to v2 with face detection", () => {
    for (const id of TEMPLATE_IDS) expect(TEMPLATES[id].framing).toBe("letterbox");
  });

  it("throws on an unknown template rather than falling back to a default", () => {
    // A silent default here would render the wrong template and pass every
    // gate — the failure mode §12.1 warns about, where nothing errors.
    expect(() => getTemplate("nope")).toThrow(/unknown template/);
  });

  it("differentiates the three on karaoke face, grade and rhythm", () => {
    const ts = TEMPLATE_IDS.map((id) => TEMPLATES[id]);

    // 02 §2.2: "Serif display face for statement content; condensed sans for
    // punchy/listicle content. Set per template."
    const karaokeFaces = ts.map((t) => t.typography.karaoke);
    expect(new Set(karaokeFaces).size).toBe(3);

    // 02 §6: "One look per template."
    const grades = ts.map((t) => JSON.stringify(t.grade));
    expect(new Set(grades).size).toBe(3);

    const rhythms = ts.map((t) => JSON.stringify(t.rhythm));
    expect(new Set(rhythms).size).toBe(3);

    const rotations = ts.map((t) => t.captionPositions.join(">"));
    expect(new Set(rotations).size).toBe(3);
  });

  it("pins the banner to display_condensed in all three (02 §2.1)", () => {
    for (const id of TEMPLATE_IDS) expect(TEMPLATES[id].typography.banner).toBe("display_condensed");
  });

  it("uses 02 §7's four position names and invents none", () => {
    for (const id of TEMPLATE_IDS) {
      for (const p of TEMPLATES[id].captionPositions) {
        expect(CAPTION_POSITIONS).toContain(p);
      }
    }
  });
});

describe("caption position rotation (02 §2.2, G6)", () => {
  it("never repeats a position twice in a row, for any template", () => {
    for (const id of TEMPLATE_IDS) {
      const t = TEMPLATES[id];
      for (let i = 0; i < 40; i++) {
        expect(templatePositionForShot(t, i)).not.toBe(templatePositionForShot(t, i + 1));
      }
    }
  });

  it("reaches ≥3 distinct positions within the first four shots (G6)", () => {
    for (const id of TEMPLATE_IDS) {
      const t = TEMPLATES[id];
      const seen = new Set([0, 1, 2, 3].map((i) => templatePositionForShot(t, i)));
      expect(seen.size).toBeGreaterThanOrEqual(3);
    }
  });

  it("alternates the handle between two corners, never static (02 §2.3)", () => {
    for (const id of TEMPLATE_IDS) {
      const t = TEMPLATES[id];
      const corners = [0, 1, 2, 3, 4, 5].map((i) => templateHandleCornerForShot(t, i));
      expect(new Set(corners).size).toBe(2);
      for (let i = 0; i < corners.length - 1; i++) expect(corners[i]).not.toBe(corners[i + 1]);
    }
  });
});

describe("embedded fonts", () => {
  it("embeds exactly 02 §7's three tokens", () => {
    expect(embeddedFamilies().sort()).toEqual(Object.values(FONT_FAMILIES).sort());
  });

  it("emits a @font-face per family, each a data: URL", () => {
    const css = fontFaceCss();
    for (const family of embeddedFamilies()) {
      expect(css).toContain(`font-family:"${family}"`);
    }
    expect(css.match(/url\("data:font\/ttf;base64,/g)).toHaveLength(3);
    // A remote URL here would reintroduce the delayRender hang the embedding
    // exists to prevent, and would make the render host-dependent (G13).
    expect(css).not.toMatch(/url\("https?:/);
  });

  it("names the embedded family FIRST in every stack, so fallbacks are only a degradation path", () => {
    for (const token of Object.keys(FONT_STACKS) as (keyof typeof FONT_STACKS)[]) {
      expect(FONT_STACKS[token].startsWith(`"${FONT_FAMILIES[token]}"`)).toBe(true);
    }
  });
});

describe("text measurement (the wrap predictor's foundation)", () => {
  // A regression pin. If a font is re-subset, re-instanced or swapped, these
  // move — and everything G9 concludes about wrapping moves with them. Better
  // to fail here, where the message says "the metrics changed", than in a
  // banner that silently starts wrapping.
  it("pins the measured width of a known string per face", () => {
    const size = TYPE_SCALE.banner * WIDTH; // 66.96px
    expect(Math.round(textWidthPx("THE POWER OF OBSESSION", size, "display_condensed"))).toBe(521);
    expect(Math.round(textWidthPx("THE POWER OF OBSESSION", size, "display_serif"))).toBe(914);
    expect(Math.round(textWidthPx("THE POWER OF OBSESSION", size, "body_sans"))).toBe(881);
  });

  it("shows the condensed face is ~43% narrower, which is the real difference between the templates", () => {
    // Not decoration: this ratio is why T2 fits more hook on one line than T1
    // and why its caption lines break differently. It is also the reason
    // per-template SIZE scaling was rejected — the faces differ in width, not
    // in optical size (cap heights are within 4%).
    const size = TYPE_SCALE.karaoke * WIDTH;
    const condensed = textWidthPx("ABCDEFGHIJ", size, "display_condensed");
    const serif = textWidthPx("ABCDEFGHIJ", size, "display_serif");
    expect(condensed / serif).toBeGreaterThan(0.5);
    expect(condensed / serif).toBeLessThan(0.65);
  });

  it("is monotonic in size and in length", () => {
    const a = textWidthPx("ABC", 40, "display_serif");
    expect(textWidthPx("ABC", 80, "display_serif")).toBeCloseTo(a * 2, 6);
    expect(textWidthPx("ABCD", 40, "display_serif")).toBeGreaterThan(a);
  });

  it("adds letter-spacing per character", () => {
    const plain = textWidthPx("ABCD", 100, "body_sans");
    const tracked = textWidthPx("ABCD", 100, "body_sans", 0.1);
    expect(tracked - plain).toBeCloseTo(4 * 0.1 * 100, 6);
  });

  it("wraps greedily, and puts an over-wide single word on its own line", () => {
    const size = 60;
    // A box that fits about two short words.
    const box = textWidthPx("AAA AAA", size, "body_sans") + 1;
    expect(wrapLines("AAA AAA AAA AAA", size, "body_sans", box)).toEqual(["AAA AAA", "AAA AAA"]);
    expect(wrapLines("AAAAAAAAAAAAAAAAAAAA", size, "body_sans", box)).toHaveLength(1);
  });

  it("measures karaoke text AS RENDERED — uppercase, like the composition draws it", () => {
    // ── The bug ─────────────────────────────────────────────────────────────
    // `Reel.tsx` sets `textTransform: uppercase` on every karaoke word, and
    // `textWidthPx` sums per-codepoint advances — so measuring the plan's
    // stored casing measured the wrong glyphs, short by 20-35%. Every karaoke
    // width read from it was wrong: G9's horizontal bound, the wrapped line
    // COUNT, and the block height that G9's vertical bound, the face floor and
    // §12.43's containment check are all derived from.
    //
    // It hid because the banner — the one layer checked against a rendered
    // frame — takes hook text that is already uppercase in the brief, so it
    // agreed either way (§12.34's shape). Caught by measuring accent pixels in
    // a real frame: a chunk every check called single-line wrapped to two on
    // screen and pushed its first line 23px up into the footage.
    const size = TYPE_SCALE.emphasis * WIDTH;
    const lower = textWidthPx("wondering", size, "display_serif");
    const upper = textWidthPx("WONDERING", size, "display_serif");
    expect(upper, "capitals must measure wider than lowercase in this face").toBeGreaterThan(lower);

    // What the wrapper actually uses is the UPPER width, whichever casing the
    // plan stored — so both spellings wrap identically.
    const box = upper - 1; // narrower than the uppercase word, wider than lower
    expect(box).toBeGreaterThan(lower);
    const asLower = wrapWords([{ text: "wondering", fontSizePx: size }], "display_serif", box, { wordGapPx: 0 });
    const asUpper = wrapWords([{ text: "WONDERING", fontSizePx: size }], "display_serif", box, { wordGapPx: 0 });
    expect(asLower.length).toBe(asUpper.length);

    // And the transform is load-bearing: two words that fit at lowercase
    // widths must NOT fit once uppercased, which is exactly the case that
    // wrapped on screen.
    const pair = [
      { text: "wondering", fontSizePx: size },
      { text: "what", fontSizePx: TYPE_SCALE.karaoke * WIDTH },
    ];
    const naive =
      textWidthPx("wondering", size, "display_serif") +
      textWidthPx("what", TYPE_SCALE.karaoke * WIDTH, "display_serif");
    const rendered =
      textWidthPx("WONDERING", size, "display_serif") +
      textWidthPx("WHAT", TYPE_SCALE.karaoke * WIDTH, "display_serif");
    const between = Math.floor((naive + rendered) / 2);
    expect(wrapWords(pair, "display_serif", between, { wordGapPx: 0 }).length, "must wrap at rendered widths").toBe(2);
  });

  it("measures a mixed-size chunk per word, and its height as per-line maxima", () => {
    // The exact case that made an over-strict G9 fail a chunk that fits:
    // only the emphasis word draws at 0.101·W, its neighbours at 0.075·W.
    const karaoke = TYPE_SCALE.karaoke * WIDTH;
    const emphasis = TYPE_SCALE.emphasis * WIDTH;
    const words = [
      { text: "To", fontSizePx: karaoke },
      { text: "remember", fontSizePx: emphasis },
      { text: "that", fontSizePx: karaoke },
    ];
    // A box narrow enough to force the wrap, stated explicitly. Deriving it
    // from an anchor's own box made this test depend on that anchor's x,
    // and widening `lower_left` to the safe margin (§12.16) silently turned
    // the chunk into one line — the assertion still "passed" its inequality
    // by measuring nothing. An explicit box keeps the test about the thing
    // it is named for.
    const box = 620;
    const lines = wrapWords(words, "display_serif", box, { wordGapPx: WIDTH * 0.02 });
    expect(lines.length).toBeGreaterThan(1);

    const uniform = emphasis * LINE_HEIGHT * lines.length;
    const measured = blockHeightPx(lines, LINE_HEIGHT);

    // Measuring every line at the emphasis size over-states the block, and
    // the difference is large enough to decide a gate.
    expect(measured).toBeLessThan(uniform);
    expect(uniform - measured).toBeGreaterThan(20);
  });
});

describe("banner wrap — ARCHITECTURE §12.11 Minor A", () => {
  it("allows exactly ONE banner line at 1080×1920, which is what the carve-out buys", () => {
    // Pins §12.7's geometry: BANNER_ANCHOR at y=0.10 with a 0.062·W face puts
    // a one-line block's top at 8.17% (inside the 8% exemption) and a
    // two-line block's at 6.34% (through it — the ~6.3% §12.11 names).
    expect(maxBannerLines(WIDTH, HEIGHT)).toBe(1);

    const size = TYPE_SCALE.banner * WIDTH;
    expect(g9Violations("banner", BANNER_ANCHOR, size, 1, WIDTH, HEIGHT)).toEqual([]);
    const two = g9Violations("banner", BANNER_ANCHOR, size, 2, WIDTH, HEIGHT);
    expect(two.length).toBeGreaterThan(0);
    expect(two.join(" ")).toMatch(/^top 0\.063/);
  });

  it("keeps the carve-out asymmetric — top only, and banner only (§12.7)", () => {
    const size = TYPE_SCALE.banner * WIDTH;
    // The same block, same place, as a karaoke layer: not exempt.
    expect(g9Violations("karaoke", BANNER_ANCHOR, size, 1, WIDTH, HEIGHT).length).toBeGreaterThan(0);
    expect(BANNER_TOP_MARGIN_RATIO).toBeLessThan(SAFE_MARGIN_RATIO);
  });

  it("accepts a hook that fits on one line", () => {
    for (const id of TEMPLATE_IDS) {
      expect(measureBannerLines(TEMPLATES[id], "THE POWER OF OBSESSION", WIDTH)).toBe(1);
      const style = resolveTemplateStyle(TEMPLATES[id], { width: WIDTH, height: HEIGHT, hookText: "THE POWER OF OBSESSION" });
      expect(style.bannerLines).toBe(1);
    }
  });

  it("REFUSES a hook long enough to wrap, loudly and with the measurement", () => {
    const long = "THE POWER OF OBSESSION AND WHY IT MATTERS MORE THAN TALENT EVER WILL";
    for (const id of TEMPLATE_IDS) {
      const t = TEMPLATES[id];
      expect(measureBannerLines(t, long, WIDTH)).toBeGreaterThan(1);
      let caught: BannerFitError | null = null;
      try {
        resolveTemplateStyle(t, { width: WIDTH, height: HEIGHT, hookText: long });
      } catch (e) {
        caught = e as BannerFitError;
      }
      expect(caught).toBeInstanceOf(BannerFitError);
      expect(caught!.maxLines).toBe(1);
      expect(caught!.lines).toBeGreaterThan(1);
      // The message must carry the numbers, not just "too long" — vague
      // failures are what 07 §2 refuses to accept from a reviewer, and a
      // machine's should be held to the same bar.
      expect(caught!.message).toContain(long);
      expect(caught!.message).toMatch(/wraps to \d+ line/);
    }
  });

  it("gives Agent B a worst-case hook cap it can put in the schema", () => {
    // Measured on "W", the widest glyph, so a cap set from it holds for ANY
    // hook rather than the average one (05 §1 is the contract; this is the
    // number the `hook_text` cap wants).
    for (const id of TEMPLATE_IDS) {
      const t = TEMPLATES[id];
      const n = worstCaseHookChars(t, WIDTH);
      expect(n).toBeGreaterThan(10);

      // The bound must be tight in both directions, and it has to be checked
      // on WIDTH, not on line count: a single unbroken word never wraps (it
      // overflows instead), so `measureBannerLines("WWWW…")` is 1 for any
      // length and would pass vacuously.
      const size = TYPE_SCALE.banner * WIDTH;
      const { left, right } = textBoxBounds(BANNER_ANCHOR, WIDTH);
      const box = right - left;
      const token = t.typography.banner;
      const tracking = t.typography.bannerTrackingEm;
      expect(textWidthPx("W".repeat(n), size, token, tracking)).toBeLessThanOrEqual(box);
      expect(textWidthPx("W".repeat(n + 1), size, token, tracking)).toBeGreaterThan(box);

      // And a real hook of that many characters must actually fit on one line.
      const hook = "WORD ".repeat(Math.floor(n / 5)).trim();
      expect(measureBannerLines(t, hook, WIDTH)).toBe(1);
    }
  });
});

describe("resolved template style (frozen onto the plan)", () => {
  it("resolves 02 §7's type scale exactly, with no per-template deviation", () => {
    for (const id of TEMPLATE_IDS) {
      const s = resolveTemplateStyle(TEMPLATES[id], { width: WIDTH, height: HEIGHT, hookText: "SHORT HOOK" });
      expect(s.sizes.banner).toBeCloseTo(TYPE_SCALE.banner * WIDTH, 9);
      expect(s.sizes.karaoke).toBeCloseTo(TYPE_SCALE.karaoke * WIDTH, 9);
      expect(s.sizes.emphasis).toBeCloseTo(TYPE_SCALE.emphasis * WIDTH, 9);
      expect(s.sizes.handle).toBeCloseTo(TYPE_SCALE.handle * WIDTH, 9);
    }
  });

  it("carries the metrics token alongside the CSS stack, so QC measures the drawn font", () => {
    for (const id of TEMPLATE_IDS) {
      const t = TEMPLATES[id];
      const s = resolveTemplateStyle(t, { width: WIDTH, height: HEIGHT, hookText: "SHORT HOOK" });
      expect(s.fontTokens.karaoke).toBe(t.typography.karaoke);
      expect(s.fonts.karaoke).toBe(FONT_STACKS[t.typography.karaoke]);
    }
  });

  it("uses 02 §4.2's punch depth, one value for all templates", () => {
    expect(PUNCH_SCALE).toBeCloseTo(0.06, 9);
    for (const id of TEMPLATE_IDS) {
      const s = resolveTemplateStyle(TEMPLATES[id], { width: WIDTH, height: HEIGHT, hookText: "SHORT HOOK" });
      expect(s.punchScale).toBeCloseTo(0.06, 9);
    }
  });

  it("gives every template the content region the zoom origin is derived against", () => {
    // `camera.ts` puts the zoom's `originY` on the chin line by calling
    // `faceFloorOriginY()` with the DEFAULT region ratio, because a camera has
    // no access to the template. That is only sound while every template
    // actually renders at that ratio — a template that shipped its own
    // `regionRatio` would move the region under a zoom origin still computed
    // for 0.625, and the chin would quietly stop being the fixed point
    // §12.19's whole fix depends on. Pinned here rather than papered over with
    // an unused parameter on `shotCamera`.
    for (const id of TEMPLATE_IDS) {
      const s = resolveTemplateStyle(TEMPLATES[id], { width: WIDTH, height: HEIGHT, hookText: "SHORT HOOK" });
      expect(s.content.regionRatio, `${id} region ratio`).toBeCloseTo(CONTENT_REGION_RATIO, 12);
    }
  });
});

describe("G9 safety of every template's own geometry", () => {
  it("keeps the handle inside the margins in both corners it visits", () => {
    for (const id of TEMPLATE_IDS) {
      const t = TEMPLATES[id];
      const s = resolveTemplateStyle(t, { width: WIDTH, height: HEIGHT, hookText: "SHORT HOOK" });
      for (const corner of t.handleCorners) {
        expect(g9Violations("handle", handleAnchor(corner), s.sizes.handle, 1, WIDTH, HEIGHT)).toEqual([]);
      }
    }
  });

  it("splits a realistic 3-word emphasised chunk, then clears every bound at every position", () => {
    // ── What changed, and why the split is the assertion ────────────────────
    // "MORE THAN WORK" with the middle word at emphasis size measures 200px
    // over two lines. Before §12.43 that was fine: the positions sat in the
    // video band, which had room. Now every position is in the 129.6px bottom
    // bar, so this chunk does not fit and the fit predicate splits it BEFORE a
    // position is assigned. The invariant is therefore not "a 3-word chunk
    // fits" — it does not — but "whatever the chunker actually emits fits".
    let rejectedBySomeTemplate = false;
    for (const id of TEMPLATE_IDS) {
      const t = TEMPLATES[id];
      const s = resolveTemplateStyle(t, { width: WIDTH, height: HEIGHT, hookText: "SHORT HOOK" });
      const fits = captionFitPredicate(t, WIDTH);
      const chunk = [{ word: "MORE" }, { word: "THAN" }, { word: "WORK" }];

      // Whether THIS chunk needs splitting is a property of the template's
      // face, not a universal: `staccato_condensed`'s condensed karaoke font
      // fits all three words on one line where the serif and sans do not.
      // Asserting the split for every template would be asserting the metrics,
      // so the invariant is the one below — whatever comes out, fits.
      rejectedBySomeTemplate ||= !fits(chunk);

      const pieces = splitChunksToFit(
        [chunk.map((w) => ({ word: w.word, startMs: 0, endMs: 1, rms: null }))],
        fits,
      );

      for (const piece of pieces) {
        for (const position of t.captionPositions) {
          const anchor = anchorFor(position);
          const { left, right } = textBoxBounds(anchor, WIDTH);
          // Widest case: the longest word draws at emphasis size, which is
          // what the predicate assumed when it accepted this piece.
          const words = piece.map((w, i) => ({
            text: w.word,
            fontSizePx: i === 0 ? s.sizes.emphasis : s.sizes.karaoke,
          }));
          const lines = wrapWords(words, s.fontTokens.karaoke, right - left, {
            wordGapPx: WIDTH * 0.02,
            trackingEm: s.tracking.karaoke,
          });
          const height = blockHeightPx(lines, LINE_HEIGHT);
          const where = `${id} @ ${position} "${piece.map((w) => w.word).join(" ")}" (${lines.length} lines, ${Math.round(height)}px)`;
          expect(lines.length, where).toBe(1);
          expect(g9ViolationsForBlock("karaoke", anchor, height, WIDTH, HEIGHT), where).toEqual([]);
          expect(faceFloorViolationsForBlock(anchor, height, HEIGHT), where).toEqual([]);
          expect(regionContainmentViolations(anchor, height, HEIGHT), where).toEqual([]);
        }
      }
    }

    // ...and the predicate is load-bearing rather than vacuously true: at
    // least one shipped template's metrics reject this chunk. Without this a
    // predicate that always returned `true` would pass everything above.
    expect(rejectedBySomeTemplate, "captionFitPredicate must actually reject something").toBe(true);
  });

  it("rejects a three-line chunk at EVERY bar position — and the chunker never makes one", () => {
    // ── This test was inverted, not deleted (§12.39's posture) ───────────────
    // It used to record which single position could hold a three-line block:
    // `center_low` failed G9's bottom, `center` failed the face floor, and
    // `lower_left` cleared both "by 17.0px and 5.8px". That was true of the
    // OLD geometry, where the positions sat in the video band at three
    // different heights.
    //
    // §12.43 moved every default position into the bottom bar, where the
    // usable height is 129.6px against a three-line block's 284.6px. So the
    // answer is now the same at every position — it fits nowhere — and the
    // interesting assertion moved: the chunker's fit predicate guarantees a
    // three-line chunk is never built in the first place, so this bound is a
    // backstop rather than a thing the rotation has to dodge.
    const s = resolveTemplateStyle(TEMPLATES.statement_serif, {
      width: WIDTH,
      height: HEIGHT,
      hookText: "SHORT HOOK",
    });
    const words = [
      { text: "EVERYTHING", fontSizePx: s.sizes.karaoke },
      { text: "COMPOUNDING", fontSizePx: s.sizes.emphasis },
      { text: "RELENTLESSLY", fontSizePx: s.sizes.karaoke },
    ];

    for (const position of BAR_CAPTION_POSITIONS) {
      const anchor = anchorFor(position);
      const { left, right } = textBoxBounds(anchor, WIDTH);
      const lines = wrapWords(words, s.fontTokens.karaoke, right - left, { wordGapPx: WIDTH * 0.02 });
      expect(lines.length, `${position} line count`).toBe(3);
      const height = blockHeightPx(lines, LINE_HEIGHT);
      expect(height, `${position} block height`).toBeCloseTo(284.6, 1);

      // Every bar position rejects it, and it is the BOTTOM margin that does
      // the rejecting — the block is too tall for the bar, not misplaced.
      const g9 = g9ViolationsForBlock("karaoke", anchor, height, WIDTH, HEIGHT);
      expect(g9.length, `${position} must fail G9`).toBeGreaterThan(0);
      expect(g9.join(" "), `${position} G9 reason`).toContain("bottom");
      // ...and it straddles the region edge, which is the §12.43 bound.
      expect(
        regionContainmentViolations(anchor, height, HEIGHT).length,
        `${position} must fail containment`,
      ).toBeGreaterThan(0);
    }

    // The predicate that makes the above unreachable in practice. Splitting
    // this chunk is what the plan builders do before a position is ever
    // assigned, so no rotation order can produce a three-line block.
    const fits = captionFitPredicate(TEMPLATES.statement_serif, WIDTH);
    expect(fits(words.map((w) => ({ word: w.text }))), "3 long words must NOT fit on one line").toBe(false);
    expect(fits([{ word: "MORE" }, { word: "THAN" }]), "2 short words must fit").toBe(true);
  });
});

describe("every template builds a plan that passes every plan-scorable gate", () => {
  // Built from the SAME committed analyzer output the evidence renders use
  // (docs/studio/evidence/inputs), so this suite and the frames on disk are
  // describing one thing.
  const plans = new Map<string, RenderPlan>();
  for (const id of TEMPLATE_IDS) plans.set(id, planFor(id));

  it.each(TEMPLATE_IDS)("%s — plan validates against the schema", (id) => {
    expect(() => RenderPlanSchema.parse(plans.get(id))).not.toThrow();
  });

  it.each(TEMPLATE_IDS)("%s — G1a beat lock ≥85%%", (id) => {
    const g = gateG1a(plans.get(id)!);
    expect(g.pass, JSON.stringify(g.measured)).toBe(true);
  });

  it.each(TEMPLATE_IDS)("%s — G2 cut density 25–40/min", (id) => {
    const g = gateG2(plans.get(id)!);
    expect(g.pass, `measured ${JSON.stringify(g.measured)}`).toBe(true);
  });

  it.each(TEMPLATE_IDS)("%s — G3 median shot 1.0–2.0s", (id) => {
    const g = gateG3(plans.get(id)!);
    expect(g.pass, `measured ${JSON.stringify(g.measured)}`).toBe(true);
  });

  it.each(TEMPLATE_IDS)("%s — G4 min shot ≥0.6s", (id) => {
    const g = gateG4(plans.get(id)!);
    expect(g.pass, `measured ${JSON.stringify(g.measured)}`).toBe(true);
  });

  it.each(TEMPLATE_IDS)("%s — G5 ≤3 words on screen", (id) => {
    expect(gateG5(plans.get(id)!).pass).toBe(true);
  });

  it.each(TEMPLATE_IDS)("%s — G6 ≥3 distinct caption positions", (id) => {
    expect(gateG6(plans.get(id)!).pass).toBe(true);
  });

  it.each(TEMPLATE_IDS)("%s — G7 micro-motion on 100%% of shots", (id) => {
    const g = gateG7(plans.get(id)!);
    expect(g.computable).toBe(true);
    expect(g.pass, JSON.stringify(g.measured)).toBe(true);
  });

  it.each(TEMPLATE_IDS)("%s — G8 ≤1 emphasis word per chunk", (id) => {
    expect(gateG8(plans.get(id)!).pass).toBe(true);
  });

  it.each(TEMPLATE_IDS)("%s — G9 safe margins, banner carve-out included", (id) => {
    const g = gateG9(plans.get(id)!);
    expect(g.computable).toBe(true);
    expect(g.pass, JSON.stringify(g.measured)).toBe(true);
  });

  it("produces three genuinely different edits from one piece of footage", () => {
    // The point of having three templates. If two of them cut the same
    // footage the same number of times, one of them is decoration.
    const cutCounts = TEMPLATE_IDS.map((id) => plans.get(id)!.cuts.length);
    expect(new Set(cutCounts).size).toBe(3);

    const faces = TEMPLATE_IDS.map((id) => plans.get(id)!.templateStyle!.fontTokens.karaoke);
    expect(new Set(faces).size).toBe(3);

    const grades = TEMPLATE_IDS.map((id) => JSON.stringify(plans.get(id)!.grade));
    expect(new Set(grades).size).toBe(3);
  });

  it("is deterministic — the same seed rebuilds a byte-identical plan (G13)", () => {
    for (const id of TEMPLATE_IDS) {
      expect(JSON.stringify(planFor(id, 42))).toBe(JSON.stringify(plans.get(id)));
    }
  });

  it("declares letterbox framing on every plan (§11.1 R2)", () => {
    for (const id of TEMPLATE_IDS) expect(plans.get(id)!.framing).toBe("letterbox");
  });

  it("carries no decoration field the schema could smuggle in (ADR-4)", () => {
    // ADR-4's enforcement is "absence in the contract, not a lint rule". This
    // is that absence, asserted: if someone re-adds an `enter`/`overlay`/
    // `sfx` field to the schema, a plan can carry it and this fails.
    for (const id of TEMPLATE_IDS) {
      const raw = JSON.parse(JSON.stringify(plans.get(id)));
      const keys = new Set(Object.keys(raw));
      for (const banned of ["enter", "overlay", "broll", "sfx", "accent", "transition"]) {
        expect(keys.has(banned), `plan carries banned key "${banned}"`).toBe(false);
      }
      for (const cut of raw.cuts) {
        expect(Object.keys(cut).some((k) => ["enter", "transition", "sfx"].includes(k))).toBe(false);
      }
    }
  });
});

/**
 * ARCHITECTURE §12.41 — the seed sweep the ruling requires.
 *
 * `editorial_sans` shipped a rhythm curve centred ~26–27 cuts/min against
 * G2's 25 floor: about 5% of margin, so whether it passed was a **seed draw**.
 * It failed 3 of 8 seeds on the locked-off fixture and 1 of 8 on the reference,
 * and nothing caught it because the committed evidence happens to use seed 42,
 * which passes. Production uses `planSeed(job)`, which is arbitrary.
 *
 * A single-seed test cannot see this class of defect at all — that is the whole
 * point. Fixed seed SET, both clips, all three rhythm gates: tuning one band
 * into range while pushing another out is the failure mode a cuts-only sweep
 * would wave through.
 */
describe("rhythm gates hold across seeds, not just the evidence seed (§12.41)", () => {
  const SEEDS = [1, 7, 42, 99, 123, 777, 2024, 31337] as const;

  function rhythmOf(plan: RenderPlan) {
    const durations = plan.cuts.map((c) => (c.outputEndMs - c.outputStartMs) / 1000).sort((a, b) => a - b);
    return {
      cutsPerMin: (plan.cuts.length - 1) / (plan.durationInFrames / plan.fps / 60),
      median: durations[durations.length >> 1]!,
      min: durations[0]!,
    };
  }

  it.each(TEMPLATE_IDS)("%s — every seed lands inside G2, G3 and G4", (id) => {
    const outOfBand: string[] = [];
    for (const seed of SEEDS) {
      const plan = planFor(id, seed);
      const { cutsPerMin, median, min } = rhythmOf(plan);
      const problems: string[] = [];
      if (cutsPerMin < 25 || cutsPerMin > 40) problems.push(`G2 ${cutsPerMin.toFixed(1)}/min`);
      if (median < 1.0 || median > 2.0) problems.push(`G3 median ${median.toFixed(2)}s`);
      if (min < 0.6) problems.push(`G4 min ${min.toFixed(2)}s`);
      if (problems.length) outOfBand.push(`seed ${seed}: ${problems.join(", ")}`);
    }
    expect(outOfBand, `${id} out of band on ${outOfBand.length}/${SEEDS.length} seeds`).toEqual([]);
  });

  it("would have caught the defect it was written for", () => {
    // Guards the guard. `editorial_sans`'s OLD curve — the one that shipped —
    // is re-run here through the same planner. If this ever stops producing an
    // out-of-band seed, the sweep has lost its teeth (a wider band, a changed
    // planner) and the test above is no longer evidence of anything.
    const { words, beats } = referenceInputs();
    const offBand = SEEDS.filter((seed) => {
      const plan = buildTemplatePlan({
        templateId: "editorial_sans",
        words,
        durationSec: REFERENCE_DURATION_SEC,
        beats,
        seed,
        hook: "THE POWER OF OBSESSION",
        emphasisWord: "OBSESSION",
        handleText: "@PERFSTAQ",
        footage: { assetId: "reference-proxy", r2Key: "demo/reference-16x9-proxy.mp4" },
        // The pre-§12.41 curve, verbatim.
        rhythm: { establishSec: [2.8, 3.6], accelerateSec: [1.1, 1.6], holdSec: [3.8, 4.6], burstShots: [3, 4] },
      });
      const { cutsPerMin } = rhythmOf(plan);
      return cutsPerMin < 25 || cutsPerMin > 40;
    });
    expect(offBand.length, "the old curve must still fail at least one seed").toBeGreaterThan(0);
  });
});

/** ARCHITECTURE §12.43 — emphasis is editorial, not acoustic. */
describe("stopword emphasis floor (§12.43)", () => {
  it("never lets loudness alone nominate a stopword", () => {
    // A speaker leaning hard on "you" against ten ordinary words: z ≈ 3.2, so
    // the audio term contributes ≈ +4.8 against the stopword's −2.0 and the
    // word clears the 1.0 threshold comfortably ON VOLUME ALONE. That is the
    // shape of the defect — ordinary spoken stress read as editorial emphasis.
    const quiet = Array.from({ length: 10 }, (_, i) => ({
      word: `word${i}`,
      startMs: i * 100,
      endMs: i * 100 + 80,
      rms: 0.1,
    }));
    const loudYou = { word: "you", startMs: 2000, endMs: 2200, rms: 0.9 };
    const ctx = buildEmphasisContext([...quiet, loudYou], ["compound slowly"]);

    // The scorer still rates it above threshold — so the block below is the
    // FLOOR doing the work, not an incidentally low score.
    expect(scoreWord(loudYou, 1, ctx)).toBeGreaterThan(EMPHASIS_THRESHOLD);
    expect(pickEmphasis([loudYou], ctx, 1), "a loud stopword must not be emphasised").toBeNull();
  });

  it("still emphasises a contrast word, which IS a stopword-shaped exception", () => {
    // §12.17 recorded "not" as a correct emphasis (CONTRAST_WORDS, +0.8).
    // The floor must not undo that.
    const ctx = buildEmphasisContext([{ word: "not", startMs: 0, endMs: 200, rms: 0.5 }], ["do not compound"]);
    expect(pickEmphasis([{ word: "not", startMs: 0, endMs: 200, rms: 0.9 }], ctx, 1)).toBe(0);
  });

  it("drops stopwords from the claim-token set, the heaviest term in the scorer", () => {
    // `appears_in_claim_text` weighs 2.0 and is meant to mean "the approved
    // claim's payload". Nearly every claim contains "is" and "the".
    const tokens = claimTokenSet(["Gravity is one of the reasons we age"]);
    expect(tokens.has("gravity")).toBe(true);
    expect(tokens.has("reasons")).toBe(true);
    for (const stop of ["is", "of", "the", "we", "one"]) {
      expect(tokens.has(stop), `"${stop}" must not count as claim payload`).toBe(false);
    }
  });
});
