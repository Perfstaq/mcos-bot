import { execFileSync } from "node:child_process";

/**
 * ported-beat-grid.ts — the constant-tempo estimator ARCHITECTURE.md §4
 * demotes to the last fallback rung ("constant_grid"), copied verbatim (not
 * reimplemented from a paraphrase) from founder-journey's
 * pipeline/music.ts:548-702 (`energyEnvelope`, `onsetStrength`,
 * `movingAverage`, `pickOnsets`, `estimateTempo`, `buildBeatGrid`,
 * `analyzeOnsets`, `decodeMonoPCM`, `detectBeats`), so measurements M-1/M-4
 * compare against the actual algorithm the ADR is deciding about, not a
 * reconstruction of it. Measurement-only: this is Agent P's task-5 spike,
 * not where the real `constant_grid` fallback rung ends up living in
 * production (that call belongs to Agent M, the planner owner, once these
 * numbers land).
 *
 * ONLY the pure onset/tempo math + ffmpeg decode are ported. `findMusicBed`
 * and everything network/library-selection related is out of scope here.
 */

/** RMS energy per hop-sized frame. */
export function energyEnvelope(samples: Float32Array, sampleRate: number, hopSec = 0.02): number[] {
  const hop = Math.max(1, Math.round(sampleRate * hopSec));
  const frames = Math.floor(samples.length / hop);
  const env: number[] = new Array(frames);
  for (let i = 0; i < frames; i++) {
    const start = i * hop;
    const end = Math.min(samples.length, start + hop);
    let sum = 0;
    for (let j = start; j < end; j++) sum += samples[j]! * samples[j]!;
    env[i] = Math.sqrt(sum / Math.max(1, end - start));
  }
  return env;
}

/** Half-wave rectified energy flux — onsets show up as positive spikes. */
export function onsetStrength(envelope: number[]): number[] {
  const odf: number[] = new Array(envelope.length).fill(0);
  for (let i = 1; i < envelope.length; i++) odf[i] = Math.max(0, envelope[i]! - envelope[i - 1]!);
  return odf;
}

function movingAverage(arr: number[], window = 3): number[] {
  const half = Math.floor(window / 2);
  return arr.map((_, i) => {
    const start = Math.max(0, i - half);
    const end = Math.min(arr.length, i + half + 1);
    let sum = 0;
    for (let j = start; j < end; j++) sum += arr[j]!;
    return sum / (end - start);
  });
}

/** Adaptive peak-pick: local maxima above mean + 0.5·stddev, ≥minIntervalSec apart. */
export function pickOnsets(odf: number[], hopSec: number, minIntervalSec = 0.15): number[] {
  if (odf.length < 3) return [];
  const mean = odf.reduce((s, v) => s + v, 0) / odf.length;
  const variance = odf.reduce((s, v) => s + (v - mean) ** 2, 0) / odf.length;
  const threshold = mean + Math.sqrt(variance) * 0.5;
  const minGapFrames = Math.max(1, Math.round(minIntervalSec / hopSec));
  const onsets: number[] = [];
  let lastPeak = -Infinity;
  for (let i = 1; i < odf.length - 1; i++) {
    if (odf[i]! > threshold && odf[i]! >= odf[i - 1]! && odf[i]! >= odf[i + 1]! && i - lastPeak >= minGapFrames) {
      onsets.push(i * hopSec);
      lastPeak = i;
    }
  }
  return onsets;
}

/** Inter-onset-interval histogram, octave-folded into 46-240bpm. */
export function estimateTempo(onsetTimes: number[]): number | null {
  if (onsetTimes.length < 2) return null;
  const MIN_IOI = 0.25;
  const MAX_IOI = 1.3;
  const folded: number[] = [];
  for (let i = 1; i < onsetTimes.length; i++) {
    let d = onsetTimes[i]! - onsetTimes[i - 1]!;
    if (d <= 0) continue;
    while (d >= MAX_IOI) d /= 2;
    while (d > 0 && d < MIN_IOI) d *= 2;
    if (d >= MIN_IOI && d < MAX_IOI) folded.push(d);
  }
  if (!folded.length) return null;
  const binSec = 0.02;
  const bins = new Map<number, number[]>();
  for (const d of folded) {
    const b = Math.round(d / binSec);
    const arr = bins.get(b);
    if (arr) arr.push(d);
    else bins.set(b, [d]);
  }
  let bestValues: number[] = [];
  for (const values of bins.values()) {
    if (values.length > bestValues.length) bestValues = values;
  }
  if (!bestValues.length) return null;
  const modeIOI = bestValues.reduce((s, v) => s + v, 0) / bestValues.length;
  if (modeIOI <= 0) return null;
  return Math.round((60 / modeIOI) * 10) / 10;
}

/** Constant-BPM grid of beat times (seconds) spanning [0, durationSec], phase-locked to anchorSec. */
export function buildBeatGrid(bpm: number, anchorSec: number, durationSec: number): number[] {
  if (bpm <= 0 || durationSec <= 0) return [];
  const period = 60 / bpm;
  let phase = anchorSec % period;
  if (phase < 0) phase += period;
  const beats: number[] = [];
  for (let t = phase; t <= durationSec + 1e-6; t += period) beats.push(Math.round(t * 1000) / 1000);
  return beats;
}

export function analyzeOnsets(
  samples: Float32Array,
  sampleRate: number,
  hopSec = 0.02,
): { onsets: number[]; bpm: number | null } {
  const env = energyEnvelope(samples, sampleRate, hopSec);
  const odf = movingAverage(onsetStrength(env), 3);
  const onsets = pickOnsets(odf, hopSec);
  return { onsets, bpm: estimateTempo(onsets) };
}

function decodeMonoPCM(filePath: string, sampleRate: number, maxSec: number): Float32Array {
  const buf = execFileSync(
    "ffmpeg",
    ["-v", "error", "-i", filePath, "-t", String(maxSec), "-f", "f32le", "-ac", "1", "-ar", String(sampleRate), "-"],
    { maxBuffer: 1024 * 1024 * 64 },
  );
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
}

export async function detectBeats(
  filePath: string,
  gridDurationSec: number,
): Promise<{ beats: number[]; bpm: number | null }> {
  try {
    const sampleRate = 11025;
    const samples = decodeMonoPCM(filePath, sampleRate, Math.min(gridDurationSec, 90));
    const { onsets, bpm } = analyzeOnsets(samples, sampleRate);
    if (bpm === null) return { beats: [], bpm: null };
    const anchor = onsets[0] ?? 0;
    return { beats: buildBeatGrid(bpm, anchor, gridDurationSec), bpm };
  } catch {
    return { beats: [], bpm: null };
  }
}
