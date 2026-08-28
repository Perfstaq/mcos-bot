import { BANNER_ANCHOR, HANDLE_OPACITY, buildBanner } from "../captions/index.js";
import {
  assertValidRenderPlan,
  PLAN_VERSION,
  type Anchor,
  type CaptionChunk,
  type Cut,
  type RenderPlan,
} from "../plan.js";
import { getTemplate } from "../templates/index.js";
import { resolveTemplateStyle } from "../templates/resolve.js";

/**
 * baseline/plan.ts — the NAIVE BASELINE (W4.2). **Not a production path.**
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THIS MODULE EXISTS ONLY TO LOSE A COMPARISON.
 *
 *  It is the control arm of the W4.3 side-by-side: the same approved
 *  ContentBrief, the same footage, the same typography — and none of the
 *  motion system. Its output is deliberately amateur. Nothing here may be
 *  imported by `apps/api`, by `apps/web`, or by anything under
 *  `packages/render/src` other than `baseline/` itself and the one
 *  `Root.tsx` line that registers the baseline composition.
 *  `studio-baseline.test.ts` scans the tree and fails if that is violated.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ── The instruction this file is written against ────────────────────────────
 * "It must be honestly bad… An agent optimising for 'the comparison looks
 * good' will unconsciously soften the baseline — make its cuts slightly
 * musical, its captions slightly better placed. If you soften it, the
 * comparison is worthless."
 *
 * So every choice below is the OBVIOUS naive one, made without consulting any
 * analysis the pipeline produces, and each is recorded next to the production
 * behaviour it declines to use:
 *
 *  1. **Cuts every 2.5s, full stop.** No beat grid, no word edges. The beat
 *     grid is still EMBEDDED on the plan — copied verbatim from the analyzer,
 *     exactly as a real plan carries it — so G1a scores these cuts against the
 *     grid they ignored. Cuts landing mid-word is the point (G10), and it is
 *     what `planner/` exists to avoid.
 *  2. **Block captions.** Whole sentences, one static position, no karaoke, no
 *     per-word reveal, no emphasis word. The words are carried individually so
 *     G5 measures the real count rather than a sentence disguised as one word
 *     (see `CaptionModeSchema` in `../plan.ts` for why that mattered enough to
 *     change the schema).
 *  3. **No camera.** Every shot declares `fromScale === toScale === 1`. Note
 *     what this is NOT: omitting `motion` entirely makes `gateG7` report
 *     `computable: false`, and an EXCLUDED gate would flatter the baseline by
 *     dropping the one that measures what it lacks. A declared camera that
 *     does not move is scored, and fails.
 *  4. **No grade, no vignette, no warm shift, no punch.** `punchScale: 0`.
 *
 * Typography is deliberately UNCHANGED from the template — same faces, same
 * tracking, same banner. The question `07 §3` asks is about the motion system,
 * so the comparison must not be winnable on fonts.
 */

// ---------------------------------------------------------------------------
// The naive constants. Every one of them is a number a person picks in ten
// seconds without looking at the footage — which is the entire point.
// ---------------------------------------------------------------------------

/**
 * "Cut every two and a half seconds."
 *
 * The single most common naive edit rule, and the one the whole beat-lock
 * apparatus (ADR-2, §4.1, §12.1, §12.13) was built to replace. It is unaware
 * of the beat grid and unaware of word boundaries, so it lands mid-word
 * roughly as often as speech occupies the timeline.
 */
export const BASELINE_CUT_INTERVAL_SEC = 2.5;

/**
 * Bottom-centre, at the middle of the frame's bottom sixth.
 *
 * The default a subtitle burner picks with no knowledge of the letterbox
 * geometry — which is precisely the knowledge §12.43 spent a ruling
 * establishing (the bar runs 0.8125→0.88 and holds exactly one line). This
 * anchor was NOT chosen to breach anything; it is the obvious value, and
 * whatever G9's margin, face-floor and region-containment bounds make of it is
 * the honest consequence of picking it without measuring.
 */
export const BASELINE_CAPTION_ANCHOR: Anchor = { x: 0.5, y: 0.85, align: "center" };

/** One position, forever. `gateG6` wants ≥3 distinct; this reports 1. */
export const BASELINE_CAPTION_POSITION = "bottom_center";

/**
 * 0.045·W — a conventional burned-in subtitle size, SMALLER than the
 * template's 0.075·W display karaoke.
 *
 * This is the one place the baseline is given the charitable option, and the
 * charity is deliberate. Whole sentences set at the professional render's
 * display size would wrap to five or six lines and swamp the frame, and a
 * reviewer would rightly say the wall of text had been manufactured by
 * inflating the type. Being generous to the control arm on an axis that is not
 * the motion system can only strengthen the comparison; being stingy could
 * only weaken it.
 */
