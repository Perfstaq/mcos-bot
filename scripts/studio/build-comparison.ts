import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TEMPLATE_IDS } from "@mcos/render/templates";

/**
 * build-comparison.ts — W4.3, the side-by-side that answers `07 §3`.
 *
 * Renders both arms of every template against the same locked-off fixture and
 * the same approved ContentBrief, scores both with the same `qc-render.ts`,
 * stacks them into one frame, and writes a manifest and a README that state
 * what was measured.
 *
 * ── It shells out to `render-evidence.ts` rather than rendering here ─────────
 * ARCHITECTURE §12.40a is the reason. The evidence harness once built plans
 * with a second builder and filed the frames as evidence for the first, and
 * "the pictures were of the right code, but the plan behind them could only
 * ever have described one clip". A comparison that rendered its own arms would
 * be that failure with two arms instead of one: the thing under test is
 * `--baseline`, so `--baseline` is what runs.
 *
 * ── The layout, and what is committed (§12.10) ──────────────────────────────
 *   docs/studio/comparison/
 *     README.md                              ← committed
 *     manifest.json                          ← committed
 *     qc-<template>-perfstaq.json            ← committed
 *     qc-<template>-baseline.json            ← committed
 *     plan-<template>-baseline.json          ← committed
 *     frames/<template>-<ms>ms.png           ← committed (side-by-side)
 *     <template>-perfstaq.mp4                ← NOT committed, sha256 recorded
 *     <template>-baseline.mp4                ← NOT committed, sha256 recorded
 *     <template>-grid.mp4                    ← NOT committed, sha256 recorded
 *     source-<footage>.mp4                   ← NOT committed, sha256 recorded
 *
 * `plan-<template>-perfstaq.json` is deliberately absent: it is already
 * committed at `docs/studio/evidence/<template>/plan.json` and is the file
 * this script feeds to `--plan`. A second copy is a second thing to go stale.
 *
 * Usage (repo root):
 *   ANALYZER_PYTHON=… npx tsx scripts/studio/build-comparison.ts
 *     [--only <template>] [--skip-render] [--skip-grid]
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const evidenceDir = path.join(repoRoot, "docs/studio/evidence");
const inputsDir = path.join(evidenceDir, "inputs");
const comparisonDir = path.join(repoRoot, "docs/studio/comparison");
const framesDir = path.join(comparisonDir, "frames");
const renderEvidence = path.join(here, "render-evidence.ts");

/**
 * The fixture and the brief, copied from `docs/studio/evidence/manifest.json`
 * so both arms are provably given the same inputs. Not re-derived: §12.44's
 * ruling is that the comparison is about the motion system, which only holds
 * if everything else is byte-identical between the arms.
 */
const FOOTAGE = "/Users/sathvik/aix/studio-assets/talking-head-v1-1080.mp4";
const FOOTAGE_SHA = "dd17a3609eca17ea613babf9c32f4892cc213e0edc20bf26fb38c719185af7b6";
const DURATION_SEC = 59.605;
const HOOK = "GRAVITY IS AGEING YOU";
const EMPHASIS = "AGEING";
/** The ContentBrief approved through the real gate in W4.1. Reused, never
 *  regenerated: the gate is the product and bypassing it is invariant 1. */
const CONTENT_BRIEF_ID = "cca7adf4-2404-455c-90ae-e907587f6284";
const ASSET_ID = "talking-head-v1-1080";
const R2_KEY = "studio/talking-head-v1-1080.mp4";

/**
 * The three instants both arms are sampled at.
 *
 * 880ms is the moment the W4.1 evidence already samples ("banner settled +
 * first karaoke chunk"). 7470ms and 30000ms are §12.45's two flagged
 * timestamps — the captions that landed on the subject's HANDS before §12.43
 * moved captions into the bars. Sampling the real arm there is the point: the
 * ruling is either visible in the pixels or it is not.
 */
const FRAME_TIMES_MS = [880, 7470, 30000];

/** Where each half's colour key is drawn. This ffmpeg build has no drawtext
 *  (no libfreetype), so the key is a colour band, explained in the README. */
const GRID_BAND_H = 96;
const PERFSTAQ_BAND = "0xFF7A1A"; // the product accent
const BASELINE_BAND = "0x3A3A3E"; // neutral grey

type Arm = "perfstaq" | "baseline";

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function argValue(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : null;
}

function run(cmd: string, args: string[]): void {
  execFileSync(cmd, args, { cwd: repoRoot, stdio: "inherit" });
}

