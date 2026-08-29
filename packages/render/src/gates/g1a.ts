import { cutTimesMs, type RenderPlan } from "../plan.js";
import type { GateResult } from "./types.js";

/**
 * G1a — musical intent (ADR-8, finalized 2026-08-27).
 *
 * Plan cut times vs the plan's OWN embedded beat grid, ≥85% within 150ms.
 * This is the NORMATIVE evaluation point: ADR-8 requires G1a scored at
 * `plan.build`, inside apps/api, BEFORE anything renders — a plan that
 * fails it must never reach `render.submit`. It lives here, in
 * packages/render (not scripts/qc-render.ts, and not duplicated into
 * apps/api), specifically so `plan.build` can import it directly instead of
 * recreating the gate math — the exact "two rulers measuring the same
 * thing" failure ADR-2/ADR-8 exist to prevent. `scripts/qc-render.ts`
 * imports this same function as an audit re-check on the finished render,
 * not as its own copy.
 *
 * Calibrated on the reference under the pinned harness (ARCHITECTURE §4.1 /
 * ADR-8): tempo 112.347bpm, beat_lock_ratio 0.821, grid_quality 2.2003 —
 * measured directly by this milestone's own services/analyzer, not copied
 * from the doc's pixel-re-detection number (which ARCHITECTURE §10 itself
 * says not to trust as a stable target).
 */
export const REFERENCE_BEAT_LOCK_RATIO = 0.821;
export const REFERENCE_GRID_QUALITY = 2.2003;
export const FINGERPRINT_ACCEPTANCE_FLOOR = REFERENCE_BEAT_LOCK_RATIO - 0.02; // ≥0.80 today (§4.1)

function nearestDistanceMs(t: number, others: number[]): number | null {
  if (!others.length) return null;
  return Math.min(...others.map((o) => Math.abs(o - t)));
}

export function gateG1a(plan: RenderPlan): GateResult {
  const id = "G1a";
  const name = "Beat lock — musical intent";
  const cuts = cutTimesMs(plan);
  const beats = plan.beatGrid.beatTimesMs;

  if (plan.beatGrid.method === "constant_grid") {
    return {
      id,
      name,
      hard: true,
      computable: true,
      pass: false,
      measured: { method: "constant_grid" },
      target: "≥85% of cuts within 150ms of the embedded beat grid",
      note: "a constant_grid plan can never pass G1a for merge evidence (ARCHITECTURE §4 fallback ladder, rung 3).",
    };
  }
  if (!cuts.length || !beats.length) {
    return {
      id,
      name,
      hard: true,
      computable: true,
      pass: false,
      measured: { cuts: cuts.length, beats: beats.length },
      target: "≥85% within 150ms",
      note: "empty cut list or empty beat grid",
    };
  }

  const distances = cuts.map((c) => nearestDistanceMs(c, beats)!);
  const withinCount = distances.filter((d) => d <= 150).length;
  const ratio = withinCount / cuts.length;

  // Anti-gaming guard: a beat_track grid MUST carry a real grid_quality
  // measurement to count — a null here would silently waive the check
  // (fixed: previously `gq === null` produced `gridQualityOk: null`, and
  // `null !== false` let the gate pass anyway). onset_env grids are not
  // held to this check — the metric compares onset-strength at a MUSIC
  // BED's beat times, which doesn't apply to a speech-derived onset grid.
  const gq = plan.beatGrid.gridQuality;
  const gridQualityOk =
    plan.beatGrid.method === "beat_track" ? gq !== null && gq >= REFERENCE_GRID_QUALITY * 0.8 : true;

  const pass = ratio >= 0.85 && gridQualityOk;
  return {
    id,
    name,
    hard: true,
    computable: true,
    pass,
    measured: {
      ratio: Math.round(ratio * 1000) / 1000,
      withinCount,
      totalCuts: cuts.length,
      gridQuality: gq,
      gridQualityOk,
    },
    target:
      "≥85% within 150ms of the embedded grid, AND (for beat_track grids) grid_quality present and ≥ 80% of the reference's 2.2003 (guards a degraded/absent grid gaming the gate)",
  };
}
