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
/**
 * Per-shot camera declaration (Agent M, 02 §4.1 + ARCHITECTURE §11.3).
 *
 * The composition calls `spring(config, durationInFrames)` and lerps
 * `fromScale → toScale`; it computes nothing itself. `durationInFrames` is
 * NOT optional and is always the shot's own frame count for drift — at its
 * natural speed the overdamped drift spring moves a 0.6s shot ~0.57%, which
 * fails G7's "scale delta >1% on 100% of shots", and 0.7–1.2s accelerate
 * shots are the common case.
 *
 * Carrying it on the plan is also what makes G7 machine-checkable *before*
 * a render: `|toScale - fromScale| > 0.01` is decidable from this object, no
 * pixels required. `scripts/qc-render.ts` currently reports G7 and G9 as
 * `computable: false` because the schema had no motion or caption geometry —
 * these two blocks close that gap (wiring them up is P's, per the boundary).
 */
export const ShotMotionSchema = z.object({
  motion: z.enum(["push", "pull"]),
  fromScale: z.number().positive(),
  toScale: z.number().positive(),
  spring: z.enum(["pop", "punch", "drift", "out"]),
  durationInFrames: z.number().int().positive(),
  originX: z.number(),
  originY: z.number(),
});
export type ShotMotion = z.infer<typeof ShotMotionSchema>;

export const CutSchema = z.object({
  id: z.string().min(1),
  sourceInMs: z.number().int().nonnegative(),
  sourceOutMs: z.number().int().nonnegative(),
  outputStartMs: z.number().int().nonnegative(),
  outputEndMs: z.number().int().nonnegative(),
  /** Optional so plans written against the scaffold shape still validate. */
  motion: ShotMotionSchema.optional(),
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
  /** Mirrors the chunk's `emphasisWordIndex` for the renderer's convenience. */
  isEmphasis: z.boolean().optional(),
});
export type CaptionWord = z.infer<typeof CaptionWordSchema>;

/** 0..1 of the frame. G9 (nothing within 12% of an edge) is decidable from
 *  this without rasterising, which is why it is on the plan at all. */
export const AnchorSchema = z.object({
  x: z.number(),
  y: z.number(),
  align: z.enum(["center", "left", "right"]),
});
export type Anchor = z.infer<typeof AnchorSchema>;

/**
 * G5's bound, named so the schema refinement and the gate cite one constant.
 *
 * It used to be `.max(3)` inline on `words` below. It is enforced from
 * `RenderPlanSchema`'s refinement instead, for one reason and with the
 * guarantee unchanged: a plan that does not declare `captionMode: "block"`
 * still cannot represent a fourth word. See `CaptionModeSchema`.
 */
export const KARAOKE_MAX_WORDS_PER_CHUNK = 3;

export const CaptionChunkSchema = z.object({
  words: z.array(CaptionWordSchema).min(1), // G5: ≤3 words — enforced on the PLAN, see KARAOKE_MAX_WORDS_PER_CHUNK
  /**
   * G6 wants ≥3 distinct. Left as a free string rather than an enum so plans
   * written against the scaffold's examples still validate; the canonical set
   * is exported from `@mcos/render/captions` as `CAPTION_POSITIONS`
   * ("center_low" | "lower_left" | "center"). `upper_third` was retired by
   * §12.20 — the corrected content region leaves no room for it.
   */
  position: z.string(),
  emphasisWordIndex: z.number().int().nonnegative().nullable(), // G8: ≤1 per chunk
  startMs: z.number().int().nonnegative().optional(),
  endMs: z.number().int().nonnegative().optional(),
  /** Resolved geometry for `position` — see AnchorSchema. */
  anchor: AnchorSchema.optional(),
});
export type CaptionChunk = z.infer<typeof CaptionChunkSchema>;

// ---------------------------------------------------------------------------
// The other two caption layers (01 §4 / 02 §2 — "three separate composition
// layers with independent timing"). Both optional: a plan may legitimately
// carry neither (a reel with no hook banner and no tenant handle still
// renders), and making them required would invalidate every plan written
// against the scaffold shape.
// ---------------------------------------------------------------------------

/** 02 §2.1 — persistent hook banner. Text and emphasis word both come from
 *  the approved ContentBrief; nothing is chosen at render time. */
export const BannerSchema = z.object({
  text: z.string(),
  /** Index into `text.split(/\s+/)`. Exactly one word is coloured — "two
   *  coloured words halves the emphasis" (02 §2.1). */
  emphasisWordIndex: z.number().int().nonnegative().nullable(),
  anchor: AnchorSchema.optional(),
});
export type Banner = z.infer<typeof BannerSchema>;

/** 02 §2.3 — handle / brand bug. `cornerByShot` alternates across shots;
 *  a static bug reads as a watermark, an alternating one reads as design. */
export const HandleSchema = z.object({
  text: z.string(),
  opacity: z.number().min(0).max(1),
  cornerByShot: z.array(z.enum(["upper_right", "upper_left"])),
});
export type Handle = z.infer<typeof HandleSchema>;

