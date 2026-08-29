import { BANNER_ANCHOR, CONTENT_REGION_RATIO, TYPE_SCALE, anchorFor, g9Violations, textBoxBounds } from "../captions/layout.js";
import { lineCount, textWidthPx, makeSingleLineFitPredicate } from "../captions/measure.js";
import { fontStack } from "../fonts/index.js";
import type { MetricToken } from "../fonts/metrics.generated.js";
import type { TemplateStyle } from "../plan.js";
import type { Template } from "./index.js";

/**
 * resolve.ts — a Template becomes concrete pixels, and the banner is proved
 * to fit before anything renders.
 *
 * Kept separate from `templates/index.ts` so the registry stays plain data
 * that anything can import without pulling in the layout and font modules.
 */

/** 02 §4.2 — "scale +6% over 8 frames". One value, not a template knob:
 *  the spec pins it, and a punch that varies per template is decoration
 *  masquerading as design. */
export const PUNCH_SCALE = 0.06;

/**
 * Thrown when a hook cannot be rendered without breaking G9's banner
 * carve-out. Named so callers (a plan builder, later `plan.build`) can map it
 * onto 03 §7's `plan_infeasible` rather than treating it as a crash.
 */
export class BannerFitError extends Error {
  readonly hookText: string;
  readonly lines: number;
  readonly maxLines: number;
  readonly violations: string[];

  constructor(hookText: string, lines: number, maxLines: number, violations: string[]) {
    super(
      `banner hook does not fit: "${hookText}" wraps to ${lines} line(s) at the banner type size, ` +
        `but only ${maxLines} fit inside G9's banner carve-out ` +
        `(ARCHITECTURE §12.7 — top edge exempt to 8% for the banner ONLY). ` +
        `Violations at ${lines} lines: ${violations.join("; ") || "none at this line count"}. ` +
        `Shorten the hook, or lower BANNER_ANCHOR — but lowering it moves the hook off the ` +
        `letterbox bar and over the video, which is a different decision than it looks.`,
    );
    this.name = "BannerFitError";
    this.hookText = hookText;
    this.lines = lines;
    this.maxLines = maxLines;
    this.violations = violations;
  }
}

const METRIC_TOKEN: Record<string, MetricToken> = {
  display_condensed: "display_condensed",
  display_serif: "display_serif",
  body_sans: "body_sans",
};

/**
 * How many lines the banner would occupy, measured — not assumed.
 *
 * The box the banner wraps inside is `textBoxBounds` of its own anchor, which
 * is the same geometry G9 scores and the same geometry the composition lays
 * out. Deriving all three from one function is the point: the §12.7 review
 * found the vertical half of G9 unasserted precisely because the check and
 * the layout had drifted into two different ideas of where text goes.
 */
export function measureBannerLines(template: Template, hookText: string, width: number): number {
  const size = TYPE_SCALE.banner * width;
  const { left, right } = textBoxBounds(BANNER_ANCHOR, width);
  return lineCount(hookText, size, METRIC_TOKEN[template.typography.banner]!, right - left, {
    trackingEm: template.typography.bannerTrackingEm,
  });
}

/**
 * The largest line count that still satisfies G9 for the banner at this
 * width/height. Derived from `g9Violations` rather than hardcoded to 1, so if
 * someone later lowers the banner or shrinks the type, the headroom that
 * creates is actually usable and the constant cannot go stale.
 */
export function maxBannerLines(width: number, height: number, limit = 4): number {
  const size = TYPE_SCALE.banner * width;
  let best = 0;
  for (let lines = 1; lines <= limit; lines++) {
    if (g9Violations("banner", BANNER_ANCHOR, size, lines, width, height).length === 0) best = lines;
    else break;
  }
  return best;
}

/**
 * Resolve a template against a frame size and a hook, or throw.
 *
 * **This is where ARCHITECTURE §12.11's Minor A is closed.** The banner's
 * wrap count is measured from real font metrics and checked against the G9
 * carve-out; a hook too long for one line fails LOUDLY here, at plan build,
 * instead of rendering ink at ~6.3% and passing a gate that only ever
 * asserted a single line. Agent B caps `hook_text` at the ContentBrief
 * schema; this is the assertion that makes the cap's absence detectable
 * rather than invisible, and it does not depend on B having landed.
 */
