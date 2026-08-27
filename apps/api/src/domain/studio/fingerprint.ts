import { z } from "zod";

/**
 * fingerprint.ts — the `EditFingerprint` contract (04_STYLE_TRANSFER §3).
 *
 * The Node-side shape of what `services/analyzer/stages/fingerprint.py`
 * emits, plus the two things that turned out to need pinning in a schema
 * rather than left to convention: the **cuts-vs-shots rule** and the
 * **confidence floor** below which a field is not allowed to influence a
 * render.
 *
 * Same "loud loaders" discipline as `media-analysis-schema.ts` — a malformed
 * sidecar payload fails at the boundary, never as a silently-wrong row.
 */

// ---------------------------------------------------------------------------
// The cuts-vs-shots convention (ARCHITECTURE §11.3, pinned here by request).
//
// N detected shots ⇒ N−1 cuts. The t=0 boundary is NOT a cut.
//
// This is worth a named constant and a validated invariant because it is
// load-bearing on a gate boundary rather than cosmetic. The reference detects
// 29 shots; under this convention that is 28 cuts and 30.62 cuts/min, and
// under the other reading (29 cuts) it is 31.7. `04 §6`'s band floor is 30.
// A convention that decides whether the exemplar passes its own acceptance
// test is not a detail. It is the same rule `qc_scene_detect.py`,
// `plan.cutTimesMs` and G1a already use; `assertCutConvention` below makes a
// payload that disagrees fail loudly instead of quietly shifting a metric.
// ---------------------------------------------------------------------------
export const CUTS_PER_SHOT_OFFSET = 1;

export function cutsForShots(shotCount: number): number {
  return Math.max(0, shotCount - CUTS_PER_SHOT_OFFSET);
}

/**
 * The confidence at or below which a field must NOT influence the render.
 *
 * `04 §3`: "Every low-confidence field falls back to the template default
 * rather than guessing." That sentence is the whole safety property of style
 * transfer under ARCHITECTURE §11.2 R6, so it is a constant the mapping
 * checks rather than a habit each call site is trusted to remember. Anything
 * at 0 was not measured at all; the band up to this floor is "measured, but
 * not well enough to overrule a template that was designed by a human".
 */
export const USABLE_CONFIDENCE_FLOOR = 0.5;

export function isUsable(confidence: number | undefined): boolean {
  return confidence !== undefined && confidence > USABLE_CONFIDENCE_FLOOR;
}

// ---------------------------------------------------------------------------
// Sub-shapes
// ---------------------------------------------------------------------------

export const RhythmPatternSchema = z.enum([
  "establish_accelerate_hold",
  "uniform",
  "accelerating",
]);
export type RhythmPattern = z.infer<typeof RhythmPatternSchema>;

export const FingerprintRhythmSchema = z.object({
  shotCount: z.number().int().nonnegative(),
  cutCount: z.number().int().nonnegative(),
  cutsPerMin: z.number().positive().nullable(),
  medianShotMs: z.number().int().positive().nullable(),
  meanShotMs: z.number().int().positive().nullable(),
  minShotMs: z.number().int().nonnegative().nullable(),
  maxShotMs: z.number().int().nonnegative().nullable(),
  shotDurationsMs: z.array(z.number().int().nonnegative()),
  pattern: RhythmPatternSchema.nullable(),
});
export type FingerprintRhythm = z.infer<typeof FingerprintRhythmSchema>;

export const FingerprintAudioSchema = z.object({
  tempoBpm: z.number().positive().nullable(),
  /**
   * The reference's OWN beat times. Present because `beatLockRatio` was
   * computed against them and a ratio nobody can recheck is not evidence.
   *
   * NEVER an input to a render. 00_MASTER invariant 5 ("reference audio is
   * never reused — style transfer copies rhythm, never the track") and 04 §4
   * step 4 ("re-derive the beat grid from the NEW audio — never reuse the
   * reference's beat times") both land on this field. `style-transfer.ts`
   * enforces it structurally rather than by convention: the mapping's input
   * type cannot see this array, and `assertNoReferenceAudioLeak` re-checks
   * the finished plan.
   */
  beatTimesMs: z.array(z.number().int().nonnegative()),
  beatCount: z.number().int().nonnegative(),
  gridQuality: z.number().nonnegative().nullable(),
  beatLockRatio: z.number().min(0).max(1).nullable(),
  beatLockMedianMs: z.number().int().nonnegative().nullable(),
  cutToBeatDeltasMs: z.array(z.number().int().nonnegative()),
});
export type FingerprintAudio = z.infer<typeof FingerprintAudioSchema>;

