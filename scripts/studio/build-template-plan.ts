import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BANNER_ANCHOR, HANDLE_OPACITY, anchorFor, buildBanner, buildCaptionTrack } from "@mcos/render/captions";
import { shotCamera } from "@mcos/render/motion";
import { assertValidRenderPlan, PLAN_VERSION, type Cut, type RenderPlan } from "@mcos/render/plan";
import { planBeatLockedCuts, type Bed, type WordInterval } from "@mcos/render/planner";
import {
  getTemplate,
  templateHandleCornerForShot,
  templatePositionForShot,
  TEMPLATE_IDS,
} from "@mcos/render/templates";
import { BannerFitError, resolveTemplateStyle } from "@mcos/render/templates/resolve";

/**
 * build-template-plan.ts — assemble a real `RenderPlan` for a named template.
 *
 * The template-aware successor to `build-demo-plan.ts` (which stays as-is:
 * Agent M's committed evidence references it, and rewriting it would
 * invalidate that evidence for no gain). Same inputs, same modules, same
 * discipline — every number comes from the code `plan.build` will use in
 * production, so the MP4 this feeds is a genuine end-to-end exercise rather
 * than a fixture that happens to render.
 *
 * **This is a script, not the job.** `apps/api/src/jobs/plan-build.ts` does
 * not exist (ARCHITECTURE §12.12) and is assigned separately; nothing here
 * should be read as that job, and nothing here writes to a database. The
 * builder function below is the piece that job will eventually call.
 *
 * Usage:
 *   npx tsx scripts/studio/build-template-plan.ts \
 *     --template statement_serif --words <words.json> --beats <beats.json> \
 *     --out <plan.json> [--duration <sec>] [--hook "..."] [--emphasis WORD]
 *     [--handle @handle] [--seed 42]
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

export type BuildTemplatePlanInput = {
  templateId: string;
  words: { word: string; start: number; end: number; rms?: number | null }[];
  durationSec: number;
  beats: BeatsJson;
  seed: number;
  hook: string;
  emphasisWord: string | null;
  handleText: string;
  footage: { assetId: string; r2Key: string };
  fps?: number;
  width?: number;
  height?: number;
};

export function buildTemplatePlan(input: BuildTemplatePlanInput): RenderPlan {
  const template = getTemplate(input.templateId);
  const fps = input.fps ?? FPS;
  const width = input.width ?? WIDTH;
  const height = input.height ?? HEIGHT;

  // Resolve the template FIRST. `resolveTemplateStyle` measures the hook's
  // wrap against the real font metrics and throws `BannerFitError` if it
  // would breach G9's banner carve-out (ARCHITECTURE §12.11 Minor A). Doing
  // it before the expensive planning is deliberate: an unrenderable hook
  // should cost a millisecond, not a DP sweep.
  const style = resolveTemplateStyle(template, { width, height, hookText: input.hook });

  const flat = [...input.words].sort((a, b) => a.start - b.start);
  const intervals: WordInterval[] = flat.map((w) => ({ start: w.start, end: w.end }));

  // The grid comes from the FOOTAGE's own audio, so its phase is a physical
  // property of a recording that already exists — not something we choose.
  // Sweeping φ here would produce a plan perfectly locked to a grid that does
  // not exist, which is exactly the silent 100%-planner/29%-QC failure
  // ARCHITECTURE §12.1 records. `phaseLocked` is what forbids it.
  const bed: Bed = {
    id: "analyzer-grid",
    tempoBpm: input.beats.tempoBpm ?? 112.3,
    beatTimesSec: input.beats.beatTimesMs.map((ms) => ms / 1000),
    phaseLocked: true,
  };

  const planned = planBeatLockedCuts({
    words: intervals,
    durationSec: input.durationSec,
    beds: [bed],
    seed: input.seed,
    // The template's rhythm character — the one planner input that differs
    // between the three (01 §2's "rhythmic breathing, not uniform pacing").
    rhythm: template.rhythm,
    gatePct: 0,
  });
  if (!planned.cutTimesSec.length) {
    throw new Error(`planner returned no cuts for ${template.id}: ${planned.reason ?? "unknown"}`);
  }

  // Shot boundaries on a continuous timeline — the reference's own approach
  // (01 §8: "a single continuous interview, cut on itself"), so source time
  // and output time advance together and no speech is dropped. Removing
  // footage is the selection stage of 03 §6, which does not exist; see the
  // note in this file's PR body on why G1b cannot pass until it does.
  const boundaries = [0, ...planned.cutTimesSec, input.durationSec];
  const cuts: Cut[] = boundaries.slice(1).map((end, i) => {
    const start = boundaries[i]!;
    const frames = Math.max(1, Math.round((end - start) * fps));
    const cam = shotCamera(i, frames, input.seed);
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

  // `claimTexts` stands in for the ContentBrief's frozen claim texts
  // (ARCHITECTURE §11.1 R3) — Agent B owns producing them.
  const track = buildCaptionTrack({
    words: flat.map((w) => ({
      word: w.word,
      startMs: Math.round(w.start * 1000),
      endMs: Math.round(w.end * 1000),
      rms: w.rms ?? null,
    })),
    cutTimesMs: planned.cutTimesSec.map((t) => Math.round(t * 1000)),
    claimTexts: [input.hook],
    positionForShot: (shotIndex) => templatePositionForShot(template, shotIndex),
  });

  const banner = buildBanner(input.hook, input.emphasisWord);

  return assertValidRenderPlan(
    {
      planVersion: PLAN_VERSION,
      seed: input.seed,
      fps,
      width,
      height,
      durationInFrames: Math.round(input.durationSec * fps),
      framing: template.framing,
      footage: input.footage,
      cuts,
      captions: track.map((c) => ({
        words: c.words.map((w) => ({
          word: w.word,
          startMs: w.startMs,
          endMs: w.endMs,
          isEmphasis: w.isEmphasis,
        })),
        position: c.position,
        emphasisWordIndex: c.emphasisWordIndex,
        startMs: c.startMs,
        endMs: c.endMs,
        anchor: anchorFor(c.position),
      })),
      banner: { text: banner.text, emphasisWordIndex: banner.emphasisWordIndex, anchor: BANNER_ANCHOR },
      handle: {
        text: input.handleText,
        opacity: HANDLE_OPACITY,
        cornerByShot: cuts.map((_, i) => templateHandleCornerForShot(template, i)),
      },
      // The grid the planner ACTUALLY scored against, not the raw analyzer
      // file — "canonical grid = the grid as used" (ARCHITECTURE §4.1).
      beatGrid: {
        method: input.beats.method,
        tempoBpm: input.beats.tempoBpm,
        beatTimesMs: planned.beatTimesSec.map((s) => Math.round(s * 1000)),
        gridQuality: input.beats.gridQuality,
      },
      music: null,
      grade: template.grade,
      templateStyle: style,
      scrim: template.scrim,
    },
    `${template.id} plan`,
  );
}

function main(): void {
  const templateId = arg("template");
  if (!TEMPLATE_IDS.includes(templateId as (typeof TEMPLATE_IDS)[number])) {
    throw new Error(`unknown --template "${templateId}" — known: ${TEMPLATE_IDS.join(", ")}`);
  }

  const wordsJson = JSON.parse(readFileSync(arg("words"), "utf8")) as WordsJson;
  const beats = JSON.parse(readFileSync(arg("beats"), "utf8")) as BeatsJson;
  const outPath = arg("out");

  const flat = wordsJson.segments.flatMap((s) => s.words);
  // faster-whisper reports the duration it DECODED, which trails the
  // container when the tail is silent (VAD drops it). The plan must cover the
  // real media or the last shot renders short, so the caller passes the
  // ffprobe duration and the words file is only a fallback.
  const durationSec = Number(arg("duration", String(wordsJson.durationSec)));

  let plan: RenderPlan;
  try {
    plan = buildTemplatePlan({
      templateId,
      words: flat,
      durationSec,
      beats,
      seed: Number(arg("seed", "42")),
      hook: arg("hook", "THE POWER OF OBSESSION"),
      emphasisWord: arg("emphasis", "OBSESSION"),
      handleText: arg("handle", "@PERFSTAQ"),
      footage: {
        assetId: arg("footage-id", "demo-reference-proxy"),
        r2Key: arg("footage-key", "demo/reference-16x9-proxy.mp4"),
      },
    });
  } catch (e) {
    if (e instanceof BannerFitError) {
      // 03 §7's `plan_infeasible`: a real, actionable, user-facing failure —
      // not a crash. Exits 2 so a caller can tell it apart from a bug.
      console.error(`plan_infeasible(banner_wrap): ${e.message}`);
      process.exit(2);
    }
    throw e;
  }

  writeFileSync(outPath, JSON.stringify(plan, null, 2));

  const style = plan.templateStyle!;
  const shots = plan.cuts.map((c) => (c.outputEndMs - c.outputStartMs) / 1000).sort((a, b) => a - b);
  const median = shots[Math.floor(shots.length / 2)] ?? 0;
  const emphasised = plan.captions.filter((c) => c.emphasisWordIndex !== null).length;

  console.log(`template        ${style.templateId} v${style.templateVersion}`);
  console.log(`plan            ${path.resolve(outPath)}`);
  console.log(`duration        ${durationSec.toFixed(2)}s (${plan.durationInFrames} frames @ ${plan.fps}fps)`);
  console.log(
    `cuts            ${plan.cuts.length - 1}  (${((plan.cuts.length - 1) / (durationSec / 60)).toFixed(1)}/min, median ${median.toFixed(2)}s, min ${shots[0]?.toFixed(2)}s, max ${shots[shots.length - 1]?.toFixed(2)}s)`,
  );
  console.log(
    `captions        ${plan.captions.length} chunks, max ${Math.max(...plan.captions.map((c) => c.words.length))} words, ${new Set(plan.captions.map((c) => c.position)).size} distinct positions, ${emphasised} emphasised`,
  );
  console.log(
    `typography      banner=${style.fonts.banner.split(",")[0]} karaoke=${style.fonts.karaoke.split(",")[0]} bannerLines=${style.bannerLines}`,
  );
  console.log(
    `grade           contrast=${plan.grade.contrast} sat=${plan.grade.saturation} warm=${plan.grade.warmTint} vignette=${plan.grade.vignette ?? 0}`,
  );
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
