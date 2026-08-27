import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BASELINE_M3,
  planBeatLockedCuts,
  type PlannerInput,
  type WordInterval,
} from "@mcos/render/planner";

/**
 * ACCEPTANCE TEST — Agent M's deliverable (ARCHITECTURE.md §4.2).
 *
 * `02_MOTION_SYSTEM §5` step 3 ("for each planned cut time t, snap to the
 * nearest beat") is SUPERSEDED. Agent P measured that algorithm on these six
 * real talking-head clips with a *perfect* phase-optimized grid — best case,
 * no estimation error — and it is structurally marginal: it commits to cut
 * POSITIONS before it knows where legal word edges are, so it wastes cuts on
 * positions no word boundary can serve. At the reference's 112.3bpm it scored
 * mean 89.44% with the WORST clip at 82.05%, under the 85% G1a gate.
 *
 * The bar is therefore not the mean (beating that is easy and not the point):
 * it is the WORST CLIP, which must clear 85% at the reference tempo.
 *
 * The fixture is P's committed one (`apps/api/tests/fixtures/studio/m3-clips`),
 * word timings only — the same input the naive simulation consumed, so the
 * comparison is like-for-like. `scripts/measurements/m3-report.ts` prints the
 * full seed/tempo tables for both algorithms; this test pins the headline row
 * so a regression fails CI rather than a PR body.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, "fixtures/studio/m3-clips");

const REFERENCE_BPM = 112.3;
const HEADLINE_SEED = 42;
const G1A_GATE = 85;

type ManifestClip = { id: string; durationSec: number; wordsFile: string };
type WordsJson = { segments: { words: { word: string; start: number; end: number }[] }[] };

function loadManifest(): ManifestClip[] {
  const raw = readFileSync(path.join(fixturesDir, "manifest.json"), "utf8");
  return (JSON.parse(raw) as { clips: ManifestClip[] }).clips;
}

function loadWords(clip: ManifestClip): WordInterval[] {
  const raw = JSON.parse(readFileSync(path.join(fixturesDir, clip.wordsFile), "utf8")) as WordsJson;
  const words: WordInterval[] = [];
  for (const seg of raw.segments) for (const w of seg.words) words.push({ start: w.start, end: w.end });
  return words.sort((a, b) => a.start - b.start);
}

function planFor(clip: ManifestClip, bpm: number, seed: number) {
  const input: PlannerInput = {
    words: loadWords(clip),
    durationSec: clip.durationSec,
    beds: [{ id: `bed-${bpm}`, tempoBpm: bpm }],
    seed,
  };
  return planBeatLockedCuts(input);
}

const clips = loadManifest();

describe("beat-snap planner — M-3 acceptance (ARCHITECTURE §4.2)", () => {
  const results = clips.map((clip) => ({ clip, result: planFor(clip, REFERENCE_BPM, HEADLINE_SEED) }));

  it("every clip produces a feasible plan at the reference tempo", () => {
    for (const { clip, result } of results) {
      expect(result.status, `${clip.id}: ${result.reason ?? ""}`).toBe("ok");
    }
  });

  it("lifts the WORST clip above the 85% G1a gate (baseline worst: 82.05%)", () => {
    const perClip = results.map(({ clip, result }) => [clip.id, result.lockPct] as const);
    const worst = Math.min(...perClip.map(([, pct]) => pct));
    const detail = perClip.map(([id, pct]) => `${id}=${pct.toFixed(2)}%`).join(" ");
    expect(BASELINE_M3.worstPct).toBe(82.05);
    expect(worst, `per-clip: ${detail}`).toBeGreaterThan(G1A_GATE);
    expect(worst, `per-clip: ${detail}`).toBeGreaterThan(BASELINE_M3.worstPct);
  });

  it("also beats the baseline mean (89.44%) — necessary, not sufficient", () => {
    const mean = results.reduce((a, r) => a + r.result.lockPct, 0) / results.length;
    expect(BASELINE_M3.meanPct).toBe(89.44);
    expect(mean).toBeGreaterThan(BASELINE_M3.meanPct);
  });

  it("holds the worst clip over the gate across every seed P swept, not just 42", () => {
    for (const seed of [1, 7, 42, 99]) {
      const worst = Math.min(...clips.map((clip) => planFor(clip, REFERENCE_BPM, seed).lockPct));
      expect(worst, `seed ${seed}`).toBeGreaterThan(G1A_GATE);
    }
  });
});

describe("beat-snap planner — the lock % cannot be bought by cutting less", () => {
  /**
   * A planner that emits three cuts in 70s would score 100% lock and be
   * useless. Every rhythm gate from 07_QUALITY_GATES §1 is asserted alongside
   * the lock number so the acceptance figure means what it claims.
   */
  for (const clip of clips) {
    it(`${clip.id}: G2 cut density, G3 median shot, G4 min shot all in band`, () => {
      const r = planFor(clip, REFERENCE_BPM, HEADLINE_SEED);
      expect(r.cutsPerMinute).toBeGreaterThanOrEqual(25); // G2
      expect(r.cutsPerMinute).toBeLessThanOrEqual(40);
      expect(r.medianShotSec).toBeGreaterThanOrEqual(1.0); // G3 (07's wider band wins — ARCH §11.3)
      expect(r.medianShotSec).toBeLessThanOrEqual(2.0);
      expect(r.minShotSec).toBeGreaterThanOrEqual(0.6); // G4
      expect(r.maxShotSec).toBeLessThanOrEqual(5.0);
    });
  }
});

