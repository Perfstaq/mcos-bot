import { BANNER_ANCHOR, HANDLE_OPACITY, anchorFor, buildBanner, buildCaptionTrack } from "@mcos/render/captions";
import { gateG1a } from "@mcos/render/gates/g1a";
import type { GateResult } from "@mcos/render/gates/types";
import { shotCamera } from "@mcos/render/motion";
import { assertValidRenderPlan, PLAN_VERSION, type BeatGrid, type Cut, type RenderPlan } from "@mcos/render/plan";
import { planBeatLockedCuts, type Bed, type PlannerResult, type WordInterval } from "@mcos/render/planner";
import { getTemplate, templateHandleCornerForShot, templatePositionForShot } from "@mcos/render/templates";
import { BannerFitError, resolveTemplateStyle } from "@mcos/render/templates/resolve";

/**
 * plan-builder.ts — the pure half of `plan.build` (ARCHITECTURE §12.12).
 *
 * Everything here is a function of its arguments: no Prisma, no env, no clock,
 * no network. `jobs/plan-build.ts` does the I/O — load the approved brief, load
 * the analysis, write the row — and calls this for the computation. Splitting
 * them is what lets the two hard requirements (§12.12a's transactional
 * approval re-check, §12.13's output-time grid ruling) be tested as the
 * properties they are, rather than only as the behaviour of a worker.
 *
 * It consumes `packages/render` and reimplements none of it. In particular
 * G1a is IMPORTED (`@mcos/render/gates/g1a`), never recomputed: ADR-8 and
 * §12.19 both exist because a second ruler nearly appeared, and a gate that
 * `plan.build` scores differently from `qc-render.ts` is worse than no gate.
 */

/* -------------------------------------------------------------- failure state */

/**
 * 03_RENDER_PIPELINE §7's `plan_infeasible(reason)` — a real, actionable,
 * user-facing outcome, not a crash.
 *
 * `code` is the stable machine-readable half the UI switches on; `message` is
 * the half a human reads. Both travel onto `Render.error` / the job's failure
 * so a rejected plan can say *why* it was rejected, which 03 §7 requires of
 * every failure state in this pipeline.
 */
export type PlanInfeasibleCode =
  | "analysis_missing"
  | "analysis_incomplete"
  | "banner_wrap"
  | "footage_too_short"
  | "g1a_below_gate"
  | "invalid_grid_configuration"
  | "no_locked_cut_path"
  | "unknown_template";

export class PlanInfeasibleError extends Error {
  constructor(
    readonly code: PlanInfeasibleCode,
    message: string,
    /** Measured numbers worth surfacing next to the reason (e.g. G1a's lock %). */
    readonly measured?: Record<string, unknown>,
  ) {
    super(`plan_infeasible(${code}): ${message}`);
    this.name = "PlanInfeasibleError";
  }
}

/* --------------------------------------------- §12.13 — the output-time grid */

/**
 * Where the grid a plan locks its cuts to came from.
 *
 * `footage_audio` is the analyzer's `beat_track`/`onset_env` grid over the
 * user's own recording. `music_bed` is a licensed track laid over the finished
 * edit. The distinction is the whole of §12.13.
 */
export type GridSource = "footage_audio" | "music_bed";

/**
 * ARCHITECTURE §12.13, stated as code.
 *
 * Removing footage makes output time ≠ source time. The beat grid is consumed
 * in OUTPUT coordinates, so a grid derived from the footage's own audio stops
 * describing what the viewer hears the moment a span is cut out — the plan
 * would be locked to a grid that does not exist in the artifact. That is
 * §12.1's failure one level up, and it is silent: the planner reports a
 * perfect lock and the render lands ~200ms off every beat.
 *
 * |                     | footage's own audio | music bed |
 * |---------------------|---------------------|-----------|
 * | continuous playthrough | legal — source time IS output time | legal |
 * | footage removal        | **INVALID — rejected here**        | legal — the bed plays over the finished edit, so its grid is output-time by construction |
 *
 * Consequence, stated plainly by the ruling and enforced by this function:
 * footage selection (03 §6) and the music bed are coupled. There is no
 * "remove footage but keep the speech-derived grid" configuration. A reel that
 * actually cuts needs music.
 *
 * This is a guard rather than a comment because the selection stage does not
 * exist yet: whoever builds it must confront the ruling, not rediscover it in
 * a render.
 */
