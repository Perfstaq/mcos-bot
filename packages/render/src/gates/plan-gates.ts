import { cutTimesMs, type RenderPlan } from "../plan.js";
import type { GateResult } from "./types.js";
import {
  BANNER_ANCHOR,
  BANNER_TOP_MARGIN_RATIO,
  CONTENT_REGION_RATIO,
  FACE_FLOOR_RATIO,
  LINE_HEIGHT,
  TYPE_SCALE,
  blockHeightPx,
  faceFloorViolationsForBlock,
  g9Violations,
  g9ViolationsForBlock,
  handleAnchor,
  regionContainmentViolations,
  textBoxBounds,
  wrapWords,
} from "../captions/index.js";
import { MIN_VISIBLE_SCALE_DELTA } from "../motion/index.js";

/**
 * plan-gates.ts — the hard gates decidable from a RenderPlan alone.
 *
 * ── Why these live here and not in `scripts/qc-render.ts` (ARCHITECTURE §12.42)
 * ADR-8's posture is that a plan failing its gate is rejected at `plan.build`
 * "so it never costs a render". That was implemented for G1a only — which is
 * why `gates/g1a.ts` already existed here — while G2–G10 stayed inside the QC
 * script, reachable only after an MP4 existed. §12.41 is what that cost: a
 * plan that could not pass G2 was materialised and would have burned a full
 * render before anything noticed.
 *
 * §12.6 had already given the argument for this file: G7 and G9 were made
 * plan-decidable *deliberately*, on the grounds that "a gate that needed a
 * rasteriser could not run at plan.build, which is where a failing plan should
 * be rejected". This is that sentence finally being true of the code.
 *
 * `qc-render.ts` re-exports every one of these, so the QC report still scores
 * the same gates from the same implementations — one definition, two callers,
 * which is the arrangement §12.32 says to prefer over two copies that "agree
 * by construction of having been written from the same ruling".
 *
 * G11 (loudness), G12 (output spec) and G13 (checksum) are NOT here: they read
 * the rendered file and genuinely cannot be known before it exists.
 */

export function gateG2(plan: RenderPlan): GateResult {
  const cuts = cutTimesMs(plan);
  const minutes = plan.durationInFrames / plan.fps / 60;
  const perMin = minutes > 0 ? cuts.length / minutes : 0;
  return {
    id: "G2",
    name: "Cut density",
    hard: true,
    computable: true,
    pass: perMin >= 25 && perMin <= 40,
    measured: Math.round(perMin * 10) / 10,
    target: "25-40 cuts/minute",
  };
}

function shotDurationsSec(plan: RenderPlan): number[] {
  return plan.cuts.map((c) => (c.outputEndMs - c.outputStartMs) / 1000).filter((d) => d > 0);
}

export function gateG3(plan: RenderPlan): GateResult {
  const durations = shotDurationsSec(plan).sort((a, b) => a - b);
  const mid = Math.floor(durations.length / 2);
  const median = durations.length ? (durations.length % 2 ? durations[mid]! : (durations[mid - 1]! + durations[mid]!) / 2) : 0;
  return { id: "G3", name: "Shot length (median)", hard: true, computable: true, pass: median >= 1.0 && median <= 2.0, measured: Math.round(median * 100) / 100, target: "1.0-2.0s" };
}

export function gateG4(plan: RenderPlan): GateResult {
  const durations = shotDurationsSec(plan);
  const min = durations.length ? Math.min(...durations) : 0;
  return { id: "G4", name: "Min shot length", hard: true, computable: true, pass: min >= 0.6, measured: Math.round(min * 100) / 100, target: "≥0.6s" };
}

export function gateG5(plan: RenderPlan): GateResult {
  const max = plan.captions.length ? Math.max(...plan.captions.map((c) => c.words.length)) : 0;
  return { id: "G5", name: "Caption density", hard: true, computable: true, pass: max <= 3, measured: max, target: "≤3 words visible simultaneously" };
}

export function gateG6(plan: RenderPlan): GateResult {
  const distinct = new Set(plan.captions.map((c) => c.position)).size;
  return { id: "G6", name: "Caption position variance", hard: true, computable: true, pass: distinct >= 3, measured: distinct, target: "≥3 distinct positions" };
}

export function gateG8(plan: RenderPlan): GateResult {
  // The schema (CaptionChunkSchema: a single nullable emphasisWordIndex, not
  // a count) already makes >1 emphasis word per chunk unrepresentable — this
  // recomputes the true definition anyway rather than trusting the type,
  // the same "don't trust the call site" discipline append-only.ts uses.
  const violations = plan.captions.filter((c) => c.emphasisWordIndex !== null && c.emphasisWordIndex >= c.words.length).length;
  return { id: "G8", name: "Emphasis", hard: true, computable: true, pass: violations === 0, measured: { chunks: plan.captions.length, outOfRangeEmphasis: violations }, target: "≤1 emphasis word per chunk (schema-enforced) and it must index a real word" };
}

