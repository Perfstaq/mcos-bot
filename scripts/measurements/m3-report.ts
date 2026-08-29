import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { planBeatLockedCuts, type WordInterval } from "@mcos/render/planner";
import { lockPct, simulateClip } from "./m3.js";

/**
 * m3-report.ts — the runnable evidence for ARCHITECTURE.md §4.2.
 *
 * Originally (Agent P) this reproduced M-3's seed- and tempo-sensitivity
 * tables for the algorithm 02_MOTION_SYSTEM §5 step 3 specifies: draw a
 * rhythm curve, then snap each planned cut to the nearest beat. That
 * algorithm came back structurally marginal — mean 89.44% lock at the
 * reference's 112.3bpm with the WORST clip at 82.05%, under the 85% G1a
 * gate — and was superseded for Agent M.
 *
 * It now reports BOTH algorithms over the same fixtures, with one ruler
 * (`lockPct`, imported from m3.ts rather than re-implemented). The baseline
 * table is unchanged and still reproduces P's committed
 * `measured-results.json` exactly, so the comparison cannot be accused of
 * moving the goalposts.
 *
 * Read the ATTRIBUTION section at the bottom before quoting the headline: it
 * separates how much of the gain is the DP and how much is the legality
 * model, and it audits the baseline's own cut lists against G4 and G10.
 *
 * Usage: npx tsx scripts/measurements/m3-report.ts [--out report.json]
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const fixturesDir = path.join(repoRoot, "apps/api/tests/fixtures/studio/m3-clips");

const REFERENCE_BPM = 112.3;
const G1A_GATE = 85;

type ManifestClip = { id: string; durationSec: number; wordsFile: string };
type Manifest = { clips: ManifestClip[] };
type WordsJson = { segments: { words: { word: string; start: number; end: number }[] }[] };

function loadManifest(): Manifest {
  return JSON.parse(readFileSync(path.join(fixturesDir, "manifest.json"), "utf8")) as Manifest;
}

function clipPath(clip: ManifestClip): string {
  return path.join(fixturesDir, clip.wordsFile);
}

function loadWords(clip: ManifestClip): WordInterval[] {
  const raw = JSON.parse(readFileSync(clipPath(clip), "utf8")) as WordsJson;
  const words: WordInterval[] = [];
  for (const seg of raw.segments) for (const w of seg.words) words.push({ start: w.start, end: w.end });
  return words.sort((a, b) => a.start - b.start);
}

type Row = { seedOrBpm: number; perClip: Record<string, number>; mean: number; min: number };

function summarise(seedOrBpm: number, perClip: Record<string, number>): Row {
  const values = Object.values(perClip);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return { seedOrBpm, perClip, mean: Math.round(mean * 100) / 100, min: Math.min(...values) };
}

// ---------------------------------------------------------------------------
// The two algorithms, both scored with m3.ts's `lockPct`.
// ---------------------------------------------------------------------------

function baselineLock(clip: ManifestClip, bpm: number, seed: number): number {
  return Math.round(simulateClip(clipPath(clip), clip.durationSec, bpm, seed).afterRefinePct * 100) / 100;
}

type PlannerRun = { lockPct: number; cutsPerMinute: number; medianShotSec: number; minShotSec: number; maxShotSec: number; status: string };

function plannerRun(clip: ManifestClip, bpm: number, seed: number, legality?: "gaps-only"): PlannerRun {
  const r = planBeatLockedCuts({
    words: loadWords(clip),
    durationSec: clip.durationSec,
    beds: [{ id: `bed-${bpm}`, tempoBpm: bpm }],
    seed,
    legality,
    gatePct: 0, // report the measured number; the gate is asserted in the test suite
  });
  // Score with the BASELINE's own ruler, not the planner's, so the two tables
  // are directly comparable rather than merely adjacent.
  const measured = r.cutTimesSec.length ? lockPct(r.cutTimesSec, 60 / bpm, r.phaseSec) : 0;
  return {
    lockPct: Math.round(measured * 100) / 100,
    cutsPerMinute: r.cutsPerMinute,
    medianShotSec: r.medianShotSec,
    minShotSec: r.minShotSec,
    maxShotSec: r.maxShotSec,
    status: r.status,
  };
}

function sweep(
  manifest: Manifest,
  values: number[],
  fixed: { seed?: number; bpm?: number },
  score: (clip: ManifestClip, bpm: number, seed: number) => number,
): Row[] {
  return values.map((v) => {
    const seed = fixed.seed ?? v;
    const bpm = fixed.bpm ?? v;
    const perClip: Record<string, number> = {};
    for (const clip of manifest.clips) perClip[clip.id] = score(clip, bpm, seed);
    return summarise(v, perClip);
  });
}

function printTable(title: string, label: string, rows: Row[], clipIds: string[]): void {
  console.log(`\n=== ${title} ===`);
  console.log(`${label.padEnd(10)} ${clipIds.map((c) => c.padStart(10)).join(" ")}   mean     min`);
  for (const row of rows) {
    const cells = clipIds.map((c) => row.perClip[c]!.toFixed(1).padStart(10));
    console.log(
      `${String(row.seedOrBpm).padEnd(10)} ${cells.join(" ")}   ${row.mean.toFixed(2).padStart(6)}  ${row.min.toFixed(2).padStart(6)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Attribution — where the improvement actually comes from, and what the
// baseline's own cut lists look like when audited.
// ---------------------------------------------------------------------------

/** Re-runs P's algorithm and returns the CUT LIST so it can be audited.
 *  Logic identical to m3.ts's simulateClip; m3.ts returns only statistics. */
