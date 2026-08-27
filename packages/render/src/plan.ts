import { z } from "zod";

/**
 * plan.ts — the RenderPlan contract.
 *
 * Scaffold note (Agent P, task 1): this is a deliberately minimal v1 shape —
 * just enough to (a) be a valid `RenderPlan.plan` Json payload (schema.prisma,
 * ARCHITECTURE.md §3), (b) let `scripts/qc-render.ts` score G1a/G1b against
 * `cuts[].outputStartMs` + `beatGrid` without waiting on the full contract,
 * and (c) give `plan.build`'s queue wiring something typed to validate
 * against. Agent M owns the full contract (SPRINGS, caption engine, emphasis
 * scoring, the beat-snap planner — ARCHITECTURE.md §8) and will extend this
 * file rather than fork it, the same discipline schema.ts documents in the
 * ported source (remotion/src/schema.ts:11 in founder-journey).
 *
 * "Plan-as-props": every Remotion composition in this package takes a
 * RenderPlan as its only source of timing (03_RENDER_PIPELINE §4) — no
 * component computes its own. That is what makes a render reproducible
 * (G13) and testable without touching a browser or a Lambda.
 */

export const PLAN_VERSION = "1" as const;

// ---------------------------------------------------------------------------
// Beat grid — embedded, not recomputed. ADR-2 / ARCHITECTURE §4.1: the grid
// that G1a scores a plan against is the one baked in here, produced by the
// Python sidecar's `beats` stage (services/analyzer) and copied verbatim from
// `MediaAnalysis.beats` at plan-build time. QC never re-derives it.
// ---------------------------------------------------------------------------
export const BeatMethodSchema = z.enum(["beat_track", "onset_env", "constant_grid"]);
export type BeatMethod = z.infer<typeof BeatMethodSchema>;

export const BeatGridSchema = z.object({
  method: BeatMethodSchema,
  tempoBpm: z.number().positive().nullable(),
  beatTimesMs: z.array(z.number().int().nonnegative()),
  /** mean onset-strength at beat times ÷ mean at inter-beat midpoints
   *  (ARCHITECTURE §4.1) — guards a degraded grid from gaming G1a. */
  gridQuality: z.number().nonnegative().nullable(),
});
export type BeatGrid = z.infer<typeof BeatGridSchema>;

// ---------------------------------------------------------------------------
// Cuts — the output-timeline shot list. `outputStartMs` is what G1a (plan vs
// embedded grid) and G1b (render vs plan) both measure against; `sourceInMs`/
// `sourceOutMs` are the footage span each shot plays. The very first cut's
// `outputStartMs` is always 0 and is not itself scored as a "cut" (07
// §1/ADR-8: "the t=0 boundary is not a cut").
// ---------------------------------------------------------------------------
export const CutSchema = z.object({
  id: z.string().min(1),
  sourceInMs: z.number().int().nonnegative(),
  sourceOutMs: z.number().int().nonnegative(),
  outputStartMs: z.number().int().nonnegative(),
  outputEndMs: z.number().int().nonnegative(),
});
export type Cut = z.infer<typeof CutSchema>;

// ---------------------------------------------------------------------------
// Captions — word-level chunks. Left intentionally thin: Agent M's caption
// engine (02_MOTION_SYSTEM) owns emphasis scoring, position variance and the
// spring timing; this just fixes the wire shape so plan.build can start
// emitting something valid before that lands.
// ---------------------------------------------------------------------------
export const CaptionWordSchema = z.object({
  word: z.string(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
});
export type CaptionWord = z.infer<typeof CaptionWordSchema>;

export const CaptionChunkSchema = z.object({
  words: z.array(CaptionWordSchema).min(1).max(3), // G5: ≤3 words visible at once
  position: z.string(), // e.g. "center-low" | "lower-left" | "center" — G6 wants ≥3 distinct
  emphasisWordIndex: z.number().int().nonnegative().nullable(), // G8: ≤1 per chunk
});
export type CaptionChunk = z.infer<typeof CaptionChunkSchema>;

// ---------------------------------------------------------------------------
// Grade + music — thin refs; the actual grade math (motion.ts port) and the
// bed selection (music.ts port) are not this scaffold's job.
// ---------------------------------------------------------------------------
export const GradeSchema = z.object({
  contrast: z.number().positive(),
  saturation: z.number().positive(),
  warmTint: z.number(),
});
export type Grade = z.infer<typeof GradeSchema>;

export const MusicRefSchema = z.object({
  assetId: z.string(),
  startOffsetMs: z.number().int().nonnegative(), // the bed's chosen global phase φ (ARCHITECTURE §4)
});
export type MusicRef = z.infer<typeof MusicRefSchema>;

export const FramingSchema = z.enum(["letterbox", "fill"]);
export type Framing = z.infer<typeof FramingSchema>;

// ---------------------------------------------------------------------------
// RenderPlan — the reproducible artifact (G13). Given the same plan +
// footage, the render is byte-reproducible; a re-render never re-runs an LLM
// or recomputes analysis.
// ---------------------------------------------------------------------------
export const RenderPlanSchema = z.object({
  planVersion: z.literal(PLAN_VERSION),
  seed: z.number().int(),

  fps: z.number().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  durationInFrames: z.number().int().positive(),
  framing: FramingSchema,

  footage: z.object({
    assetId: z.string(),
    r2Key: z.string(),
  }),

  cuts: z.array(CutSchema).min(1),
  captions: z.array(CaptionChunkSchema),
  beatGrid: BeatGridSchema,
  music: MusicRefSchema.nullable(),
  grade: GradeSchema,
});
export type RenderPlan = z.infer<typeof RenderPlanSchema>;

/** Loud loader — same discipline as founder-journey's schema.ts
 *  (`assertValidRoughCut`): validation fails loudly, never silently. */
export function assertValidRenderPlan(raw: unknown, label = "render plan"): RenderPlan {
  const parsed = RenderPlanSchema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  • [${i.path.join(".")}] ${i.message}`);
    throw new Error(`RenderPlan validation failed for ${label}:\n${lines.join("\n")}`);
  }
  return parsed.data;
}

/** Every cut's output-timeline start except the first (07 §1/ADR-8: t=0 is
 *  not a cut) — the exact list G1a/G1b score against. */
export function cutTimesMs(plan: RenderPlan): number[] {
  return plan.cuts
    .map((c) => c.outputStartMs)
    .filter((t) => t > 0)
    .sort((a, b) => a - b);
}
