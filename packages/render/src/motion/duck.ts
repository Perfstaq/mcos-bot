/**
 * duck.ts — music-under-voice ducking. **Ported as-is** from founder-journey
 * `remotion/src/duck.ts` (ARCHITECTURE.md §1.1: "PORT AS-IS — pure,
 * unit-testable music-under-voice gain math, exactly 03 §5's sidechain
 * ducking. Audio infrastructure, not decoration.").
 *
 * The ledger's one explicit disagreement with a maximal reading of the
 * restraint thesis: restraint applies to visible decoration, not to audio
 * plumbing. Pure math, no framework import, so the gain curve is directly
 * unit-testable.
 */

export type SpeechWindow = { start: number; end: number };

export type DuckOptions = {
  duckLevel?: number; // gain multiplier while speech is active (0..1)
  attackSec?: number; // ramp-down time before a window starts
  releaseSec?: number; // ramp-up time after a window ends
};

/**
 * Gain multiplier (0..1) for the music bed at output time `t`, given the
 * reel's speech windows (captions double as these — wherever a caption is on
 * screen, the speaker is talking). Full volume outside any window; dips to
 * `duckLevel` for the window's duration with a short attack/release ramp
 * either side so the dip never clicks. Overlapping windows take the lowest
 * resulting gain — never fights itself into going louder than it should.
 *
 * The defaults carry a measurement from the source repo worth keeping: real
 * caption tracks run near wall-to-wall (median inter-caption gap 0ms on one
 * measured reel, 60–380ms on another), so the older 0.15s/0.35s attack and
 * release never let the bed climb back past ~0.53 anywhere in a whole reel —
 * the release ramp alone outlasted almost every real gap. 0.08s/0.15s lets a
 * real gap actually be felt without an audible pump.
 */
export function duckGain(t: number, windows: SpeechWindow[], opts: DuckOptions = {}): number {
  const duckLevel = opts.duckLevel ?? 0.45;
  const attack = opts.attackSec ?? 0.08;
  const release = opts.releaseSec ?? 0.15;
  let gain = 1;
  for (const w of windows) {
    if (w.end <= w.start) continue;
    if (t >= w.start && t <= w.end) {
      gain = Math.min(gain, duckLevel);
    } else if (t < w.start && t >= w.start - attack) {
      const p = (t - (w.start - attack)) / attack;
      gain = Math.min(gain, 1 - p * (1 - duckLevel));
    } else if (t > w.end && t <= w.end + release) {
      const p = (t - w.end) / release;
      gain = Math.min(gain, duckLevel + p * (1 - duckLevel));
    }
  }
  return gain;
}
