import type { WordInterval } from "../edl.js";
import { buildCandidates, type Candidate, type CandidateOptions } from "./candidates.js";
import { rhythmSlots, type RhythmOptions } from "./rhythm.js";

/**
 * beat-plan.ts — the beat-snap planner.
 *
 * **02_MOTION_SYSTEM §5 step 3 is superseded here** (ARCHITECTURE.md §4.2,
 * orchestrator ruling 27 Aug 2026). The doc's algorithm is:
 *
 *     draw a rhythm curve → for each planned cut time t, snap to the
 *     nearest beat → reject the snap if the shot leaves [0.6s, 5.0s]
 *
 * Agent P measured it on six real talking-head clips with a *perfect*
 * phase-optimized grid — best case, no estimation error — and it is
 * structurally marginal: mean 89.44% lock at 112.3bpm with the worst clip at
 * 82.05%, under the 85% G1a gate. The failure is geometric, not numerical: it
 * commits to cut POSITIONS before it knows where legal word edges are, so it
 * spends cuts on positions no word boundary can serve, and the later snap can
 * only move a bad position to a slightly different bad position.
 *
 * This planner inverts the two steps. It enumerates the legal cut points
 * FIRST (candidates.ts), then chooses a subset of them with a Viterbi/DP over
 * shot slots. The rhythm curve becomes a soft per-slot target the DP is free
 * to bend; the word-edge constraint (G10) and the beat window (G1a) stay
 * hard. "Never place a cut where a word edge and a beat don't coincide —
 * bend the rhythm instead" is expressed directly in the cost: `W_MISS`
 * exceeds the largest rhythm penalty any in-bounds shot can incur, so a miss
 * is only ever taken when no locked path exists at all.
 *
 * Bed **phase** and **tempo** are search variables, per §4.2. Tempo is the
 * weaker lever and the ruling is explicit about why: P's sweep shows the mean
 * rising monotonically with tempo while the MINIMUM does not (120bpm beats
 * 112.3 on the mean and loses on the worst clip). What fails the gate is one
 * clip's word-edge geometry, not the average clip's — so the DP is the
 * load-bearing part and tempo is a secondary refinement.
 */

export type Bed = {
  id: string;
  tempoBpm: number;
  /**
   * A real librosa `beat_track` grid (seconds), when one exists — production
   * path, ADR-2. Phase search then shifts this array wholesale, which is
   * exactly what choosing the bed's start offset does. Omitted for a
   * `synthBed`, whose grid is exact by construction and generated from
   * `tempoBpm`.
   */
  beatTimesSec?: number[];
  /**
   * Set when the grid's phase is NOT ours to choose.
   *
   * ARCHITECTURE §4's phase freedom is specifically "the music bed's *start
   * offset* is ours to choose" — it exists because we decide when to drop the
   * needle on a track we are laying under the footage. It does NOT exist for
   * a grid derived from the footage's own audio (ADR-2's rung 2, speech-only
   * footage with no bed): you cannot slide a speaker's room tone in time, so
   * sweeping φ there produces a plan locked to a grid that does not exist.
   * That failure is silent and total — the cuts look perfectly locked to the
   * planner and land ~200ms off every beat in the render — so it is a flag on
   * the bed rather than a convention at the call site.
   */
  phaseLocked?: boolean;
};

export type PlannerWeights = {
  /** Cut further than the lock window from every beat. Must exceed the worst
   *  in-bounds rhythm penalty, or the DP would trade locks for tidiness. */
  miss: number;
  /** Quadratic penalty inside the window — an exact hit beats a 149ms hit. */
  near: number;
  /** Squared log-ratio deviation from the slot's target duration. */
  rhythm: number;
  /** Bonus (negative cost) for cutting inside a real speech pause. */
  pause: number;
};

export const DEFAULT_WEIGHTS: PlannerWeights = {
  miss: 4.0,
  near: 0.6,
  rhythm: 1.0,
  pause: 0.5,
};

export type ShotBounds = { minShotSec: number; maxShotSec: number };
/** G4 (min shot ≥0.6s) and 02 §5 step 3's upper bound. */
export const DEFAULT_BOUNDS: ShotBounds = { minShotSec: 0.6, maxShotSec: 5.0 };

/** The G1a window (07 §1 / ADR-8): pass at ≤150ms inclusive. */
export const LOCK_WINDOW_MS = 150;

/** G1a's hard gate — a plan below this is rejected before anything renders. */
export const G1A_GATE_PCT = 85;

/**
 * P's measured baseline for the superseded algorithm, at the reference tempo,
 * seed 42 (apps/api/tests/fixtures/studio/m3-clips/measured-results.json).
 * Exported so the acceptance test asserts against a named constant rather
 * than a magic number nobody can trace.
 */
