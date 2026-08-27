import { mulberry32 } from "../rng.js";
import { MIN_VISIBLE_SCALE_DELTA, SPRINGS, driftDurationInFrames, type HouseSpringConfig } from "./springs.js";

/**
 * camera.ts — per-shot micro-motion, ported from founder-journey
 * `remotion/src/motion.ts` (ARCHITECTURE.md §1.1: "PORT WITH CHANGES").
 *
 * The four changes the ledger asked for, all made:
 *
 * 1. **The analytic ease-out is gone.** The source computed scale with
 *    `1 - (1-p)²` (motion.ts:32-37) — a closed-form tween, which is exactly
 *    what 02 §1 bans. This module now emits a spring *declaration* and the
 *    component drives it with `spring()`.
 * 2. **`MAX_GROW` 0.06 → the 0.05–0.08 band** of 01 §5 ("scale 1.00 →
 *    1.05–1.08 over the shot duration"), drawn per shot from the plan seed.
 * 3. **`decayingScaleFloor` did not port.** It exists only to unwind the
 *    scale padding that slide/whip entrances need, and ADR-4 leaves the whole
 *    entrance vocabulary behind.
 * 4. **`atmosphericWashAllowed` did not port.** Washes are banned decoration
 *    (01 §8), and R2 descopes face detection, so the predicate has neither a
 *    caller nor an input.
 *
 * One further deviation from the source, forced by a gate: `effectiveMotion`
 * returned `"none"` for shots under 3s, and most of our shots are under 3s.
 * G7 requires scale delta >1% on **100%** of shots and 02 §4.1 says
 * "every shot, no exceptions". `"none"` therefore is not reachable by
 * default — direction alternates instead, per 02 §4.1's "push-in on odd
 * shots, pull-back on even. A reel where every shot pushes in feels
 * monotonous."
 */

export type SpanMotion = "push" | "pull";

/** 01 §5's measured band. */
export const MIN_GROW = 0.05;
export const MAX_GROW = 0.08;

/**
 * Everything the composition needs to animate one shot's camera, and nothing
 * it has to work out for itself (plan-as-props, 03 §4). `spring()` is called
 * with `config` and `durationInFrames`, and its 0..1 output lerps
 * `fromScale → toScale`.
 */
export type ShotCamera = {
  motion: SpanMotion;
  fromScale: number;
  toScale: number;
  config: HouseSpringConfig;
  /** ARCHITECTURE §11.3: always the shot's own frame count for drift. */
  durationInFrames: number;
  /** Transform origin, 0..1 of the frame — 02 §4.1 alternates it per shot. */
  originX: number;
  originY: number;
};

/**
 * Explicit `motion` wins (the template may pin a shot); otherwise alternate.
 * Kept as a named function because it is the source's seam and templates will
 * want it.
 */
export function effectiveMotion(shotIndex: number, override?: SpanMotion): SpanMotion {
  if (override) return override;
  return shotIndex % 2 === 0 ? "push" : "pull";
}

/**
 * Alternating base framing — wide, then punched in — so that a hard cut
 * between two shots is actually VISIBLE.
 *
 * Found by rendering: the reference gets its visible cuts by removing footage
 * ("a single continuous interview, cut on itself" — 01 §8), so every cut is a
 * real discontinuity. A plan that plays its footage continuously and only
 * resets the drift spring at each boundary produces a scale step of well
 * under 1% — the cuts are invisible, a scene detector finds nothing at them,
 * and **G1b (≥90% of plan cut times matched by a detected cut) can never
 * pass**. Alternating the base framing restores the discontinuity without
 * dropping a single word of speech, which footage removal cannot promise.
 *
 * Deliberately larger than the drift range: it must survive being sampled at
 * the two sides of a cut where drift has already moved the scale.
 */
export const REFRAME_STEP = 0.18;

/**
 * Both scales stay ≥1 so the 9:16 cover-crop never reveals the source frame's
 * edges — the invariant the ported `motionScale` protected and the one thing
 * about it that must not change.
 */
export function shotCamera(
  shotIndex: number,
  shotFrames: number,
  seed: number,
  override?: SpanMotion,
  reframeStep = REFRAME_STEP,
): ShotCamera {
  const rand = mulberry32(seed + shotIndex * 7919);
  const grow = MIN_GROW + rand() * (MAX_GROW - MIN_GROW);
  const motion = effectiveMotion(shotIndex, override);
  // Even shots sit wide, odd shots punched in. Applied to BOTH ends of the
  // range, so the per-shot scale delta — and therefore G7 — is untouched.
  const base = 1 + (shotIndex % 2 === 1 ? reframeStep : 0);
  // Offset alternates between subject-centre and a slight lateral offset
  // (02 §4.1) — small enough that it never crops into the subject.
  const offset = (rand() - 0.5) * 0.08;
  return {
    motion,
    fromScale: motion === "push" ? base : base + grow,
    toScale: motion === "push" ? base + grow : base,
    config: SPRINGS.drift,
    durationInFrames: driftDurationInFrames(shotFrames),
    originX: shotIndex % 2 === 0 ? 0.5 : 0.5 + offset,
    originY: 0.5,
  };
}

/** G7, checkable straight off the declaration — no pixels required. */
export function scaleDelta(camera: ShotCamera): number {
  return Math.abs(camera.toScale - camera.fromScale);
}

export function passesMicroMotionGate(camera: ShotCamera): boolean {
  return scaleDelta(camera) > MIN_VISIBLE_SCALE_DELTA;
}

/** Lerp a spring's 0..1 progress onto the shot's scale range. */
export function scaleAt(camera: ShotCamera, springProgress: number): number {
  return camera.fromScale + (camera.toScale - camera.fromScale) * springProgress;
}

/**
 * 02 §4.2's emphasis punch, as a declaration: `scale +6% over 8 frames with
 * SPRINGS.punch, settle over 14 frames`, landing on the emphasis word's
 * onset. Additive on top of the shot's drift scale.
 */
export const PUNCH_SCALE_BOOST = 0.06;
