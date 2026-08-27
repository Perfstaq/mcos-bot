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

  it("keeps a realistic 3-word emphasised chunk inside the margins at every position", () => {
    // Ordinary caption words, one at emphasis size — the shape real chunks
    // take. These reach two lines at most, which every position must hold.
    for (const id of TEMPLATE_IDS) {
      const t = TEMPLATES[id];
      const s = resolveTemplateStyle(t, { width: WIDTH, height: HEIGHT, hookText: "SHORT HOOK" });
      for (const position of t.captionPositions) {
        const anchor = anchorFor(position);
        const { left, right } = textBoxBounds(anchor, WIDTH);
        const words = [
          { text: "MORE", fontSizePx: s.sizes.karaoke },
          { text: "THAN", fontSizePx: s.sizes.emphasis },
          { text: "WORK", fontSizePx: s.sizes.karaoke },
        ];
        const lines = wrapWords(words, s.fontTokens.karaoke, right - left, {
          wordGapPx: WIDTH * 0.02,
          trackingEm: s.tracking.karaoke,
        });
        const height = blockHeightPx(lines, LINE_HEIGHT);
        expect(lines.length).toBeLessThanOrEqual(2);
        expect(
          g9ViolationsForBlock("karaoke", anchor, height, WIDTH, HEIGHT),
          `${id} @ ${position} (${lines.length} lines, ${Math.round(height)}px)`,
        ).toEqual([]);
      }
    }
  });

  it("scores a three-line chunk at EVERY position — the limit, asserted rather than hidden", () => {
    // Three long words with one at emphasis size wrap to three lines (284.6px).
    // This used to be pinned at `center_low` alone and titled "does not fit
    // anywhere". Scoring all three positions, as §12.19 required, shows that
    // claim was never measured — it is true of two positions and false of the
    // third, and the single-position test could not tell the difference.
    //
    // The two bounds catch DIFFERENT positions, which is the whole reason
    // §12.19 asked for the face floor:
    //
    //   center_low  bottom 0.8921 → G9. Clears the chin by 51.6px.
    //   center      top    0.7109 → face floor. Clears every G9 margin —
    //                               this is the block that used to pass
    //                               silently with text across a face.
    //   lower_left  top    0.7259, bottom 0.8741 → clears both, by 17.0px and
    //                               5.8px. It genuinely fits.
    //
    // The honest thing is to pin what each position does, not to tune an
    // anchor until a "fits nowhere" headline came true — that is exactly the
    // move that put a caption on a subject's mouth (§12.16).
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

    // Which bound rejects a three-line block, per position. `null` means the
    // block fits there — recorded as a fact, not smoothed over.
    const expected: Record<string, "g9" | "faceFloor" | null> = {
      center_low: "g9",
      center: "faceFloor",
      lower_left: null,
    };

    for (const position of CAPTION_POSITIONS) {
      const anchor = anchorFor(position);
      const { left, right } = textBoxBounds(anchor, WIDTH);
      const lines = wrapWords(words, s.fontTokens.karaoke, right - left, { wordGapPx: WIDTH * 0.02 });
      expect(lines.length, `${position} line count`).toBe(3);

      const height = blockHeightPx(lines, LINE_HEIGHT);
      expect(height, `${position} block height`).toBeCloseTo(284.6, 1);

      const g9 = g9ViolationsForBlock("karaoke", anchor, height, WIDTH, HEIGHT);
      const face = faceFloorViolationsForBlock(anchor, height, HEIGHT);

      if (expected[position] === "g9") {
        expect(g9.length, `${position} must fail G9`).toBeGreaterThan(0);
        expect(g9.join(" "), `${position} G9 reason`).toContain("bottom");
        expect(face, `${position} clears the face`).toEqual([]);
      } else if (expected[position] === "faceFloor") {
        // The case §12.19 names: inside every margin, on top of the subject.
        expect(g9, `${position} clears G9`).toEqual([]);
        expect(face.length, `${position} must fail the face floor`).toBeGreaterThan(0);
      } else {
        expect(g9, `${position} clears G9`).toEqual([]);
        expect(face, `${position} clears the face`).toEqual([]);
      }
    }

    // Three lines therefore survive at exactly one of three positions, so
    // whether such a chunk is safe is decided by the shot's position rotation.
    // Nothing in the chunker prevents one (G5 bounds WORDS, not lines), so
    // this is the gate's job and gateG9 now scores both bounds on every chunk.
    const survives = CAPTION_POSITIONS.filter((p) => expected[p] === null);
    expect(survives).toEqual(["lower_left"]);
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
