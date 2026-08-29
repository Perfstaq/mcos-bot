import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BANNER_ANCHOR, buildBanner, buildCaptionTrack, anchorFor, handleCornerForShot, HANDLE_OPACITY } from "@mcos/render/captions";
import { shotCamera } from "@mcos/render/motion";
import { assertValidRenderPlan, PLAN_VERSION, type Cut, type RenderPlan } from "@mcos/render/plan";
import { planBeatLockedCuts, type Bed, type WordInterval } from "@mcos/render/planner";

/**
 * build-demo-plan.ts — assemble a real `RenderPlan` from real analyzer output.
 *
 * 06_AGENTS_AND_MODELS §4 step 3: no PR without output. This produces the
 * plan half of that — every number in it comes from the same modules
 * `plan.build` will use in production (the planner, the caption engine, the
 * camera), so the MP4 it feeds is a genuine end-to-end exercise of Agent M's
 * work rather than a hand-written fixture that happens to render.
 *
 * Inputs are the sidecar's own `words.json` and `beats.json`
 * (services/analyzer). The beat grid is copied VERBATIM into the plan and is
 * never recomputed — ARCHITECTURE §4.1: "Canonical grid = MediaAnalysis.beats,
 * embedded into RenderPlan.plan", so G1a and the planner score against one
 * ruler.
 *
 * Usage:
 *   npx tsx scripts/studio/build-demo-plan.ts \
 *     --words <words.json> --beats <beats.json> --out <plan.json> \
 *     [--hook "THE POWER OF OBSESSION"] [--emphasis OBSESSION] [--handle @handle] [--seed 42]
 */

type WordsJson = {
  durationSec: number;
  segments: { words: { word: string; start: number; end: number; rms?: number | null }[] }[];
};
type BeatsJson = {
  method: "beat_track" | "onset_env" | "constant_grid";
  tempoBpm: number | null;
  beatTimesMs: number[];
  gridQuality: number | null;
};

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]!;
  if (fallback !== undefined) return fallback;
  throw new Error(`missing required --${name}`);
}

const FPS = 30;
const WIDTH = 1080;
const HEIGHT = 1920;