export function resolveTemplateStyle(
  template: Template,
  opts: { width: number; height: number; hookText?: string | null },
): TemplateStyle {
  const { width, height } = opts;

  let bannerLines = 1;
  if (opts.hookText) {
    const measured = measureBannerLines(template, opts.hookText, width);
    const allowed = maxBannerLines(width, height);
    if (measured > allowed) {
      const size = TYPE_SCALE.banner * width;
      throw new BannerFitError(
        opts.hookText,
        measured,
        allowed,
        g9Violations("banner", BANNER_ANCHOR, size, measured, width, height),
      );
    }
    bannerLines = measured;
  }

  const t = template.typography;
  return {
    templateId: template.id,
    templateVersion: template.version,
    fonts: {
      banner: fontStack(t.banner),
      karaoke: fontStack(t.karaoke),
      handle: fontStack(t.handle),
    },
    fontTokens: { banner: t.banner, karaoke: t.karaoke, handle: t.handle },
    // 02 §7's tokens, unmodified — see the note in templates/index.ts on why
    // the three faces' cap heights make per-template scaling unjustified.
    sizes: {
      banner: TYPE_SCALE.banner * width,
      karaoke: TYPE_SCALE.karaoke * width,
      emphasis: TYPE_SCALE.emphasis * width,
      handle: TYPE_SCALE.handle * width,
    },
    tracking: {
      banner: t.bannerTrackingEm,
      karaoke: t.karaokeTrackingEm,
      handle: t.handleTrackingEm,
    },
    bannerLines,
    punchScale: PUNCH_SCALE,
    content: {
      regionRatio: CONTENT_REGION_RATIO,
      cropX: template.crop?.x ?? 0.5,
      cropY: template.crop?.y ?? 0.5,
    },
  };
}

/**
 * The longest hook this template can carry on one line, in characters, found
 * by bisection on the real metrics.
 *
 * Exported for Agent B: `05_BRIEF_INTEGRATION` §1 is the contract, and the
 * ContentBrief schema's `hook_text` cap wants a number rather than a guess.
 * It is deliberately a *worst-case* figure — measured on capital "W", the
 * widest glyph — so a cap set from it holds for any hook, not just the
 * average one. Real hooks fit considerably more; this is the bound that never
 * needs revisiting.
 */
export function worstCaseHookChars(template: Template, width: number): number {
  const size = TYPE_SCALE.banner * width;
  const { left, right } = textBoxBounds(BANNER_ANCHOR, width);
  const token = METRIC_TOKEN[template.typography.banner]!;
  // Measured directly rather than by search: a single unbroken run of "W"s
  // has no wrap opportunity, so a bisection on line count would never find a
  // break and would run to its guard. The bound is just how many of the
  // widest glyph fit across the box.
  const perChar = textWidthPx("W", size, token, template.typography.bannerTrackingEm);
  return Math.floor((right - left) / perChar);
}

/**
 * §12.43 — the `fits` predicate for this template at this width.
 *
 * Built here rather than at each call site because there are two plan builders
 * (`domain/studio/plan-builder.ts` and `scripts/studio/build-template-plan.ts`)
 * and a predicate that disagreed between them would put different captions in
 * the committed evidence than in the product — the drift §12.32 warns about,
 * in the one place it would be least visible.
 *
 * The box is the NARROWEST of the template's own rotation positions, so a
 * chunk that fits is placeable wherever the rotation happens to send it. All
 * three bar positions are currently the same 0.76·W, but taking the minimum
 * means adding a narrower position cannot silently start wrapping captions.
 */
export function captionFitPredicate(
  template: Template,
  width: number,
): (words: { word: string }[]) => boolean {
  const boxWidthPx = Math.min(
    ...template.captionPositions.map((p) => {
      const { left, right } = textBoxBounds(anchorFor(p), width);
      return right - left;
    }),
  );
  return makeSingleLineFitPredicate({
    karaokePx: TYPE_SCALE.karaoke * width,
    emphasisPx: TYPE_SCALE.emphasis * width,
    token: METRIC_TOKEN[template.typography.karaoke]!,
    trackingEm: template.typography.karaokeTrackingEm,
    // The composition lays the chunk out as a flex row with this gap.
    wordGapPx: width * 0.02,
    boxWidthPx,
  });
}
