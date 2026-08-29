#!/usr/bin/env node
/**
 * render-plan.mjs — invoke the renderer on a props file.
 *
 * ── Why this lives in packages/render ───────────────────────────────────────
 * ADR-5 contains Remotion to this package: "all timing/motion/caption math
 * lives in pure TS modules … `remotion` imports allowed only inside
 * `packages/render`. A forced Revideo swap then touches one directory, not
 * the pipeline." Knowing *how to invoke the renderer* is Remotion-specific
 * knowledge in exactly that sense, so it belongs here alongside the
 * compositions rather than in a script under `scripts/studio/`.
 *
 * It moved here because `render-containment.test.ts` flagged
 * `scripts/studio/render-evidence.ts` — technically a false positive (that
 * file passed "remotion" as an argv token to `npx`, it imported nothing), but
 * the test was pointing at something true: a renderer-specific invocation had
 * escaped the boundary. The fix is to honour the boundary, not to exempt the
 * file, and certainly not to disguise the string from the scanner.
 *
 * Usage:
 *   node render-plan.mjs --props <props.json> --out <out.mp4> [--composition Reel]
 *   node render-plan.mjs --print-version      # renderer version, for a manifest
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`missing required --${name}`);
}

/** The renderer's version, read from the lockfile so a manifest can record
 *  which build produced an MP4 (part of "every render is reproducible"). */
function printVersion() {
  const lock = path.join(packageRoot, "..", "..", "package-lock.json");
  try {
    const pkg = JSON.parse(readFileSync(lock, "utf8"));
    const key = ["node_modules", "@remotion", "renderer"].join("/");
    process.stdout.write(String(pkg.packages?.[key]?.version ?? "unknown"));
  } catch {
    process.stdout.write("unknown");
  }
}

/** 07 §1 G11 / 03_RENDER_PIPELINE §5 — the integrated-loudness target. */
const TARGET_LUFS = -14;
/** True peak, in dBTP. -1.5 is the usual headroom for lossy delivery. */
const TARGET_TRUE_PEAK = -1.5;
/** Loudness range. 11 LU is EBU R128's default and suits speech. */
const TARGET_LRA = 11;

/**
 * Normalise the finished render to −14 LUFS (03_RENDER_PIPELINE §5).
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * ARCHITECTURE §12.21 flagged G11 as "not a capability": all three templates
 * hit −14 exactly because the old fixture's audio was already at −14 and
 * passed through untouched, and **no loudness stage existed anywhere in the
 * pipeline**. "The number is true and demonstrates nothing about arbitrary
 * footage." The first genuinely different recording proved the point — the
 * locked-off fixture is −16.1 LUFS in and was −16.1 LUFS out, failing G11 by
 * 2.1 LU. That is the predicted consequence of a missing feature, not a
 * regression, and the honest fix is to build the feature rather than to keep
 * reporting a gate that only ever measured the input.
 *
 * ── Two passes, not one ─────────────────────────────────────────────────────
 * Single-pass `loudnorm` works from a running estimate and drifts on material
 * whose level changes — which speech with long pauses (this fixture has four
 * over 1.5s) is exactly. Measuring first and then applying with the measured
 * values is ffmpeg's own documented linear mode and is what makes the result
 * both accurate and deterministic, which G13 requires.
 *
 * The VIDEO stream is copied, never re-encoded: this must not be able to
 * change a pixel, so a frame extracted from the normalised file is still a
 * frame of the render whose behaviour the gates scored.
 */
function normaliseLoudness(file) {
  const measureArgs = [
    "-hide_banner", "-nostats", "-i", file,
    "-af", `loudnorm=I=${TARGET_LUFS}:TP=${TARGET_TRUE_PEAK}:LRA=${TARGET_LRA}:print_format=json`,
    "-f", "null", "-",
  ];
  const probe = spawnSync("ffmpeg", measureArgs, { encoding: "utf8" });
  if (probe.status !== 0) {
    throw new Error(`loudness measurement failed (${probe.status}): ${String(probe.stderr).slice(-400)}`);
  }
  // The JSON block is the last {...} ffmpeg prints on stderr.
  const text = String(probe.stderr);
  const start = text.lastIndexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("loudnorm printed no JSON measurement");
  const m = JSON.parse(text.slice(start, end + 1));

  const tmp = `${file}.loudnorm.mp4`;
  const applyArgs = [
    "-y", "-hide_banner", "-loglevel", "error", "-i", file,
    "-af",
    `loudnorm=I=${TARGET_LUFS}:TP=${TARGET_TRUE_PEAK}:LRA=${TARGET_LRA}` +
      `:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}` +
      `:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true:print_format=summary`,
    // G12 wants AAC; the video is untouched.
    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart",
    tmp,
  ];
  const applied = spawnSync("ffmpeg", applyArgs, { encoding: "utf8" });
  if (applied.status !== 0) {
    rmSync(tmp, { force: true });
    throw new Error(`loudness normalisation failed (${applied.status}): ${String(applied.stderr).slice(-400)}`);
  }
  renameSync(tmp, file);
  process.stdout.write(`[render-plan] loudness ${Number(m.input_i).toFixed(1)} → ${TARGET_LUFS} LUFS\n`);
}

function render() {
  const props = path.resolve(arg("props"));
  const out = path.resolve(arg("out"));
  const composition = arg("composition", "Reel");
  execFileSync("npx", ["remotion", "render", "src/index.ts", composition, out, `--props=${props}`, "--log=error"], {
    cwd: packageRoot,
    stdio: "inherit",
  });
  if (!process.argv.includes("--no-loudnorm")) normaliseLoudness(out);
}

if (process.argv.includes("--print-version")) printVersion();
else render();
