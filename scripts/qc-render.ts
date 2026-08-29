import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RenderPlanSchema, cutTimesMs, planRemovesFootage, type RenderPlan } from "@mcos/render/plan";
import { gateG1a, FINGERPRINT_ACCEPTANCE_FLOOR, REFERENCE_BEAT_LOCK_RATIO } from "@mcos/render/gates/g1a";
import type { GateResult } from "@mcos/render/gates/types";
import {
  BANNER_ANCHOR,
  BANNER_TOP_MARGIN_RATIO,
  FACE_FLOOR_RATIO,
  LINE_HEIGHT,
  TYPE_SCALE,
  blockHeightPx,
  faceFloorViolationsForBlock,
  regionContainmentViolations,
  CONTENT_REGION_RATIO,
  g9Violations,
  g9ViolationsForBlock,
  handleAnchor,
  textBoxBounds,
  wrapWords,
} from "@mcos/render/captions";
import { MIN_VISIBLE_SCALE_DELTA } from "@mcos/render/motion";

/**
 * qc-render.ts — 07_QUALITY_GATES §1, ADR-8.
 *
 * Takes a rendered MP4 + its RenderPlan, runs PySceneDetect + ffmpeg
 * (loudness/ffprobe) + plan introspection, emits qc.json: one entry per
 * gate, `pass: null` where a gate isn't computable from what this
 * milestone's RenderPlan/caption contract carries yet (never silently
 * skipped — see `NOT_YET_COMPUTABLE` below).
 *
 * G1 is TWO independent hard gates (ADR-8, finalized 2026-08-27):
 *   G1a — musical intent (planner's gate): plan cut times vs the plan's OWN
 *         embedded beat grid, ≥85% within 150ms. In production this is
 *         evaluated at `plan.build`, before anything renders (a failing
 *         plan must never reach `render.submit`) — this script re-checks it
 *         here too, as an audit record on the finished render, not as the
 *         first line of defense.
 *   G1b — render fidelity (renderer's gate): scene-detect the OUTPUT and
 *         require ≥90% of the plan's cut times to have a detected cut
 *         within ±2 frames. Matches against KNOWN cut times — never blind
 *         re-discovery, which is what made the reference oscillate between
 *         0.862 (claimed) and 0.821 (re-measured) depending on detector
 *         threshold (§4.1). The pixel-derived beat-lock ratio is written
 *         alongside as informational only, next to the calibrated 0.821
 *         reference baseline — never gated on.
 *
 * Usage (dev, via tsx — transpiles on the fly, no build step needed):
 *   npx tsx scripts/qc-render.ts --mp4 <rendered.mp4> --plan <plan.json>
 *     [--words <words.json>] [--content-brief-id <id>]
 *     [--prev-checksum <sha256>] [--out <qc.json>]
 *
 * Usage (production — compiled by `npx tsc -p scripts/tsconfig.build.json`,
 * this is what jobs/render-qc.ts and Dockerfile.media actually run; no tsx
 * in the production image, see C1 in the code-review history):
 *   node scripts/dist/qc-render.js --mp4 <rendered.mp4> --plan <plan.json> [...same flags]
 */

// REFERENCE_BEAT_LOCK_RATIO/REFERENCE_GRID_QUALITY/FINGERPRINT_ACCEPTANCE_FLOOR
// and gateG1a itself now live in @mcos/render/gates/g1a — imported above, not
// duplicated here. That module's own header comment has the full rationale
// (ADR-8 requires G1a evaluated at `plan.build`, inside apps/api; this file
// stays the audit re-check on the finished render, importing the exact same
// function rather than a second copy of the gate math).

/**
 * Repo root, found by walking up from wherever this file actually runs from
 * — NOT a fixed number of `..` hops. This file runs from two different
 * depths depending on how it's invoked: `scripts/qc-render.ts` directly
 * (tsx, dev/local) is one level below repo root, but its COMPILED output
 * (`scripts/dist/qc-render.js`, what jobs/render-qc.ts and Dockerfile.media
 * actually run — no tsx in production, see render-qc.ts's comment on C1) is
 * two levels below. A fixed `path.resolve(here, "..")` silently pointed at
 * the wrong directory once the build step existed — caught by the
 * Dockerfile.media smoke test, not by typecheck (both paths type-check
 * fine; only one resolves at runtime).
 */
