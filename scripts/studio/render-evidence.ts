import { execFileSync } from "node:child_process";
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
 *   npx tsx scripts/studio/render-evidence.ts --check
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const evidenceDir = path.join(repoRoot, "docs/studio/evidence");
const inputsDir = path.join(evidenceDir, "inputs");
const manifestPath = path.join(evidenceDir, "manifest.json");
const renderPkg = path.join(repoRoot, "packages/render");
const stagingDir = path.join(renderPkg, "public");

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
    const t = w.startMs + (SPRING_PUNCH_ATTACK_FRAMES / fps) * 1000;
    specs.push({
      frame: Math.round((t / 1000) * fps),
      timeMs: Math.round(t),
      why: `emphasis word "${w.word}" at its punch peak — accent means emphasis only (§12.9)`,
    });
  }

  // (3) A late shot whose caption sits in a different position and whose
  // handle is in the other corner — proves rotation actually rotates (G6,
  // 02 §2.3) rather than being asserted in a test and static on screen.
  const late = [...plan.captions].reverse().find((c) => {
    const start = c.startMs ?? 0;
    return start > plan.durationInFrames / fps / 2 * 1000 && start < ((plan.durationInFrames / fps) - 2) * 1000;
  });
  if (late) {
    const t = (late.startMs ?? 0) + 200;
    specs.push({
      frame: Math.round((t / 1000) * fps),
      timeMs: Math.round(t),
      why: `late chunk at position "${late.position}" — caption rotation and the alternating handle corner`,
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
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package-lock.json"), "utf8"));
    out.remotion = pkg.packages?.["node_modules/@remotion/renderer"]?.version ?? "unknown";
  } catch {
    out.remotion = "unknown";
  }
  return out;
}

function renderTemplate(templateId: string, footagePath: string, keepMp4: boolean): Record<string, unknown> {
  const template = getTemplate(templateId);
  const outDir = path.join(evidenceDir, templateId);
  mkdirSync(outDir, { recursive: true });

  // --- plan -----------------------------------------------------------------
  const wordsJson = JSON.parse(readFileSync(path.join(inputsDir, "reference-words.json"), "utf8"));
  const beats = JSON.parse(readFileSync(path.join(inputsDir, "reference-beats.json"), "utf8"));
  const plan = buildTemplatePlan({
    templateId,
    words: wordsJson.segments.flatMap((s: { words: unknown[] }) => s.words) as never,
    durationSec: REFERENCE_DURATION_SEC,
    beats,
    seed: 42,
    hook: "THE POWER OF OBSESSION",
    emphasisWord: "OBSESSION",
    handleText: "@PERFSTAQ",
    footage: { assetId: "reference-proxy", r2Key: "demo/reference-16x9-proxy.mp4" },
  });
  const planPath = path.join(outDir, "plan.json");
  writeFileSync(planPath, JSON.stringify(plan, null, 2));

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
  console.log(`[${templateId}] rendering ${plan.durationInFrames} frames…`);
  execFileSync(
    "npx",
    ["remotion", "render", "src/index.ts", "Reel", mp4Path, `--props=${propsPath}`, "--log=error"],
    { cwd: renderPkg, stdio: "inherit" },
  );
  rmSync(propsPath, { force: true });

  const mp4Sha = sha256(mp4Path);
  const mp4Bytes = statSync(mp4Path).size;

  // --- frames (extracted FROM the rendered MP4) -----------------------------
  const frameSpecs = chooseFrames(plan);
  const frames = frameSpecs.map((spec, i) => {
    const name = `frame${i + 1}.png`;
    const framePath = path.join(outDir, name);
    execFileSync(
      "ffmpeg",
      ["-y", "-loglevel", "error", "-i", mp4Path, "-vf", `select=eq(n\\,${spec.frame})`, "-vsync", "0", "-frames:v", "1", framePath],
      { stdio: "pipe" },
    );
    return { file: name, sha256: sha256(framePath), bytes: statSync(framePath).size, ...spec };
  });

  // --- qc -------------------------------------------------------------------
  const qcPath = path.join(outDir, "qc.json");
  console.log(`[${templateId}] scoring gates…`);
  execFileSync(
    "npx",
    [
      "tsx",
      path.join(repoRoot, "scripts/qc-render.ts"),
      "--mp4", mp4Path,
      "--plan", planPath,
      "--words", path.join(inputsDir, "reference-words.json"),
      "--out", qcPath,
    ],
    { cwd: repoRoot, stdio: "inherit" },
  );
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

function runRender(): void {
  const footage = path.resolve(arg("footage"));
  if (!existsSync(footage)) throw new Error(`footage not found: ${footage}`);
  const keepMp4 = flag("keep-mp4");
  const only = process.argv.includes("--template") ? arg("template") : null;
  const targets = only ? [only] : [...TEMPLATE_IDS];

  const existing = existsSync(manifestPath)
    ? (JSON.parse(readFileSync(manifestPath, "utf8")) as { templates?: Record<string, unknown> })
    : {};

  const templates: Record<string, unknown> = { ...(existing.templates ?? {}) };
  for (const id of targets) {
    templates[id] = renderTemplate(id, footage, keepMp4);
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
    // A dirty tree means the recorded commit does NOT fully describe what was
    // rendered. Recording it is the difference between evidence and a claim.
    treeDirty: git(["status", "--porcelain"]).length > 0,
    renderAffectingPaths: RENDER_AFFECTING,
    harness: harnessVersions(),
    footage: { path: footage, sha256: sha256(footage), bytes: statSync(footage).size },
    inputs: {
      words: { file: "inputs/reference-words.json", sha256: sha256(path.join(inputsDir, "reference-words.json")) },
      beats: { file: "inputs/reference-beats.json", sha256: sha256(path.join(inputsDir, "reference-beats.json")) },
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