/**
 * Three-valued, deliberately.
 *
 * "I measured that this layer is absent" and "I could not measure this
 * layer" are different claims, and collapsing them is how a fingerprint
 * starts lying — an `absent` the extractor did not earn would switch OFF a
 * layer the template would otherwise have rendered. `undetermined` carries
 * confidence 0, which routes to the template default (04 §3).
 */
export const LayerVerdictSchema = z.enum(["present", "absent", "undetermined"]);
export type LayerVerdict = z.infer<typeof LayerVerdictSchema>;

export const FingerprintCaptionsSchema = z.object({
  layerVerdicts: z.object({
    banner: LayerVerdictSchema,
    karaoke: LayerVerdictSchema,
    handle: LayerVerdictSchema,
  }),
  layers: z.array(z.enum(["banner", "karaoke", "handle"])),
  undeterminedLayers: z.array(z.enum(["banner", "karaoke", "handle"])),
  occupancy: z.record(z.string(), z.number()),
  // --- ARCHITECTURE §11.2 R6: not measurable without OCR in v1. ------------
  // Typed as nullable rather than omitted so the shape stays stable when v2
  // adds OCR and starts populating them — a consumer written today against
  // `null` keeps compiling.
  wordsPerChunkMedian: z.number().int().positive().nullable(),
  styleClass: z.string().nullable(),
  positionSequence: z.array(z.string()).nullable(),
  emphasis: z
    .object({
      colored: z.boolean(),
      scaleRatio: z.number(),
      accentHex: z.string(),
    })
    .nullable(),
});
export type FingerprintCaptions = z.infer<typeof FingerprintCaptionsSchema>;

export const FingerprintMotionSchema = z.object({
  microMotion: z.boolean().nullable(),
  meanScaleDelta: z.number().nonnegative().nullable(),
  medianScaleDelta: z.number().nonnegative().nullable(),
  shotsWithMotionRatio: z.number().min(0).max(1).nullable(),
  shotsWithMotion: z.number().int().nonnegative().optional(),
  shotCount: z.number().int().nonnegative().optional(),
  punchEventsMs: z.array(z.number().int().nonnegative()),
  perShotScaleDelta: z.array(z.number()),
});
export type FingerprintMotion = z.infer<typeof FingerprintMotionSchema>;

/**
 * Absolute look descriptors, NOT the multipliers 01 §6 quotes.
 *
 * 01 §6's "contrast ~1.08, saturation ~1.06" are multipliers applied to an
 * ungraded source. These are measurements of finished pixels normalised
 * against neutral-image constants. Recovering a multiplier would require the
 * ungraded source, which we do not have and never will — the reference
 * arrived graded. They are comparable BETWEEN reels measured the same way,
 * which is all nearest-template matching needs, and they are not
 * interpretable as "the grade that was applied". Confidence 0.5 records that.
 */
export const FingerprintGradeSchema = z.object({
  contrast: z.number().nullable(),
  saturation: z.number().nullable(),
  warmth: z.number().nullable(),
  vignette: z.number().nullable(),
  blackPointP1: z.number().nullable(),
  whitePointP99: z.number().nullable(),
});
export type FingerprintGrade = z.infer<typeof FingerprintGradeSchema>;

export const FingerprintFramingDetailSchema = z.object({
  mode: z.enum(["letterbox", "fill"]),
  videoTopRow: z.number().int().nonnegative(),
  videoBottomRow: z.number().int().nonnegative(),
  topBarRatio: z.number().min(0).max(1),
  bottomBarRatio: z.number().min(0).max(1),
  contentRegionRatio: z.number().positive().max(1),
  contentWidthPx: z.number().int().positive(),
  contentHeightPx: z.number().int().positive(),
  contentAspect: z.number().positive(),
  frameWidthPx: z.number().int().positive(),
  frameHeightPx: z.number().int().positive(),
  overlayBandsAboveVideo: z.array(z.array(z.number().int().nonnegative())),
});
export type FingerprintFramingDetail = z.infer<typeof FingerprintFramingDetailSchema>;

