import { isMidWord, speechGaps, speechRuns, type WordInterval } from "../edl.js";

/**
 * candidates.ts — the legal cut points, and how good each one is.
 *
 * ARCHITECTURE §4.2: "Candidates are word boundaries from the
 * WhisperX/faster-whisper output, each carrying a pause-quality score (a
 * >400ms gap is a better cut than a mid-sentence word edge)."
 *
 * Two families, both legal under G10 (a cut is illegal only strictly inside a
 * word — see edl.ts):
 *
 *  - **Edges.** Every word start/end. A mid-sentence edge is a jump cut; the
 *    reference is built from them (01 §8) and there is no other way to reach
 *    30 shots in 55s.
 *  - **In-gap beat points.** Inside a silence, *every* point is legal, so the
 *    beat itself is available at distance 0 — ARCHITECTURE §4's "cuts placed
 *    inside speech pauses satisfy both constraints almost freely". This is the
 *    family the naive algorithm could never reach, because it chose the
 *    position first.
 *
 * The set is deliberately thinned. Two candidates 40ms apart are the same
 * editorial decision, and the DP's cost is dominated by beat distance and
 * slot deviation, neither of which can tell them apart — but keeping both
 * doubles the transition fan-out. Thinning is a performance decision, and the
 * kept representative is always the best-scoring one in its window, so it
 * never removes reachable quality.
 */

export type Candidate = {
  /** Seconds on the output timeline. */
  timeSec: number;
  /** Distance to the nearest beat, milliseconds. */
  beatDistMs: number;
  /** 0..1 — 1.0 once the surrounding silence reaches `FULL_PAUSE_MS`. */
  pauseQuality: number;
};

/** A gap of this length or more is a "real" pause (03 §6 / ARCHITECTURE §4). */
export const FULL_PAUSE_MS = 400;

/** Candidates closer together than this collapse to their best representative. */
const THIN_WINDOW_SEC = 0.06;

function nearestBeatDistMs(t: number, beats: number[]): number {
  if (!beats.length) return Number.POSITIVE_INFINITY;
  // beats are sorted — binary search for the insertion point.
  let lo = 0;
  let hi = beats.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (beats[mid]! < t) lo = mid + 1;
    else hi = mid;
  }
  let best = Math.abs(beats[lo]! - t);
  if (lo > 0) best = Math.min(best, Math.abs(beats[lo - 1]! - t));
  return best * 1000;
}

/**
 * Length of the silence a candidate sits in, in ms. A point strictly between
 * two speech runs gets that gap's full length; a word edge inside a
 * continuous run gets 0 (it is a legal cut, just not a restful one).
 */
function pauseMsAt(t: number, gaps: WordInterval[]): number {
  for (const g of gaps) {
    if (g.start > t) break;
    if (t >= g.start && t <= g.end) return (g.end - g.start) * 1000;
  }
  return 0;
}

export type CandidateOptions = {
  /**
   * `"word-edges"` (default, and what G10 actually says) treats every word
   * boundary as legal. `"gaps-only"` additionally forbids boundaries inside a
   * contiguous speech run — the stricter model P's M-3 simulation used
   * because it merged touching words before testing legality. Exposed so the
   * M-3 report can show how much of the improvement is the DP and how much is
   * the legality model, rather than leaving that to assertion.
   */
  legality?: "word-edges" | "gaps-only";
};

export function buildCandidates(
  words: WordInterval[],
  durationSec: number,
  beats: number[],
  opts: CandidateOptions = {},
): Candidate[] {
  const legality = opts.legality ?? "word-edges";
  const blocking = legality === "gaps-only" ? speechRuns(words) : [...words].sort((a, b) => a.start - b.start);
  const gaps = speechGaps(words, durationSec);

  const times: number[] = [];

  // Family 1 — word boundaries (or speech-run boundaries under "gaps-only").
  for (const w of blocking) {
    times.push(w.start, w.end);
  }

  // Family 2 — every beat that falls in a legal position, at distance 0, plus
  // the nearest legal point to every beat that does not (so a beat buried in
  // dense speech still offers its best available approach).
  for (const b of beats) {
    if (b <= 0 || b >= durationSec) continue;
    if (!isMidWord(b, blocking)) {
      times.push(b);
      continue;
    }
    for (const w of blocking) {
      if (w.start < b && b < w.end) {
        times.push(w.start, w.end);
        break;
      }
    }
  }

  const seen = new Set<number>();
  const all: Candidate[] = [];
  for (const raw of times) {
    const t = Math.round(raw * 1000) / 1000;
    if (t <= 0 || t >= durationSec) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    all.push({
      timeSec: t,
      beatDistMs: nearestBeatDistMs(t, beats),
      pauseQuality: Math.min(1, pauseMsAt(t, gaps) / FULL_PAUSE_MS),
    });
  }
  all.sort((a, b) => a.timeSec - b.timeSec);

  // Thin: keep the best candidate per THIN_WINDOW_SEC. "Best" = closest to a
  // beat, then the restfullest pause.
  const kept: Candidate[] = [];
  for (const c of all) {
    const last = kept[kept.length - 1];
    if (!last || c.timeSec - last.timeSec > THIN_WINDOW_SEC) {
      kept.push(c);
      continue;
    }
    const better =
      c.beatDistMs < last.beatDistMs - 1 ||
      (Math.abs(c.beatDistMs - last.beatDistMs) <= 1 && c.pauseQuality > last.pauseQuality);
    if (better) kept[kept.length - 1] = c;
  }
  return kept;
}