// --- G10: word integrity (needs the footage's own transcript) --------------
export type SourceWord = { word: string; start: number; end: number };
export type WordsFile = { segments: { words: SourceWord[] }[] };

function isStrictlyInsideAWord(tSec: number, words: SourceWord[]): boolean {
  return words.some((w) => tSec > w.start && tSec < w.end);
}

export function gateG10(plan: RenderPlan, wordsFile: WordsFile | null): GateResult {
  if (!wordsFile) {
    return { id: "G10", name: "Word integrity", hard: true, computable: false, pass: null, measured: null, target: "0 cuts landing mid-word", note: "no --words file given — pass --words <MediaAnalysis.words JSON> for the footage asset" };
  }
  const words = wordsFile.segments.flatMap((s) => s.words);
  let violations = 0;
  for (const cut of plan.cuts) {
    if (isStrictlyInsideAWord(cut.sourceInMs / 1000, words)) violations++;
    if (isStrictlyInsideAWord(cut.sourceOutMs / 1000, words)) violations++;
  }
  return { id: "G10", name: "Word integrity", hard: true, computable: true, pass: violations === 0, measured: { violations, cutsChecked: plan.cuts.length }, target: "0 cuts landing mid-word (source in/out points)" };
}

export function gateG7(plan: RenderPlan): GateResult {
  const id = "G7";
  const name = "Micro-motion";
  const target = "100% of shots have scale delta >1%";

  const withoutMotion = plan.cuts.filter((c) => !c.motion);
  if (withoutMotion.length === plan.cuts.length) {
    return {
      id,
      name,
      hard: true,
      computable: false,
      pass: null,
      measured: null,
      target,
      note: "no cut on this plan declares `motion` — a pre-template plan; scored for any plan the current builder produces",
    };
  }

  const failing = plan.cuts.filter(
    (c) => !c.motion || Math.abs(c.motion.toScale - c.motion.fromScale) <= MIN_VISIBLE_SCALE_DELTA,
  );
  const deltas = plan.cuts.map((c) => (c.motion ? Math.abs(c.motion.toScale - c.motion.fromScale) : 0));

  return {
    id,
    name,
    hard: true,
    computable: true,
    pass: failing.length === 0,
    measured: {
      shots: plan.cuts.length,
      staticShots: failing.length,
      minDelta: deltas.length ? Math.round(Math.min(...deltas) * 10000) / 10000 : null,
      maxDelta: deltas.length ? Math.round(Math.max(...deltas) * 10000) / 10000 : null,
      threshold: MIN_VISIBLE_SCALE_DELTA,
    },
    target,
  };
}

/**
 * G9, with §12.7's carve-out and §12.11's wrap bound both asserted.
 *
 * Three things this checks that a naive reading would not:
 *
 *  1. **Vertical extents, not anchors.** A block's top and bottom are its
 *     anchor ± half its height. §12.7 required this explicitly, because
 *     checking the anchor alone is exactly why a banner at y=0.09 shipped
 *     inside a margin it looked clear of.
 *  2. **The banner's measured line count** (§12.11 Minor A). Two lines double
 *     the block height and put ink at ~6.3%, through the 8% exemption. The
 *     line count is measured at plan build and carried on the plan, so this
 *     scores the same number the renderer laid out rather than assuming one.
 *  3. **Caption wrap.** Up to three words at emphasis size in a serif face
 *     can exceed the text box and wrap, which grows the block downward toward
 *     the 12% bottom bound. Same failure mode as the banner's, one layer down.
 *  4. **The face floor** (§12.19). Margins bound a block against the frame's
 *     EDGES; nothing bounded it against the subject. A tall karaoke block
 *     grows upward as well as downward, and a three-line chunk at `center`
 *     puts its top at 0.711 — above the chin at 0.717 — while clearing every
 *     margin, so it passed this gate silently with text across a face. Scored
 *     here rather than as a new gate id because `07 §1` fixes the gate list at
 *     G1–G14 and this is the same question G9 already answers for the other
 *     three edges: is the text allowed to be where it is.
 */