function main(): void {
  const wordsPath = arg("words");
  const beatsPath = arg("beats");
  const outPath = arg("out");
  const seed = Number(arg("seed", "42"));
  const hook = arg("hook", "THE POWER OF OBSESSION");
  const emphasisWord = arg("emphasis", "OBSESSION");
  const handleText = arg("handle", "@PERFSTAQ");

  const wordsJson = JSON.parse(readFileSync(wordsPath, "utf8")) as WordsJson;
  const beats = JSON.parse(readFileSync(beatsPath, "utf8")) as BeatsJson;

  const flat = wordsJson.segments.flatMap((s) => s.words).sort((a, b) => a.start - b.start);
  // faster-whisper reports the duration it DECODED, which trails the
  // container when the tail is silent (VAD drops it). The plan must cover the
  // real media or the last shot renders short, so the caller passes the
  // ffprobe duration and the words file is only a fallback.
  const durationSec = Number(arg("duration", String(wordsJson.durationSec)));
  const intervals: WordInterval[] = flat.map((w) => ({ start: w.start, end: w.end }));

  // The bed. Its grid is the sidecar's librosa output, used verbatim — phase
  // stays a search variable (the bed's start offset is ours to choose,
  // ARCHITECTURE §4), tempo does not, because this grid is the footage's own.
  // This grid comes from the FOOTAGE's own audio, not from a music bed we are
  // laying underneath it, so its phase is fixed: there is no start offset to
  // choose. ADR-2 rung 2. Sweeping φ here would produce a plan locked to a
  // grid that does not exist — which is exactly what the first render of this
  // demo did, scoring 100% in the planner and 29% in QC.
  const bed: Bed = {
    id: "analyzer-grid",
    tempoBpm: beats.tempoBpm ?? 112.3,
    beatTimesSec: beats.beatTimesMs.map((ms) => ms / 1000),
    phaseLocked: true,
  };

  const plan = planBeatLockedCuts({ words: intervals, durationSec, beds: [bed], seed, gatePct: 0 });
  if (!plan.cutTimesSec.length) throw new Error(`planner returned no cuts: ${plan.reason ?? "unknown"}`);

  // Cuts: shot boundaries on a continuous timeline — the reference's own
  // approach (01 §8, "a single continuous interview, cut on itself"), so
  // source time and output time advance together and no speech is dropped.
  const boundaries = [0, ...plan.cutTimesSec, durationSec];
  const cuts: Cut[] = boundaries.slice(1).map((end, i) => {
    const start = boundaries[i]!;
    const frames = Math.max(1, Math.round((end - start) * FPS));
    const cam = shotCamera(i, frames, seed);
    return {
      id: `c${i}`,
      sourceInMs: Math.round(start * 1000),
      sourceOutMs: Math.round(end * 1000),
      outputStartMs: Math.round(start * 1000),
      outputEndMs: Math.round(end * 1000),
      motion: {
        motion: cam.motion,
        fromScale: cam.fromScale,
        toScale: cam.toScale,
        spring: "drift",
        durationInFrames: cam.durationInFrames,
        originX: cam.originX,
        originY: cam.originY,
      },
    };
  });

  // Captions. `claimTexts` stands in for the ContentBrief's frozen claim
  // texts (ARCHITECTURE §11.1 R3) — Agent B owns producing them; the contract
  // is all this needs.
  const claimTexts = [hook];
  const track = buildCaptionTrack({
    words: flat.map((w) => ({ word: w.word, startMs: Math.round(w.start * 1000), endMs: Math.round(w.end * 1000), rms: w.rms ?? null })),
    cutTimesMs: plan.cutTimesSec.map((t) => Math.round(t * 1000)),
    claimTexts,
  });
  const banner = buildBanner(hook, emphasisWord);

  const renderPlan: RenderPlan = assertValidRenderPlan({
    planVersion: PLAN_VERSION,
    seed,
    fps: FPS,
    width: WIDTH,
    height: HEIGHT,
    durationInFrames: Math.round(durationSec * FPS),
    framing: "letterbox",
    footage: { assetId: "demo-reference-proxy", r2Key: "demo/reference-16x9-proxy.mp4" },
    cuts,
    captions: track.map((c) => ({
      words: c.words.map((w) => ({ word: w.word, startMs: w.startMs, endMs: w.endMs, isEmphasis: w.isEmphasis })),
      position: c.position,
      emphasisWordIndex: c.emphasisWordIndex,
      startMs: c.startMs,
      endMs: c.endMs,
      anchor: anchorFor(c.position),
    })),
    banner: { text: banner.text, emphasisWordIndex: banner.emphasisWordIndex, anchor: BANNER_ANCHOR },
    handle: {
      text: handleText,
      opacity: HANDLE_OPACITY,
      cornerByShot: cuts.map((_, i) => handleCornerForShot(i)),
    },
    // The grid the planner ACTUALLY scored against, not the raw analyzer
    // file. When phase is a free variable these differ by φ, and embedding
    // the wrong one makes G1a measure the plan against a grid it was never
    // built for — the plan's cuts are then correct and unscoreable at once.
    // "Canonical grid = MediaAnalysis.beats, embedded into RenderPlan.plan"
    // (ARCHITECTURE §4.1) means the grid as used, which is what the planner
    // returns.
    beatGrid: {
      method: beats.method,
      tempoBpm: beats.tempoBpm,
      beatTimesMs: plan.beatTimesSec.map((s) => Math.round(s * 1000)),
      gridQuality: beats.gridQuality,
    },
    music: null,
    grade: { contrast: 1.08, saturation: 1.06, warmTint: 0.04 },
    scrim: "never",
  });

  writeFileSync(outPath, JSON.stringify(renderPlan, null, 2));

  const emphasised = track.filter((c) => c.emphasisWordIndex !== null).length;
  console.log(`plan            ${path.resolve(outPath)}`);
  console.log(`duration        ${durationSec.toFixed(2)}s (${renderPlan.durationInFrames} frames @ ${FPS}fps)`);
  console.log(`grid            method=${beats.method} tempo=${beats.tempoBpm?.toFixed(2) ?? "null"} beats=${beats.beatTimesMs.length} gridQuality=${beats.gridQuality?.toFixed(4) ?? "null"}`);
  console.log(`cuts            ${plan.cutTimesSec.length}  (${plan.cutsPerMinute.toFixed(1)}/min, median ${plan.medianShotSec.toFixed(2)}s, min ${plan.minShotSec.toFixed(2)}s, max ${plan.maxShotSec.toFixed(2)}s)`);
  console.log(`beat lock       ${plan.lockPct.toFixed(2)}% within 150ms  (phase φ=${plan.phaseSec.toFixed(3)}s)`);
  console.log(`captions        ${track.length} chunks, max ${Math.max(...track.map((c) => c.words.length))} words, ${new Set(track.map((c) => c.position)).size} distinct positions, ${emphasised} emphasised`);
}

main();