export const BASELINE_CAPTION_TYPE_SCALE = 0.045;

/**
 * A sentence longer than this is hard-split at a word boundary.
 *
 * A guard, not a rhythm: mechanical, unaware of pauses, phrasing or breath. It
 * exists because one unpunctuated 30-second run would otherwise be a single
 * caption, which is a transcript artefact rather than a property of naive
 * captioning. Nothing here consults the beat grid or the RMS the analyzer
 * emits — the moment it did, it would stop being the control arm.
 */
export const BASELINE_MAX_BLOCK_WORDS = 14;

/**
 * The one tween length, used for every entrance and every exit alike.
 *
 * 12 frames matches `SPRING_FRAMES.popEnter`, deliberately: the baseline's
 * entrances take exactly as long as the real ones, so what a viewer perceives
 * differs by CURVE and by SYMMETRY, not by duration. If the baseline were also
 * slower, "it looks worse" would have a second available explanation.
 */
export const BASELINE_EASE_FRAMES = 12;

/**
 * Knots for the baseline's opacity envelope: ramp up, hold, ramp down.
 *
 * Lives here rather than in the composition so the CURVE is assertable without
 * a renderer — `BaselineReel.tsx` feeds these straight to Remotion's
 * `interpolate`, which is linear between knots unless handed an `easing`, and
 * it is not handed one.
 *
 * The two ramps are the SAME length. `02 §1` requires exits ~40% faster than
 * entrances (`EXIT_SPEEDUP = 0.6`); equal-and-opposite is what you write when
 * you are not thinking about it, so equal-and-opposite is what this does. The
 * symmetry is therefore a property a test can point at, not a claim in a
 * comment.
 */
export function baselineEnvelopeKnots(totalFrames: number): { input: number[]; output: number[] } {
  const ease = Math.min(BASELINE_EASE_FRAMES, Math.max(1, Math.floor(totalFrames / 2)));
  return {
    input: [0, ease, Math.max(ease, totalFrames - ease), totalFrames],
    output: [0, 1, 1, 0],
  };
}

export type BaselineWord = { word: string; start: number; end: number };

export type BuildBaselinePlanInput = {
  /** Only for typography parity — the baseline uses none of the template's
   *  rhythm curve, caption rotation, handle rotation or grade. */
  templateId: string;
  words: BaselineWord[];
  durationSec: number;
  beats: { method: "beat_track" | "onset_env" | "constant_grid"; tempoBpm: number | null; beatTimesMs: number[]; gridQuality: number | null };
  seed: number;
  hook: string;
  emphasisWord: string | null;
  handleText: string;
  footage: { assetId: string; r2Key: string };
  fps?: number;
  width?: number;
  height?: number;
};