export const BASELINE_M3 = { meanPct: 89.44, worstPct: 82.05, tempoBpm: 112.3, seed: 42 } as const;

export type PlannerInput = {
  words: WordInterval[];
  durationSec: number;
  beds: Bed[];
  seed: number;
  bounds?: Partial<ShotBounds>;
  rhythm?: RhythmOptions;
  weights?: Partial<PlannerWeights>;
  lockWindowMs?: number;
  gatePct?: number;
} & CandidateOptions;

export type PlannerResult = {
  status: "ok" | "plan_infeasible";
  reason?: string;
  /** Output-timeline cut times in seconds, ascending, excluding t=0 (07 §1). */
  cutTimesSec: number[];
  shotDurationsSec: number[];
  /** The grid this plan is scored against — embedded into `RenderPlan.beatGrid`. */
  beatTimesSec: number[];
  bedId: string | null;
  tempoBpm: number | null;
  /** The bed's chosen global start offset φ (ARCHITECTURE §4). */
  phaseSec: number;
  lockedCuts: number;
  lockPct: number;
  cutsPerMinute: number;
  medianShotSec: number;
  minShotSec: number;
  maxShotSec: number;
  cost: number;
};

const COARSE_PHASE_STEPS = 32;
const FINE_PHASE_STEPS = 8;
const PHASE_FINALISTS = 3;

/** Beats covering [-period, duration+period] so a cut near either clip
 *  boundary still measures against the beat that is actually nearest. */
export function buildPeriodicGrid(tempoBpm: number, phaseSec: number, durationSec: number): number[] {
  const period = 60 / tempoBpm;
  const beats: number[] = [];
  const first = Math.floor((-period - phaseSec) / period);
  const last = Math.ceil((durationSec + period - phaseSec) / period);
  for (let k = first; k <= last; k++) beats.push(Math.round((phaseSec + k * period) * 1e6) / 1e6);
  return beats;
}

function shiftGrid(beats: number[], phaseSec: number): number[] {
  return beats.map((b) => Math.round((b + phaseSec) * 1e6) / 1e6);
}

function median(sorted: number[]): number {
  if (!sorted.length) return 0;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Keep at most `maxCount` candidates, best-in-bucket. Used only for the
 *  phase sweep: ranking phases does not need the full set, and the full set
 *  makes the sweep ~10× more expensive than the handful of finalist solves. */
function thinTo(candidates: Candidate[], maxCount: number, durationSec: number): Candidate[] {
  if (candidates.length <= maxCount || maxCount <= 0) return candidates;
  const bucketSec = durationSec / maxCount;
  const kept: Candidate[] = [];
  let bucketEnd = bucketSec;
  let best: Candidate | null = null;
  for (const c of candidates) {
    while (c.timeSec > bucketEnd) {
      if (best) kept.push(best);
      best = null;
      bucketEnd += bucketSec;
    }
    if (
      !best ||
      c.beatDistMs < best.beatDistMs - 1 ||
      (Math.abs(c.beatDistMs - best.beatDistMs) <= 1 && c.pauseQuality > best.pauseQuality)
    ) {
      best = c;
    }
  }
  if (best) kept.push(best);
  return kept;
}

type Solution = { indices: number[]; cost: number };

/**
 * The Viterbi. Layer `s` holds, for every candidate `i`, the cheapest prefix
 * in which candidate `i` is the (s+1)-th cut. Shots are the gaps between
 * consecutive chosen candidates (plus the head shot from t=0 and the tail
 * shot to `durationSec`), each scored against `slots[s]`.
 */
function solve(
  candidates: Candidate[],
  durationSec: number,
  slots: number[],
  bounds: ShotBounds,
  weights: PlannerWeights,
  lockWindowMs: number,
): Solution | null {
  const n = candidates.length;
  if (!n) return null;
  const { minShotSec: minShot, maxShotSec: maxShot } = bounds;

  const times = new Float64Array(n);
  const cutCost = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const c = candidates[i]!;
    times[i] = c.timeSec;
    const d = c.beatDistMs;
    const beatTerm = d <= lockWindowMs ? weights.near * (d / lockWindowMs) ** 2 : weights.miss;
    cutCost[i] = beatTerm - weights.pause * c.pauseQuality;
  }

  const rhythmCost = (dur: number, target: number): number => {
    const r = Math.log(dur / target);
    return weights.rhythm * r * r;
  };

  // Transition window per j: candidates i with times[j]-times[i] ∈ [min,max].
  const winLo = new Int32Array(n);
  const winHi = new Int32Array(n);
  {
    let lo = 0;
    let hi = 0;
    for (let j = 0; j < n; j++) {
      while (lo < n && times[lo]! < times[j]! - maxShot) lo++;
      while (hi < n && times[hi]! <= times[j]! - minShot) hi++;
      winLo[j] = lo;
      winHi[j] = hi; // exclusive
    }
  }

  const maxLayers = Math.min(slots.length - 1, Math.ceil(durationSec / minShot) + 2);
  if (maxLayers < 1) return null;

  const INF = Number.POSITIVE_INFINITY;
  let prev = new Float64Array(n).fill(INF);
  const back: Int32Array[] = [];

  // Layer 0 — the head shot runs from t=0.
  const back0 = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const d = times[i]!;
    if (d < minShot || d > maxShot) continue;
    prev[i] = cutCost[i]! + rhythmCost(d, slots[0]!);
  }
  back.push(back0);

  let bestTotal = INF;
  let bestLayer = -1;
  let bestIndex = -1;

  const considerTerminal = (layer: number, dp: Float64Array): void => {
    const tailTarget = slots[layer + 1]!;
    for (let i = 0; i < n; i++) {
      if (dp[i] === INF) continue;
      const tail = durationSec - times[i]!;
      if (tail < minShot || tail > maxShot) continue;
      const total = dp[i]! + rhythmCost(tail, tailTarget);
      if (total < bestTotal) {
        bestTotal = total;
        bestLayer = layer;
        bestIndex = i;
      }
    }
  };

  considerTerminal(0, prev);

  for (let s = 1; s < maxLayers; s++) {
    const cur = new Float64Array(n).fill(INF);
    const bs = new Int32Array(n).fill(-1);
    const target = slots[s]!;
    let anyReachable = false;
    for (let j = 0; j < n; j++) {
      const lo = winLo[j]!;
      const hi = winHi[j]!;
      let best = INF;
      let bestI = -1;
      for (let i = lo; i < hi; i++) {
        const base = prev[i]!;
        if (base === INF) continue;
        const total = base + rhythmCost(times[j]! - times[i]!, target);
        if (total < best) {
          best = total;
          bestI = i;
        }
      }
      if (bestI >= 0) {
        cur[j] = best + cutCost[j]!;
        bs[j] = bestI;
        anyReachable = true;
      }
    }
    back.push(bs);
    prev = cur;
    if (!anyReachable) break;
    considerTerminal(s, cur);
  }

  if (bestLayer < 0) return null;

  const indices: number[] = [];
  let layer = bestLayer;
  let idx = bestIndex;
  while (idx >= 0) {
    indices.push(idx);
    const parent = back[layer]![idx]!;
    layer -= 1;
    idx = parent;
  }
  indices.reverse();
  return { indices, cost: bestTotal };
}

