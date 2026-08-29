/**
 * springs.ts — the house springs (02_MOTION_SYSTEM §1).
 *
 * "Ban `interpolate()` for any visible motion. Every entrance, exit, scale and
 * position change uses `spring()`. Linear tweens are the #1 tell of generated
 * video." These four configs are the whole vocabulary; components import them
 * rather than inventing their own, so the reel has one physical feel.
 *
 * Plain data, no framework import — ADR-5's containment rule keeps the timing
 * math framework-free so a forced swap off Remotion touches the compositions
 * and nothing else. The `spring()` call itself lives in the components.
 *
 * ── ARCHITECTURE §11.3, the correction 02 never mentions ────────────────────
 * `durationInFrames` is MANDATORY on every spring call. `drift` is heavily
 * overdamped (damping 200, mass 3, stiffness 40): at its natural speed a 0.6s
 * shot traverses ~11% of the spring's range, which turns a 5% scale move into
 * a ~0.57% one and **fails G7's "scale delta >1% on 100% of shots"** — and the
 * reference's accelerate bursts are 0.7–1.2s, so this is the common case, not
 * the edge case. Rescaling with `durationInFrames = shot frames` makes the
 * spring complete inside the shot whatever the shot's length. The port source
 * passes it on every spring call; the spec doc forgot to say so.
 */

/** Structural mirror of Remotion's `SpringConfig` — declared locally so this
 *  module stays framework-free (ADR-5). Assignable to the real thing. */
export type HouseSpringConfig = {
  damping: number;
  mass: number;
  stiffness: number;
  overshootClamping?: boolean;
};

export const SPRINGS = {
  /** Text enters: overshoots then settles. The signature move. */
  pop: { damping: 12, mass: 0.5, stiffness: 200 },
  /** Frame punch on emphasis: fast, tight, minimal overshoot. */
  punch: { damping: 20, mass: 0.3, stiffness: 400 },
  /** Slow continuous push: no overshoot, just ease. */
  drift: { damping: 200, mass: 3, stiffness: 40 },
  /** Exits: quicker than entrances, always. */
  out: { damping: 18, mass: 0.4, stiffness: 260 },
} as const satisfies Record<string, HouseSpringConfig>;

export type SpringName = keyof typeof SPRINGS;

/**
 * Stated frame counts for the fixed-length springs (02 §2.1, §4.2). Only
 * `drift` is shot-length-relative; everything else has a duration the spec
 * names outright.
 */
export const SPRING_FRAMES = {
  /** Banner/caption entrance — 02 §2.1 "animates in over first 12 frames". */
  popEnter: 12,
  /** Emphasis punch attack — 02 §4.2 "scale +6% over 8 frames". */
  punchAttack: 8,
  /** …"settle over 14 frames". */
  punchSettle: 14,
} as const;

/**
 * 02 §1's "exits are ~40% faster than entrances", restated as the duration
 * rule it actually is (ARCHITECTURE §11.3) rather than a spring-config rule:
 * `SPRINGS.out` is stiffer than `SPRINGS.pop`, but with `durationInFrames`
 * driving both, only the frame count decides the speed.
 */
export const EXIT_SPEEDUP = 0.6;

export function exitFrames(enterFrames: number): number {
  return Math.max(1, Math.round(enterFrames * EXIT_SPEEDUP));
}

/**
 * The drift contract: a shot's push/pull spring completes in exactly that
 * shot. `Math.max(1, …)` because Remotion rejects a zero-frame duration and a
 * 1-frame shot cannot exist anyway under G4 (min shot 0.6s = 18 frames).
 */
export function driftDurationInFrames(shotFrames: number): number {
  return Math.max(1, Math.round(shotFrames));
}

/** G7's floor: a shot whose scale moves less than this reads as static. */
export const MIN_VISIBLE_SCALE_DELTA = 0.01;