describe("beat-snap planner — G10 word integrity", () => {
  for (const clip of clips) {
    it(`${clip.id}: no cut lands strictly inside a transcribed word`, () => {
      const words = loadWords(clip);
      const r = planFor(clip, REFERENCE_BPM, HEADLINE_SEED);
      const offenders = r.cutTimesSec.filter((t) => words.some((w) => t > w.start && t < w.end));
      expect(offenders).toEqual([]);
    });
  }
});

describe("beat-snap planner — reproducibility and honest failure", () => {
  it("is deterministic: same input + seed ⇒ identical cut list (G13 precondition)", () => {
    const a = planFor(clips[0]!, REFERENCE_BPM, HEADLINE_SEED);
    const b = planFor(clips[0]!, REFERENCE_BPM, HEADLINE_SEED);
    expect(b.cutTimesSec).toEqual(a.cutTimesSec);
    expect(b.phaseSec).toBe(a.phaseSec);
    expect(b.beatTimesSec).toEqual(a.beatTimesSec);
  });

  it("emits plan_infeasible with the measured lock % rather than a plan that will fail QC", () => {
    // One unbroken 30s word: no legal cut point exists anywhere inside it, so
    // no shot list can satisfy [0.6s, 5.0s]. 03 §7 / ARCHITECTURE §4.2.
    const r = planBeatLockedCuts({
      words: [{ start: 0, end: 30 }],
      durationSec: 30,
      beds: [{ id: "bed", tempoBpm: REFERENCE_BPM }],
      seed: HEADLINE_SEED,
    });
    expect(r.status).toBe("plan_infeasible");
    expect(r.reason).toBeTruthy();
    expect(r.cutTimesSec).toEqual([]);
  });

  it("searches tempo when given several beds and keeps the best-scoring plan", () => {
    const words = loadWords(clips[2]!); // clip3 — the clip that failed outright at 82.05%
    const single = planBeatLockedCuts({
      words,
      durationSec: clips[2]!.durationSec,
      beds: [{ id: "a", tempoBpm: 90 }],
      seed: HEADLINE_SEED,
    });
    const searched = planBeatLockedCuts({
      words,
      durationSec: clips[2]!.durationSec,
      beds: [
        { id: "a", tempoBpm: 90 },
        { id: "b", tempoBpm: 112.3 },
        { id: "c", tempoBpm: 124 },
      ],
      seed: HEADLINE_SEED,
    });
    expect(searched.lockPct).toBeGreaterThanOrEqual(single.lockPct);
    expect(["a", "b", "c"]).toContain(searched.bedId);
  });
});
