import type { RenderPlan } from "@mcos/render/plan";
import { rhythmSlots, type RhythmOptions } from "@mcos/render/planner";
import { TEMPLATE_IDS, TEMPLATES, getTemplate, type Template, type TemplateId } from "@mcos/render/templates";
import {
  isUsable,
  type EditFingerprint,
  type FingerprintRhythm,
} from "./fingerprint.js";

/**
 * style-transfer.ts — fingerprint → RenderPlan mapping (04_STYLE_TRANSFER §4).
 *
 * Turns a measured `EditFingerprint` into (a) a template choice and (b) a
 * parameterisation of that template, re-timed to the USER's footage. It
 * deliberately stops short of assembling the plan itself: `plan.build`
 * (`jobs/plan-build.ts`) is Agent I's, so this module produces the inputs
 * that job needs and `scripts/studio/build-style-transfer-plan.ts` composes
 * them with the existing `buildTemplatePlan` to prove a real plan comes out
 * the other end.
 *
 * ── The three hard constraints, and where each is enforced ───────────────
 * 04 §5 and 00_MASTER invariants 1 and 5 are not comments here, they are
 * code:
 *
 *   1. **Reference audio is never reused** (invariant 5, 04 §4 step 4). The
 *      mapping's input type physically cannot see `fingerprint.audio
 *      .beatTimesMs` — `StyleTransferInput` takes the NEW footage's analysis
 *      and `referenceRhythm()` extracts tempo-shaped quantities only. Then
 *      `assertNoReferenceAudioLeak` re-checks the finished plan, because a
 *      type is a compile-time promise and this one is worth a runtime one.
 *
 *   2. **The reference's text is never copied** (04 §5). Structurally
 *      guaranteed rather than policed: §11.2 R6 means no OCR ran, so no text
 *      was ever read. The banner and caption words come from the
 *      ContentBrief, which this module never touches.
 *
 *   3. **The cutting grid lives in OUTPUT time** (ARCHITECTURE §12.13).
 *      `assertOutputTimeGrid` rejects the invalid quadrant — footage removal
 *      scored against the footage's own audio — before it can become a plan
 *      that is locked to a grid the artifact does not contain.
 */

// ---------------------------------------------------------------------------
// What the mapping is allowed to see
// ---------------------------------------------------------------------------

/**
 * The subset of a fingerprint the mapping may act on.
 *
 * This type is the enforcement mechanism for invariant 5, not documentation
 * of it. `tempoBpm` is a scalar — a tempo, which 00_MASTER invariant 5
 * explicitly permits ("style transfer copies rhythm, never the track"). The
 * reference's beat TIMES are absent by construction, so no amount of
 * downstream carelessness can snap the user's cuts to the reference's music.
 */
export type ReferenceRhythm = {
  cutsPerMin: number | null;
  medianShotMs: number | null;
  pattern: FingerprintRhythm["pattern"];
  tempoBpm: number | null;
  framing: "letterbox" | "fill";
  layers: readonly ("banner" | "karaoke" | "handle")[];
  warmth: number | null;
  meanScaleDelta: number | null;
  shotsWithMotionRatio: number | null;
};

export function referenceRhythm(fp: EditFingerprint): ReferenceRhythm {
  return {
    cutsPerMin: fp.rhythm.cutsPerMin,
    medianShotMs: fp.rhythm.medianShotMs,
    pattern: fp.rhythm.pattern,
    // Tempo only. Never `fp.audio.beatTimesMs`.
    tempoBpm: fp.audio.tempoBpm,
    framing: fp.framing,
    layers: fp.captions.layers,
    // Passed through at its measured confidence (0.5) on purpose. It is below
    // `USABLE_CONFIDENCE_FLOOR`, so it may not set a VALUE on the render — and
    // it does not: `mapFingerprintToTemplate` sources `grade` from the
    // template. Its only consumer is the ordinal warmth tiebreak in
    // `selectTemplate`, where "is this reel warmer or cooler" is a question a
    // 0.5-confidence absolute measurement can legitimately answer.
    warmth: fp.grade.warmth,
    meanScaleDelta: fp.motion.meanScaleDelta,
    shotsWithMotionRatio: fp.motion.shotsWithMotionRatio,
  };
}

// ---------------------------------------------------------------------------
// Template rhythm characteristics — derived, never hardcoded
// ---------------------------------------------------------------------------

/** Nominal clip used to characterise a template's rhythm curve. */
const CHARACTERISATION_SEC = 60;
const CHARACTERISATION_SEED = 42;