/** Sentence-final punctuation, ignoring trailing quotes/brackets. */
function endsSentence(word: string): boolean {
  return /[.!?]["')\]]*$/.test(word.trim());
}

/**
 * Whole sentences, split on punctuation alone.
 *
 * Contrast `captions/chunk.ts`, which breaks on cut boundaries, keeps ≤3 words
 * on screen, scores emphasis from audio energy and splits anything that would
 * wrap. This does none of that. It reads the transcript's full stops.
 */
export function splitIntoSentences(
  words: BaselineWord[],
  maxWords: number = BASELINE_MAX_BLOCK_WORDS,
): BaselineWord[][] {
  const out: BaselineWord[][] = [];
  let current: BaselineWord[] = [];
  for (const w of words) {
    current.push(w);
    if (endsSentence(w.word) || current.length >= maxWords) {
      out.push(current);
      current = [];
    }
  }
  if (current.length) out.push(current);
  return out;
}

/**
 * Cut boundaries at a fixed interval, in output seconds.
 *
 * Returns the SHOT boundaries including 0 and the clip end. A final shot
 * shorter than the interval is left short rather than merged — merging it
 * would be a judgement about shot length, and the baseline makes no
 * judgements.
 */
export function fixedIntervalBoundaries(
  durationSec: number,
  intervalSec: number = BASELINE_CUT_INTERVAL_SEC,
): number[] {
  const boundaries: number[] = [0];
  for (let t = intervalSec; t < durationSec; t += intervalSec) boundaries.push(t);
  boundaries.push(durationSec);
  return boundaries;
}

export function buildBaselinePlan(input: BuildBaselinePlanInput): RenderPlan {
  const template = getTemplate(input.templateId);
  const fps = input.fps ?? 30;
  const width = input.width ?? 1080;
  const height = input.height ?? 1920;

  // Typography parity: the same resolved style the real render uses, with the
  // two motion terms zeroed. `punchScale: 0` disables the emphasis punch at
  // its source rather than in the composition, so a reader of the plan can see
  // that the baseline has no punch without opening the renderer.
  const templateStyle = {
    ...resolveTemplateStyle(template, { width, height, hookText: input.hook }),
    punchScale: 0,
  };

  const words = [...input.words].sort((a, b) => a.start - b.start);

  // --- cuts: fixed interval, beat-blind, word-blind --------------------------
  const boundaries = fixedIntervalBoundaries(input.durationSec);
  const cuts: Cut[] = boundaries.slice(1).map((end, i) => {
    const start = boundaries[i]!;
    const frames = Math.max(1, Math.round((end - start) * fps));
    return {
      id: `b${i}`,
      // Output time and source time advance together: the baseline removes no
      // footage either, so `planRemovesFootage` is false on BOTH sides and
      // G1b is n/a for the same derived reason (§12.37). The comparison must
      // not turn on one side being excluded from a gate the other was scored
      // on.
      sourceInMs: Math.round(start * 1000),
      sourceOutMs: Math.round(end * 1000),
      outputStartMs: Math.round(start * 1000),
      outputEndMs: Math.round(end * 1000),
      motion: {
        motion: "push",
        // Declared and identical: a camera that is scored and does not move.
        fromScale: 1,
        toScale: 1,
        spring: "drift",
        durationInFrames: frames,
        originX: 0.5,
        originY: 0.5,
      },
    };
  });

  // --- captions: static sentence blocks -------------------------------------
  const captions: CaptionChunk[] = splitIntoSentences(words).map((sentence) => ({
    words: sentence.map((w) => ({
      word: w.word,
      startMs: Math.round(w.start * 1000),
      endMs: Math.round(w.end * 1000),
    })),
    position: BASELINE_CAPTION_POSITION,
    // No emphasis word anywhere. `02 §3`'s scorer, the RMS term §11.1 R1 was
    // built for, and §12.45's stopword floor are all simply not consulted.
    emphasisWordIndex: null,
    startMs: Math.round(sentence[0]!.start * 1000),
    endMs: Math.round(sentence[sentence.length - 1]!.end * 1000),
    anchor: BASELINE_CAPTION_ANCHOR,
  }));

  const banner = buildBanner(input.hook, input.emphasisWord);

  return assertValidRenderPlan(
    {
      planVersion: PLAN_VERSION,
      seed: input.seed,
      fps,
      width,
      height,
      durationInFrames: Math.round(input.durationSec * fps),
      framing: "letterbox",
      footage: input.footage,
      cuts,
      captions,
      banner: { text: banner.text, emphasisWordIndex: banner.emphasisWordIndex, anchor: BANNER_ANCHOR },
      handle: {
        text: input.handleText,
        opacity: HANDLE_OPACITY,
        // Static in one corner for the whole reel. 02 §2.3 names this exactly:
        // "static bugs read as a watermark, an alternating one reads as
        // design." Corner alternation is a per-shot motion-system behaviour,
        // so it goes with the rest of the motion system.
        cornerByShot: cuts.map(() => "upper_right" as const),
      },
      // Carried, and ignored. G1a needs it to be able to say how badly the
      // fixed grid missed.
      beatGrid: {
        method: input.beats.method,
        tempoBpm: input.beats.tempoBpm,
        beatTimesMs: input.beats.beatTimesMs,
        gridQuality: input.beats.gridQuality,
      },
      music: null,
      // Ungraded: 02 §6's contrast/saturation/warm/vignette all at identity.
      grade: { contrast: 1, saturation: 1, warmTint: 0, vignette: 0 },
      templateStyle,
      scrim: "never",
      captionMode: "block",
    },
    `${template.id} BASELINE plan`,
  );
}

/**
 * A tiny schema-valid plan so `Root.tsx` can register the baseline composition
 * without inlining a `templateStyle` block. Preview only — every real baseline
 * render passes a built plan as props, exactly as the real composition does.
 */
export const BASELINE_PREVIEW_PLAN: RenderPlan = buildBaselinePlan({
  templateId: "statement_serif",
  words: [{ word: "Preview.", start: 0, end: 1 }],
  durationSec: 5,
  beats: { method: "constant_grid", tempoBpm: null, beatTimesMs: [], gridQuality: null },
  seed: 0,
  hook: "BASELINE PREVIEW",
  emphasisWord: "BASELINE",
  handleText: "@PERFSTAQ",
  footage: { assetId: "preview", r2Key: "preview" },
});