export function assertOutputTimeGrid(config: { removesFootage: boolean; gridSource: GridSource }): void {
  if (config.removesFootage && config.gridSource === "footage_audio") {
    throw new PlanInfeasibleError(
      "invalid_grid_configuration",
      "footage removal against a grid derived from the footage's own audio is the invalid quadrant of " +
        "ARCHITECTURE §12.13: removing a span makes output time ≠ source time, so the speech-derived grid no " +
        "longer describes what the viewer hears and the plan would lock to a grid that does not exist in the " +
        "artifact. Removal requires the licensed music bed's grid, which is output-time by construction.",
      { removesFootage: true, gridSource: "footage_audio" },
    );
  }
}

/* -------------------------------------------------------------------- inputs */

export type PlanBuilderWord = { word: string; start: number; end: number; rms?: number | null };

export type BuildRenderPlanInput = {
  /** The `packages/render` template id — see `resolveRenderTemplateId`. */
  templateId: string;
  words: PlanBuilderWord[];
  /** ffprobe duration, not the words file's: faster-whisper reports what it
   *  DECODED, which trails the container whenever the tail is silent (VAD drops
   *  it), and a plan that stops short renders its last shot short. */
  durationSec: number;
  beats: BeatGrid;
  seed: number;
  /** From the approved ContentBrief — nothing here is chosen at plan time. */
  hookText: string;
  emphasisWord: string | null;
  /** The brief's FROZEN claim texts (§11.1 R3) — the emphasis scorer reads
   *  these and never reaches into claim tables. */
  claimTexts: string[];
  handleText: string;
  footage: { assetId: string; r2Key: string };
  /** §12.13. v1 ships continuous playthrough only; the field exists so the
   *  selection stage cannot be added without answering the ruling. */
  removesFootage?: boolean;
  fps?: number;
  width?: number;
  height?: number;
};

export type BuiltPlan = {
  plan: RenderPlan;
  planner: PlannerResult;
  g1a: GateResult;
};

// 03_RENDER_PIPELINE §4 / 07 §1 G12: 1080×1920, 30fps, exact.
const FPS = 30;
const WIDTH = 1080;
const HEIGHT = 1920;

/** Below this there is no room for even the shortest legal shot list
 *  (G4's 0.6s floor across an establish + a hold). 03 §7's
 *  "footage too short for template" made decidable. */
const MIN_FOOTAGE_SEC = 3;

/**
 * The DB `MotionTemplate` row → `packages/render` template id seam.
 *
 * Agent T ruled the template catalogue is a versioned TS const, not a table
 * (ARCHITECTURE §11.2 R4's reasoning applied to templates): a template is
 * product knowledge that changes with our editorial thinking, and a table
 * would mean a migration every time someone retunes a rhythm band. But
 * `RenderPlan.templateId` is still an FK to `motion_templates`, so a row must
 * exist for the plan to reference. `MotionTemplate.name` carries the render
 * template id, and this is the single place that bridge is expressed.
 */
export function resolveRenderTemplateId(row: { name: string }): string {
  try {
    return getTemplate(row.name).id;
  } catch (error) {
    throw new PlanInfeasibleError(
      "unknown_template",
      `motion_templates row names "${row.name}", which is not a template packages/render ships. ` +
        `${(error as Error).message}. The row's \`name\` is the bridge to the TS catalogue ` +
        "(templates/index.ts); seed it with a catalogued id.",
      { name: row.name },
    );
  }
}

/**
 * Build the complete `RenderPlan` payload and score G1a against it.
 *
 * Every number on the returned plan comes from `packages/render` — the DP
 * planner, the caption engine, the emphasis scorer, the camera, the resolved
 * template style. Nothing is computed twice and nothing is invented here.
 */