export type TemplateRhythmProfile = {
  templateId: TemplateId;
  cutsPerMin: number;
  medianShotMs: number;
};

/**
 * A template's expected rhythm, computed by running its own curve.
 *
 * `templates/index.ts` states these in prose ("~35 cuts/min against T1's
 * ~32"), and a comment is exactly the wrong place for a number the mapping
 * makes a decision on — retuning a band would silently invalidate it. This
 * runs `rhythmSlots`, the same generator the planner uses, at a fixed seed,
 * so the profile is derived from the code that will actually produce the cuts.
 */
export function templateRhythmProfile(template: Template): TemplateRhythmProfile {
  const slots = rhythmSlots(CHARACTERISATION_SEC, CHARACTERISATION_SEED, template.rhythm);
  // Take only the slots that fit the nominal clip — the generator
  // deliberately overshoots so the DP never runs out of layers.
  const used: number[] = [];
  let covered = 0;
  for (const s of slots) {
    if (covered >= CHARACTERISATION_SEC) break;
    used.push(s);
    covered += s;
  }
  const sorted = [...used].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return {
    templateId: template.id,
    cutsPerMin: (used.length - 1) / (covered / 60),
    medianShotMs: Math.round(median * 1000),
  };
}

// ---------------------------------------------------------------------------
// Nearest template by vector distance (04 §4 step 1)
// ---------------------------------------------------------------------------

/**
 * Weights over `04 §4`'s five-term distance vector.
 *
 * ── What R6 did to this vector, stated honestly ─────────────────────────
 * 04 §4 step 1 names `(cuts_per_min, median_shot_ms, caption_style_class,
 * framing, layer_set)`. Three of those five carry no discriminating power in
 * v1, and pretending otherwise would produce a confident-looking match driven
 * by noise:
 *
 *   caption_style_class — needs OCR + a vision classifier. §11.2 R6 rules
 *     both out, so the fingerprint reports `null` at confidence 0. Weight 0.
 *   framing — all three shipped templates are `letterbox` by construction
 *     (`templates/index.ts` types the field as the literal, so `fill` cannot
 *     be reached without a visible diff). A term that is constant across
 *     every candidate cannot separate them. Weight 0, and it becomes a
 *     FILTER instead: a `fill` fingerprint has no legal template in v1.
 *   layer_set — banner and karaoke are present in all three templates and
 *     `handle` is `undetermined`. Also constant. Weight 0.
 *
 * So the live terms are the two rhythm ones, plus warmth as a weak ordinal
 * tiebreak. That is a smaller vector than 04 §4 describes, and it is the
 * honest one: rhythm is what this milestone can actually measure well, and
 * rhythm is what most distinguishes the three templates anyway.
 */
export const TEMPLATE_MATCH_WEIGHTS = {
  cutsPerMin: 1.0,
  medianShotMs: 1.0,
  /**
   * Ordinal only, and low. The fingerprint's `warmth` is `(R−B)/255` on
   * finished pixels; a template's `warmTint` is the strength of a warm
   * overlay it applies. They are different physical quantities and their
   * magnitudes are not comparable (see `FingerprintGradeSchema`). What IS
   * comparable is their ORDER: a warm reel should prefer the warmer
   * template. Used as a ranked nudge, never as a distance in absolute units.
   */
  warmthRank: 0.25,
  captionStyleClass: 0.0,
  framing: 0.0,
  layerSet: 0.0,
} as const;

export type TemplateMatch = {
  templateId: TemplateId;
  distance: number;
  terms: Record<string, number>;
};

export type TemplateSelection = {
  chosen: TemplateId;
  ranked: TemplateMatch[];
  /** Terms that contributed nothing, and why — surfaced so a reviewer reading
   *  a match never assumes all five of 04 §4's terms were live. */
  inertTerms: string[];
};

function normalisedDelta(a: number | null, b: number): number | null {
  if (a === null || !Number.isFinite(a) || b === 0) return null;
  return Math.abs(a - b) / Math.abs(b);
}

/**
 * Pick the nearest template (04 §4 step 1).
 *
 * Throws when the fingerprint's framing has no template that can serve it —
 * `plan_infeasible` rather than a silent downgrade to a template that will
 * render the wrong shape. v1 is letterbox-only (§11.1 R2).
 */
