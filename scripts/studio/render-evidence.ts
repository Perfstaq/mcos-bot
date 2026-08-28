import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RenderPlanSchema, type RenderPlan } from "@mcos/render/plan";
import { TEMPLATE_IDS, getTemplate } from "@mcos/render/templates";
import { buildTemplatePlan } from "./build-template-plan.js";

/**
 * render-evidence.ts — ARCHITECTURE §12.10, "Render evidence lives in-repo
 * with a manifest".
 *
 * The ruling exists because render artifacts living in
 * `/Users/sathvik/aix/studio-renders/` produced the same failure twice in one
 * day: frames written three minutes before a fix were forwarded as evidence
 * of the fixed behaviour, and a demo MP4 went stale against its commit while
 * still sitting there looking authoritative. **Evidence that cannot be
 * checked against the code it claims to demonstrate is worse than no
 * evidence, because it is trusted.**
 *
 * So this writes, per template, under `docs/studio/evidence/<template>/`:
 *   - `plan.json`  — the RenderPlan that was rendered
 *   - `qc.json`    — every gate, scored on the real MP4
 *   - 2–3 PNG frames, EXTRACTED FROM THAT MP4 (not re-rendered separately,
 *     so a frame is literally a frame of the file whose hash is recorded)
 * and one `manifest.json` recording each MP4's sha256, the commit it was
 * rendered from, whether the tree was dirty, and the hash of every committed
 * artifact.
 *
 * The MP4s stay out of git (~22MB each) — `.gitignore` covers them.
 *
 * ── Staleness is the point ──────────────────────────────────────────────────
 * `--check` re-hashes every committed artifact against the manifest and asks
 * git whether anything that can change a render has been touched since the
 * recorded commit. A reviewer then learns "these pictures predate the code in
 * front of you" from a command instead of from a bug report. Note what it
 * does NOT do: fail merely because HEAD moved. A commit to an unrelated file
 * does not invalidate a frame, and a staleness check that cries wolf gets
 * ignored, which is the failure it exists to prevent.
 *
 * Usage:
 *   npx tsx scripts/studio/render-evidence.ts --footage <clean.mp4> [--template <id>] [--keep-mp4]
 *     [--words <words.json>] [--beats <beats.json>] [--duration <sec>]
 *     [--asset-id <id>] [--r2-key <key>] [--hook <text>] [--emphasis <word>|none]
 *   npx tsx scripts/studio/render-evidence.ts --check
 *
 * `--words`/`--beats` are the analysis the PLAN is built from and must describe
 * the same recording as `--footage`. They default to the committed reference
 * inputs, so an invocation that passes neither reproduces the prior evidence.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const evidenceDir = path.join(repoRoot, "docs/studio/evidence");
const inputsDir = path.join(evidenceDir, "inputs");
const manifestPath = path.join(evidenceDir, "manifest.json");
const renderPkg = path.join(repoRoot, "packages/render");
const stagingDir = path.join(renderPkg, "public");
const renderPlanScript = path.join(renderPkg, "scripts", "render-plan.mjs");

/**
 * Paths whose contents can change what a render looks like. `--check` asks
 * git whether any of them moved since the manifest's commit. Deliberately
 * broader than "the composition": a planner change moves every cut, a font
 * change moves every wrap, and the QC script decides what the numbers mean.
 */
const RENDER_AFFECTING = [
  "packages/render/src",
  "packages/render/assets",
  "packages/render/remotion.config.ts",
  "scripts/studio/build-template-plan.ts",
  "scripts/studio/render-evidence.ts",
  "scripts/qc-render.ts",
  "docs/studio/evidence/inputs",
];

const REFERENCE_DURATION_SEC = 54.87;

/**
 * The analysis a plan is built from.
 *
 * Until W4.1 these were hardcoded to `inputs/reference-*.json`, so `--footage`
 * swapped only the PIXELS: the plan's cuts, caption chunks and word-edge
 * legality all still came from the reference reel's speech. Rendered against
 * any other clip that produces captions of one recording laid over the audio
 * of another — desynced by construction, and G10 (word integrity) scored
 * against words that are not in the file being measured.
 *
 * That was invisible while the only footage anyone rendered WAS the reference
 * proxy, which is the same "latent while its inputs happen to agree" shape
 * ARCHITECTURE §12.34 records. The fixture of §12.18 is exactly the input that
 * makes them disagree.
 *
 * Additive and defaulted (the §12.30 R8 posture): omitting all three
 * reproduces the committed evidence byte-for-byte.
 */
