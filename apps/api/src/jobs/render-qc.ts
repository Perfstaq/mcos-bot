import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RenderStatus } from "@prisma/client";
import { prisma } from "../db.js";
import { env } from "../env.js";
import { downloadToFile } from "../integrations/studio-r2.js";
import { logger } from "../logger.js";
import type { RenderQcJob } from "../queue.js";
import { withTenantContext } from "./context.js";

const log = logger.child({ job: "render-qc" });

const here = path.dirname(fileURLToPath(import.meta.url));
// apps/api/src/jobs -> repo root
const repoRoot = path.resolve(here, "../../../..");

// 03_RENDER_PIPELINE §3's render.qc timeout (queue.ts's table comment). Same
// reasoning as media-analyze.ts's MEDIA_ANALYZE_TIMEOUT_MS: an async spawn
// (not spawnSync) is what makes worker-media.ts's concurrency real — a sync
// call blocks the shared event loop long enough to starve a DIFFERENT job's
// BullMQ lock-renewal heartbeat past its own lockDuration, which is exactly
// how a wedged analyze job could cause a render.qc job to be reclaimed and
// double-processed.
const RENDER_QC_TIMEOUT_MS = 5 * 60 * 1000;

function qcRenderScript(): string {
  // Compiled by `npm run build:scripts` (tsc -p scripts/tsconfig.build.json)
  // — plain JS, run with `node` directly. Not tsx: tsx is an apps/api
  // devDependency that `npm prune --omit=dev` strips from the production
  // image (Dockerfile.media), so invoking a .ts file via tsx at runtime
  // would throw in production every time (this was C1).
  return env.QC_RENDER_SCRIPT ?? path.join(repoRoot, "scripts/dist/qc-render.js");
}

type SpawnResult = { status: number | null; stdout: string; stderr: string; timedOut: boolean };

/** Promisified `spawn`, not `spawnSync`: `runRenderQc` must not block the
 *  worker's event loop for up to `RENDER_QC_TIMEOUT_MS` while a QC run is in
 *  flight. Resolves (never rejects) on a normal exit REGARDLESS of exit
 *  code — qc-render.ts exits 1 to mean "the report says FAIL", which is a
 *  legitimate outcome, not a crash — but distinguishes a TIMEOUT (`timedOut:
 *  true`) as its own condition, which the caller treats as an infra failure
 *  (I4: an environmental failure must throw, never quietly look like "we
 *  couldn't measure, so this render passes"). */
function runQcScript(nodeBin: string, args: string[]): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(nodeBin, args, { timeout: RENDER_QC_TIMEOUT_MS, killSignal: "SIGKILL" });
    } catch (e) {
      reject(e as Error);
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      const timedOut = child.killed && signal === "SIGKILL";
      resolve({ status: code, stdout, stderr, timedOut });
    });
  });
}

/**
 * The `render.qc` job: shells to `scripts/qc-render.ts`'s compiled output
 * exactly the way `media-analyze.ts` shells to the Python sidecar — the
 * script is designed to be a standalone CLI (07_QUALITY_GATES §1: "Wire
 * into the render.qc queue and into CI"), so this job's whole
 * responsibility is fetching the inputs from R2/Postgres, invoking it, and
 * persisting the result.
 */
export async function runRenderQc(job: RenderQcJob): Promise<void> {
  await withTenantContext(job.tenantId, async () => {
    const render = await prisma.render.findUnique({
      where: { id: job.renderId },
      include: { plan: { include: { footage: { include: { analysis: true } } } } },
    });
    if (!render) throw new Error(`Unknown render ${job.renderId}`);
    if (!render.r2Key) throw new Error(`Render ${render.id} has no r2Key yet — render.submit hasn't finished`);

    const workDir = mkdtempSync(path.join(tmpdir(), "render-qc-"));
    try {
      const mp4Path = path.join(workDir, "rendered.mp4");
      log.info({ renderId: render.id, r2Key: render.r2Key }, "downloading render for QC");
      await downloadToFile(render.r2Key, mp4Path);

      const planPath = path.join(workDir, "plan.json");
      writeFileSync(planPath, JSON.stringify(render.plan.plan));

      const args = [
        qcRenderScript(),
        "--mp4",
        mp4Path,
        "--plan",
        planPath,
        "--content-brief-id",
        render.plan.contentBriefId,
      ];

      // I4: by the time a render reaches QC, `media.analyze` must already
      // have succeeded for its footage (plan.build couldn't have built a
      // plan otherwise) — a missing `words` analysis here is a data-
      // integrity problem in THIS pipeline, not a legitimate "we don't have
      // it" case the way an ad-hoc CLI invocation without --words is (that
      // stays G10 `computable: false` at the script level — see
      // qc-render.ts). So the JOB throws rather than silently omitting
      // --words and letting G10 quietly drop out of the pass/fail rollup.
      const words = render.plan.footage.analysis?.words;
      if (!words) {
        throw new Error(
          `Render ${render.id}: footage asset ${render.plan.footageAssetId} has no words analysis — ` +
            "media.analyze must have failed or not run; G10 cannot be scored without it",
        );
      }
      const wordsPath = path.join(workDir, "words.json");
      writeFileSync(wordsPath, JSON.stringify(words));
      args.push("--words", wordsPath);

      // G13: a paired comparison against the most recent prior succeeded
      // render of the SAME plan, if one exists — reproducibility is a
      // property of two renders, not of one (07 §1).
      const prior = await prisma.render.findFirst({
        where: { planId: render.planId, status: RenderStatus.succeeded, id: { not: render.id } },
        orderBy: { createdAt: "desc" },
      });
      if (prior?.checksum) args.push("--prev-checksum", prior.checksum);

      const qcOutPath = path.join(workDir, "qc.json");
      args.push("--out", qcOutPath);

      const result = await runQcScript(process.execPath, args);
      if (result.timedOut) {
        throw new Error(`qc-render.ts timed out after ${RENDER_QC_TIMEOUT_MS}ms — infra failure, not a QC verdict`);
      }
      if (!existsSync(qcOutPath)) {
        throw new Error(`qc-render.ts produced no report (exit ${result.status}): ${result.stderr.slice(0, 2000)}`);
      }

      const qc = JSON.parse(readFileSync(qcOutPath, "utf8")) as { overallPass: boolean; gates: unknown[] };
      const checksumGate = (qc.gates as Array<{ id: string; measured?: { checksum?: string } }>).find(
        (g) => g.id === "G13",
      );
      const checksum = checksumGate?.measured?.checksum;

      await prisma.render.update({
        where: { id: render.id },
        data: {
          status: qc.overallPass ? RenderStatus.succeeded : RenderStatus.failed,
          qc,
          qcPassed: qc.overallPass,
          checksum,
          finishedAt: new Date(),
          ...(qc.overallPass ? {} : { failedStage: "qc", error: "one or more hard QC gates failed — see qc.json" }),
        },
      });

      log.info({ renderId: render.id, overallPass: qc.overallPass }, "render qc finished");
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
}

/** Only a permanent BullMQ failure (the subprocess/DB layer itself broke,
 *  not "a gate failed") calls this — see worker-media.ts. */
export async function failRenderQc(job: RenderQcJob, error: Error): Promise<void> {
  await withTenantContext(job.tenantId, async () => {
    await prisma.render
      .update({
        where: { id: job.renderId },
        data: { status: RenderStatus.failed, failedStage: "qc", error: error.message, finishedAt: new Date() },
      })
      .catch((e: unknown) => {
        log.error({ err: (e as Error).message }, "could not record render-qc failure");
      });
  });
}
