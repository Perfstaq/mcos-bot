import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectBeats as portedDetectBeats } from "./ported-beat-grid.js";

/**
 * M-1 (estimator honesty) + M-4 (fallback ceiling) — ARCHITECTURE.md §4.
 *
 * M-1: librosa `beat_track` vs the ported `detectBeats` on ≥10 licensed-
 * library tracks + the reference audio — Δtempo and median per-beat offset
 * at t=55s.
 * M-4: |beat_track − constant grid| at t=55s across the library, p95.
 *
 * Both read the same per-track measurement (tempo from each estimator, and
 * how far apart their grids have drifted by t≈55s — the exact quantity
 * ARCHITECTURE §4 reason 2's drift math is about: tempo error ε accumulates
 * as ε·t, so the absolute time-position gap at t≈55s is the drift, not a
 * derived proxy for it) — M-1 reports the median across tracks, M-4 the p95
 * (the fallback's worst realistic case, not its typical case).
 *
 * Caveat on the offset numbers: "nearest beat to t in each grid, then the
 * gap between those two beats" is a metric that SATURATES at roughly one
 * beat period — once true accumulated drift exceeds ~half a period, the
 * two grids' phases can wrap back into apparent alignment even though the
 * underlying tempo/phase error is larger. So a reported offset (and its p95)
 * is a LOWER BOUND on the true drift, not an exact ceiling — report it as
 * "≥ measured", never as the worst case that could possibly occur.
 *
 * Usage: npx tsx scripts/measurements/m1-m4.ts <track1.mp3> <track2.mp3> ...
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const analyzerPython = path.join(repoRoot, "services/analyzer/.venv/bin/python");
const analyzerScript = path.join(repoRoot, "services/analyzer/analyzer.py");

type BeatsJson = { method: string; tempoBpm: number | null; beatTimesMs: number[]; gridQuality: number | null };

function ffprobeDurationSec(file: string): number {
  const out = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], {
    encoding: "utf8",
  });
  return Number(out.trim());
}

function librosaBeats(file: string): BeatsJson {
  const workDir = mkdtempSync(path.join(tmpdir(), "m1m4-"));
  try {
    execFileSync(analyzerPython, [analyzerScript, "--input", file, "--out", workDir, "--stages", "beats"], {
      stdio: "pipe",
    });
    return JSON.parse(readFileSync(path.join(workDir, "beats.json"), "utf8")) as BeatsJson;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

/** Nearest beat time (seconds) to `t` in a sorted beat array; null if empty. */
function nearestBeat(beatsSec: number[], t: number): number | null {
  if (!beatsSec.length) return null;
  let best = beatsSec[0]!;
  let bestDist = Math.abs(best - t);
  for (const b of beatsSec) {
    const d = Math.abs(b - t);
    if (d < bestDist) {
      best = b;
      bestDist = d;
    }
  }
  return best;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function p95(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1);
  return s[idx]!;
}

type TrackResult = {
  file: string;
  durationSec: number;
  tAt: number;
  librosaTempo: number | null;
  portedTempo: number | null;
  deltaTempo: number | null;
  offsetAtTMs: number | null;
};

async function measureTrack(file: string): Promise<TrackResult> {
  const durationSec = ffprobeDurationSec(file);
  const tAt = Math.min(55, Math.max(0, durationSec - 0.5));

  const librosa = librosaBeats(file);
  const ported = await portedDetectBeats(file, durationSec);

  const librosaBeatsSec = librosa.beatTimesMs.map((ms) => ms / 1000);
  const portedBeatsSec = ported.beats;

  const librosaNear = nearestBeat(librosaBeatsSec, tAt);
  const portedNear = nearestBeat(portedBeatsSec, tAt);
  const offsetAtTMs = librosaNear !== null && portedNear !== null ? Math.abs(librosaNear - portedNear) * 1000 : null;

  const deltaTempo =
    librosa.tempoBpm !== null && ported.bpm !== null ? Math.abs(librosa.tempoBpm - ported.bpm) : null;

  return {
    file: path.basename(file),
    durationSec,
    tAt,
    librosaTempo: librosa.tempoBpm,
    portedTempo: ported.bpm,
    deltaTempo,
    offsetAtTMs,
  };
}

async function main(): Promise<void> {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error("usage: npx tsx scripts/measurements/m1-m4.ts <track1> <track2> ...");
    process.exit(1);
  }

  const results: TrackResult[] = [];
  for (const f of files) {
    process.stderr.write(`measuring ${path.basename(f)}...\n`);
    results.push(await measureTrack(f));
  }

  console.log("\nfile                                    dur(s)   t     librosa   ported   Δtempo   offset@t(ms)");
  console.log("-".repeat(100));
  for (const r of results) {
    console.log(
      `${r.file.padEnd(40)} ${r.durationSec.toFixed(1).padStart(6)} ${r.tAt.toFixed(1).padStart(5)}` +
        `  ${(r.librosaTempo?.toFixed(1) ?? "null").padStart(8)} ${(r.portedTempo?.toFixed(1) ?? "null").padStart(8)}` +
        `  ${(r.deltaTempo?.toFixed(2) ?? "null").padStart(7)}  ${(r.offsetAtTMs?.toFixed(0) ?? "null").padStart(10)}`,
    );
  }

  const deltas = results.map((r) => r.deltaTempo).filter((x): x is number => x !== null);
  const offsets = results.map((r) => r.offsetAtTMs).filter((x): x is number => x !== null);
  const nullTempoCount = results.filter((r) => r.portedTempo === null).length;

  console.log("\n=== M-1: estimator honesty ===");
  console.log(`n tracks with a tempo from both estimators: ${deltas.length}/${results.length}`);
  console.log(`ported detectBeats returned null bpm on: ${nullTempoCount}/${results.length} tracks`);
  console.log(`median Δtempo: ${median(deltas)?.toFixed(2) ?? "n/a"} bpm`);
  console.log(`mean Δtempo:   ${deltas.length ? (deltas.reduce((a, b) => a + b, 0) / deltas.length).toFixed(2) : "n/a"} bpm`);
  console.log(`median offset-at-t: ≥${median(offsets)?.toFixed(0) ?? "n/a"} ms (saturating metric — see header comment)`);

  console.log("\n=== M-4: fallback ceiling ===");
  console.log(`p95 offset-at-t (|beat_track - constant_grid| at t≈55s): ≥${p95(offsets)?.toFixed(0) ?? "n/a"} ms (saturating metric — see header comment)`);
}

main();