type PlanInputs = {
  wordsPath: string;
  beatsPath: string;
  durationSec: number;
  assetId: string;
  r2Key: string;
  /**
   * Render a plan the PIPELINE built, instead of rebuilding one here.
   *
   * `jobs/plan-build.ts` materializes plans with `buildApprovedRenderPlan`
   * (G1a-gated, claim-text-aware, container-duration); this script's
   * `buildTemplatePlan` is a second builder with a different input contract.
   * Rendering the second one and calling the frames evidence for the first is
   * the §12.10 failure — artifacts that cannot be checked against the code
   * they claim to demonstrate. Given `--plan`, the harness renders exactly the
   * row the chain committed and asserts it is the right template.
   */
  presetPlanPath: string | null;
};

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--")) return process.argv[i + 1]!;
  if (fallback !== undefined) return fallback;
  throw new Error(`missing required --${name}`);
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

type FrameSpec = { frame: number; timeMs: number; why: string };

/** 02 §4.2's punch attack, mirrored here so frame choice lands on the peak. */
const SPRING_PUNCH_ATTACK_FRAMES = 8;

/**
 * Which frames to keep, chosen FROM THE PLAN rather than at fixed timestamps.
 *
 * A fixed "grab 2s, 10s, 20s" produces frames that happen to show whatever
 * was on screen, and the three templates cut differently, so the same
 * timestamps would show different features in each — which makes them useless
 * for comparison. These pick the moments that carry the things a reviewer
 * needs to judge: the hook established, an emphasis word at its punch, and a
 * late shot in a different caption position with the handle in its other
 * corner.
 */
function chooseFrames(plan: RenderPlan): FrameSpec[] {
  const fps = plan.fps;
  const specs: FrameSpec[] = [];

  // (1) The banner settled (its pop spring runs 12 frames) over the first
  // caption chunk that has words on screen.
  const firstChunk = plan.captions.find((c) => (c.startMs ?? 0) > 400);
  if (firstChunk) {
    const t = (firstChunk.startMs ?? 0) + Math.min(300, ((firstChunk.endMs ?? 0) - (firstChunk.startMs ?? 0)) / 2);
    specs.push({
      frame: Math.round((t / 1000) * fps),
      timeMs: Math.round(t),
      why: "banner settled + first karaoke chunk — the scroll-stopper as a viewer first sees it",
    });
  }

  // (2) An emphasis word at the peak of its punch (02 §4.2: +6% over 8
  // frames). This is the frame that shows accent colour meaning EMPHASIS and
  // nothing else (§12.9), and the emphasis type size (0.101·W).
  const emph = plan.captions.find((c) => {
    if (c.emphasisWordIndex === null) return false;
    const w = c.words[c.emphasisWordIndex];
    return Boolean(w) && (w!.startMs ?? 0) > 3000;
  });
  if (emph && emph.emphasisWordIndex !== null) {
    const w = emph.words[emph.emphasisWordIndex]!;
    // Clamped inside the CHUNK's sequence, not just past the word's onset:
    // the punch peak is 8 frames (~267ms) after onset, and a short emphasis
    // word near the end of its chunk would put that peak past the sequence,
    // rendering an empty frame. Same failure as the `late` chunk below.
    const chunkEnd = emph.endMs ?? w.endMs;
    const t = Math.min(w.startMs + (SPRING_PUNCH_ATTACK_FRAMES / fps) * 1000, chunkEnd - 20);
    specs.push({
      frame: Math.round((t / 1000) * fps),
      timeMs: Math.round(t),
      why: `emphasis word "${w.word}" at its punch peak — accent means emphasis only (§12.9)`,
    });
  }

  // (3) A late shot whose caption sits in a different position and whose
  // handle is in the other corner — proves rotation actually rotates (G6,
  // 02 §2.3) rather than being asserted in a test and static on screen.
  const firstPosition = firstChunk?.position;
  const late = [...plan.captions].reverse().find((c) => {
    const start = c.startMs ?? 0;
    const end = c.endMs ?? 0;
    return (
      start > ((plan.durationInFrames / fps) / 2) * 1000 &&
      start < ((plan.durationInFrames / fps) - 2) * 1000 &&
      // Must actually demonstrate rotation, so: a different position from
      // frame 1's, and long enough to be worth sampling.
      c.position !== firstPosition &&
      end - start >= 250 &&
      c.words.length >= 2
    );
  });
  if (late) {
    // Sample the MIDPOINT, never `start + 200ms`.
    //
    // This is the bug that produced a frame with no caption on it at all,
    // labelled "caption rotation": chunks are as short as 160ms (the chunker
    // breaks on punctuation, and "them." is one word), so a fixed +200ms
    // offset lands PAST the end of the Sequence and renders nothing. A frame
    // whose caption says one thing and whose pixels say another is precisely
    // the mislabelled evidence §12.10 exists to prevent — and it got into the
    // first manifest I generated.
    const start = late.startMs ?? 0;
    const end = late.endMs ?? start;
    const t = start + (end - start) / 2;
    specs.push({
      frame: Math.round((t / 1000) * fps),
      timeMs: Math.round(t),
      why: `late chunk "${late.words.map((w) => w.word).join(" ")}" at position "${late.position}" — caption rotation and the alternating handle corner`,
    });
  }

  // Clamp into range and dedupe frames that collide.
  const maxFrame = plan.durationInFrames - 1;
  const seen = new Set<number>();
  return specs
    .map((s) => ({ ...s, frame: Math.max(0, Math.min(maxFrame, s.frame)) }))
    .filter((s) => (seen.has(s.frame) ? false : (seen.add(s.frame), true)));
}

