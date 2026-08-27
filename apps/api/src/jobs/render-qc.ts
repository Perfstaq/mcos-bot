import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RenderStatus } from "@prisma/client";
import { prisma } from "../db.js";
import { downloadToFile } from "../integrations/studio-r2.js";
import { logger } from "../logger.js";
import type { RenderQcJob } from "../queue.js";
import { withTenantContext } from "./context.js";

const log = logger.child({ job: "render-qc" });

const here = path.dirname(fileURLToPath(import.meta.url));
// apps/api/src/jobs -> repo root
const repoRoot = path.resolve(here, "../../../..");

function tsxBin(): string {
  return path.join(repoRoot, "node_modules/.bin/tsx");
}
function qcRenderScript(): string {
  return path.join(repoRoot, "scripts/qc-render.ts");
}

/**
 * The `render.qc` job: shells to `scripts/qc-render.ts` exactly the way
 * `media-analyze.ts` shells to the Python sidecar — the script is designed
 * to be a standalone CLI (07_QUALITY_GATES §1: "Wire into the render.qc
 * queue and into CI"), so this job's whole responsibility is fetching the
 * inputs from R2/Postgres, invoking it, and persisting the result.
 *
 * qc-render.ts exits 1 when its report says FAIL — that is an expected
 * OUTCOME (a render that fails a gate), not a crashed subprocess, so this
 * uses `spawnSync` (which never throws on a non-zero exit) rather than
 * `execFileSync`, and reads the `--out` file regardless of exit code.
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

      const words = render.plan.footage.analysis?.words;
      if (words) {
        const wordsPath = path.join(workDir, "words.json");
        writeFileSync(wordsPath, JSON.stringify(words));
        args.push("--words", wordsPath);
      }

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

      const result = spawnSync(tsxBin(), args, { encoding: "utf8" });
      if (!existsSync(qcOutPath)) {
        throw new Error(
          `qc-render.ts produced no report (exit ${result.status}): ${(result.stderr || result.error?.message || "").slice(0, 2000)}`,
        );
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