function scoreCuts(cutTimesSec: number[], beats: number[], lockWindowMs: number): { locked: number; pct: number } {
  if (!cutTimesSec.length) return { locked: 0, pct: 0 };
  let locked = 0;
  for (const t of cutTimesSec) {
    let lo = 0;
    let hi = beats.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (beats[mid]! < t) lo = mid + 1;
      else hi = mid;
    }
    let d = Math.abs(beats[lo]! - t);
    if (lo > 0) d = Math.min(d, Math.abs(beats[lo - 1]! - t));
    if (d * 1000 <= lockWindowMs) locked++;
  }
  return { locked, pct: (100 * locked) / cutTimesSec.length };
}

type Attempt = {
  bed: Bed;
  phaseSec: number;
  beats: number[];
  solution: Solution;
  candidates: Candidate[];
  lockPct: number;
  locked: number;
};

export function planBeatLockedCuts(input: PlannerInput): PlannerResult {
  const bounds: ShotBounds = { ...DEFAULT_BOUNDS, ...input.bounds };
  const weights: PlannerWeights = { ...DEFAULT_WEIGHTS, ...input.weights };
  const lockWindowMs = input.lockWindowMs ?? LOCK_WINDOW_MS;
  const gatePct = input.gatePct ?? G1A_GATE_PCT;
  const slots = rhythmSlots(input.durationSec, input.seed, input.rhythm);
  const words = [...input.words].sort((a, b) => a.start - b.start);
  const candidateOpts: CandidateOptions = { legality: input.legality };

  const gridFor = (bed: Bed, phaseSec: number): number[] =>
    bed.beatTimesSec?.length
      ? shiftGrid(bed.beatTimesSec, phaseSec)
      : buildPeriodicGrid(bed.tempoBpm, phaseSec, input.durationSec);

  const attempt = (bed: Bed, phaseSec: number, sweepOnly: boolean): Attempt | null => {
    const beats = gridFor(bed, phaseSec);
    const full = buildCandidates(words, input.durationSec, beats, candidateOpts);
    // The sweep only needs to RANK phases; one representative per beat is
    // enough for that and keeps the sweep an order of magnitude cheaper than
    // the finalist solves it feeds.
    const candidates = sweepOnly ? thinTo(full, Math.max(24, beats.length), input.durationSec) : full;
    const solution = solve(candidates, input.durationSec, slots, bounds, weights, lockWindowMs);
    if (!solution) return null;
    const cutTimesSec = solution.indices.map((i) => candidates[i]!.timeSec);
    const { locked, pct } = scoreCuts(cutTimesSec, beats, lockWindowMs);
    return { bed, phaseSec, beats, solution, candidates, lockPct: pct, locked };
  };

  const betterThan = (a: Attempt, b: Attempt | null): boolean => {
    if (!b) return true;
    if (a.lockPct !== b.lockPct) return a.lockPct > b.lockPct;
    return a.solution.cost < b.solution.cost;
  };

  let best: Attempt | null = null;

  for (const bed of input.beds) {
    // Phase is circular over one beat period. For a real librosa grid that is
    // the mean inter-beat interval, not 60/tempo — a tracked grid is not
    // exactly periodic, and sweeping the wrong period would leave a slice of
    // phase space unexplored.
    const grid = bed.beatTimesSec;
    const period =
      grid && grid.length > 1 ? (grid[grid.length - 1]! - grid[0]!) / (grid.length - 1) : 60 / bed.tempoBpm;

    if (bed.phaseLocked) {
      const a = attempt(bed, 0, false);
      if (a && betterThan(a, best)) best = a;
      continue;
    }

    // Coarse phase sweep, then a local refinement around the strongest few.
    const coarse: Attempt[] = [];
    for (let k = 0; k < COARSE_PHASE_STEPS; k++) {
      const a = attempt(bed, (k * period) / COARSE_PHASE_STEPS, true);
      if (a) coarse.push(a);
    }
    coarse.sort((x, y) => (y.lockPct !== x.lockPct ? y.lockPct - x.lockPct : x.solution.cost - y.solution.cost));

    const finalists: number[] = [];
    for (const seedAttempt of coarse.slice(0, PHASE_FINALISTS)) {
      let bestFine = seedAttempt;
      const span = period / COARSE_PHASE_STEPS;
      for (let k = 1; k <= FINE_PHASE_STEPS; k++) {
        const offset = ((k - FINE_PHASE_STEPS / 2) * span) / (FINE_PHASE_STEPS / 2);
        const phase = ((seedAttempt.phaseSec + offset) % period + period) % period;
        const a = attempt(bed, phase, true);
        if (a && betterThan(a, bestFine)) bestFine = a;
      }
      finalists.push(bestFine.phaseSec);
    }

    // Only the finalists pay for the full candidate set.
    for (const phase of finalists) {
      const a = attempt(bed, phase, false);
      if (a && betterThan(a, best)) best = a;
    }
  }

  if (!best) {
    return {
      status: "plan_infeasible",
      reason:
        "no shot list satisfies the [0.6s, 5.0s] bound over the legal cut points — the speech has no usable word boundaries in range (G10 vs G3/G4)",
      cutTimesSec: [],
      shotDurationsSec: [],
      beatTimesSec: [],
      bedId: null,
      tempoBpm: null,
      phaseSec: 0,
      lockedCuts: 0,
      lockPct: 0,
      cutsPerMinute: 0,
      medianShotSec: 0,
      minShotSec: 0,
      maxShotSec: 0,
      cost: Number.POSITIVE_INFINITY,
    };
  }

  const cutTimesSec = best.solution.indices.map((i) => best!.candidates[i]!.timeSec);
  const boundaries = [0, ...cutTimesSec, input.durationSec];
  const shotDurationsSec = boundaries.slice(1).map((t, i) => Math.round((t - boundaries[i]!) * 1000) / 1000);
  const sortedShots = [...shotDurationsSec].sort((a, b) => a - b);
  const lockPct = Math.round(best.lockPct * 100) / 100;

  return {
    status: lockPct >= gatePct ? "ok" : "plan_infeasible",
    reason:
      lockPct >= gatePct
        ? undefined
        : `best plan locks ${lockPct.toFixed(2)}% of cuts within ${lockWindowMs}ms, under the G1a gate of ${gatePct}% — rejected at plan.build rather than rendered (ARCHITECTURE §4.2)`,
    cutTimesSec,
    shotDurationsSec,
    beatTimesSec: best.beats.filter((b) => b >= 0 && b <= input.durationSec),
    bedId: best.bed.id,
    tempoBpm: best.bed.tempoBpm,
    phaseSec: Math.round(best.phaseSec * 1e6) / 1e6,
    lockedCuts: best.locked,
    lockPct,
    cutsPerMinute: Math.round(((cutTimesSec.length * 60) / input.durationSec) * 100) / 100,
    medianShotSec: median(sortedShots),
    minShotSec: sortedShots[0] ?? 0,
    maxShotSec: sortedShots[sortedShots.length - 1] ?? 0,
    cost: best.solution.cost,
  };
}
