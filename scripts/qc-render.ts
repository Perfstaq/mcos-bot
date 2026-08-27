import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RenderPlanSchema, cutTimesMs, type RenderPlan } from "@mcos/render/plan";
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
export function gateG1b(plan: RenderPlan, detectedCutsMs: number[]): GateResult {
  const id = "G1b";
  const name = "Beat lock — render fidelity";
  const planCuts = cutTimesMs(plan);
  const windowMs = Math.floor(2000 / plan.fps); // ±2 frames

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
export function gateG2(plan: RenderPlan): GateResult {
  const cuts = cutTimesMs(plan);
  const minutes = plan.durationInFrames / plan.fps / 60;
  const perMin = minutes > 0 ? cuts.length / minutes : 0;
  return {
    id: "G2",
    name: "Cut density",
    hard: true,
    computable: true,
    pass: perMin >= 25 && perMin <= 40,
    measured: Math.round(perMin * 10) / 10,
    target: "25-40 cuts/minute",
  };
}

function shotDurationsSec(plan: RenderPlan): number[] {
  return plan.cuts.map((c) => (c.outputEndMs - c.outputStartMs) / 1000).filter((d) => d > 0);
}

export function gateG3(plan: RenderPlan): GateResult {
  const durations = shotDurationsSec(plan).sort((a, b) => a - b);
  const mid = Math.floor(durations.length / 2);
  const median = durations.length ? (durations.length % 2 ? durations[mid]! : (durations[mid - 1]! + durations[mid]!) / 2) : 0;
  return { id: "G3", name: "Shot length (median)", hard: true, computable: true, pass: median >= 1.0 && median <= 2.0, measured: Math.round(median * 100) / 100, target: "1.0-2.0s" };
}

export function gateG4(plan: RenderPlan): GateResult {
  const durations = shotDurationsSec(plan);
  const min = durations.length ? Math.min(...durations) : 0;
  return { id: "G4", name: "Min shot length", hard: true, computable: true, pass: min >= 0.6, measured: Math.round(min * 100) / 100, target: "≥0.6s" };
}

export function gateG5(plan: RenderPlan): GateResult {
  const max = plan.captions.length ? Math.max(...plan.captions.map((c) => c.words.length)) : 0;
  return { id: "G5", name: "Caption density", hard: true, computable: true, pass: max <= 3, measured: max, target: "≤3 words visible simultaneously" };
}

export function gateG6(plan: RenderPlan): GateResult {
  const distinct = new Set(plan.captions.map((c) => c.position)).size;
  return { id: "G6", name: "Caption position variance", hard: true, computable: true, pass: distinct >= 3, measured: distinct, target: "≥3 distinct positions" };
}

export function gateG8(plan: RenderPlan): GateResult {
  // The schema (CaptionChunkSchema: a single nullable emphasisWordIndex, not
  // a count) already makes >1 emphasis word per chunk unrepresentable — this
  // recomputes the true definition anyway rather than trusting the type,
  // the same "don't trust the call site" discipline append-only.ts uses.
  const violations = plan.captions.filter((c) => c.emphasisWordIndex !== null && c.emphasisWordIndex >= c.words.length).length;
  return { id: "G8", name: "Emphasis", hard: true, computable: true, pass: violations === 0, measured: { chunks: plan.captions.length, outOfRangeEmphasis: violations }, target: "≤1 emphasis word per chunk (schema-enforced) and it must index a real word" };
}

// --- G10: word integrity (needs the footage's own transcript) --------------
type SourceWord = { word: string; start: number; end: number };
type WordsFile = { segments: { words: SourceWord[] }[] };

function isStrictlyInsideAWord(tSec: number, words: SourceWord[]): boolean {
  return words.some((w) => tSec > w.start && tSec < w.end);
}

export function gateG10(plan: RenderPlan, wordsFile: WordsFile | null): GateResult {
  if (!wordsFile) {
    return { id: "G10", name: "Word integrity", hard: true, computable: false, pass: null, measured: null, target: "0 cuts landing mid-word", note: "no --words file given — pass --words <MediaAnalysis.words JSON> for the footage asset" };
  }
  const words = wordsFile.segments.flatMap((s) => s.words);
  let violations = 0;
  for (const cut of plan.cuts) {
    if (isStrictlyInsideAWord(cut.sourceInMs / 1000, words)) violations++;
    if (isStrictlyInsideAWord(cut.sourceOutMs / 1000, words)) violations++;
  }
  return { id: "G10", name: "Word integrity", hard: true, computable: true, pass: violations === 0, measured: { violations, cutsChecked: plan.cuts.length }, target: "0 cuts landing mid-word (source in/out points)" };
}

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
export function gateG7(plan: RenderPlan): GateResult {
  const id = "G7";
  const name = "Micro-motion";
  const target = "100% of shots have scale delta >1%";

  const withoutMotion = plan.cuts.filter((c) => !c.motion);
  if (withoutMotion.length === plan.cuts.length) {
    return {
      id,
      name,
      hard: true,
      computable: false,
      pass: null,
      measured: null,
      target,
      note: "no cut on this plan declares `motion` — a pre-template plan; scored for any plan the current builder produces",
    };
  }

  const failing = plan.cuts.filter(
    (c) => !c.motion || Math.abs(c.motion.toScale - c.motion.fromScale) <= MIN_VISIBLE_SCALE_DELTA,
  );
  const deltas = plan.cuts.map((c) => (c.motion ? Math.abs(c.motion.toScale - c.motion.fromScale) : 0));

  return {
    id,
    name,
    hard: true,
    computable: true,
    pass: failing.length === 0,
    measured: {
      shots: plan.cuts.length,
      staticShots: failing.length,
      minDelta: deltas.length ? Math.round(Math.min(...deltas) * 10000) / 10000 : null,
      maxDelta: deltas.length ? Math.round(Math.max(...deltas) * 10000) / 10000 : null,
      threshold: MIN_VISIBLE_SCALE_DELTA,
    },
    target,
  };
}

/**
 * G9, with §12.7's carve-out and §12.11's wrap bound both asserted.
 *
 * Three things this checks that a naive reading would not:
 *
 *  1. **Vertical extents, not anchors.** A block's top and bottom are its
 *     anchor ± half its height. §12.7 required this explicitly, because
 *     checking the anchor alone is exactly why a banner at y=0.09 shipped
 *     inside a margin it looked clear of.
 *  2. **The banner's measured line count** (§12.11 Minor A). Two lines double
 *     the block height and put ink at ~6.3%, through the 8% exemption. The
 *     line count is measured at plan build and carried on the plan, so this
 *     scores the same number the renderer laid out rather than assuming one.
 *  3. **Caption wrap.** Up to three words at emphasis size in a serif face
 *     can exceed the text box and wrap, which grows the block downward toward
 *     the 12% bottom bound. Same failure mode as the banner's, one layer down.
 *  4. **The face floor** (§12.19). Margins bound a block against the frame's
 *     EDGES; nothing bounded it against the subject. A tall karaoke block
 *     grows upward as well as downward, and a three-line chunk at `center`
 *     puts its top at 0.711 — above the chin at 0.717 — while clearing every
 *     margin, so it passed this gate silently with text across a face. Scored
 *     here rather than as a new gate id because `07 §1` fixes the gate list at
 *     G1–G14 and this is the same question G9 already answers for the other
 *     three edges: is the text allowed to be where it is.
 */
export function gateG9(plan: RenderPlan): GateResult {
  const id = "G9";
  const name = "Safe margins";
  const target =
    "0 text blocks within 12% of the left/right/bottom edge; banner top exempt to 8% (ARCHITECTURE §12.7); " +
    `0 karaoke blocks whose top is above the face floor at ${FACE_FLOOR_RATIO} (ARCHITECTURE §12.19)`;

  const style = plan.templateStyle;
  const sizes = style
    ? style.sizes
    : {
        banner: TYPE_SCALE.banner * plan.width,
        karaoke: TYPE_SCALE.karaoke * plan.width,
        emphasis: TYPE_SCALE.emphasis * plan.width,
        handle: TYPE_SCALE.handle * plan.width,
      };
  const tokens = style?.fontTokens ?? {
    banner: "display_condensed" as const,
    karaoke: "display_serif" as const,
    handle: "body_sans" as const,
  };
  const tracking = style?.tracking ?? { banner: 0.01, karaoke: 0, handle: 0.08 };

  const violations: { layer: string; detail: string; problems: string[] }[] = [];

  // Layer 1 — banner.
  if (plan.banner) {
    const anchor = plan.banner.anchor ?? BANNER_ANCHOR;
    const lines = style?.bannerLines ?? 1;
    const problems = g9Violations("banner", anchor, sizes.banner, lines, plan.width, plan.height);
    if (problems.length) {
      violations.push({ layer: "banner", detail: `"${plan.banner.text}" (${lines} line(s))`, problems });
    }
  }

  // Layer 2 — karaoke chunks, measured PER WORD.
  //
  // Only the emphasis word draws at `sizes.emphasis`; its neighbours draw at
  // `sizes.karaoke` (02 §7). Measuring the whole chunk at the larger size
  // over-estimates both width and height by up to 35% and fails chunks that
  // fit — which it did, on "To remember that" @ lower_left, before this was
  // measured properly. The layout is a flex row with `gap: width * 0.02`, so
  // the separator is that gap and not a space glyph.
  for (const chunk of plan.captions) {
    const anchor = chunk.anchor;
    if (!anchor) continue; // pre-geometry plan; nothing to score for this chunk
    const { left, right } = textBoxBounds(anchor, plan.width);
    const measured = chunk.words.map((w, i) => ({
      text: w.word,
      fontSizePx: w.isEmphasis === true || chunk.emphasisWordIndex === i ? sizes.emphasis : sizes.karaoke,
    }));
    const lines = wrapWords(measured, tokens.karaoke, right - left, {
      wordGapPx: plan.width * 0.02,
      trackingEm: tracking.karaoke,
    });
    const height = blockHeightPx(lines, LINE_HEIGHT);
    const problems = [
      ...g9ViolationsForBlock("karaoke", anchor, height, plan.width, plan.height),
      // The block's TOP against the subject, not against the frame (§12.19).
      // Measured on the same wrapped height as the margins are, so a chunk
      // cannot be judged safe by one bound and unsafe by the other because
      // they disagreed about how tall it is.
      ...faceFloorViolationsForBlock(anchor, height, plan.height),
    ];
    if (problems.length) {
      violations.push({
        layer: "karaoke",
        detail: `"${chunk.words.map((w) => w.word).join(" ")}" @ ${chunk.position} (${lines.length} line(s), ${Math.round(height)}px)`,
        problems,
      });
    }
  }

  // Layer 3 — the handle, in each corner it visits.
  if (plan.handle) {
    for (const corner of new Set(plan.handle.cornerByShot)) {
      const anchor = handleAnchor(corner);
      const problems = g9Violations("handle", anchor, sizes.handle, 1, plan.width, plan.height);
      if (problems.length) {
        violations.push({ layer: "handle", detail: `${plan.handle.text} @ ${corner}`, problems });
      }
    }
  }

  return {
    id,
    name,
    hard: true,
    computable: true,
    pass: violations.length === 0,
    measured: {
      violations: violations.length,
      bannerTopExemptionRatio: BANNER_TOP_MARGIN_RATIO,
      faceFloorRatio: FACE_FLOOR_RATIO,
      bannerLines: style?.bannerLines ?? null,
      // Capped: a broken template can produce one violation per chunk, and a
      // qc.json nobody can read is a qc.json nobody reads.
      examples: violations.slice(0, 5),
    },
    target,
  };
}

export type QcReport = {
  analyzerVersion: string;
  mp4: string;
  gates: GateResult[];
  overallPass: boolean;
  fingerprintAcceptanceFloor: number;
};

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

  // Overall pass: every HARD gate that IS computable must pass. A gate that
  // isn't computable yet doesn't block a merge on its own (07 §4's "the M1
  // suite must stay green" is about a DIFFERENT suite; this milestone's own
  // gates fail loudly by being reported `pass: null`, never silently true).
  const overallPass = gates.filter((g) => g.hard && g.computable).every((g) => g.pass === true);

  return {
    analyzerVersion: "qc-render@0.1.0",
    mp4: opts.mp4Path,
    gates,
    overallPass,
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

  console.error(`\nqc-render: ${report.overallPass ? "PASS" : "FAIL"} (${report.gates.filter((g) => g.hard && g.computable).length} hard gates scored)`);
  for (const g of report.gates) {
    const mark = g.pass === null ? "·" : g.pass ? "✓" : "✗";
    console.error(`  ${mark} ${g.id} ${g.name}`);
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