export function selectTemplate(ref: ReferenceRhythm): TemplateSelection {
  const candidates = TEMPLATE_IDS.map((id) => TEMPLATES[id]).filter((t) => t.framing === ref.framing);
  if (!candidates.length) {
    throw new StyleTransferInfeasible(
      `no v1 template renders framing "${ref.framing}" — all three are letterbox ` +
        "(ARCHITECTURE §11.1 R2 defers `fill` to v2 with face detection).",
    );
  }

  // Warmth as a rank, not a magnitude: order the candidates by their own
  // warmTint and score how far each sits from the end the reference wants.
  const byWarmth = [...candidates].sort((a, b) => a.grade.warmTint - b.grade.warmTint);
  const warmestFirst = ref.warmth !== null && ref.warmth > 0;

  const ranked: TemplateMatch[] = candidates
    .map((template) => {
      const profile = templateRhythmProfile(template);
      const cuts = normalisedDelta(ref.cutsPerMin, profile.cutsPerMin);
      const median = normalisedDelta(ref.medianShotMs, profile.medianShotMs);

      const warmthIndex = byWarmth.indexOf(template);
      const wanted = warmestFirst ? byWarmth.length - 1 : 0;
      const warmthRank =
        ref.warmth === null ? 0 : Math.abs(warmthIndex - wanted) / Math.max(1, byWarmth.length - 1);

      const terms: Record<string, number> = {
        cutsPerMin: (cuts ?? 0) * TEMPLATE_MATCH_WEIGHTS.cutsPerMin,
        medianShotMs: (median ?? 0) * TEMPLATE_MATCH_WEIGHTS.medianShotMs,
        warmthRank: warmthRank * TEMPLATE_MATCH_WEIGHTS.warmthRank,
      };
      const distance = Object.values(terms).reduce((a, b) => a + b, 0);
      return { templateId: template.id, distance, terms };
    })
    .sort((a, b) => a.distance - b.distance || a.templateId.localeCompare(b.templateId));

  return {
    chosen: ranked[0]!.templateId,
    ranked,
    inertTerms: [
      "captionStyleClass (confidence 0 — no OCR in v1, ARCHITECTURE §11.2 R6)",
      "framing (constant: all v1 templates are letterbox — used as a filter instead)",
      "layerSet (constant: banner+karaoke in all templates; handle undetermined)",
    ],
  };
}

// ---------------------------------------------------------------------------
// Re-timing to the user's footage (04 §4 steps 2–3)
// ---------------------------------------------------------------------------

/** G4 / `DEFAULT_BOUNDS.minShotSec` — 04 §4 step 3 restates it as a floor the
 *  re-timing must enforce, so it is applied here rather than left to the DP. */
export const MIN_SHOT_SEC = 0.6;
/** A rescale beyond this is no longer "this template, paced like that reel" —
 *  it is a different template. Clamping keeps the mapping inside the band the
 *  template was designed and gate-checked for (G2/G3). */
export const MAX_RHYTHM_RESCALE = 1.6;
export const MIN_RHYTHM_RESCALE = 0.625;

export type RetimedRhythm = {
  rhythm: Required<RhythmOptions>;
  /** The proportional factor applied to every band. */
  rescale: number;
  /** True when `rescale` hit a clamp — the reference is paced further from
   *  this template than the template can honestly be stretched to reach. */
  clamped: boolean;
  minShotSecAfter: number;
};

/**
 * Scale the template's rhythm curve toward the fingerprint's measured pace
 * (04 §4 steps 2–3).
 *
 * "Scale the rhythm pattern proportionally; enforce min shot 0.6s" — one
 * factor applied to every band, so the template's *shape* (the ratio between
 * establish, accelerate and hold, which is 01 §2's "rhythmic breathing")
 * survives while its absolute pace moves. Rescaling the bands independently
 * would hit the target median faster and destroy the thing being transferred.
 *
 * The shot count is NOT matched, deliberately. 04 §4 step 3 says "the
 * fingerprint's shot count rarely matches available footage"; the DP in
 * `beat-plan.ts` decides how many cuts the user's speech can actually carry,
 * and forcing the reference's 29 onto a clip that has room for 12 would push
 * cuts into mid-word positions — the exact failure ARCHITECTURE §4.2 rebuilt
 * the planner to avoid.
 */