function harnessVersions(): Record<string, string> {
  const python = process.env.ANALYZER_PYTHON ?? path.join(repoRoot, "services/analyzer/.venv/bin/python");
  const out: Record<string, string> = { node: process.version, analyzerPython: python };
  try {
    out.pythonPackages = execFileSync(
      python,
      ["-c", "import librosa,scenedetect,numpy;print(f'librosa={librosa.__version__} scenedetect={scenedetect.__version__} numpy={numpy.__version__}')"],
      { encoding: "utf8" },
    ).trim();
  } catch {
    out.pythonPackages = "unavailable";
  }
  try {
    out.renderer = execFileSync("node", [renderPlanScript, "--print-version"], { encoding: "utf8" }).trim();
  } catch {
    out.renderer = "unknown";
  }
  return out;
}

function renderTemplate(
  templateId: string,
  footagePath: string,
  keepMp4: boolean,
  reuseMp4: boolean,
  inputs: PlanInputs,
  hook: string,
  emphasisWord: string | null,
  contentBriefId: string | null,
): Record<string, unknown> {
  const template = getTemplate(templateId);
  const outDir = path.join(evidenceDir, templateId);
  mkdirSync(outDir, { recursive: true });

  // --- plan -----------------------------------------------------------------
  const wordsJson = JSON.parse(readFileSync(inputs.wordsPath, "utf8"));
  const beats = JSON.parse(readFileSync(inputs.beatsPath, "utf8"));
  const plan = inputs.presetPlanPath
    ? (() => {
        const loaded = RenderPlanSchema.parse(JSON.parse(readFileSync(inputs.presetPlanPath!, "utf8")));
        // `templateStyle` is optional in the schema (it post-dates the first
        // plans). Without it a plan carries no template identity, so filing it
        // under one is a guess — refuse rather than assume.
        const loadedId = loaded.templateStyle?.templateId;
        if (loadedId !== templateId) {
          throw new Error(
            `--plan is for template "${loadedId ?? "<none: plan has no templateStyle>"}" but this run is ` +
              `rendering "${templateId}" — that would file one template's render under another's evidence`,
          );
        }
        return loaded;
      })()
    : buildTemplatePlan({
    templateId,
    words: wordsJson.segments.flatMap((s: { words: unknown[] }) => s.words) as never,
    durationSec: inputs.durationSec,
    beats,
    seed: 42,
    hook,
    emphasisWord,
    handleText: "@PERFSTAQ",
    footage: { assetId: inputs.assetId, r2Key: inputs.r2Key },
  });
  const planPath = path.join(outDir, "plan.json");
  const planJson = JSON.stringify(plan, null, 2);
  // Captured BEFORE the overwrite — the reuse guard below compares the plan
  // the existing MP4 was rendered from against the one just built. Reading it
  // after writing would compare the plan to itself and always say "reuse",
  // which is the guard failing open: exactly the silent-staleness bug this
  // whole harness exists to make impossible.
  const previousPlanJson = existsSync(planPath) ? readFileSync(planPath, "utf8") : null;
  writeFileSync(planPath, planJson);

  // --- render ---------------------------------------------------------------
  // Footage is staged into the render package's `public/` so `staticFile()`
  // resolves it — the gitignored scratch dir the .gitignore comment describes.
  mkdirSync(stagingDir, { recursive: true });
  const stagedName = path.basename(footagePath);
  const staged = path.join(stagingDir, stagedName);
  if (!existsSync(staged) || statSync(staged).size !== statSync(footagePath).size) {
    copyFileSync(footagePath, staged);
  }

  const propsPath = path.join(outDir, ".props.json");
  writeFileSync(propsPath, JSON.stringify({ plan, footageSrc: stagedName }));

  const mp4Path = path.join(outDir, `${templateId}.mp4`);

  // `--reuse-mp4` exists for one situation: the render succeeded and a step
  // AFTER it failed (frame extraction, QC), so re-rendering three minutes of
  // video would only reproduce a file we already have.
  //
  // It is guarded, because an unguarded reuse is precisely the failure §12.10
  // was written about — an MP4 that no longer matches the plan beside it,
  // still looking authoritative. Reuse is allowed only when the plan on disk
  // is byte-identical to the plan just built. Any difference and it re-renders.
  const canReuse = reuseMp4 && existsSync(mp4Path) && previousPlanJson === planJson;

  if (canReuse) {
    console.log(`[${templateId}] reusing existing MP4 — plan is byte-identical to the one just built`);
  } else {
    if (reuseMp4 && existsSync(mp4Path)) {
      console.log(`[${templateId}] plan changed since that MP4 was rendered — re-rendering rather than reusing`);
    }
    console.log(`[${templateId}] rendering ${plan.durationInFrames} frames…`);
    // Delegated to packages/render (ADR-5): how to drive the renderer is
    // renderer-specific knowledge and belongs behind the containment
    // boundary, so a swap touches one directory rather than this script too.
    execFileSync("node", [renderPlanScript, "--props", propsPath, "--out", mp4Path], {
      cwd: repoRoot,
      stdio: "inherit",
    });
  }
  rmSync(propsPath, { force: true });

  const mp4Sha = sha256(mp4Path);
  const mp4Bytes = statSync(mp4Path).size;

  // --- frames (extracted FROM the rendered MP4) -----------------------------
  const frameSpecs = chooseFrames(plan);
  const frames = frameSpecs.map((spec, i) => {
    const name = `frame${i + 1}.png`;
    const framePath = path.join(outDir, name);
    // No `-vsync 0`: ffmpeg 9 removed the option outright ("Unrecognized
    // option 'vsync'"), and `select` + `-frames:v 1` is already exact without
    // it — the filter emits one frame, so there is no rate to reconcile.
    execFileSync(
      "ffmpeg",
      ["-y", "-loglevel", "error", "-i", mp4Path, "-vf", `select=eq(n\\,${spec.frame})`, "-frames:v", "1", framePath],
      { stdio: "pipe" },
    );
    return { file: name, sha256: sha256(framePath), bytes: statSync(framePath).size, ...spec };
  });

  // --- qc -------------------------------------------------------------------
  const qcPath = path.join(outDir, "qc.json");
  rmSync(qcPath, { force: true });
  console.log(`[${templateId}] scoring gates…`);

  // qc-render.ts exits 1 when a hard gate FAILS — that is a verdict, not a
  // crash, and recording it is the entire point of evidence. G1b currently
  // fails by construction (§12.3/§12.13: real jump cuts need footage removal
  // plus a bed-derived grid, neither of which exists), so treating a non-zero
  // exit as fatal would make it impossible to produce evidence at all.
  //
  // The distinction that matters is the one qc-render.ts documents itself: a
  // gate FAILING still writes qc.json; a gate function THROWING (broken
  // ffmpeg, unreadable MP4) writes nothing. So the presence of qc.json is the
  // signal, not the exit code.
  const qcRun = spawnSync(
    "npx",
    [
      "tsx",
      path.join(repoRoot, "scripts/qc-render.ts"),
      "--mp4", mp4Path,
      "--plan", planPath,
      // The SAME words the plan was built from. Scoring G10 against a
      // different recording's words measures nothing about this render.
      "--words", inputs.wordsPath,
      // Without this G14 is `computable: false` — a REAL contract gap in the
      // §12.37 sense, not an exclusion. The DoD chain has an approved
      // ContentBrief behind every plan, so the id exists and provenance can
      // be scored rather than skipped.
      ...(contentBriefId ? ["--content-brief-id", contentBriefId] : []),
      "--out", qcPath,
    ],
    { cwd: repoRoot, stdio: "inherit" },
  );
  if (!existsSync(qcPath)) {
    throw new Error(
      `[${templateId}] qc-render produced no qc.json (exit ${qcRun.status}) — that is a crashed QC run, ` +
        "not a failing gate, so no evidence is written for this template",
    );
  }
  const qc = JSON.parse(readFileSync(qcPath, "utf8"));

  // --- disk discipline ------------------------------------------------------
  // The MP4's hash is recorded; the file itself is ~22MB and is not committed.
  // Deleting it immediately is what keeps three renders inside the disk budget.
  if (!keepMp4) {
    rmSync(mp4Path, { force: true });
    console.log(`[${templateId}] removed ${(mp4Bytes / 1e6).toFixed(1)}MB MP4 (sha recorded)`);
  }

  return {
    templateVersion: template.version,
    mp4: { sha256: mp4Sha, bytes: mp4Bytes, retained: keepMp4, file: keepMp4 ? `${templateId}.mp4` : null },
    plan: { file: "plan.json", sha256: sha256(planPath) },
    qc: { file: "qc.json", sha256: sha256(qcPath) },
    frames,
    overallPass: qc.overallPass,
    gates: Object.fromEntries(
      (qc.gates as { id: string; pass: boolean | null; measured: unknown }[]).map((g) => [
        g.id,
        { pass: g.pass, measured: g.measured },
      ]),
    ),
  };
}