/** Both arms get the same inputs; only `--plan` vs `--baseline` differs. */
function renderArm(templateId: string, arm: Arm): void {
  const shared = [
    "tsx", renderEvidence,
    "--footage", FOOTAGE,
    "--template", templateId,
    "--words", path.join(inputsDir, "talking-head-v1-words.json"),
    "--beats", path.join(inputsDir, "talking-head-v1-beats.json"),
    "--duration", String(DURATION_SEC),
    "--hook", HOOK,
    "--emphasis", EMPHASIS,
    "--content-brief-id", CONTENT_BRIEF_ID,
    "--asset-id", ASSET_ID,
    "--r2-key", R2_KEY,
    "--out-dir", comparisonDir,
    "--keep-mp4",
    "--frames-at", FRAME_TIMES_MS.join(","),
  ];
  const armArgs =
    arm === "baseline"
      ? ["--baseline"]
      : // The REAL arm renders the plan the pipeline committed in W4.1 — the
        // row that came through gate-approve → plan.build → RenderPlan — not a
        // reconstruction of it. Same reasoning as `--plan` itself (§12.40a).
        ["--plan", path.join(evidenceDir, templateId, "plan.json")];
  run("npx", [...shared, ...armArgs]);
}

/**
 * Move what `render-evidence` wrote in its per-template subdirectory up into
 * the flat comparison layout, and drop what the grid supersedes.
 *
 * The per-arm PNG frames are deleted on purpose. The real arm's frames are
 * already committed under `docs/studio/evidence/<template>/`, and a comparison
 * is not served by two half-pictures a reader has to hold side by side in
 * their head — the stacked frames below are the artifact.
 */
function promote(templateId: string, arm: Arm): { mp4: string; qc: string; plan: string } {
  const slug = arm === "baseline" ? `${templateId}-baseline` : templateId;
  const subdir = path.join(comparisonDir, slug);
  if (!existsSync(subdir)) throw new Error(`expected ${subdir} from render-evidence`);

  const mp4 = path.join(comparisonDir, `${templateId}-${arm}.mp4`);
  renameSync(path.join(subdir, `${slug}.mp4`), mp4);

  const qc = path.join(comparisonDir, `qc-${templateId}-${arm}.json`);
  renameSync(path.join(subdir, "qc.json"), qc);

  // Only the BASELINE plan is promoted; the real one is already committed.
  const plan = path.join(comparisonDir, `plan-${templateId}-baseline.json`);
  if (arm === "baseline") renameSync(path.join(subdir, "plan.json"), plan);

  rmSync(subdir, { recursive: true, force: true });
  return { mp4, qc, plan };
}

/**
 * PerfStaq left, baseline right, 1080×1920 each, 2160×1920 out.
 *
 * The audio is taken from the real arm and is not a choice with consequences:
 * neither arm removes footage, so both play the same continuous source audio,
 * and `render-plan.mjs` normalises both to −14 LUFS with the video stream
 * copied. The two tracks are the same sound.
 */
function buildGrid(templateId: string): string {
  const left = path.join(comparisonDir, `${templateId}-perfstaq.mp4`);
  const right = path.join(comparisonDir, `${templateId}-baseline.mp4`);
  const out = path.join(comparisonDir, `${templateId}-grid.mp4`);
  rmSync(out, { force: true });
  run("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-i", left,
    "-i", right,
    "-filter_complex",
    `[0:v]drawbox=x=0:y=0:w=iw:h=${GRID_BAND_H}:color=${PERFSTAQ_BAND}@1:t=fill[l];` +
      `[1:v]drawbox=x=0:y=0:w=iw:h=${GRID_BAND_H}:color=${BASELINE_BAND}@1:t=fill[r];` +
      `[l][r]hstack=inputs=2[v]`,
    "-map", "[v]", "-map", "0:a",
    "-c:v", "libx264", "-crf", "23", "-preset", "medium", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
    out,
  ]);
  return out;
}