// ---------------------------------------------------------------------------
// Grade + music — thin refs; the actual grade math (motion.ts port) and the
// bed selection (music.ts port) are not this scaffold's job.
// ---------------------------------------------------------------------------
export const GradeSchema = z.object({
  contrast: z.number().positive(),
  saturation: z.number().positive(),
  warmTint: z.number(),
  /** 02 §6's "slight vignette (0.12)". Optional so plans written before the
   *  templates landed still validate; absent renders as no vignette. */
  vignette: z.number().min(0).max(1).optional(),
});
export type Grade = z.infer<typeof GradeSchema>;

// ---------------------------------------------------------------------------
// Template style — resolved at plan build, frozen here, never looked up at
// render time.
//
// The composition reads THIS and never imports the template registry. A
// render is reproducible from {ContentBrief, template_id, footage_ref, seed}
// (00_MASTER invariant 6), which cannot hold if editing a constant in
// `templates/index.ts` silently changes what an existing plan renders as. It
// is the same freeze discipline §11.1 R3 applies to claim texts and §11.2 R4
// to `framework_evidence_tier`.
//
// It also keeps G7/G9 decidable from the plan alone (§12.6): the pixel sizes
// the gates measure are on the artifact, not behind a rasteriser.
// ---------------------------------------------------------------------------
export const TemplateStyleSchema = z.object({
  templateId: z.string().min(1),
  templateVersion: z.number().int().positive(),
  /** Resolved CSS font-family stacks, primary face embedded as a data URL. */
  fonts: z.object({
    banner: z.string().min(1),
    karaoke: z.string().min(1),
    handle: z.string().min(1),
  }),
  /**
   * 02 §7's token name per layer, alongside the CSS stack.
   *
   * The stack is what the browser reads; the token is what a *measurement*
   * reads — `FONT_METRICS` is keyed by token, and G9 has to predict wrapping
   * with the same advances the renderer draws with. Carrying both is what
   * keeps `qc-render.ts` from having to parse a CSS font-family string back
   * into a metrics table, which is the kind of seam that silently starts
   * measuring the wrong font.
   */
  fontTokens: z.object({
    banner: z.enum(["display_condensed", "display_serif", "body_sans"]),
    karaoke: z.enum(["display_condensed", "display_serif", "body_sans"]),
    handle: z.enum(["display_condensed", "display_serif", "body_sans"]),
  }),
  /** 02 §7's tokens resolved against this plan's width, in pixels. */
  sizes: z.object({
    banner: z.number().positive(),
    karaoke: z.number().positive(),
    emphasis: z.number().positive(),
    handle: z.number().positive(),
  }),
  /** CSS letter-spacing per layer, in em. */
  tracking: z.object({
    banner: z.number(),
    karaoke: z.number(),
    handle: z.number(),
  }),
  /**
   * How many lines the banner text occupies, MEASURED at plan build against
   * the real font metrics (ARCHITECTURE §12.11 Minor A). G9's banner
   * carve-out is a bound on the text block's top edge, and a block's height
   * is a function of its line count — so a gate that assumes one line is a
   * gate that stops holding the moment a hook wraps. Carried on the plan so
   * `qc-render.ts` scores the same number the renderer laid out.
   */
  bannerLines: z.number().int().positive(),
  /** 02 §4.2's emphasis punch depth (+6%). 0 disables. */
  punchScale: z.number().min(0),
  /**
   * How footage fills the frame (ARCHITECTURE §12.16).
   *
   * `regionRatio` is the content region's share of frame height (0.625 — the
   * reference's measured 62.5%, NOT the 31.6% a 16:9-to-width fit produces).
   * `cropX`/`cropY` are the static crop offsets, 0..1, as CSS
   * `object-position` — the source is scaled to COVER the region and the
   * overflow cropped. Static per template and centred by default: locked-off
   * interview footage does not need a tracker, so this does not reintroduce
   * the face detection §11.1 R2 descoped.
   */
  content: z.object({
    regionRatio: z.number().positive().max(1),
    cropX: z.number().min(0).max(1),
    cropY: z.number().min(0).max(1),
  }),
});
export type TemplateStyle = z.infer<typeof TemplateStyleSchema>;

export const MusicRefSchema = z.object({
  assetId: z.string(),
  startOffsetMs: z.number().int().nonnegative(), // the bed's chosen global phase φ (ARCHITECTURE §4)
});
export type MusicRef = z.infer<typeof MusicRefSchema>;

export const FramingSchema = z.enum(["letterbox", "fill"]);
export type Framing = z.infer<typeof FramingSchema>;

