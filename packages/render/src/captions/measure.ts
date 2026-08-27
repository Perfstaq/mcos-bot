import { FONT_METRICS, type MetricToken } from "../fonts/metrics.generated.js";

/**
 * measure.ts — how wide a string is, and therefore how many lines it takes.
 *
 * ── Why this exists (ARCHITECTURE §12.11, Minor A) ──────────────────────────
 * §12.7 carved out G9's top margin for the persistent banner: it may sit as
 * high as 8% where every other layer is bound at 12%. `BANNER_ANCHOR` is
 * pinned at y=0.10 so that a ONE-LINE banner's block top lands at 8.2%,
 * inside the carve-out. The review that produced §12.11 noticed the carve-out
 * is asserted at one line only: a hook long enough to wrap doubles the block
 * height, and a two-line banner centred at 0.10 puts ink at ~6.3% — through
 * the exemption, with nothing to catch it. `buildBanner` accepts any string
 * and the composition wraps happily.
 *
 * So: measure the text, predict the wrap, and refuse to build a plan whose
 * banner would breach the carve-out. The assertion belongs at plan build
 * because that is the last point where failing is cheap — after it, the next
 * thing that notices is a human looking at a rendered frame, which is exactly
 * how the §12.9 bug survived to a render.
 *
 * ── Why an estimate is legitimate here ──────────────────────────────────────
 * There is no browser at plan-build time, so this cannot be a layout query.
 * It does not need to be. The advances come from the very font binaries the
 * renderer draws with (`metrics.generated.ts`, read out of the instanced
 * subsets), and kerning — the only term omitted — can only ever pull glyphs
 * CLOSER. So this over-estimates, and a wrap predictor that over-estimates
 * fails a borderline hook early rather than passing one that then breaks the
 * gate. Erring is safe in exactly one direction and this errs in that one.
 *
 * The margin is checked, not assumed: `studio-templates.test.ts` pins the
 * measured width of a known string against the value the renderer actually
 * produced, so a font swap that moved the metrics could not pass silently.
 */

/** Advance width of one string at `fontSizePx`, in pixels, ignoring kerning. */
export function textWidthPx(
  text: string,
  fontSizePx: number,
  token: MetricToken,
  trackingEm = 0,
): number {
  const table = FONT_METRICS[token];
  let units = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    const w = cp === undefined ? table.fallback : ((table.widths as Record<number, number>)[cp] ?? table.fallback);
    units += w;
  }
  // Tracking is applied per character (CSS letter-spacing adds after every
  // glyph, the trailing one included — counting it is the conservative read).
  return (units / 1000) * fontSizePx + [...text].length * trackingEm * fontSizePx;
}

export type WrapOptions = {
  /**
   * Space between words. Omit for normal inline text, where the space glyph's
   * own advance is the separator. The karaoke layer lays words out in a flex
   * row with a `gap`, where the space glyph is absent and the gap is the
   * separator — pass it there.
   */
  wordGapPx?: number;
  trackingEm?: number;
};

/**
 * Greedy word wrap — the same algorithm CSS `normal` word wrapping uses for
 * text with no hyphenation opportunities: fill a line until the next word
 * would overflow, then break. A single word wider than the box gets its own
 * line and overflows it (which browsers also do, and which the G9 check will
 * then catch as a horizontal violation rather than silently hiding).
 */
export function wrapLines(
  text: string,
  fontSizePx: number,
  token: MetricToken,
  maxWidthPx: number,
  opts: WrapOptions = {},
): string[] {
  const trackingEm = opts.trackingEm ?? 0;
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return [];

  const sep =
    opts.wordGapPx !== undefined ? opts.wordGapPx : textWidthPx(" ", fontSizePx, token, trackingEm);

  const lines: string[] = [];
  let current = "";
  let currentWidth = 0;

  for (const word of words) {
    const w = textWidthPx(word, fontSizePx, token, trackingEm);
    if (!current) {
      current = word;
      currentWidth = w;
      continue;
    }
    if (currentWidth + sep + w <= maxWidthPx) {
      current = `${current} ${word}`;
      currentWidth += sep + w;
    } else {
      lines.push(current);
      current = word;
      currentWidth = w;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * A karaoke chunk's words, each at the size it actually draws at.
 *
 * 02 §7 gives the emphasis word 0.101·W and its neighbours 0.075·W, so a
 * chunk is a mixed-size line and its block height is the sum of per-line
 * MAXIMA, not `size × lines`. Treating it as uniform over-estimates height by
 * up to 35% and width by nearly as much — enough to fail a chunk that fits.
 */
export type MeasuredWord = { text: string; fontSizePx: number };

/**
 * Wrap mixed-size words into lines, the way the composition's flex row does:
 * words separated by a fixed `wordGapPx` (a `gap`, not a space glyph), broken
 * when the next word would overflow the box.
 */
export function wrapWords(
  words: MeasuredWord[],
  token: MetricToken,
  maxWidthPx: number,
  opts: { wordGapPx: number; trackingEm?: number },
): MeasuredWord[][] {
  const trackingEm = opts.trackingEm ?? 0;
  const lines: MeasuredWord[][] = [];
  let current: MeasuredWord[] = [];
  let currentWidth = 0;

  for (const word of words) {
    const w = textWidthPx(word.text, word.fontSizePx, token, trackingEm);
    if (!current.length) {
      current = [word];
      currentWidth = w;
      continue;
    }
    if (currentWidth + opts.wordGapPx + w <= maxWidthPx) {
      current.push(word);
      currentWidth += opts.wordGapPx + w;
    } else {
      lines.push(current);
      current = [word];
      currentWidth = w;
    }
  }
  if (current.length) lines.push(current);
  return lines;
}

/**
 * The rendered height of wrapped mixed-size lines: each line is as tall as
 * its largest word, which is how a flex row with `flex-wrap` lays out.
 */
export function blockHeightPx(lines: MeasuredWord[][], lineHeight: number): number {
  return lines.reduce((sum, line) => sum + Math.max(...line.map((w) => w.fontSizePx)) * lineHeight, 0);
}

/** How many lines `text` occupies in a box `maxWidthPx` wide. */
export function lineCount(
  text: string,
  fontSizePx: number,
  token: MetricToken,
  maxWidthPx: number,
  opts: WrapOptions = {},
): number {
  return Math.max(1, wrapLines(text, fontSizePx, token, maxWidthPx, opts).length);
}
