import { Worker } from "bullmq";
import { QUEUE, closeQueues, connection, type MediaAnalyzeJob, type RenderQcJob } from "./queue.js";
import { failMediaAnalyze, runMediaAnalyze } from "./jobs/media-analyze.js";
import { failRenderQc, runRenderQc } from "./jobs/render-qc.js";
import { disconnect } from "./db.js";
import { logger } from "./logger.js";

const log = logger.child({ service: "worker-media" });

/**
 * The media-sidecar half of the deployable (ARCHITECTURE.md §5/ADR-3):
 * `Dockerfile.media`, a SEPARATE image/service from `worker.ts`, consuming
 * ONLY `media.analyze` and `render.qc` — the two queues needing
 * ffmpeg/faster-whisper/librosa. `plan.build` (pure TS) and `render.submit`
 * (Remotion Lambda API calls) stay on the existing lean worker; registering
 * them here would put ML dependencies on their deploy path for no reason.
 *
 * Concurrency 2 for `media.analyze` (03 §3: faster-whisper on CPU is the
 * expensive one here) and a generous `lockDuration` standing in for the
 * spec's 15-minute timeout — see queue.ts's table comment for why BullMQ has
 * no first-class per-job timeout.
 */
const workers = [
  new Worker<MediaAnalyzeJob>(QUEUE.mediaAnalyze, (job) => runMediaAnalyze(job.data), {
    connection,
    concurrency: 2,
    lockDuration: 15 * 60 * 1000,
  }),
  new Worker<RenderQcJob>(QUEUE.renderQc, (job) => runRenderQc(job.data), {
    connection,
    concurrency: 4,
    lockDuration: 5 * 60 * 1000,
  }),
];

for (const worker of workers) {
  worker.on("completed", (job) => {
    log.info({ queue: worker.name, jobId: job.id }, "job completed");
  });

  worker.on("failed", async (job, error) => {
    const attempts = job?.opts.attempts ?? 1;
    const made = job?.attemptsMade ?? 0;
    const final = made >= attempts;

    log.error(
      { queue: worker.name, jobId: job?.id, attempt: made, of: attempts, err: error.message },
      final ? "job failed permanently" : "job failed, will retry",
    );

    if (!final || !job) return;
    try {
      switch (worker.name) {
        case QUEUE.mediaAnalyze:
          await failMediaAnalyze(job.data as MediaAnalyzeJob, error);
          break;
        case QUEUE.renderQc:
          // Only reached for an actual crash (subprocess/DB layer) — a
          // legitimate "gate failed" outcome is handled inside
          // runRenderQc itself and never throws (see jobs/render-qc.ts).
          await failRenderQc(job.data as RenderQcJob, error);
          break;
      }
    } catch (markError) {
      log.error({ err: (markError as Error).message }, "could not record failure on media analysis/render");
    }
  });
}

log.info({ queues: workers.map((w) => w.name) }, "worker-media started");

async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, "worker-media shutting down");
  await Promise.all(workers.map((w) => w.close()));
  await closeQueues();
  await disconnect();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