export function buildRenderPlan(input: BuildRenderPlanInput): BuiltPlan {
  const fps = input.fps ?? FPS;
  const width = input.width ?? WIDTH;
  const height = input.height ?? HEIGHT;
  const removesFootage = input.removesFootage ?? false;

  // §12.13 FIRST, before any expensive work. The grid a plan locks to must be
  // valid in output time; deciding that after a DP sweep would be deciding it
  // late for no reason. The analyzer's grid is the footage's own audio.
  assertOutputTimeGrid({ removesFootage, gridSource: "footage_audio" });

  if (!(input.durationSec >= MIN_FOOTAGE_SEC)) {
    throw new PlanInfeasibleError(
      "footage_too_short",
      `footage is ${input.durationSec.toFixed(2)}s; a template needs at least ${MIN_FOOTAGE_SEC}s to place ` +
        "even the shortest legal shot list (G4's 0.6s minimum shot).",
      { durationSec: input.durationSec, minimumSec: MIN_FOOTAGE_SEC },
    );
  }
  if (!input.words.length) {
    throw new PlanInfeasibleError(
      "analysis_incomplete",
      "the footage's MediaAnalysis carries no words — the planner's legal cut points are word edges (G10), " +
        "so there is nothing to cut on.",
    );
  }
  if (!input.beats.beatTimesMs.length) {
    throw new PlanInfeasibleError(
      "analysis_incomplete",
      "the footage's MediaAnalysis carries an empty beat grid — G1a scores cuts against the plan's embedded " +
        "grid (ADR-2/ADR-8) and cannot be evaluated without one.",
    );
  }

  const template = getTemplate(input.templateId);

  // Resolve the template BEFORE planning. `resolveTemplateStyle` measures the
  // hook's wrap against real font metrics and throws `BannerFitError` if it
  // would breach G9's banner carve-out (§12.11 Minor A). An unrenderable hook
  // should cost a millisecond, not a DP sweep.
  let style;
  try {
    style = resolveTemplateStyle(template, { width, height, hookText: input.hookText });
  } catch (error) {
    if (error instanceof BannerFitError) {
      throw new PlanInfeasibleError("banner_wrap", error.message, { hookText: input.hookText });
    }
    throw error;
  }

  const flat = [...input.words].sort((a, b) => a.start - b.start);
  const intervals: WordInterval[] = flat.map((w) => ({ start: w.start, end: w.end }));

  // `phaseLocked: true` is load-bearing, not defensive. The grid comes from the
  // FOOTAGE's own audio, so its phase is a physical property of a recording
  // that already exists — you cannot slide a speaker's room tone in time.
  // Sweeping φ here would produce a plan perfectly locked to a grid that does
  // not exist, which is the silent 100%-planner / 29%-QC failure §12.1
  // records. Phase freedom belongs to a music bed, whose start offset really
  // is ours to choose — and per §12.13 a bed is also the only grid a plan that
  // REMOVES footage may lock to.
  const bed: Bed = {
    id: "analyzer-grid",
    tempoBpm: input.beats.tempoBpm ?? 112.3,
    beatTimesSec: input.beats.beatTimesMs.map((ms) => ms / 1000),
    phaseLocked: true,
  };

  // `gatePct: 0` so the planner returns its best attempt rather than
  // self-rejecting: G1a is scored ONCE below, by the imported gate, against
  // the grid actually embedded in the plan. Two rejection thresholds for one
  // question is the second ruler ADR-8/§12.19 forbid.
  const planned = planBeatLockedCuts({
    words: intervals,
    durationSec: input.durationSec,
    beds: [bed],
    seed: input.seed,
    rhythm: template.rhythm,
    gatePct: 0,
  });

  if (!planned.cutTimesSec.length) {
    throw new PlanInfeasibleError(
      "no_locked_cut_path",
      planned.reason ??
        "the planner found no shot list satisfying the [0.6s, 5.0s] bound over the legal cut points (G10 vs G3/G4).",
      { lockPct: planned.lockPct, cuts: 0 },
    );
  }

  // Continuous playthrough: `sourceIn == outputStart` for every shot, which is
  // exactly what makes the footage's own grid legal in output time (§12.13 row
  // 1, and the reference's own approach — 01 §8, "a single continuous
  // interview, cut on itself"). If this ever stops holding, `removesFootage`
  // must become true and the grid must come from a bed.
  const boundaries = [0, ...planned.cutTimesSec, input.durationSec];
  const cuts: Cut[] = boundaries.slice(1).map((end, i) => {
    const start = boundaries[i]!;
    const frames = Math.max(1, Math.round((end - start) * fps));
    const cam = shotCamera(i, frames, input.seed);
    return {
      id: `c${i}`,
      sourceInMs: Math.round(start * 1000),
      sourceOutMs: Math.round(end * 1000),
      outputStartMs: Math.round(start * 1000),
      outputEndMs: Math.round(end * 1000),
      motion: {
        motion: cam.motion,
        fromScale: cam.fromScale,
        toScale: cam.toScale,
        spring: "drift",
        durationInFrames: cam.durationInFrames,
        originX: cam.originX,
        originY: cam.originY,
      },
    };
  });

  const track = buildCaptionTrack({
    words: flat.map((w) => ({
      word: w.word,
      startMs: Math.round(w.start * 1000),
      endMs: Math.round(w.end * 1000),
      rms: w.rms ?? null,
    })),
    cutTimesMs: planned.cutTimesSec.map((t) => Math.round(t * 1000)),
    claimTexts: input.claimTexts,
    positionForShot: (shotIndex) => templatePositionForShot(template, shotIndex),
  });

  const banner = buildBanner(input.hookText, input.emphasisWord);

  const plan = assertValidRenderPlan(
    {
      planVersion: PLAN_VERSION,
      seed: input.seed,
      fps,
      width,
      height,
      durationInFrames: Math.round(input.durationSec * fps),
      framing: template.framing,
      footage: input.footage,
      cuts,
      captions: track.map((c) => ({
        words: c.words.map((w) => ({
          word: w.word,
          startMs: w.startMs,
          endMs: w.endMs,
          isEmphasis: w.isEmphasis,
        })),
        position: c.position,
        emphasisWordIndex: c.emphasisWordIndex,
        startMs: c.startMs,
        endMs: c.endMs,
        anchor: anchorFor(c.position),
      })),
      banner: { text: banner.text, emphasisWordIndex: banner.emphasisWordIndex, anchor: BANNER_ANCHOR },
      handle: {
        text: input.handleText,
        opacity: HANDLE_OPACITY,
        cornerByShot: cuts.map((_, i) => templateHandleCornerForShot(template, i)),
      },
      // The grid the planner ACTUALLY scored against, not the raw analyzer
      // file — "canonical grid = the grid as used" (§4.1). G1a below and
      // qc-render.ts later both measure against this exact array.
      beatGrid: {
        method: input.beats.method,
        tempoBpm: input.beats.tempoBpm,
        beatTimesMs: planned.beatTimesSec.map((s) => Math.round(s * 1000)),
        gridQuality: input.beats.gridQuality,
      },
      // No bed in v1. §12.13: the day this becomes non-null is the day
      // footage removal becomes legal, and the two land together.
      music: null,
      grade: template.grade,
      templateStyle: style,
      scrim: template.scrim,
    },
    `${template.id} plan for ${input.footage.assetId}`,
  );

  // ADR-8: G1a is evaluated at plan.build, BEFORE anything is persisted and
  // long before anything renders, so a plan that fails it never costs a
  // render. The gate is imported, not reimplemented.
  const g1a = gateG1a(plan);

  return { plan, planner: planned, g1a };
}

/**
 * `buildRenderPlan` + ADR-8's rejection. Separate from the builder so a caller
 * that wants to *inspect* a failing plan (an evidence harness, a tuning
 * script) still can, while the production path cannot accidentally persist one.
 */
export function buildApprovedRenderPlan(input: BuildRenderPlanInput): BuiltPlan {
  const built = buildRenderPlan(input);
  if (!built.g1a.pass) {
    const measured = built.g1a.measured as Record<string, unknown>;
    throw new PlanInfeasibleError(
      "g1a_below_gate",
      `the best plan locks ${formatPct(measured["ratio"])} of its cuts within 150ms of the embedded beat grid, ` +
        `under G1a's 85% gate${built.g1a.note ? ` (${built.g1a.note})` : ""} — rejected at plan.build so it never ` +
        "costs a render (ADR-8).",
      { ...measured, lockPct: built.planner.lockPct },
    );
  }
  return built;
}

function formatPct(ratio: unknown): string {
  return typeof ratio === "number" ? `${(ratio * 100).toFixed(2)}%` : "an unmeasurable share of";
}