// ---------------------------------------------------------------------------
// captionMode — BASELINE ONLY (W4.2). Nothing in production ever sets it.
// ---------------------------------------------------------------------------
/**
 * How the renderer draws a caption chunk.
 *
 * **`"block"` exists solely for the W4.2 naive baseline** — the deliberately
 * amateur comparison render in `src/baseline/`, which draws whole sentences
 * statically with no karaoke and no per-word timing. No production builder
 * emits it: `plan-builder.ts` and `build-template-plan.ts` leave it absent, and
 * `studio-baseline.test.ts` asserts they always will.
 *
 * ── Why this is a schema field and not a fork of the schema ─────────────────
 * The baseline is only worth rendering if the REAL gates score it, and the
 * gates take a `RenderPlan`. `gateG5` measures `words.length` per chunk, so a
 * block caption has to arrive as its actual words or G5 reports 1 and passes —
 * a green number describing a wall of text, which is the exact shape of lie
 * §12.21 and §12.10 were both written about. Collapsing a sentence into one
 * `CaptionWord` would make the baseline LOOK compliant on the one gate its
 * captions most obviously break.
 *
 * ── What the production guarantee was, and that it is unchanged ─────────────
 * `CaptionChunkSchema.words` carried `.max(3)`, so ADR-4's "a template
 * physically cannot reach for an effect that does not exist in the contract"
 * held for caption density too: a 4-word chunk was unrepresentable. That is
 * preserved exactly. The bound moved from the chunk to `RenderPlanSchema`'s
 * refinement below, where it applies to every plan that does not declare
 * `captionMode: "block"` — which is every plan any production path builds. A
 * production plan is refused a fourth word by the schema now as before; only a
 * plan that has explicitly announced itself as the baseline is exempt, and such
 * a plan fails G5 at `plan.build` (§12.42) so it can never be persisted.
 */
export const CaptionModeSchema = z.enum(["karaoke", "block"]);
export type CaptionMode = z.infer<typeof CaptionModeSchema>;

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
  banner: BannerSchema.optional(),
  handle: HandleSchema.optional(),
  beatGrid: BeatGridSchema,
  music: MusicRefSchema.nullable(),
  grade: GradeSchema,
  /** Optional so plans predating the template registry still validate; the
   *  composition falls back to the reference look when it is absent. */
  templateStyle: TemplateStyleSchema.optional(),
  /** Static per-template legibility policy — ARCHITECTURE §11.1 R2 descopes
   *  the per-frame luminance decision 02 §2.2 asked for. Drop shadow is
   *  always on and is not a policy. */
  scrim: z.enum(["never", "always"]).optional(),
  /** BASELINE ONLY — absent on every production plan. See `CaptionModeSchema`. */
  captionMode: CaptionModeSchema.optional(),
}).superRefine((plan, ctx) => {
  // G5's ≤3, enforced here rather than as `.max(3)` on the chunk so that the
  // W4.2 baseline's block captions can carry their real words and be MEASURED
  // by G5 instead of silently satisfying it. For every other plan — i.e. every
  // plan production builds — this is the identical constraint it replaced.
  if (plan.captionMode === "block") return;
  plan.captions.forEach((chunk, i) => {
    if (chunk.words.length > KARAOKE_MAX_WORDS_PER_CHUNK) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["captions", i, "words"],
        message:
          `${chunk.words.length} words in one chunk — a karaoke chunk may hold at most ` +
          `${KARAOKE_MAX_WORDS_PER_CHUNK} (G5). Only a plan declaring \`captionMode: "block"\` ` +
          "(the W4.2 baseline, which is never persisted) may exceed it.",
      });
    }
  });
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

/**
 * One millisecond. A span boundary can round by that much; a real removal is
 * orders of magnitude larger.
 */
const SOURCE_CONTINUITY_TOLERANCE_MS = 1;

/**
 * Does this plan REMOVE footage — i.e. does output time diverge from source
 * time anywhere?
 *
 * A plan removes footage exactly when some shot's source span does not continue
 * where the previous one ended. That is decidable from the cuts alone, which is
 * why this is derived here rather than declared by a caller: a flag can be
 * wrong about a plan, but a plan cannot be wrong about itself.
 *
 * Two consumers turn on this one property, and they are the same question asked
 * from opposite ends:
 *
 *  - **ARCHITECTURE §12.13** — removal makes the footage's own beat grid stop
 *    describing what the viewer hears, so removal requires a music bed whose
 *    grid is output-time by construction.
 *  - **ARCHITECTURE §12.3 / §12.37** — removal is also what creates the content
 *    discontinuities G1b's scene detector looks for. No removal, nothing to
 *    detect, and G1b is not applicable rather than failed.
 *
 * The two are the same coupling seen from either side, which is why §12.13
 * could say G1a and G1b "become jointly satisfiable only under this
 * convention". Defined next to `CutSchema` so both readings share one
 * definition and cannot drift apart.
 */
export function planRemovesFootage(plan: RenderPlan): boolean {
  return plan.cuts.some((cut, i) => {
    if (i === 0) return false;
    const prev = plan.cuts[i - 1]!;
    return Math.abs(cut.sourceInMs - prev.sourceOutMs) > SOURCE_CONTINUITY_TOLERANCE_MS;
  });
}
