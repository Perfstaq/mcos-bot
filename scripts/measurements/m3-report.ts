import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { simulateClip } from "./m3.js";

/**
 * m3-report.ts — reproduces M-3's full seed-sensitivity + tempo-sensitivity
 * tables against the committed fixture set
 * (apps/api/tests/fixtures/studio/m3-clips/). This is the runnable artifact
 * the coordinator asked for: a number in a PR body isn't runnable, this is —
 * Agent M re-runs this after a planner change and diffs the output.
 *
 * Usage: npx tsx scripts/measurements/m3-report.ts [--out report.json]
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const fixturesDir = path.join(repoRoot, "apps/api/tests/fixtures/studio/m3-clips");

type ManifestClip = { id: string; durationSec: number; wordsFile: string };
type Manifest = { clips: ManifestClip[] };

function loadManifest(): Manifest {
  return JSON.parse(readFileSync(path.join(fixturesDir, "manifest.json"), "utf8")) as Manifest;
}

function clipPath(clip: ManifestClip): string {
  return path.join(fixturesDir, clip.wordsFile);
}

type Row = { seedOrBpm: number; perClip: Record<string, number>; mean: number; min: number };

function sweep(manifest: Manifest, values: number[], fixed: { seed?: number; bpm?: number }): Row[] {
  return values.map((v) => {
    const seed = fixed.seed ?? v;
    const bpm = fixed.bpm ?? v;
    const perClip: Record<string, number> = {};
    for (const clip of manifest.clips) {
      const r = simulateClip(clipPath(clip), clip.durationSec, bpm, seed);
      perClip[clip.id] = Math.round(r.afterRefinePct * 100) / 100;
    }
    const values2 = Object.values(perClip);
    const mean = values2.reduce((a, b) => a + b, 0) / values2.length;
    return { seedOrBpm: v, perClip, mean: Math.round(mean * 100) / 100, min: Math.min(...values2) };
  });
}

function printTable(title: string, label: string, rows: Row[], clipIds: string[]): void {
  console.log(`\n=== ${title} ===`);
  console.log(`${label.padEnd(10)} ${clipIds.map((c) => c.padStart(10)).join(" ")}   mean     min`);
  for (const row of rows) {
    const cells = clipIds.map((c) => row.perClip[c]!.toFixed(1).padStart(10));
    console.log(`${String(row.seedOrBpm).padEnd(10)} ${cells.join(" ")}   ${row.mean.toFixed(2).padStart(6)}  ${row.min.toFixed(2).padStart(6)}`);
  }
}

function main(): void {
  const manifest = loadManifest();
  const clipIds = manifest.clips.map((c) => c.id);

  const seedRows = sweep(manifest, [1, 7, 42, 99], { bpm: 112.3 });
  printTable("M-3 seed sensitivity (bpm=112.3)", "seed", seedRows, clipIds);

  const bpmRows = sweep(manifest, [90, 100, 112.3, 120, 130], { seed: 42 });
  printTable("M-3 tempo sensitivity (seed=42)", "bpm", bpmRows, clipIds);

  const report = {
    fixtureSet: "apps/api/tests/fixtures/studio/m3-clips",
    clips: clipIds,
    seedSensitivity: { fixedBpm: 112.3, rows: seedRows },
    tempoSensitivity: { fixedSeed: 42, rows: bpmRows },
  };

  const outIdx = process.argv.indexOf("--out");
  if (outIdx >= 0) {
    writeFileSync(process.argv[outIdx + 1]!, JSON.stringify(report, null, 2));
    console.error(`\nwrote ${process.argv[outIdx + 1]}`);
  }
}

main();