export function retimeRhythm(template: Template, ref: ReferenceRhythm): RetimedRhythm {
  const profile = templateRhythmProfile(template);
  const target = ref.medianShotMs;

  let rescale = target === null ? 1 : target / profile.medianShotMs;
  const wanted = rescale;
  rescale = Math.min(MAX_RHYTHM_RESCALE, Math.max(MIN_RHYTHM_RESCALE, rescale));
  const clamped = Math.abs(rescale - wanted) > 1e-9;

  const scale = (band: [number, number]): [number, number] => [
    Math.max(MIN_SHOT_SEC, band[0] * rescale),
    Math.max(MIN_SHOT_SEC, band[1] * rescale),
  ];

  const rhythm: Required<RhythmOptions> = {
    establishSec: scale(template.rhythm.establishSec),
    accelerateSec: scale(template.rhythm.accelerateSec),
    holdSec: scale(template.rhythm.holdSec),
    // Burst COUNT is a shape property, not a duration — rescaling pace must
    // not change how many shots a burst contains.
    burstShots: template.rhythm.burstShots,
  };

  return {
    rhythm,
    rescale: Math.round(rescale * 1e6) / 1e6,
    clamped,
    minShotSecAfter: Math.min(
      rhythm.establishSec[0],
      rhythm.accelerateSec[0],
      rhythm.holdSec[0],
    ),
  };
}

// ---------------------------------------------------------------------------
// The mapping
// ---------------------------------------------------------------------------

export class StyleTransferInfeasible extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StyleTransferInfeasible";
  }
}

export type FieldSource = "fingerprint" | "template_default";

export type StyleTransferMapping = {
  templateId: TemplateId;
  selection: TemplateSelection;
  retimed: RetimedRhythm;
  /** Tempo carried across as a scalar. NEVER beat times (invariant 5). */
  referenceTempoBpm: number | null;
  /** Per-field provenance: which fields the fingerprint actually drove, and
   *  which fell back to the template (04 §3). Reported so a "recreate in this
   *  style" claim can be audited against what was really transferred. */
  fieldSources: Record<string, FieldSource>;
  /** Human-readable notes on every field that fell back and why. */
  fallbacks: string[];
};

/**
 * `04 §4` steps 1–3, as a pure function.
 *
 * Step 4 (re-derive the grid from the NEW audio) is not here because there is
 * nothing to decide: the grid comes from the user's own `MediaAnalysis`, and
 * the guarantee that the reference's grid did not leak into it is enforced by
 * `assertNoReferenceAudioLeak` on the finished plan.
 */
export function mapFingerprintToTemplate(fp: EditFingerprint): StyleTransferMapping {
  const ref = referenceRhythm(fp);
  const selection = selectTemplate(ref);
  const template = getTemplate(selection.chosen);
  const retimed = retimeRhythm(template, ref);

  const fieldSources: Record<string, FieldSource> = {};
  const fallbacks: string[] = [];

  const usable = (key: string) => isUsable(fp.confidence[key]);

  fieldSources["rhythm.bands"] = usable("rhythm") ? "fingerprint" : "template_default";
  if (!usable("rhythm")) fallbacks.push("rhythm: confidence too low — template curve unchanged.");

  fieldSources["framing"] = usable("framing") ? "fingerprint" : "template_default";

  // Motion: magnitude is Medium-fidelity (0.45) and below the usable floor,
  // so the template's own camera settings stand. The fingerprint's motion is
  // still recorded on the mapping for review — it is evidence about the
  // reference, just not authority over our render.
  fieldSources["motion.magnitude"] = usable("motion") ? "fingerprint" : "template_default";
  if (!usable("motion")) {
    fallbacks.push(
      "motion: optical-flow magnitude is Medium fidelity (04 §2) and a talking head " +
        "contaminates the radial fit — template camera settings stand.",
    );
  }

  // Grade: NOT mappable in v1, and not for a confidence reason.
  // The fingerprint measures absolute finished pixels; a template's grade is
  // a set of multipliers applied to an ungraded source. They are different
  // physical quantities, so there is no correct way to assign one to the
  // other — a mapping here would be arithmetic on incompatible units. Only
  // the ORDER of warmth is used, and only in template selection.
  fieldSources["grade"] = "template_default";
  fallbacks.push(
    "grade: the fingerprint measures the absolute look of finished pixels; a template's " +
      "grade is multipliers over an ungraded source. Not the same quantity — warmth is " +
      "used as an ordinal tiebreak in template selection only, never as a value.",
  );

  for (const key of [
    "captions.wordsPerChunkMedian",
    "captions.styleClass",
    "captions.positionSequence",
    "captions.emphasis",
    "captions.layers.handle",
  ]) {
    fieldSources[key] = "template_default";
  }
  fallbacks.push(
    "captions (timing, position pattern, words-per-chunk, style class, emphasis, handle): " +
      "confidence 0 — no OCR in v1 (ARCHITECTURE §11.2 R6). Template defaults apply, which " +
      "is what 04 §3 specifies for a low-confidence field.",
  );

  return {
    templateId: selection.chosen,
    selection,
    retimed,
    referenceTempoBpm: ref.tempoBpm,
    fieldSources,
    fallbacks,
  };
}

