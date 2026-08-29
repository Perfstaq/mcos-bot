import { faceFloorOriginY } from "../captions/layout.js";
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
  /**
   * Transform origin for the zoom, **0..1 of the CONTENT REGION** — not of the
   * frame. `Reel.tsx` applies it as a CSS `transform-origin` on the region
   * div, whose height is `frameHeight × regionRatio`, so region coordinates
   * are the units it is read in.
   *
   * The old comment here said "0..1 of the frame". That was numerically
   * harmless only while `originY` was 0.5 — the region is vertically centred,
   * so its midpoint and the frame's coincide — and it is exactly the kind of
   * constant-whose-name-lies that §12.14 and §12.16 item 3 each had to record
   * once already. `originY` is no longer 0.5, so the distinction is now load
   * bearing: see `REFRAME_STEP`.
   *
   * 02 §4.1 alternates `originX` per shot.
   */
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
 * between two shots reads as a change rather than a jump in nothing.
 *
 * ── Two corrections live in this constant ───────────────────────────────────
 * **It does not make G1b passable** (ARCHITECTURE §12.14). The comment here
 * used to claim that alternating the base framing "restores the
 * discontinuity" a scene detector needs. Measurement falsified that: the
 * render scores 2/29 on G1b with this in place. Real jump cuts need footage
 * REMOVAL plus an output-time grid (§12.3, §12.13), neither of which is this.
 *
 * **It was reduced 0.18 → 0.10** (§12.16 item 2), and that reduction alone was
 * NOT enough (§12.19). The claim this comment used to make — that the origin
 * at the region's centre makes the face "the near-fixed point of the zoom
 * rather than the thing it displaces" — is true of the EYES and false of the
 * CHIN, and the chin is the line the caption band is derived from. It sits
 * 416px below the region's centre, so composing drift × punch up to
 * 1.18 × 1.06 ≈ 1.25 walks it from 0.717 down to 0.771, through caption tops
 * at 0.755 and 0.733. §12.16 item 3 asked for the reframe to be neutralised;
 * reducing the step only made it smaller.
 *
 * **It is now neutralised at the origin instead** (`faceFloorOriginY`). The
 * zoom is anchored on the chin line, which makes the chin the transform's
 * exact fixed point: `FACE_FLOOR_RATIO` is where the chin is at EVERY scale,
 * not just at 1.0, so the derivation the caption anchors were built on is
 * finally true of the thing that renders. The step is left at 0.10 because it
 * is now a framing choice rather than a caption-safety one.
 *
 * Why the origin and not the anchors: deriving the anchors against the
 * worst-case composed chin (0.771) instead would have collapsed all three
 * positions into a ~9px window — every two-line block needs its centre in
 * y ∈ [0.823, 0.828] to clear both 0.771 and G9's bottom bound — which
 * destroys the vertical separation the rotation exists for and re-couples the
 * anchors to `REFRAME_STEP`, `MAX_GROW` and `punchScale`, so any later change
 * to any of the three silently re-opens this bug. Anchoring the origin fixes
 * every scale term at once and leaves the face floor a single measured number.
 */
export const REFRAME_STEP = 0.1;

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
    // The chin line, in region coordinates (§12.19) — every shot, not just the
    // reframed odd ones: an even shot still grows 5–8%, which moves a
    // centre-anchored chin 33px down, and "only the odd shots are safe" is not
    // a property anyone can hold in their head.
    originY: faceFloorOriginY(),
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
