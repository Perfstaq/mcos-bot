import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MediaAnalysisStatus } from "@prisma/client";
import { prisma } from "../db.js";
import { env } from "../env.js";
import { logger } from "../logger.js";
import type { MediaAnalyzeJob } from "../queue.js";
import { downloadToFile } from "../integrations/studio-r2.js";
import { assertValidBeatGrid, assertValidWordsResult } from "../domain/studio/media-analysis-schema.js";
import { withTenantContext } from "./context.js";

const log = logger.child({ job: "media-analyze" });

const here = path.dirname(fileURLToPath(import.meta.url));
// apps/api/src/jobs -> repo root
const repoRoot = path.resolve(here, "../../../..");

/**
 * Resolve the sidecar's python + script path. Same discipline as
 * founder-journey's transcribe.ts checking `.venv` exists before shelling out
 * — a missing venv is a named startup-shaped error, not a cryptic ENOENT deep
 * in execFileSync.
 */
function analyzerPython(): string {
  if (env.ANALYZER_PYTHON) return env.ANALYZER_PYTHON;
  const devPath = path.join(repoRoot, "services/analyzer/.venv/bin/python");
  if (!existsSync(devPath)) {
    throw new Error(
      `analyzer venv not found at ${devPath} (and ANALYZER_PYTHON is unset).\n` +
        "  run: cd services/analyzer && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt",
    );
  }
  return devPath;
}

function analyzerScript(): string {
  return env.ANALYZER_SCRIPT ?? path.join(repoRoot, "services/analyzer/analyzer.py");
}

type AnalyzerVersions = { analyzerVersion: string; fasterWhisper: string; librosa: string; numpy: string };

function analyzerVersionString(v: AnalyzerVersions): string {
  return `${v.analyzerVersion}+faster-whisper${v.fasterWhisper}+librosa${v.librosa}`;
}

/**
 * The `media.analyze` job: pulls a `MediaAsset`'s footage from R2, runs the
 * Python sidecar's `words`+`beats` stages (03_RENDER_PIPELINE §1), and
 * writes the result into its `MediaAnalysis` row. Never leaves the row in
 * `running` on failure — see `failMediaAnalyze` — and never leaves a temp
 * file behind (07 §3 "analyze_failed(reason)" is always surfaced, never
 * silent, and never at the cost of a leaked local disk).
 */
export async function runMediaAnalyze(job: MediaAnalyzeJob): Promise<void> {
  await withTenantContext(job.tenantId, async () => {
    const asset = await prisma.mediaAsset.findUnique({ where: { id: job.assetId } });
    if (!asset) throw new Error(`Unknown media asset ${job.assetId}`);

    const workDir = mkdtempSync(path.join(tmpdir(), "media-analyze-"));
    try {
      const ext = path.extname(asset.r2Key) || ".mp4";
      const localInput = path.join(workDir, `input${ext}`);
      log.info({ assetId: asset.id, r2Key: asset.r2Key }, "downloading footage for analysis");
      await downloadToFile(asset.r2Key, localInput);

      const python = analyzerPython();
      const script = analyzerScript();

      const versions = JSON.parse(
        execFileSync(python, [script, "--print-versions"], { encoding: "utf8" }),
      ) as AnalyzerVersions;

      execFileSync(python, [script, "--input", localInput, "--out", workDir, "--stages", "words,beats"], {
        stdio: "pipe",
      });

      const words = assertValidWordsResult(
        JSON.parse(readFileSync(path.join(workDir, "words.json"), "utf8")),
        `${asset.id} words.json`,
      );
      const beats = assertValidBeatGrid(
        JSON.parse(readFileSync(path.join(workDir, "beats.json"), "utf8")),
        `${asset.id} beats.json`,
      );

      await prisma.mediaAnalysis.update({
        where: { id: job.mediaAnalysisId },
        data: {
          status: MediaAnalysisStatus.succeeded,
          words,
          beats,
          tempoBpm: beats.tempoBpm,
          beatMethod: beats.method,
          analyzerVersion: analyzerVersionString(versions),
          finishedAt: new Date(),
        },
      });

      const nWords = words.segments.reduce((n, s) => n + s.words.length, 0);
      log.info(
        { assetId: asset.id, tempoBpm: beats.tempoBpm, nBeats: beats.beatTimesMs.length, nWords },
        "media analyze succeeded",
      );
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
}

/** Mirrors jobs/extract.ts's `failExtraction`: only a permanent BullMQ
 *  failure calls this (see worker-media.ts), and it never throws itself —
 *  a failure to record a failure must not mask the original error. */
export async function failMediaAnalyze(job: MediaAnalyzeJob, error: Error): Promise<void> {
  await withTenantContext(job.tenantId, async () => {
    await prisma.mediaAnalysis
      .update({
        where: { id: job.mediaAnalysisId },
        data: { status: MediaAnalysisStatus.failed, error: error.message, finishedAt: new Date() },
      })
      .catch((e: unknown) => {
        log.error({ err: (e as Error).message }, "could not record media-analyze failure");
      });
  });
}