/**
 * ARCHITECTURE §12.23, closed — check the analyzer venv BEFORE rendering.
 *
 * The note has been open since T's evidence round: "`qc-render` needs
 * `ANALYZER_PYTHON` pointing at the analyzer venv, which only [st-p] has. The
 * first run rendered a full MP4 and threw the work away at the QC step. The
 * harness correctly refused to write evidence for a crashed QC, but a
 * per-worktree venv or a checked prerequisite would save a render's worth of
 * disk. Worth fixing before the next agent renders."
 *
 * It was not fixed, and it cost exactly one more render — three minutes of
 * encode and 70MB — to rediscover. A precondition that is knowable in
 * milliseconds should never be discovered after the expensive part: this is
 * the same "fail on the cheap side" reasoning `resolveTemplateStyle` already
 * applies to the banner wrap ("an unrenderable hook should cost a
 * millisecond, not a DP sweep").
 */
function assertAnalyzerAvailable(): void {
  const python =
    process.env.ANALYZER_PYTHON ?? path.join(repoRoot, "services/analyzer/.venv/bin/python");
  if (!existsSync(python)) {
    throw new Error(
      `analyzer venv not found at ${python} (ANALYZER_PYTHON ${process.env.ANALYZER_PYTHON ? "points there" : "is unset"}).\n` +
        "  qc-render needs it for PySceneDetect, so a render would complete and then be discarded.\n" +
        "  Either: ANALYZER_PYTHON=/path/to/analyzer/.venv/bin/python npx tsx scripts/studio/render-evidence.ts …\n" +
        "  or:     cd services/analyzer && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt",
    );
  }
  // Present but unusable is the same lost render, so prove it can import what
  // the QC step will actually ask of it.
  const probe = spawnSync(python, ["-c", "import scenedetect, librosa, numpy"], { stdio: "pipe" });
  if (probe.status !== 0) {
    throw new Error(
      `analyzer venv at ${python} cannot import scenedetect/librosa/numpy — qc-render would crash after the render.\n` +
        `  ${String(probe.stderr).trim().split("\n").slice(-1)[0] ?? ""}`,
    );
  }
}