// ---------------------------------------------------------------------------
// Hard constraints, checked on the finished plan
// ---------------------------------------------------------------------------

/**
 * 00_MASTER invariant 5 / 04 §4 step 4, verified rather than trusted.
 *
 * The mapping's input type already makes leaking the reference's grid
 * impossible at compile time. This is the runtime backstop for the path that
 * type cannot cover — a plan assembled elsewhere, by a job this module does
 * not own, that reached for the wrong analysis row.
 *
 * The test is structural identity, not similarity: two genuinely different
 * recordings at the same tempo will share beat times by coincidence, and
 * failing those would make the guard useless. What cannot be coincidence is a
 * plan grid that reproduces the reference's grid.
 */
export function assertNoReferenceAudioLeak(plan: RenderPlan, fp: EditFingerprint): void {
  const planBeats = plan.beatGrid.beatTimesMs;
  const refBeats = fp.audio.beatTimesMs;
  if (!planBeats.length || !refBeats.length) return;

  const refSet = new Set(refBeats);
  const shared = planBeats.filter((t) => refSet.has(t)).length;
  const overlap = shared / planBeats.length;

  // A grid re-derived from different audio does not reproduce another
  // recording's beat times wholesale. 90% is well clear of what shared tempo
  // alone produces (which drifts apart within a few bars) and well under the
  // 100% an actual reuse would show.
  if (overlap >= 0.9) {
    throw new StyleTransferInfeasible(
      `reference audio leaked into the plan: ${shared}/${planBeats.length} ` +
        `(${Math.round(overlap * 100)}%) of the plan's beat times are the reference's own. ` +
        "00_MASTER invariant 5 — style transfer copies tempo, never the track. " +
        "Re-derive the grid from the user's footage/bed (04 §4 step 4).",
    );
  }
}

/**
 * ARCHITECTURE §12.13 — the cutting grid must be valid in OUTPUT time.
 *
 * Removing footage makes output time ≠ source time, so a grid derived from
 * the footage's own audio stops describing what the viewer hears. §12.13's
 * table has exactly two legal configurations, and this rejects the third:
 *
 *   continuous playthrough + footage's own grid  → legal (source IS output)
 *   footage removal        + music bed's grid    → legal (bed is output-time
 *                                                  by construction)
 *   footage removal        + footage's own grid  → REJECTED here
 *
 * Detected from the plan rather than declared by the caller: a plan removes
 * footage exactly when some cut's source span does not continue where the
 * previous one ended, and that is decidable from the cuts alone.
 */
export function assertOutputTimeGrid(plan: RenderPlan): void {
  const removesFootage = plan.cuts.some((cut, i) => {
    if (i === 0) return false;
    const prev = plan.cuts[i - 1]!;
    // A tolerance of one millisecond absorbs ms-rounding at the boundary; a
    // real removal is orders of magnitude larger.
    return Math.abs(cut.sourceInMs - prev.sourceOutMs) > 1;
  });

  if (removesFootage && plan.music === null) {
    throw new StyleTransferInfeasible(
      "invalid grid configuration (ARCHITECTURE §12.13): this plan REMOVES footage, so " +
        "output time ≠ source time and a grid derived from the footage's own audio does not " +
        "exist in the artifact. A plan that really cuts needs a music bed, whose grid is " +
        "output-time by construction. Either add a bed or emit a continuous playthrough.",
    );
  }
}

/** Every hard constraint 04 §5 places on a style-transferred plan. */
export function assertStyleTransferConstraints(plan: RenderPlan, fp: EditFingerprint): void {
  assertNoReferenceAudioLeak(plan, fp);
  assertOutputTimeGrid(plan);
}

// ---------------------------------------------------------------------------
// Fingerprint-derived observations → PROPOSED claims only (invariant 1)
// ---------------------------------------------------------------------------

