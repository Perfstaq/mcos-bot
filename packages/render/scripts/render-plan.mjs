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
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

function render() {
  const props = path.resolve(arg("props"));
  const out = path.resolve(arg("out"));
  const composition = arg("composition", "Reel");
  execFileSync("npx", ["remotion", "render", "src/index.ts", composition, out, `--props=${props}`, "--log=error"], {
    cwd: packageRoot,
    stdio: "inherit",
  });
}

if (process.argv.includes("--print-version")) printVersion();
else render();