function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (;;) {
    if (existsSync(path.join(dir, "package-lock.json")) && existsSync(path.join(dir, "services", "analyzer"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`could not locate the repo root walking up from ${startDir}`);
    }
    dir = parent;
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = findRepoRoot(here);

function analyzerPython(): string {
  if (process.env.ANALYZER_PYTHON) return process.env.ANALYZER_PYTHON;
  const devPath = path.join(repoRoot, "services/analyzer/.venv/bin/python");
  if (!existsSync(devPath)) {
    throw new Error(`analyzer venv not found at ${devPath} (and ANALYZER_PYTHON is unset).`);
  }
  return devPath;
}

function qcSceneDetectScript(): string {
  return process.env.QC_SCENE_DETECT_SCRIPT ?? path.join(repoRoot, "services/analyzer/qc_scene_detect.py");
}

function detectCutTimesMs(mp4Path: string): number[] {
  const out = execFileSync(analyzerPython(), [qcSceneDetectScript(), "--input", mp4Path], { encoding: "utf8" });
  return (JSON.parse(out) as { cutTimesMs: number[] }).cutTimesMs;
}

function nearestDistanceMs(t: number, others: number[]): number | null {
  if (!others.length) return null;
  return Math.min(...others.map((o) => Math.abs(o - t)));
}

// G1a is imported from @mcos/render/gates/g1a (see the import above) — not
// defined here. re-export it so existing consumers of this module (tests,
// jobs/render-qc.ts) can keep importing gateG1a from "qc-render.js" as
// before, without caring that its definition moved.
export { gateG1a };

// --- G1b: render fidelity (output vs plan's known cut times) ---------------

/**
 * The exclusion's machine-readable reason code (ARCHITECTURE §12.37).
 *
 * Exported so a caller branches on a constant rather than a string literal it
 * copied out of a report — and so that renaming it breaks a compile instead of
 * silently breaking a consumer's `switch`.
 */
export const G1B_NOT_APPLICABLE_CONTINUOUS = "continuous_playback_no_discontinuities";

/**
 * G1b — render fidelity, scored **only against plans it can measure**.
 *
 * The gate matches the plan's known cut times against pixel-detected scene
 * cuts. That question is only meaningful if the render contains scene cuts to
 * detect, and it contains them only if the plan REMOVES footage: v1 plays one
 * clip continuously and changes framing, and framing changes are not content
 * discontinuities. ARCHITECTURE §12.3 records what that cost — every template
 * and every render scored ~2/29 and reported a hard red — and names the
 * temptation it creates: "inflating framing changes until a detector trips is
 * gaming the gate, not passing it."
 *
 * Two options were open (§12.37): ship a licensed music bed so `03 §6`'s
 * footage-removal stage could exist, or mark the gate not-applicable until it
 * does. There is no licensed audio asset in this repo, so removal cannot exist
 * under §12.13's ruling, so the gate cannot pass under ANY plan we can build
 * today. It is marked.
 *
 * **The exclusion is derived from the plan, not from a flag or a date.** The day
 * `03 §6` lands with a bed, its plans remove footage, `planRemovesFootage`
 * returns true, and this gate starts scoring again with no code change and no
 * migration. That property is what separates an honest exclusion from a
 * disabled gate, and it is asserted by its own test rather than left as an
 * intention.
 *
 * G1a is untouched and is the gate that means something today (§12.3).
 */
export function gateG1b(plan: RenderPlan, detectedCutsMs: number[]): GateResult {
  const id = "G1b";
  const name = "Beat lock — render fidelity";
  const planCuts = cutTimesMs(plan);
  const windowMs = Math.floor(2000 / plan.fps); // ±2 frames

  if (!planRemovesFootage(plan)) {
    return {
      id,
      name,
      hard: true,
      // Not "we lack a tool" (G10's case without --words) but "there is nothing
      // here to measure". `notApplicable` below is what tells the two apart;
      // this field is what keeps the gate out of the pass/fail rollup.
      computable: false,
      pass: null,
      notApplicable: { code: G1B_NOT_APPLICABLE_CONTINUOUS, see: "ARCHITECTURE §12.3, §12.13" },
      measured: {
        // The evidence FOR the exclusion, so a reader can check the claim
        // rather than take it. `detectedCuts` in particular: if a continuous
        // plan ever starts producing a pile of detected cuts, that is a real
        // finding about the renderer and this line is where it shows up.
        removesFootage: false,
        planCuts: planCuts.length,
        detectedCuts: detectedCutsMs.length,
        windowMs,
      },
      target: `≥90% of the plan's cut times have a detected cut within ±2 frames (${windowMs}ms) — scored only for plans that remove footage`,
      note:
        "not applicable: this plan is a continuous playthrough (every shot's source span continues where the " +
        "last ended), so the render contains no content discontinuities for a scene detector to find. Real jump " +
        "cuts need the footage-removal stage of 03 §6, which under ARCHITECTURE §12.13 requires a licensed music " +
        "bed — no audio asset exists in this repo yet. Excluded from the pass/fail rollup, NOT passed. This gate " +
        "resumes scoring automatically for any plan whose cuts actually remove footage.",
    };
  }

  if (!planCuts.length) {
    return { id, name, hard: true, computable: true, pass: false, measured: {}, target: `≥90% of plan cuts matched within ±2 frames (${windowMs}ms)`, note: "plan has no cuts" };
  }

  const matched = planCuts.filter((pc) => detectedCutsMs.some((dc) => Math.abs(dc - pc) <= windowMs)).length;
  const ratio = matched / planCuts.length;

  const beats = plan.beatGrid.beatTimesMs;
  const pixelRatio = detectedCutsMs.length
    ? detectedCutsMs.filter((dc) => (nearestDistanceMs(dc, beats) ?? Infinity) <= 150).length / detectedCutsMs.length
    : null;

  return {
    id,
    name,
    hard: true,
    computable: true,
    pass: ratio >= 0.9,
    measured: {
      removesFootage: true,
      matchedRatio: Math.round(ratio * 1000) / 1000,
      matched,
      totalPlanCuts: planCuts.length,
      detectedCuts: detectedCutsMs.length,
      windowMs,
      informationalPixelBeatLockRatio: pixelRatio === null ? null : Math.round(pixelRatio * 1000) / 1000,
      referenceBaseline: REFERENCE_BEAT_LOCK_RATIO,
    },
    target: `≥90% of the plan's cut times have a detected cut within ±2 frames (${windowMs}ms). Pixel-derived ratio is informational only, never gated.`,
  };
}

// --- Plan-introspection gates (G2-G6, G8) -----------------------------------
// ── Plan-decidable hard gates ───────────────────────────────────────────────
// Moved to `@mcos/render/gates/plan-gates` so `plan.build` can reject a
// failing plan BEFORE a render is paid for (ARCHITECTURE §12.42). Re-exported
// here unchanged so this script's callers and tests keep their import site.
import {
  gateG2,
  gateG3,
  gateG4,
  gateG5,
  gateG6,
  gateG7,
  gateG8,
  gateG9,
  gateG10,
  type WordsFile,
} from "@mcos/render/gates/plan-gates";

export {
  gateG2,
  gateG3,
  gateG4,
  gateG5,
  gateG6,
  gateG7,
  gateG8,
  gateG9,
  gateG10,
  PLAN_DECIDABLE_GATES,
  planDecidableGateResults,
  type WordsFile,
} from "@mcos/render/gates/plan-gates";

// --- G11/G12: ffmpeg/ffprobe on the rendered output -------------------------
/**
 * I4: G11 has no legitimate "not computable" case the way G7/G9 do (those
 * are real, permanent contract gaps — the plan schema has no motion/caption-
 * geometry fields yet). A rendered MP4 either HAS a measurable loudness or
 * something in the environment is broken (ffmpeg missing, a future ffmpeg
 * version changing its log format so the regex misses). Either failure mode
 * THROWS — surfacing as a crashed QC run (`failedStage: "qc"`), never as a
 * silent `computable: false` that would let the render pass QC unmeasured.
 */
export function measureLoudnessLufs(mp4Path: string): number {
  // ffmpeg writes filter output (including ebur128's summary) to stderr, not
  // stdout, regardless of exit code — spawnSync (not execFileSync) is what
  // actually surfaces stderr on the SUCCESS path, not just on throw.
  const result = spawnSync("ffmpeg", ["-nostats", "-i", mp4Path, "-af", "ebur128", "-f", "null", "-"], {
    encoding: "utf8",
  });
  if (result.error) {
    throw new Error(`G11: ffmpeg failed to run (${result.error.message}) — cannot measure loudness`);
  }
  const lufs = parseIntegratedLufs(result.stderr ?? "");
  if (lufs === null) {
    throw new Error(
      `G11: could not parse an "Integrated loudness" line from ffmpeg's ebur128 output — ` +
        "either the render has no audio, or ffmpeg's log format changed and the parser needs updating. " +
        `First 500 chars of stderr: ${(result.stderr ?? "").slice(0, 500)}`,
    );
  }
  return lufs;
}

export function parseIntegratedLufs(ffmpegOutput: string): number | null {
  const match = ffmpegOutput.match(/Integrated loudness:\s*\n\s*I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/);
  return match ? Number(match[1]) : null;
}

export function gateG11(mp4Path: string): GateResult {
  const lufs = measureLoudnessLufs(mp4Path);
  return {
    id: "G11",
    name: "Loudness",
    hard: true,
    computable: true,
    pass: lufs >= -15 && lufs <= -13,
    measured: lufs,
    target: "-14 ±1 LUFS integrated",
  };
}

type Probe = { width: number; height: number; fps: number; vcodec: string; acodec: string };

export function ffprobeSpec(mp4Path: string): Probe {
  const out = execFileSync(
    "ffprobe",
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate,codec_name", "-of", "json", mp4Path],
    { encoding: "utf8" },
  );
  const video = (JSON.parse(out).streams ?? [])[0] ?? {};
  const [num, den] = String(video.r_frame_rate ?? "0/1").split("/").map(Number);
  const audioOut = execFileSync("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name", "-of", "json", mp4Path], { encoding: "utf8" });
  const audio = (JSON.parse(audioOut).streams ?? [])[0] ?? {};
  return {
    width: Number(video.width ?? 0),
    height: Number(video.height ?? 0),
    fps: den ? num! / den : 0,
    vcodec: String(video.codec_name ?? ""),
    acodec: String(audio.codec_name ?? ""),
  };
}

export function gateG12(mp4Path: string): GateResult {
  const p = ffprobeSpec(mp4Path);
  const pass = p.width === 1080 && p.height === 1920 && Math.round(p.fps) === 30 && p.vcodec === "h264" && p.acodec === "aac";
  return { id: "G12", name: "Output spec", hard: true, computable: true, pass, measured: p, target: "1080x1920, 30fps, h264+aac" };
}

// --- G13: reproducibility (checksum; pass requires a paired comparison) ----
export function sha256File(filePath: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(filePath)).digest("hex")}`;
}

export function gateG13(mp4Path: string, prevChecksum?: string): GateResult {
  const checksum = sha256File(mp4Path);
  if (!prevChecksum) {
    return { id: "G13", name: "Reproducibility", hard: false, computable: true, pass: null, measured: { checksum }, target: "same plan+footage ⇒ identical checksum", note: "no --prev-checksum given — recorded for a future comparison, not scored this run" };
  }
  return { id: "G13", name: "Reproducibility", hard: true, computable: true, pass: checksum === prevChecksum, measured: { checksum, prevChecksum }, target: "same plan+footage ⇒ identical checksum" };
}

// --- G14: provenance (thin — ContentBrief doesn't exist yet, Agent B) ------
export function gateG14(contentBriefId?: string): GateResult {
  return {
    id: "G14",
    name: "Provenance",
    hard: false,
    computable: Boolean(contentBriefId !== undefined),
    pass: contentBriefId !== undefined ? contentBriefId.length > 0 : null,
    measured: { contentBriefId: contentBriefId ?? null },
    target: "render links to claim_ids + framework_id",
    note: "thin placeholder: only checks contentBriefId is non-empty — claim_ids/framework_id live on Agent B's ContentBrief model, not yet built",
  };
}

// --- G7/G9: closed against the plan, no pixels required (§12.6) ------------
//
// Both were `computable: false` because the contract carried no motion or
// caption geometry. Agent M added `ShotMotionSchema` per cut and `anchor` per
// caption, and the template resolver adds the resolved type sizes, so both are
// now decidable from the plan alone — which ARCHITECTURE §12.6 names as P/T's
// boundary to wire up. Scoring them off the plan rather than off frames is not
// a shortcut: the plan is the artifact a re-render reproduces, and a gate that
// needed a rasteriser could not run at `plan.build`, which is where a failing
// plan should be rejected (ADR-8's posture for G1a).

/** 02 §4.1 / G7: every shot moves. `MIN_VISIBLE_SCALE_DELTA` is M's constant. */

export type QcExclusion = { id: string; code: string; see: string };

export type QcReport = {
  analyzerVersion: string;
  mp4: string;
  gates: GateResult[];
  overallPass: boolean;
  /**
   * Every gate that did not APPLY to this render, lifted to the top of the
   * report (ARCHITECTURE §12.37).
   *
   * A report is read as a verdict, and `overallPass: true` beside a gate that
   * was never scored is the exact shape of a lie this milestone has already
   * been told twice — §12.21's "G11's −14 LUFS is not a capability", and the
   * evidence frames of §12.10. A green report with a non-empty
   * `excludedGates` is honest; a green report that quietly dropped a gate is
   * not. So the exclusions are a first-class field rather than something a
   * reader has to reconstruct by scanning `gates` for nulls.
   */
  excludedGates: QcExclusion[];
  /** How many hard gates were actually scored — the denominator behind
   *  `overallPass`, stated rather than implied. */
  scoredGateCount: number;
  fingerprintAcceptanceFloor: number;
};

/**
 * The pass/fail rollup, extracted so it is testable without an MP4, ffmpeg and
 * PySceneDetect.
 *
 * A hard gate counts toward the verdict when it is computable AND applicable.
 * Both conditions are checked independently on purpose: a future gate that sets
 * one and forgets the other must not silently rejoin the pass set, and there is
 * a test that removes exactly that safety net to prove it is load-bearing.
 *
 * A gate that is not computable still doesn't block a merge on its own — that
 * behaviour predates this function and is unchanged. What is new is that a gate
 * excluded for INAPPLICABILITY is also reported as such, so the two reasons a
 * gate can be absent from the verdict are never confused for each other.
 */
export function rollUpQc(gates: GateResult[]): {
  overallPass: boolean;
  excludedGates: QcExclusion[];
  scored: number;
} {
  const scored = gates.filter((g) => g.hard && g.computable && !g.notApplicable);
  return {
    overallPass: scored.every((g) => g.pass === true),
    excludedGates: gates
      .filter((g): g is GateResult & { notApplicable: NonNullable<GateResult["notApplicable"]> } =>
        Boolean(g.notApplicable),
      )
      .map((g) => ({ id: g.id, code: g.notApplicable.code, see: g.notApplicable.see })),
    scored: scored.length,
  };
}

export async function runQc(opts: {
  mp4Path: string;
  plan: RenderPlan;
  wordsFile?: WordsFile | null;
  contentBriefId?: string;
  prevChecksum?: string;
}): Promise<QcReport> {
  const detectedCutsMs = detectCutTimesMs(opts.mp4Path);

  const gates: GateResult[] = [
    gateG1a(opts.plan),
    gateG1b(opts.plan, detectedCutsMs),
    gateG2(opts.plan),
    gateG3(opts.plan),
    gateG4(opts.plan),
    gateG5(opts.plan),
    gateG6(opts.plan),
    gateG8(opts.plan),
    gateG10(opts.plan, opts.wordsFile ?? null),
    gateG11(opts.mp4Path),
    gateG12(opts.mp4Path),
    gateG13(opts.mp4Path, opts.prevChecksum),
    gateG14(opts.contentBriefId),
    gateG7(opts.plan),
    gateG9(opts.plan),
  ];

  // Overall pass: every HARD gate that is computable AND applicable must pass.
  // A gate that isn't computable yet doesn't block a merge on its own (07 §4's
  // "the M1 suite must stay green" is about a DIFFERENT suite; this
  // milestone's own gates fail loudly by being reported `pass: null`, never
  // silently true), and an inapplicable one is listed in `excludedGates`.
  const roll = rollUpQc(gates);

  return {
    analyzerVersion: "qc-render@0.1.0",
    mp4: opts.mp4Path,
    gates,
    overallPass: roll.overallPass,
    excludedGates: roll.excludedGates,
    scoredGateCount: roll.scored,
    fingerprintAcceptanceFloor: FINGERPRINT_ACCEPTANCE_FLOOR,
  };
}

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const mp4Path = arg("--mp4");
  const planPath = arg("--plan");
  if (!mp4Path || !planPath) {
    console.error(
      "usage: node scripts/dist/qc-render.js --mp4 <rendered.mp4> --plan <plan.json> [--words <words.json>] [--content-brief-id <id>] [--prev-checksum <sha256>] [--out <qc.json>]\n" +
        "   (dev, from TS source: npx tsx scripts/qc-render.ts ...same flags)",
    );
    process.exit(1);
  }

  const plan = RenderPlanSchema.parse(JSON.parse(readFileSync(planPath, "utf8")));
  const wordsPath = arg("--words");
  const wordsFile = wordsPath ? (JSON.parse(readFileSync(wordsPath, "utf8")) as WordsFile) : null;

  const report = await runQc({
    mp4Path,
    plan,
    wordsFile,
    contentBriefId: arg("--content-brief-id"),
    prevChecksum: arg("--prev-checksum"),
  });

  const json = JSON.stringify(report, null, 2);
  const outPath = arg("--out");
  if (outPath) writeFileSync(outPath, json);
  else console.log(json);

  // "PASS with 1 excluded" — never a bare PASS while a gate went unscored.
  // The JSON carries `excludedGates`; an operator watching the console gets
  // the same fact without having to open it.
  const excluded = report.excludedGates.length
    ? ` · ${report.excludedGates.length} excluded (n/a)`
    : "";
  console.error(
    `\nqc-render: ${report.overallPass ? "PASS" : "FAIL"} (${report.scoredGateCount} hard gates scored${excluded})`,
  );
  for (const g of report.gates) {
    // `–` is its own mark: not scored because the gate does not APPLY, which
    // is a different thing from `·` (applies, could not be measured).
    const mark = g.notApplicable ? "–" : g.pass === null ? "·" : g.pass ? "✓" : "✗";
    const why = g.notApplicable ? `  (n/a: ${g.notApplicable.code} — ${g.notApplicable.see})` : "";
    console.error(`  ${mark} ${g.id} ${g.name}${why}`);
  }
  if (!report.overallPass) process.exit(1);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e: unknown) => {
    // A gate function throwing (G11 on an unmeasurable render, G10's
    // isLegal scan hitting bad data, etc.) means the environment/inputs are
    // broken, not that a gate failed — no qc.json is written, and this
    // process exits non-zero so the caller (jobs/render-qc.ts) sees "no
    // report produced" and fails the job with failedStage: "qc" (I4).
    console.error(`qc-render: CRASHED (not a QC verdict) — ${e instanceof Error ? e.stack : String(e)}`);
    process.exit(1);
  });
}
