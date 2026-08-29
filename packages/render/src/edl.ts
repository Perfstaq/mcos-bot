/**
 * edl.ts — the word-edge invariant core, ported from founder-journey
 * `remotion/src/schema.ts` (ARCHITECTURE.md §1.1: "PORT AS-IS … exactly G10's
 * 'never mid-word' enforcement, already loud-validated").
 *
 * What ported: `EPSILON`, `wordEdges`, `snapsToEdge`, `snapToEdge` — the
 * shared definition of "a legal boundary time".
 *
 * What did NOT port: the RoughCut/Cut decision-list schema, `roughCutIssues`,
 * `computeKeptSpans`/`computeEDL`. Those encode founder-journey's own
 * per-cut human gate ("proposed → approved | rejected" removing footage from a
 * single span), which the Studio deliberately does not have: the Studio's gate
 * is the ContentBrief (05 §3 / ADR-6), and a Studio "cut" is a shot
 * transition on a continuous timeline, not a span of footage being removed.
 * Porting the decision list would have imported a second, ungated review
 * mechanism — CLAUDE.md invariant 1.
 *
 * The distinction that matters for the planner: a cut is illegal only when it
 * lands *strictly inside a word*. The boundary between two words that abut
 * with no measurable pause is a legal cut — it is the jump cut the reference
 * reel is made of (01 §8: "a single continuous interview, cut on itself"),
 * and 30 shots in 54.87s is simply not reachable from real silences alone.
 * `wordEdges` has always said so: every word start AND end is an edge.
 */

/** Boundary-snap tolerance: a cut edge must land within EPSILON of a word edge. */
export const EPSILON = 0.05; // 50 ms

export type WordInterval = { start: number; end: number };

/** All valid boundary times: every word start/end, plus 0 and duration. Sorted, deduped. */
export function wordEdges(words: WordInterval[], durationSec: number): number[] {
  const edges = new Set<number>([0, durationSec]);
  for (const w of words) {
    edges.add(w.start);
    edges.add(w.end);
  }
  return [...edges].sort((a, b) => a - b);
}

/** True if `t` is within `epsilon` of some edge (linear scan; fine for our sizes). */
export function snapsToEdge(t: number, edges: number[], epsilon = EPSILON): boolean {
  return edges.some((e) => Math.abs(e - t) <= epsilon);
}

/** Snap `t` to the nearest edge if within `epsilon`, else return `t` unchanged. */
export function snapToEdge(t: number, edges: number[], epsilon = EPSILON): number {
  let best = t;
  let bestDist = epsilon;
  for (const e of edges) {
    const d = Math.abs(e - t);
    if (d <= bestDist) {
      best = e;
      bestDist = d;
    }
  }
  return best;
}

/**
 * G10, stated positively: `t` is legal iff it is not STRICTLY inside any word.
 * Word starts/ends are legal (they are edges); gap interiors are legal (nobody
 * is speaking). `words` must be sorted by `start`.
 */
export function isMidWord(t: number, words: WordInterval[]): boolean {
  for (const w of words) {
    if (w.start >= t) break; // sorted: nothing further can strictly contain t
    if (t < w.end) return true;
  }
  return false;
}

/**
 * Merge overlapping/touching word spans into contiguous speech runs. Used for
 * *pause* measurement (how long is the silence around a candidate cut), never
 * for legality — see the note above.
 */
export function speechRuns(words: WordInterval[]): WordInterval[] {
  const sorted = [...words].sort((a, b) => a.start - b.start);
  const merged: WordInterval[] = [];
  for (const w of sorted) {
    const last = merged[merged.length - 1];
    if (last && w.start <= last.end) last.end = Math.max(last.end, w.end);
    else merged.push({ start: w.start, end: w.end });
  }
  return merged;
}

/** The silent gaps between speech runs, plus the head and tail of the clip. */
export function speechGaps(words: WordInterval[], durationSec: number): WordInterval[] {
  const runs = speechRuns(words);
  const gaps: WordInterval[] = [];
  let cursor = 0;
  for (const r of runs) {
    if (r.start > cursor) gaps.push({ start: cursor, end: r.start });
    cursor = Math.max(cursor, r.end);
  }
  if (durationSec > cursor) gaps.push({ start: cursor, end: durationSec });
  return gaps;
}