function baselineCuts(clip: ManifestClip, bpm: number, seed: number): number[] {
  const raw = JSON.parse(readFileSync(clipPath(clip), "utf8")) as WordsJson;
  const words: [number, number][] = [];
  for (const s of raw.segments) for (const w of s.words) words.push([w.start, w.end]);
  words.sort((a, b) => a[0] - b[0]);
  const spans: [number, number][] = [];
  for (const [s, e] of words) {
    const last = spans[spans.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else spans.push([s, e]);
  }
  const isLegal = (t: number): boolean => {
    for (const [s, e] of spans) {
      if (t > s && t < e) return false;
      if (t < s) break;
    }
    return true;
  };
  const nearestLegal = (target: number): number => {
    if (isLegal(target)) return target;
    for (let r = 0.005; r <= 2; r += 0.005) {
      if (target - r >= 0 && isLegal(target - r)) return target - r;
      if (target + r <= clip.durationSec && isLegal(target + r)) return target + r;
    }
    return target; // gives up and returns an ILLEGAL point — see the audit below
  };
  let a = seed;
  const rand = (): number => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const targets: number[] = [];
  let cursor = 0;
  while (cursor < clip.durationSec) {
    cursor += 2.5 + rand();
    if (cursor < clip.durationSec) targets.push(cursor);
    const bursts = 3 + Math.floor(rand() * 3);
    for (let i = 0; i < bursts && cursor < clip.durationSec; i++) {
      cursor += 0.7 + rand() * 0.6;
      if (cursor < clip.durationSec) targets.push(cursor);
    }
    cursor += 3.5 + rand();
    if (cursor < clip.durationSec) targets.push(cursor);
  }
  const legal = targets.map(nearestLegal);
  const period = 60 / bpm;
  let phase = 0;
  let best = -1;
  for (let p = 0; p < period; p += 0.002) {
    const v = lockPct(legal, period, p);
    if (v > best) {
      best = v;
      phase = p;
    }
  }
  return legal.map((c) => {
    let lo = 0;
    let hi = clip.durationSec;
    for (const [s, e] of spans) {
      if (e <= c) lo = Math.max(lo, e);
      if (s >= c && s < hi) hi = s;
    }
    const k = Math.round((c - phase) / period);
    return Math.min(hi, Math.max(lo, phase + k * period));
  });
}

function auditCuts(clip: ManifestClip, cuts: number[]): { midWord: number; tooShort: number; tooLong: number } {
  const raw = JSON.parse(readFileSync(clipPath(clip), "utf8")) as WordsJson;
  const words = raw.segments.flatMap((s) => s.words);
  const midWord = cuts.filter((t) => words.some((w) => t > w.start && t < w.end)).length;
  const bounds = [0, ...cuts, clip.durationSec];
  const durations = bounds.slice(1).map((t, i) => t - bounds[i]!);
  return {
    midWord,
    tooShort: durations.filter((d) => d < 0.6).length,
    tooLong: durations.filter((d) => d > 5.0).length,
  };
}

function main(): void {
  const manifest = loadManifest();
  const clipIds = manifest.clips.map((c) => c.id);
  const seeds = [1, 7, 42, 99];
  const tempos = [90, 100, REFERENCE_BPM, 120, 130];

  const baselineSeed = sweep(manifest, seeds, { bpm: REFERENCE_BPM }, baselineLock);
  const baselineTempo = sweep(manifest, tempos, { seed: 42 }, baselineLock);
  printTable("BASELINE (02 §5 step 3, superseded) — seed sensitivity, bpm=112.3", "seed", baselineSeed, clipIds);
  printTable("BASELINE (02 §5 step 3, superseded) — tempo sensitivity, seed=42", "bpm", baselineTempo, clipIds);

  const scorePlanner = (clip: ManifestClip, bpm: number, seed: number): number => plannerRun(clip, bpm, seed).lockPct;
  const plannerSeed = sweep(manifest, seeds, { bpm: REFERENCE_BPM }, scorePlanner);
  const plannerTempo = sweep(manifest, tempos, { seed: 42 }, scorePlanner);
  printTable("PLANNER (ARCHITECTURE §4.2 joint optimization) — seed sensitivity, bpm=112.3", "seed", plannerSeed, clipIds);
  printTable("PLANNER (ARCHITECTURE §4.2 joint optimization) — tempo sensitivity, seed=42", "bpm", plannerTempo, clipIds);

  // --- Headline -----------------------------------------------------------
  const b42 = baselineSeed.find((r) => r.seedOrBpm === 42)!;
  const p42 = plannerSeed.find((r) => r.seedOrBpm === 42)!;
  console.log("\n=== HEADLINE (bpm=112.3, seed=42) — the acceptance criterion ===");
  console.log(`  baseline   mean ${b42.mean.toFixed(2)}%   WORST CLIP ${b42.min.toFixed(2)}%`);
  console.log(`  planner    mean ${p42.mean.toFixed(2)}%   WORST CLIP ${p42.min.toFixed(2)}%`);
  console.log(
    `  worst-clip delta ${(p42.min - b42.min >= 0 ? "+" : "") + (p42.min - b42.min).toFixed(2)}pts   ` +
      `G1a gate ≥${G1A_GATE}%: baseline ${b42.min >= G1A_GATE ? "PASS" : "FAIL"}, planner ${p42.min >= G1A_GATE ? "PASS" : "FAIL"}`,
  );
  const worstAcross = Math.min(...plannerSeed.map((r) => r.min), ...plannerTempo.map((r) => r.min));
  console.log(`  planner's worst cell anywhere in BOTH sweeps: ${worstAcross.toFixed(2)}%`);

  // --- Rhythm: the lock % must not have been bought by cutting less --------
  console.log("\n=== PLANNER rhythm gates (bpm=112.3, seed=42) — lock % is not bought by cutting less ===");
  console.log("clip           lock%   cuts/min(G2 25-40)  median(G3 1.0-2.0)  min(G4 ≥0.6)   max(≤5.0)");
  const rhythm: Record<string, PlannerRun> = {};
  for (const clip of manifest.clips) {
    const r = plannerRun(clip, REFERENCE_BPM, 42);
    rhythm[clip.id] = r;
    console.log(
      `${clip.id.padEnd(12)} ${r.lockPct.toFixed(2).padStart(6)}   ${r.cutsPerMinute.toFixed(1).padStart(16)}  ` +
        `${r.medianShotSec.toFixed(2).padStart(17)}  ${r.minShotSec.toFixed(2).padStart(12)}  ${r.maxShotSec.toFixed(2).padStart(9)}`,
    );
  }

  // --- Attribution --------------------------------------------------------
  console.log("\n=== ATTRIBUTION — where the improvement comes from (bpm=112.3, seed=42) ===");
  console.log(
    "The planner changes TWO things at once, so both are measured separately:\n" +
      "  (a) the DP/Viterbi over enumerated candidates, replacing snap-after-the-fact;\n" +
      "  (b) the legality model. G10 and the ported wordEdges() say a cut is illegal only\n" +
      "      STRICTLY INSIDE a word, so a boundary between two abutting words is legal —\n" +
      "      it is the jump cut the reference is built from. P's simulation merged touching\n" +
      "      words first, which forbids those boundaries.\n",
  );
  const gapsOnly: Record<string, number> = {};
  for (const clip of manifest.clips) {
    const r = plannerRun(clip, REFERENCE_BPM, 42, "gaps-only");
    gapsOnly[clip.id] = r.status === "plan_infeasible" && r.cutsPerMinute === 0 ? Number.NaN : r.lockPct;
  }
  console.log("  DP under P's stricter 'gaps-only' legality model:");
  for (const clip of manifest.clips) {
    const v = gapsOnly[clip.id]!;
    console.log(
      `    ${clip.id.padEnd(12)} ${Number.isNaN(v) ? "INFEASIBLE — no shot list satisfies [0.6s, 5.0s] on silences alone" : `${v.toFixed(2)}%`}`,
    );
  }
  console.log(
    "\n  Reading: under the stricter model the problem is genuinely INFEASIBLE on most\n" +
      "  clips — real silences are further apart than the 5.0s maximum shot. The baseline\n" +
      "  produced numbers there only because its nearestLegal() gives up after 2s and\n" +
      "  returns the illegal target unchanged. Audit of the baseline's own cut lists:",
  );
  console.log("    clip          mid-word cuts (G10 must be 0)   shots <0.6s (G4)   shots >5.0s");
  const audit: Record<string, { midWord: number; tooShort: number; tooLong: number }> = {};
  for (const clip of manifest.clips) {
    const a = auditCuts(clip, baselineCuts(clip, REFERENCE_BPM, 42));
    audit[clip.id] = a;
    console.log(
      `    ${clip.id.padEnd(12)} ${String(a.midWord).padStart(24)}   ${String(a.tooShort).padStart(16)}   ${String(a.tooLong).padStart(11)}`,
    );
  }
  console.log(
    "\n  So the baseline's 82.05% was measured on a cut list that also fails G10 and G4.\n" +
      "  The planner's cut lists contain zero of either (asserted in studio-planner.test.ts).",
  );

  const report = {
    fixtureSet: "apps/api/tests/fixtures/studio/m3-clips",
    clips: clipIds,
    baseline: {
      seedSensitivity: { fixedBpm: REFERENCE_BPM, rows: baselineSeed },
      tempoSensitivity: { fixedSeed: 42, rows: baselineTempo },
    },
    planner: {
      seedSensitivity: { fixedBpm: REFERENCE_BPM, rows: plannerSeed },
      tempoSensitivity: { fixedSeed: 42, rows: plannerTempo },
      rhythmGates: rhythm,
      gapsOnlyLegality: gapsOnly,
    },
    baselineCutAudit: audit,
    headline: {
      bpm: REFERENCE_BPM,
      seed: 42,
      baseline: { mean: b42.mean, worstClip: b42.min },
      planner: { mean: p42.mean, worstClip: p42.min },
      g1aGatePct: G1A_GATE,
    },
  };

  const outIdx = process.argv.indexOf("--out");
  if (outIdx >= 0) {
    writeFileSync(process.argv[outIdx + 1]!, JSON.stringify(report, null, 2));
    console.error(`\nwrote ${process.argv[outIdx + 1]}`);
  }
}

main();