export const EditFingerprintSchema = z.object({
  fingerprintVersion: z.string().min(1),
  sourceAssetId: z.string().nullable(),
  durationMs: z.number().int().positive(),
  /** Container AVERAGE rate — what shot times are derived from. */
  fps: z.number().positive(),
  /** Container NOMINAL rate (`r_frame_rate`). 23.976 on the reference, which
   *  is the figure 01 §1 quotes; the average is 24.423. Both are real and
   *  they measure different things — recorded so nobody re-derives the
   *  discrepancy from scratch. */
  fpsNominal: z.number().positive().nullable(),
  framing: z.enum(["letterbox", "fill"]),
  framingDetail: FingerprintFramingDetailSchema,
  rhythm: FingerprintRhythmSchema,
  audio: FingerprintAudioSchema,
  captions: FingerprintCaptionsSchema,
  motion: FingerprintMotionSchema,
  grade: FingerprintGradeSchema,
  transitions: z.object({
    kinds: z.array(z.string()),
    counts: z.record(z.string(), z.number()),
    note: z.string().optional(),
  }),
  /** Per-field, 0..1. Keys are the field paths the extractor measured. */
  confidence: z.record(z.string(), z.number().min(0).max(1)),
});
export type EditFingerprint = z.infer<typeof EditFingerprintSchema>;

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

