import { mulberry32, type Rng } from "../rng.js";

/**
 * rhythm.ts — the rhythm curve as a sequence of TARGET shot durations.
 *
 * 01_REFERENCE_ANALYSIS §2 measured the reference's core finding: "rhythmic
 * breathing, not uniform pacing" — a long establishing shot (2.5–3.5s), a
 * burst of 3–5 rapid cuts (0.7–1.3s), then a long hold (3.5–4.5s) to let a
 * point land, repeat. Never a fixed interval.
 *
 * The important change from 02 §5 step 2 is what this returns. 02 (and P's
 * M-3 simulation) turned the curve straight into cut *times*, which is the
 * step ARCHITECTURE §4.2 superseded: fixing positions before knowing where
 * legal word edges are wastes cuts on positions no word boundary can serve.
 * Here the curve produces only *targets*, one per shot slot; the DP in
 * beat-plan.ts decides the actual times and is free to bend a slot when the
 * speech geometry demands it. The rhythm becomes a soft cost, the word-edge
 * and beat constraints stay hard.
 *
 * Sanity check on the generator itself: one cycle is ~3.0s + 4×1.0s + ~4.0s
 * ≈ 11s over 6 shots — mean 1.83s, 32.7 cuts/min. The reference measures mean
 * 1.83s and 32.8 cuts/min (01 §2). The curve is not a guess.
 */

export type RhythmOptions = {
  establishSec?: [number, number];
  accelerateSec?: [number, number];
  holdSec?: [number, number];
  burstShots?: [number, number];
};

export const DEFAULT_RHYTHM: Required<RhythmOptions> = {
  establishSec: [2.5, 3.5],
  accelerateSec: [0.8, 1.3],
  holdSec: [3.5, 4.5],
  burstShots: [3, 5],
};

function draw(rand: Rng, [lo, hi]: [number, number]): number {
  return lo + rand() * (hi - lo);
}

/**
 * Target durations for as many shot slots as could possibly be needed to
 * cover `durationSec`. The DP consumes slots in order and stops wherever the
 * clip ends, so an over-long list costs nothing but a few unused DP layers.
 */
export function rhythmSlots(durationSec: number, seed: number, opts: RhythmOptions = {}): number[] {
  const cfg = { ...DEFAULT_RHYTHM, ...opts };
  const rand = mulberry32(seed);
  const slots: number[] = [];
  let covered = 0;
  // One extra cycle of headroom: the DP may run shorter shots than the curve
  // asks for, and running out of slots would truncate the search space.
  const target = durationSec * 1.5 + 12;
  while (covered < target) {
    const establish = draw(rand, cfg.establishSec);
    slots.push(establish);
    covered += establish;
    const bursts = Math.floor(draw(rand, [cfg.burstShots[0], cfg.burstShots[1] + 1]));
    for (let i = 0; i < bursts; i++) {
      const accel = draw(rand, cfg.accelerateSec);
      slots.push(accel);
      covered += accel;
    }
    const hold = draw(rand, cfg.holdSec);
    slots.push(hold);
    covered += hold;
  }
  return slots;
}