export function gateG9(plan: RenderPlan): GateResult {
  const id = "G9";
  const name = "Safe margins";
  const target =
    "0 text blocks within 12% of the left/right/bottom edge; banner top exempt to 8% (ARCHITECTURE §12.7); " +
    `0 karaoke blocks whose top is above the face floor at ${FACE_FLOOR_RATIO} (ARCHITECTURE §12.19)`;

  const style = plan.templateStyle;
  const sizes = style
    ? style.sizes
    : {
        banner: TYPE_SCALE.banner * plan.width,
        karaoke: TYPE_SCALE.karaoke * plan.width,
        emphasis: TYPE_SCALE.emphasis * plan.width,
        handle: TYPE_SCALE.handle * plan.width,
      };
  const tokens = style?.fontTokens ?? {
    banner: "display_condensed" as const,
    karaoke: "display_serif" as const,
    handle: "body_sans" as const,
  };
  const tracking = style?.tracking ?? { banner: 0.01, karaoke: 0, handle: 0.08 };

  const violations: { layer: string; detail: string; problems: string[] }[] = [];

  // Layer 1 — banner.
  if (plan.banner) {
    const anchor = plan.banner.anchor ?? BANNER_ANCHOR;
    const lines = style?.bannerLines ?? 1;
    const problems = g9Violations("banner", anchor, sizes.banner, lines, plan.width, plan.height);
    if (problems.length) {
      violations.push({ layer: "banner", detail: `"${plan.banner.text}" (${lines} line(s))`, problems });
    }
  }

  // Layer 2 — karaoke chunks, measured PER WORD.
  //
  // Only the emphasis word draws at `sizes.emphasis`; its neighbours draw at
  // `sizes.karaoke` (02 §7). Measuring the whole chunk at the larger size
  // over-estimates both width and height by up to 35% and fails chunks that
  // fit — which it did, on "To remember that" @ lower_left, before this was
  // measured properly. The layout is a flex row with `gap: width * 0.02`, so
  // the separator is that gap and not a space glyph.
  for (const chunk of plan.captions) {
    const anchor = chunk.anchor;
    if (!anchor) continue; // pre-geometry plan; nothing to score for this chunk
    const { left, right } = textBoxBounds(anchor, plan.width);
    const measured = chunk.words.map((w, i) => ({
      text: w.word,
      fontSizePx: w.isEmphasis === true || chunk.emphasisWordIndex === i ? sizes.emphasis : sizes.karaoke,
    }));
    const lines = wrapWords(measured, tokens.karaoke, right - left, {
      wordGapPx: plan.width * 0.02,
      trackingEm: tracking.karaoke,
    });
    const height = blockHeightPx(lines, LINE_HEIGHT);
    const problems = [
      ...g9ViolationsForBlock("karaoke", anchor, height, plan.width, plan.height),
      // The block's TOP against the subject, not against the frame (§12.19).
      // Measured on the same wrapped height as the margins are, so a chunk
      // cannot be judged safe by one bound and unsafe by the other because
      // they disagreed about how tall it is.
      ...faceFloorViolationsForBlock(anchor, height, plan.height),
      // §12.43 — and wholly inside ONE region. G9 bounds the block against the
      // frame and the face floor bounds it against the chin; a block can clear
      // both and still lie half on the subject's chest and half on the bar,
      // which is what shipped at 1.20s. Same wrapped height as the other two.
      ...regionContainmentViolations(
        anchor,
        height,
        plan.height,
        style?.content?.regionRatio ?? CONTENT_REGION_RATIO,
      ),
    ];
    if (problems.length) {
      violations.push({
        layer: "karaoke",
        detail: `"${chunk.words.map((w) => w.word).join(" ")}" @ ${chunk.position} (${lines.length} line(s), ${Math.round(height)}px)`,
        problems,
      });
    }
  }

  // Layer 3 — the handle, in each corner it visits.
  if (plan.handle) {
    for (const corner of new Set(plan.handle.cornerByShot)) {
      const anchor = handleAnchor(corner);
      const problems = g9Violations("handle", anchor, sizes.handle, 1, plan.width, plan.height);
      if (problems.length) {
        violations.push({ layer: "handle", detail: `${plan.handle.text} @ ${corner}`, problems });
      }
    }
  }

  return {
    id,
    name,
    hard: true,
    computable: true,
    pass: violations.length === 0,
    measured: {
      violations: violations.length,
      bannerTopExemptionRatio: BANNER_TOP_MARGIN_RATIO,
      faceFloorRatio: FACE_FLOOR_RATIO,
      bannerLines: style?.bannerLines ?? null,
      // Capped: a broken template can produce one violation per chunk, and a
      // qc.json nobody can read is a qc.json nobody reads.
      examples: violations.slice(0, 5),
    },
    target,
  };
}

/**
 * Every plan-decidable hard gate, in report order.
 *
 * A list rather than nine call sites so that adding a tenth cannot be wired
 * into the QC report and forgotten at `plan.build` — the exact asymmetry
 * §12.42 exists to close. G10 takes the words file and is skipped (not
 * failed) when the caller has none: "could not measure" and "measured and
 * failed" are different claims, and §12.37 spent a whole ruling on keeping
 * them apart.
 */
export const PLAN_DECIDABLE_GATES = [
  "G2", "G3", "G4", "G5", "G6", "G7", "G8", "G9", "G10",
] as const;

export function planDecidableGateResults(plan: RenderPlan, wordsFile: WordsFile | null): GateResult[] {
  return [
    gateG2(plan),
    gateG3(plan),
    gateG4(plan),
    gateG5(plan),
    gateG6(plan),
    gateG7(plan),
    gateG8(plan),
    gateG9(plan),
    gateG10(plan, wordsFile),
  ];
}