function runRender(): void {
  const footage = path.resolve(arg("footage"));
  if (!existsSync(footage)) throw new Error(`footage not found: ${footage}`);
  // Before anything expensive.
  assertAnalyzerAvailable();
  const keepMp4 = flag("keep-mp4");
  const reuseMp4 = flag("reuse-mp4");
  const only = process.argv.includes("--template") ? arg("template") : null;
  const targets = only ? [only] : [...TEMPLATE_IDS];

  const wordsPath = path.resolve(arg("words", path.join(inputsDir, "reference-words.json")));
  const beatsPath = path.resolve(arg("beats", path.join(inputsDir, "reference-beats.json")));
  if (!existsSync(wordsPath)) throw new Error(`words not found: ${wordsPath}`);
  if (!existsSync(beatsPath)) throw new Error(`beats not found: ${beatsPath}`);

  // Duration defaults to REFERENCE_DURATION_SEC only when the reference words
  // are in use. For any other analysis, defaulting to a constant measured off
  // a different recording is the same class of error §12.33 flags in
  // `plan-builder.ts:248` — so it comes from the analysis itself, and the
  // planner is told how long the clip it is cutting actually is.
  const usingReferenceWords = wordsPath === path.join(inputsDir, "reference-words.json");
  const wordsDoc = JSON.parse(readFileSync(wordsPath, "utf8")) as { durationSec?: number };
  const durationSec = process.argv.includes("--duration")
    ? Number(arg("duration"))
    : usingReferenceWords
      ? REFERENCE_DURATION_SEC
      : (wordsDoc.durationSec ??
        (() => {
          throw new Error(`${wordsPath} has no durationSec — pass --duration explicitly`);
        })());
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error(`bad --duration ${durationSec}`);
  }

  const inputs: PlanInputs = {
    wordsPath,
    beatsPath,
    durationSec,
    assetId: arg("asset-id", "reference-proxy"),
    r2Key: arg("r2-key", "demo/reference-16x9-proxy.mp4"),
    presetPlanPath: process.argv.includes("--plan") ? path.resolve(arg("plan")) : null,
  };
  if (inputs.presetPlanPath && !existsSync(inputs.presetPlanPath)) {
    throw new Error(`plan not found: ${inputs.presetPlanPath}`);
  }
  // One plan file describes one template; rendering it into every template's
  // evidence directory would file the same artifact under three names.
  if (inputs.presetPlanPath && targets.length > 1) {
    throw new Error("--plan renders one template — pass --template <id> alongside it");
  }
  const contentBriefId = process.argv.includes("--content-brief-id") ? arg("content-brief-id") : null;
  const hook = arg("hook", "THE POWER OF OBSESSION");
  const emphasisArg = arg("emphasis", "OBSESSION");
  const emphasisWord = emphasisArg === "" || emphasisArg === "none" ? null : emphasisArg;

  const existing = existsSync(manifestPath)
    ? (JSON.parse(readFileSync(manifestPath, "utf8")) as { templates?: Record<string, unknown> })
    : {};

  const templates: Record<string, unknown> = { ...(existing.templates ?? {}) };
  for (const id of targets) {
    templates[id] = renderTemplate(id, footage, keepMp4, reuseMp4, inputs, hook, emphasisWord, contentBriefId);
  }

  const manifest = {
    description:
      "Render evidence for the three shipped templates (ARCHITECTURE §12.10). The MP4s are NOT committed; " +
      "their sha256 is recorded here alongside the commit they were rendered from, so a reviewer can tell " +
      "whether the committed plan/qc/frames describe the code in front of them. Regenerate with " +
      "`npx tsx scripts/studio/render-evidence.ts --footage <clean.mp4>`; check with `--check`.",
    generatedAt: new Date().toISOString(),
    renderedFromCommit: git(["rev-parse", "HEAD"]),
    renderedFromCommitSubject: git(["log", "-1", "--format=%s"]),
    // "Was the CODE that produced this render committed?" — scoped to
    // render-affecting paths, deliberately.
    //
    // Computed over the whole tree it was worse than useless: writing the
    // first template's evidence dirties the tree, so every template after it
    // flagged itself dirty for a reason that has nothing to do with whether
    // the code was committed. A flag that is always true after the first
    // render carries no information, which is the same "cries wolf" failure
    // the `--check` design avoids. Evidence files are this script's OUTPUT;
    // only its inputs can invalidate it.
    treeDirty: git(["status", "--porcelain", "--", ...RENDER_AFFECTING]).length > 0,
    renderAffectingPaths: RENDER_AFFECTING,
    harness: harnessVersions(),
    footage: { path: footage, sha256: sha256(footage), bytes: statSync(footage).size },
    // Records the analysis the plans were ACTUALLY built from. When these are
    // not the reference inputs the file lives outside the repo (§12.10 keeps
    // media out of git), so the path plus its sha256 is the whole provenance.
    inputs: {
      words: { file: path.relative(repoRoot, wordsPath), sha256: sha256(wordsPath) },
      beats: { file: path.relative(repoRoot, beatsPath), sha256: sha256(beatsPath) },
      durationSec,
      hook,
      emphasisWord,
      contentBriefId,
    },
    templates,
  };

  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`\nmanifest        ${manifestPath}`);
  if (manifest.treeDirty) {
    console.log(`WARNING         tree was DIRTY at render time — the recorded commit does not fully describe these artifacts`);
  }
  for (const [id, t] of Object.entries(templates)) {
    const rec = t as { overallPass: boolean };
    console.log(`  ${rec.overallPass ? "PASS" : "FAIL"}  ${id}`);
  }
}