function extractGridFrames(templateId: string, fps = 30): { file: string; timeMs: number; sha256: string; bytes: number }[] {
  mkdirSync(framesDir, { recursive: true });
  const grid = path.join(comparisonDir, `${templateId}-grid.mp4`);
  return FRAME_TIMES_MS.map((timeMs) => {
    const name = `${templateId}-${String(timeMs).padStart(5, "0")}ms.png`;
    const file = path.join(framesDir, name);
    const frame = Math.round((timeMs / 1000) * fps);
    run("ffmpeg", [
      "-y", "-loglevel", "error", "-i", grid,
      "-vf", `select=eq(n\\,${frame}),scale=1080:-2`,
      "-frames:v", "1", file,
    ]);
    return { file: `frames/${name}`, timeMs, sha256: sha256(file), bytes: statSync(file).size };
  });
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

type Gate = { id: string; name: string; pass: boolean | null; measured: unknown; target: string; hard: boolean; computable: boolean; notApplicable?: unknown };
type Qc = { gates: Gate[]; overallPass: boolean; excludedGates: { id: string }[]; scoredGateCount: number };

function readQc(templateId: string, arm: Arm): Qc {
  return JSON.parse(readFileSync(path.join(comparisonDir, `qc-${templateId}-${arm}.json`), "utf8")) as Qc;
}

/** A gate's measured value, flattened to something a table cell can hold. */
function cell(g: Gate | undefined): string {
  if (!g) return "—";
  const m = g.measured;
  let value: string;
  if (m === null || m === undefined) value = "—";
  else if (typeof m === "number") value = String(m);
  else if (typeof m === "object") {
    const o = m as Record<string, unknown>;
    if ("ratio" in o) value = `${Math.round(Number(o["ratio"]) * 1000) / 10}% (${o["withinCount"]}/${o["totalCuts"]})`;
    else if ("violations" in o) value = `${o["violations"]} violation(s)`;
    else if ("staticShots" in o) value = `${o["staticShots"]}/${o["shots"]} static`;
    else if ("outOfRangeEmphasis" in o) value = `${o["chunks"]} chunks, ${o["outOfRangeEmphasis"]} bad`;
    else if ("width" in o) value = `${o["width"]}x${o["height"]} ${o["vcodec"]}+${o["acodec"]}`;
    else if ("removesFootage" in o) value = "n/a";
    else if ("checksum" in o) value = "recorded";
    else if ("contentBriefId" in o) value = "linked";
    else value = JSON.stringify(m);
  } else value = String(m);
  const mark = g.pass === true ? "PASS" : g.pass === false ? "**FAIL**" : "–";
  return `${value} · ${mark}`;
}

const GATE_ORDER = ["G1a", "G1b", "G2", "G3", "G4", "G5", "G6", "G7", "G8", "G9", "G10", "G11", "G12", "G13", "G14"];

function gateTable(templateId: string): string {
  const real = readQc(templateId, "perfstaq");
  const base = readQc(templateId, "baseline");
  const byId = (q: Qc, id: string) => q.gates.find((g) => g.id === id);
  const rows = GATE_ORDER.map((id) => {
    const r = byId(real, id);
    const b = byId(base, id);
    if (!r && !b) return null;
    return `| ${id} ${r?.name ?? b?.name ?? ""} | ${cell(r)} | ${cell(b)} | ${r?.target ?? b?.target ?? ""} |`;
  }).filter(Boolean);
  return [
    `| gate | PerfStaq | baseline | target |`,
    `|---|---|---|---|`,
    ...rows,
    ``,
    `**Verdict:** PerfStaq ${real.overallPass ? "PASS" : "FAIL"} ` +
      `(${real.scoredGateCount} hard gates scored, ${real.excludedGates.length} excluded) · ` +
      `baseline ${base.overallPass ? "PASS" : "FAIL"} ` +
      `(${base.scoredGateCount} hard gates scored, ${base.excludedGates.length} excluded)`,
  ].join("\n");
}

function main(): void {
  mkdirSync(comparisonDir, { recursive: true });
  const only = argValue("only");
  const targets = only ? [only] : [...TEMPLATE_IDS];

  if (!flag("skip-render")) {
    if (!existsSync(FOOTAGE)) throw new Error(`footage not found: ${FOOTAGE}`);
    if (sha256(FOOTAGE) !== FOOTAGE_SHA) {
      throw new Error(`footage sha256 does not match the W4.1 manifest — the arms would not share a source`);
    }
    for (const templateId of targets) {
      // One arm at a time, MP4s kept: a render peaks at ~2.5GB of transient
      // frame cache, so two in flight is how the disk fills.
      for (const arm of ["perfstaq", "baseline"] as Arm[]) {
        // `--reuse-existing` is for ONE situation: a run that died partway
        // through (a crash after the first arm, a full disk) where
        // re-rendering three minutes of video would only reproduce a file we
        // already have. Explicit rather than automatic, and loud — an
        // unguarded reuse is exactly the stale-artifact failure §12.10 exists
        // to prevent. The real arm is additionally verifiable: its plan comes
        // from `--plan`, so it cannot have drifted, and its sha256 is recorded
        // in `docs/studio/evidence/manifest.json`.
        const mp4 = path.join(comparisonDir, `${templateId}-${arm}.mp4`);
        const qc = path.join(comparisonDir, `qc-${templateId}-${arm}.json`);
        if (flag("reuse-existing") && existsSync(mp4) && existsSync(qc)) {
          console.log(`[${templateId}-${arm}] --reuse-existing: keeping ${path.basename(mp4)} (sha ${sha256(mp4).slice(0, 12)}…)`);
          continue;
        }
        renderArm(templateId, arm);
        promote(templateId, arm);
      }
    }
    // `render-evidence` writes its own manifest into `--out-dir`; the
    // comparison's manifest below supersedes it and describes the flat layout.
    rmSync(path.join(comparisonDir, "manifest.json"), { force: true });
  }

  const source = path.join(comparisonDir, `source-${path.basename(FOOTAGE)}`);
  if (!existsSync(source)) copyFileSync(FOOTAGE, source);

  const templates: Record<string, unknown> = {};
  for (const templateId of targets) {
    if (!flag("skip-grid")) buildGrid(templateId);
    const frames = flag("skip-grid") ? [] : extractGridFrames(templateId);
    const entry: Record<string, unknown> = { frames, gateTable: gateTable(templateId) };
    for (const arm of ["perfstaq", "baseline"] as Arm[]) {
      const mp4 = path.join(comparisonDir, `${templateId}-${arm}.mp4`);
      const qc = path.join(comparisonDir, `qc-${templateId}-${arm}.json`);
      entry[arm] = {
        mp4: { file: `${templateId}-${arm}.mp4`, sha256: sha256(mp4), bytes: statSync(mp4).size, committed: false },
        qc: { file: `qc-${templateId}-${arm}.json`, sha256: sha256(qc) },
        overallPass: readQc(templateId, arm).overallPass,
      };
    }
    const grid = path.join(comparisonDir, `${templateId}-grid.mp4`);
    if (existsSync(grid)) {
      entry["grid"] = { file: `${templateId}-grid.mp4`, sha256: sha256(grid), bytes: statSync(grid).size, committed: false };
    }
    const basePlan = path.join(comparisonDir, `plan-${templateId}-baseline.json`);
    entry["baselinePlan"] = { file: `plan-${templateId}-baseline.json`, sha256: sha256(basePlan) };
    entry["perfstaqPlan"] = {
      file: `docs/studio/evidence/${templateId}/plan.json`,
      sha256: sha256(path.join(evidenceDir, templateId, "plan.json")),
      note: "the plan the real chain committed in W4.1 — fed to --plan, not rebuilt here",
    };
    templates[templateId] = entry;
  }

  const manifest = {
    description:
      "W4.3 side-by-side comparison: the real pipeline against the W4.2 naive baseline, same ContentBrief, " +
      "same footage, same typography. Per ARCHITECTURE §12.10 the MP4s (both arms, the grid and the source) " +
      "are NOT committed; their sha256 is recorded here alongside the commit they were rendered from. The " +
      "qc JSONs, the baseline plans and the stacked PNG frames are committed.",
    generatedAt: new Date().toISOString(),
    renderedFromCommit: git(["rev-parse", "HEAD"]),
    renderedFromCommitSubject: git(["log", "-1", "--format=%s"]),
    treeDirty:
      git([
        "status", "--porcelain", "--",
        "packages/render/src", "scripts/studio/render-evidence.ts",
        "scripts/studio/build-comparison.ts", "scripts/qc-render.ts",
      ]).length > 0,
    inputs: {
      footage: { path: FOOTAGE, sha256: FOOTAGE_SHA, copiedTo: path.basename(source) },
      durationSec: DURATION_SEC,
      hook: HOOK,
      emphasisWord: EMPHASIS,
      contentBriefId: CONTENT_BRIEF_ID,
      frameTimesMs: FRAME_TIMES_MS,
    },
    grid: {
      layout: "PerfStaq left, baseline right — 1080x1920 each, 2160x1920 out",
      colourKey: `this ffmpeg build has no drawtext (no libfreetype), so each half carries a ${GRID_BAND_H}px top band instead of a label: ${PERFSTAQ_BAND} (accent) = PerfStaq, ${BASELINE_BAND} (grey) = baseline`,
    },
    templates,
  };
  writeFileSync(path.join(comparisonDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  console.log(`\ncomparison      ${comparisonDir}`);
  for (const [id, t] of Object.entries(templates)) {
    const rec = t as Record<string, { overallPass?: boolean }>;
    console.log(
      `  ${id.padEnd(20)} perfstaq ${rec["perfstaq"]?.overallPass ? "PASS" : "FAIL"} · baseline ${rec["baseline"]?.overallPass ? "PASS" : "FAIL"}`,
    );
  }
  const stray = readdirSync(comparisonDir).filter((f) => TEMPLATE_IDS.some((t) => f === t || f === `${t}-baseline`));
  if (stray.length) console.log(`WARNING         leftover render-evidence subdirs: ${stray.join(", ")}`);
}

main();