export type FingerprintObservation = {
  kind: "format" | "rhythm" | "hook";
  text: string;
  /** Always `proposed`. There is no other value, and that is the point. */
  status: "proposed";
  /** The measured numbers behind the sentence, so a reviewer decides on
   *  evidence rather than on a summary. */
  evidence: Record<string, number | string | null>;
  confidence: number;
};

/**
 * Strategically interesting observations a fingerprint supports (04 §5).
 *
 * ── Why this returns rows and writes nothing ───────────────────────────
 * 04 §5 says these "enter the Brain as proposed claims through the review
 * gate — never auto-written", and 00_MASTER invariant 1 says the same. Both
 * are satisfied here in the strongest available way: nothing is persisted at
 * all. That is not laziness, it is the only option that does not break a
 * different invariant.
 *
 * CLAUDE.md invariant 2 is EVIDENCE OR DROP — "a claim without
 * transcript_segment linkage + verbatim quote is invalid and must be dropped
 * and counted, never persisted" — and `CandidateClaim` enforces it in the
 * schema: `meetingId`, `evidenceSourceId`, `extractionRunId`,
 * `verbatimQuote`, `speaker` and `timestampMs` are all NOT NULL. A
 * fingerprint has none of them. It is not derived from a meeting, there is
 * no transcript segment, and there is certainly no verbatim quote — §11.2 R6
 * means no text was ever read off the reel.
 *
 * So writing one of these into `candidate_claims` would require either
 * fabricating provenance or relaxing NOT NULL columns on the M1 review
 * gate's own table. The first is dishonest and the second is outside this
 * agent's boundary (07 §4) and arguably not additive. **This is a real
 * conflict between 04 §5 and CLAUDE.md invariant 2, and it needs a human
 * ruling, not an agent's improvisation** — see the PR body. Until then the
 * observations are produced, typed and testable, and the gate stays the only
 * write path, which is the invariant that actually matters.
 */
export function proposeFingerprintObservations(fp: EditFingerprint): FingerprintObservation[] {
  const out: FingerprintObservation[] = [];
  const r = fp.rhythm;

  if (r.cutsPerMin !== null && r.medianShotMs !== null && isUsable(fp.confidence.rhythm)) {
    out.push({
      kind: "rhythm",
      text:
        `Reference reel cuts at ${r.cutsPerMin.toFixed(1)} cuts/minute with a ` +
        `${(r.medianShotMs / 1000).toFixed(2)}s median shot.`,
      status: "proposed",
      evidence: {
        cutsPerMin: r.cutsPerMin,
        medianShotMs: r.medianShotMs,
        shotCount: r.shotCount,
        cutCount: r.cutCount,
      },
      confidence: fp.confidence.rhythm ?? 0,
    });
  }

  if (r.pattern && isUsable(fp.confidence.rhythm_pattern ?? 0)) {
    out.push({
      kind: "format",
      text: `Reference reel paces itself as "${r.pattern}" rather than on a fixed interval.`,
      status: "proposed",
      evidence: { pattern: r.pattern, shotDurationsSample: r.shotDurationsMs.slice(0, 8).join(",") },
      confidence: fp.confidence.rhythm_pattern ?? 0,
    });
  }

  if (fp.audio.tempoBpm !== null && fp.audio.beatLockRatio !== null && isUsable(fp.confidence.audio)) {
    out.push({
      kind: "format",
      text:
        `Reference reel cuts to the beat: ${Math.round(fp.audio.beatLockRatio * 100)}% of cuts ` +
        `land within 150ms of a beat at ${fp.audio.tempoBpm.toFixed(1)} BPM.`,
      status: "proposed",
      evidence: {
        tempoBpm: fp.audio.tempoBpm,
        beatLockRatio: fp.audio.beatLockRatio,
        beatLockMedianMs: fp.audio.beatLockMedianMs,
      },
      confidence: fp.confidence.audio ?? 0,
    });
  }

  if (isUsable(fp.confidence.framing)) {
    out.push({
      kind: "format",
      text:
        `Reference reel is ${fp.framing}, with the footage occupying ` +
        `${Math.round(fp.framingDetail.contentRegionRatio * 100)}% of frame height ` +
        `(${fp.framingDetail.contentAspect.toFixed(2)}:1) and the bars carrying the captions.`,
      status: "proposed",
      evidence: {
        framing: fp.framing,
        contentRegionRatio: fp.framingDetail.contentRegionRatio,
        contentAspect: fp.framingDetail.contentAspect,
      },
      confidence: fp.confidence.framing ?? 0,
    });
  }

  return out;
}