/** Exit codes: 0 fresh, 1 stale/mismatched. Meant for a human and for CI. */
function runCheck(): number {
  if (!existsSync(manifestPath)) {
    console.error("no manifest at docs/studio/evidence/manifest.json — nothing to check");
    return 1;
  }
  const m = JSON.parse(readFileSync(manifestPath, "utf8"));
  let stale = false;

  console.log(`manifest commit  ${m.renderedFromCommit} (${m.renderedFromCommitSubject})`);
  console.log(`HEAD             ${git(["rev-parse", "HEAD"])}`);
  if (m.treeDirty) {
    console.log(`STALE            tree was dirty when these artifacts were rendered`);
    stale = true;
  }

  // 1. Do the committed artifacts still hash to what the manifest recorded?
  for (const [id, rec] of Object.entries(m.templates as Record<string, never>)) {
    const dir = path.join(evidenceDir, id);
    const t = rec as {
      plan: { file: string; sha256: string };
      qc: { file: string; sha256: string };
      frames: { file: string; sha256: string }[];
    };
    for (const artifact of [t.plan, t.qc, ...t.frames]) {
      const p = path.join(dir, artifact.file);
      if (!existsSync(p)) {
        console.log(`MISSING          ${id}/${artifact.file}`);
        stale = true;
        continue;
      }
      if (sha256(p) !== artifact.sha256) {
        console.log(`MODIFIED         ${id}/${artifact.file} — hash does not match the manifest`);
        stale = true;
      }
    }
  }

  // 2. Has anything that can change a render moved since that commit?
  try {
    const changed = git(["diff", "--name-only", `${m.renderedFromCommit}..HEAD`, "--", ...RENDER_AFFECTING])
      .split("\n")
      .filter(Boolean);
    const dirtyNow = git(["status", "--porcelain", "--", ...RENDER_AFFECTING]).split("\n").filter(Boolean);
    if (changed.length) {
      console.log(`STALE            ${changed.length} render-affecting file(s) changed since that commit:`);
      for (const f of changed.slice(0, 10)) console.log(`                   ${f}`);
      stale = true;
    }
    if (dirtyNow.length) {
      console.log(`STALE            ${dirtyNow.length} render-affecting file(s) uncommitted right now`);
      stale = true;
    }
  } catch {
    console.log(`WARN             could not diff against ${m.renderedFromCommit} (is it in this history?)`);
    stale = true;
  }

  console.log(stale ? "\nSTALE — re-run render-evidence before trusting these frames" : "\nFRESH — artifacts describe HEAD");
  return stale ? 1 : 0;
}

function main(): void {
  if (flag("check")) {
    process.exit(runCheck());
  }
  runRender();
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { chooseFrames, RENDER_AFFECTING };
