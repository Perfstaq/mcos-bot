import { readFileSync } from "node:fs";

/**
 * M-3 (joint feasibility) — ARCHITECTURE.md §4/§9 risk #1.
 *
 * "On ≥3 real talking-head clips, simulate the planner (word edges +
 * phase-optimized grid, a ~100-line script over MediaAnalysis output):
 * report achievable lock %. Target ≥90% (margin over the 85% gate). If
 * M-3 fails, the milestone's core promise is at risk and the human must
 * see the number before M builds anything."
 *
 * This is intentionally a SIMULATION, not the real planner (that's Agent
 * M's job, informed by these numbers) — but every constraint it enforces is
 * real: (a) a legal cut point never falls strictly inside a transcribed
 * word (the actual "never cut mid-word" rule, 03_RENDER_PIPELINE §6 rule 4
 * — looser than schema.ts's ported ±50ms word-EDGE-snap rule, which encodes
 * a different, stricter model for REMOVING footage from a single span; here
 * a cut is a shot-transition point and any point strictly between two words
 * is legal, matching ARCHITECTURE §4's "any point in a ≥400ms gap is legal"
 * — un-gapped legality (any inter-word point, not just ≥400ms ones) is used
 * here since 03 §6 doesn't gate legality on gap length, only on not cutting
 * mid-word); (b) the beat grid's phase φ is a free variable solved AFTER the
 * cut list is fixed, never the other way around (§4: "first fix the
 * speech-legal cut list from the rhythm plan, then solve for the bed's
 * global phase φ"); (c) a bonus in-gap micro-shift models "cuts placed
 * inside speech pauses satisfy both constraints almost freely" — bounded to
 * the SAME gap the cut already landed in, never crossing into a neighbor's.
 *
 * Usage: npx tsx scripts/measurements/m3.ts <words.json> <durationSec> [bpm]
 */

const G1_WINDOW_MS = 150;

type Word = { word: string; start: number; end: number };
type WordsJson = { durationSec: number; segments: { words: Word[] }[] };

// mulberry32 — deterministic, no dependency, good enough for a rhythm-curve spike.
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function loadWordIntervals(path: string): [number, number][] {
  const data = JSON.parse(readFileSync(path, "utf8")) as WordsJson;
  const words: [number, number][] = [];
  for (const seg of data.segments) for (const w of seg.words) words.push([w.start, w.end]);
  words.sort((a, b) => a[0] - b[0]);
  // Merge overlapping/touching word spans so "inside a word" is a single check.
  const merged: [number, number][] = [];
  for (const [s, e] of words) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  return merged;
}

/** True iff `t` is NOT strictly inside any word span — "never cut mid-word". */
function isLegal(t: number, wordSpans: [number, number][]): boolean {
  for (const [s, e] of wordSpans) {
    if (t > s && t < e) return false;
    if (t < s) break; // spans are sorted; nothing further can contain t
  }
  return true;
}

/** The gap containing `t`: [prevWordEnd, nextWordStart] (or a clip boundary). */
function enclosingGap(t: number, wordSpans: [number, number][], durationSec: number): [number, number] {
  let lo = 0;
  let hi = durationSec;
  for (const [s, e] of wordSpans) {
    if (e <= t) lo = Math.max(lo, e);
    if (s >= t && s < hi) hi = s;
  }
  return [lo, hi];
}

/** Nearest legal point to `target`, searching outward in 5ms steps. */
function nearestLegal(target: number, wordSpans: [number, number][], durationSec: number, maxRadius = 2): number {
  if (isLegal(target, wordSpans)) return target;
  const step = 0.005;
  for (let r = step; r <= maxRadius; r += step) {
    if (target - r >= 0 && isLegal(target - r, wordSpans)) return target - r;
    if (target + r <= durationSec && isLegal(target + r, wordSpans)) return target + r;
  }
  return target; // gave up — degenerate, dense-speech clip with no nearby gap
}

/** 01_REFERENCE_ANALYSIS §2's rhythm curve: establish -> accelerate -> hold, repeat. */
function rhythmCutTimes(durationSec: number, rand: () => number): number[] {
  const times: number[] = [];
  let t = 0;
  while (t < durationSec) {
    t += 2.5 + rand() * 1.0; // establish: 2.5-3.5s
    if (t < durationSec) times.push(t);
    const bursts = 3 + Math.floor(rand() * 3); // 3-5 shots
    for (let i = 0; i < bursts && t < durationSec; i++) {
      t += 0.7 + rand() * 0.6; // accelerate: 0.7-1.3s
      if (t < durationSec) times.push(t);
    }
    t += 3.5 + rand() * 1.0; // hold: 3.5-4.5s
    if (t < durationSec) times.push(t);
  }
  return times;
}

// `export` added by Agent M (no behavioural change): the M-3 report now
// scores BOTH the baseline and the new planner, and they must be measured
// with one ruler — a second copy of this function is exactly the "two
// estimators disagreeing" failure ADR-2/ADR-8 exist to prevent.
export function lockPct(cuts: number[], period: number, phase: number): number {
  if (!cuts.length) return 100;
  let hit = 0;
  for (const c of cuts) {
    const k = Math.round((c - phase) / period);
    const beat = phase + k * period;
    if (Math.abs(beat - c) * 1000 <= G1_WINDOW_MS) hit++;
  }
  return (100 * hit) / cuts.length;
}

/** 1-D circular optimization over phase φ ∈ [0, period) — one 2ms sweep
 *  (fine enough that a coarse-then-fine refinement pass wouldn't change the
 *  winner; not actually two passes). */
function bestPhase(cuts: number[], period: number): { phase: number; lockPct: number } {
  let best = { phase: 0, lockPct: -1 };
  for (let phase = 0; phase < period; phase += 0.002) {
    const pct = lockPct(cuts, period, phase);
    if (pct > best.lockPct) best = { phase, lockPct: pct };
  }
  return best;
}

export function simulateClip(wordsPath: string, durationSec: number, bpm: number, seed = 42) {
  const wordSpans = loadWordIntervals(wordsPath);
  const rand = mulberry32(seed);
  const period = 60 / bpm;

  const rhythm = rhythmCutTimes(durationSec, rand);
  const legalCuts = rhythm.map((t) => nearestLegal(t, wordSpans, durationSec));

  const { phase, lockPct: beforeRefine } = bestPhase(legalCuts, period);

  // Refinement: micro-shift each cut within ITS OWN gap toward the nearest
  // beat at the winning phase — "cuts inside pauses satisfy both
  // constraints almost freely" (ARCHITECTURE §4).
  const refined = legalCuts.map((c) => {
    const [lo, hi] = enclosingGap(c, wordSpans, durationSec);
    const k = Math.round((c - phase) / period);
    const beat = phase + k * period;
    return Math.min(hi, Math.max(lo, beat));
  });
  const afterRefine = lockPct(refined, period, phase);

  return { nCuts: legalCuts.length, beforeRefinePct: beforeRefine, afterRefinePct: afterRefine, phase, period };
}

async function main() {
  const [wordsPath, durationArg, bpmArg] = process.argv.slice(2);
  if (!wordsPath || !durationArg) {
    console.error("usage: npx tsx scripts/measurements/m3.ts <words.json> <durationSec> [bpm=112.3]");
    process.exit(1);
  }
  const bpm = bpmArg ? Number(bpmArg) : 112.3;
  const result = simulateClip(wordsPath, Number(durationArg), bpm);
  console.log(JSON.stringify({ wordsPath, durationSec: Number(durationArg), bpm, ...result }, null, 2));
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main();