function loudParse<T>(schema: z.ZodType<T>, raw: unknown, label: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  • [${i.path.join(".")}] ${i.message}`);
    throw new Error(`fingerprint validation failed for ${label}:\n${lines.join("\n")}`);
  }
  return parsed.data;
}

/**
 * The cuts-vs-shots invariant, checked rather than assumed.
 *
 * Zod cannot express "cutCount is shotCount − 1" as a field rule, and this is
 * exactly the kind of cross-field convention that drifts silently when
 * someone adds a second producer of this payload. A mismatch is a bug in the
 * extractor, and it must fail here rather than propagate into a cuts/min
 * figure that a gate then reads.
 */
export function assertCutConvention(fp: EditFingerprint, label: string): void {
  const expected = cutsForShots(fp.rhythm.shotCount);
  if (fp.rhythm.cutCount !== expected) {
    throw new Error(
      `${label}: cuts-vs-shots convention violated — ${fp.rhythm.shotCount} shots implies ` +
        `${expected} cuts (N shots ⇒ N−1 cuts; t=0 is not a cut, ARCHITECTURE §11.3), ` +
        `but the payload reports ${fp.rhythm.cutCount}.`,
    );
  }
  if (fp.rhythm.shotDurationsMs.length !== fp.rhythm.shotCount) {
    throw new Error(
      `${label}: ${fp.rhythm.shotCount} shots but ${fp.rhythm.shotDurationsMs.length} durations.`,
    );
  }
}

export function assertValidEditFingerprint(raw: unknown, label = "fingerprint.json"): EditFingerprint {
  const fp = loudParse(EditFingerprintSchema, raw, label);
  assertCutConvention(fp, label);
  return fp;
}

// ---------------------------------------------------------------------------
// Calibration baseline + acceptance (04 §6, as amended by ARCHITECTURE §11.3)
// ---------------------------------------------------------------------------

export const ReferenceBaselineSchema = z.object({
  claimed: z.record(z.string(), z.number()),
  measured: z.object({
    shots: z.number(),
    cuts_per_min: z.number(),
    median_shot_s: z.number(),
    mean_shot_s: z.number(),
    tempo_bpm: z.number(),
    n_beats: z.number(),
    median_cut_to_beat_s: z.number(),
    beat_lock_ratio: z.number(),
    duration_s: z.number(),
  }),
  shot_durations: z.array(z.number()),
  cut_to_beat_deltas: z.array(z.number()),
});
export type ReferenceBaseline = z.infer<typeof ReferenceBaselineSchema>;

export function assertValidReferenceBaseline(raw: unknown, label = "reference_measured.json"): ReferenceBaseline {
  return loudParse(ReferenceBaselineSchema, raw, label);
}

/**
 * How far a rhythm measurement may sit from the calibration baseline.
 *
 * ── Why this is relative and not `04 §6`'s absolute band ────────────────
 * ARCHITECTURE §11.3: under the pinned harness the reference gives 30.62
 * cuts/min against 04 §6's 30–36 band and a 1335ms median against its
 * 1300–1600 band. Both clear their floor by less than one merged shot. That
 * is the same disease ADR-8 diagnosed on beat-lock: a band the exemplar
 * straddles indicts the band, not the measurement. So rhythm acceptance is
 * expressed as agreement with `reference_measured.json` — which the pinned
 * harness can re-derive — and moves only when the harness re-measures.
 *
 * 8% is chosen against the known failure mode rather than picked for
 * roundness: one shot merging or splitting at the detector threshold moves
 * cuts/min by ~3.6% (28→27 cuts) and the median by ~4%. 8% absorbs one such
 * event and roughly half of a second one; a 15% drift is a real change in
 * what the extractor thinks the reel is, and should fail.
 */
export const RHYTHM_CALIBRATION_TOLERANCE = 0.08;

/** `04 §6` survives as written for these two — ADR-8 §4.1(1)/§11.3. */
export const TEMPO_ACCEPTANCE_BPM: readonly [number, number] = [110, 115];
export const BEAT_LOCK_ACCEPTANCE_FLOOR = 0.8;

export type AcceptanceCheck = {
  field: string;
  pass: boolean;
  measured: number | string | null;
  target: string;
};

function relative(measured: number | null, baseline: number, tolerance: number): boolean {
  if (measured === null) return false;
  return Math.abs(measured - baseline) <= Math.abs(baseline) * tolerance;
}

/**
 * `04 §6`'s acceptance test, evaluated against the committed baseline.
 *
 * Returns every check rather than a bare boolean: a failing acceptance run
 * should say WHICH signal drifted and by how much, because the whole point of
 * the calibration fixture is that a number moving is evidence about the
 * extractor, not noise to re-run until green.
 */
export function evaluateAcceptance(
  fp: EditFingerprint,
  baseline: ReferenceBaseline,
): AcceptanceCheck[] {
  const b = baseline.measured;
  const tol = RHYTHM_CALIBRATION_TOLERANCE;
  const pct = `${Math.round(tol * 100)}%`;

  return [
    {
      field: "rhythm.cutsPerMin",
      pass: relative(fp.rhythm.cutsPerMin, b.cuts_per_min, tol),
      measured: fp.rhythm.cutsPerMin,
      target: `within ${pct} of baseline ${b.cuts_per_min}`,
    },
    {
      field: "rhythm.medianShotMs",
      pass: relative(fp.rhythm.medianShotMs, b.median_shot_s * 1000, tol),
      measured: fp.rhythm.medianShotMs,
      target: `within ${pct} of baseline ${b.median_shot_s * 1000}ms`,
    },
    {
      field: "rhythm.shotCount",
      pass: relative(fp.rhythm.shotCount, b.shots, tol),
      measured: fp.rhythm.shotCount,
      target: `within ${pct} of baseline ${b.shots}`,
    },
    {
      field: "audio.tempoBpm",
      pass:
        fp.audio.tempoBpm !== null &&
        fp.audio.tempoBpm >= TEMPO_ACCEPTANCE_BPM[0] &&
        fp.audio.tempoBpm <= TEMPO_ACCEPTANCE_BPM[1],
      measured: fp.audio.tempoBpm,
      target: `${TEMPO_ACCEPTANCE_BPM[0]}–${TEMPO_ACCEPTANCE_BPM[1]} BPM (04 §6, survives as written)`,
    },
    {
      field: "audio.beatLockRatio",
      pass: fp.audio.beatLockRatio !== null && fp.audio.beatLockRatio >= BEAT_LOCK_ACCEPTANCE_FLOOR,
      measured: fp.audio.beatLockRatio,
      target: `≥${BEAT_LOCK_ACCEPTANCE_FLOOR} (ADR-8: reference − 2pts)`,
    },
    {
      field: "framing",
      pass: fp.framing === "letterbox",
      measured: fp.framing,
      target: "letterbox (04 §6)",
    },
    {
      field: "captions.layerVerdicts.banner",
      pass: fp.captions.layerVerdicts.banner === "present",
      measured: fp.captions.layerVerdicts.banner,
      target: "present — detectable without OCR (region above the footage band)",
    },
    {
      field: "captions.layerVerdicts.karaoke",
      pass: fp.captions.layerVerdicts.karaoke === "present",
      measured: fp.captions.layerVerdicts.karaoke,
      target: "present — detectable without OCR (wide saturated bands, lower footage band)",
    },
    {
      // 04 §6 expects `handle` in the layer set. It is NOT detectable without
      // OCR (see `detect_layers`), so the honest pass condition is that the
      // extractor says so — an `absent` here would be a claim it did not earn,
      // and would switch off a layer the template renders by default.
      field: "captions.layerVerdicts.handle",
      pass: fp.captions.layerVerdicts.handle === "undetermined",
      measured: fp.captions.layerVerdicts.handle,
      target: "undetermined at confidence 0 ⇒ template default (04 §3 / §11.2 R6)",
    },
  ];
}
