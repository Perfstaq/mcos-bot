/**
 * rng.ts — the one seeded random source in the render package.
 *
 * G13/invariant 6: a render is reproducible from `{ContentBrief, template_id,
 * footage_ref, seed}`. That is only true if every "random" choice the planner
 * and the motion system make — rhythm slot lengths, micro-motion growth,
 * caption position rotation — comes from the plan's `seed` and nowhere else.
 * `Math.random()` and `Date.now()` are therefore banned in this package
 * (ARCHITECTURE §11.3 determinism preconditions); this is the replacement.
 *
 * mulberry32: 32-bit, dependency-free, and the exact generator P's M-3
 * simulation used (scripts/measurements/m3.ts) — keeping it identical is what
 * makes "seed 42" mean the same draw in both the baseline and the planner, so
 * the two tables in the M-3 report compare like with like.
 */
export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
