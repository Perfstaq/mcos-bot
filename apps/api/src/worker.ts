import { Worker, type Job } from "bullmq";
import {
  CALENDAR_SWEEP_PATTERN,
  MEDIA_PURGE_SWEEP_PATTERN,
  QUEUE,
  calendarSyncQueue,
  closeQueues,
  connection,
  mediaPurgeReferencesQueue,
  type CalendarSyncJob,
  type SuggestActionsJob,
  type DigestJob,
  type ExtractJob,
  type IngestRecordingJob,
  type IngestTranscriptJob,
  type MediaPurgeReferencesJob,
  type PlanBuildJob,
  type RenderSubmitJob,
  type WebhookJob,
} from "./queue.js";
import { processWebhook } from "./jobs/webhook.js";
import { failRecordingIngest, ingestRecording } from "./jobs/ingest-recording.js";
import { failTranscriptIngest, ingestTranscript } from "./jobs/ingest-transcript.js";
import { failExtraction, runExtraction } from "./jobs/extract.js";
import { syncActiveConnections, syncCalendarConnection } from "./jobs/calendar-sync.js";
import { runActionItemSuggestions } from "./jobs/suggest-action-items.js";
import { runDigest } from "./jobs/digest.js";
import { failPlanBuild, runPlanBuild } from "./jobs/plan-build.js";
import { failRenderSubmit, runRenderSubmit } from "./jobs/render-submit.js";
import { sweepPurgeReferences } from "./jobs/media-purge.js";
import { disconnect } from "./db.js";
import { logger } from "./logger.js";
import { env } from "./env.js";

const log = logger.child({ service: "worker" });

/**
 * The worker half of the single deployable. Same image as the API, different
 * command: `node dist/worker.js`.
 *
 * Concurrency is per queue, not global — the webhook queue is short and
 * chatty, artifact ingest is I/O bound on two networks at once, and extraction
 * is bounded by the OpenAI rate limit rather than by this process.
 */
const workers = [
  new Worker<WebhookJob>(QUEUE.webhook, (job) => processWebhook(job.data), {
    connection,
    concurrency: 8,
  }),

  new Worker<IngestRecordingJob>(QUEUE.ingestRecording, (job) => ingestRecording(job.data), {
    connection,
    concurrency: 3,
  }),

  new Worker<IngestTranscriptJob>(QUEUE.ingestTranscript, (job) => ingestTranscript(job.data), {
    connection,
    concurrency: 4,
  }),

  new Worker<ExtractJob>(QUEUE.extract, (job) => runExtraction(job.data), {
    connection,
    concurrency: 2,
  }),

  new Worker<CalendarSyncJob>(
    QUEUE.calendarSync,
    async (job) => {
      const { connectionId, tenantId } = job.data;
      if (connectionId && tenantId) await syncCalendarConnection({ connectionId, tenantId });
      else await syncActiveConnections();
    },
    // One at a time: the sweep fans out internally, and running several sweeps
    // concurrently would race two syncs onto the same connection's sync token.
    { connection, concurrency: 1 },
  ),

  new Worker<SuggestActionsJob>(
    QUEUE.suggestActions,
    (job) => runActionItemSuggestions(job.data).then(() => undefined),
    { connection, concurrency: 2 },
  ),

  // runDigest already catches and logs every failure itself (see
  // jobs/digest.ts) — this worker's own `failed` handler below never needs a
  // case for it, which is what keeps a digest failure from ever marking a
  // meeting failed.
  new Worker<DigestJob>(QUEUE.digest, (job) => runDigest(job.data), {
    connection,
    concurrency: 2,
  }),

  // Content Studio (ARCHITECTURE §12.12). Both live on THIS worker, not
  // worker-media.ts: `plan.build` is pure TypeScript and `render.submit` makes
  // renderer/API calls — neither needs ffmpeg, faster-whisper or librosa, and
  // registering them on the media image would put ML dependencies on their
  // deploy path for no reason (queue.ts's own note says so).
  //
  // Concurrency and lockDuration come from 03_RENDER_PIPELINE §3's table:
  // plan.build 4 @ 60s, render.submit 4 @ 20m. BullMQ has no first-class
  // per-job timeout, so `lockDuration` is what reclaims a stalled job rather
  // than holding the slot forever.
  new Worker<PlanBuildJob>(QUEUE.planBuild, (job) => runPlanBuild(job.data), {
    connection,
    concurrency: 4,
    lockDuration: 60 * 1000,
  }),

  new Worker<RenderSubmitJob>(QUEUE.renderSubmit, (job) => runRenderSubmit(job.data), {
    connection,
    concurrency: 4,
    lockDuration: 20 * 60 * 1000,
  }),

  // Reference-reel retention (ARCHITECTURE §12.36). Pure R2-delete + Prisma
  // work like plan.build/render.submit above — no ffmpeg/faster-whisper/
  // librosa — so this lives on THIS worker, not worker-media.ts, same
  // reasoning as those two. Concurrency 1: it is one sweep a day, not a
  // stream of per-resource jobs, and there is nothing to gain from running
  // two sweeps at once.
  new Worker<MediaPurgeReferencesJob>(QUEUE.mediaPurgeReferences, () => sweepPurgeReferences(), {
    connection,
    concurrency: 1,
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

    // Only a permanent failure marks the meeting failed. A transient one is
    // invisible to the user — that is what the retries are for.
    if (!final || !job) return;
    try {
      switch (worker.name) {
        case QUEUE.ingestRecording:
          await failRecordingIngest(job.data as IngestRecordingJob, error);
          break;
        case QUEUE.ingestTranscript:
          await failTranscriptIngest(job.data as IngestTranscriptJob, error);
          break;
        case QUEUE.extract:
          await failExtraction(job.data as ExtractJob, error);
          break;
        case QUEUE.planBuild:
          // 03 §7's `plan_infeasible(reason)`: structured and logged with the
          // plan id. See failPlanBuild's own comment for the gap this leaves —
          // there is no durable per-plan status row for a UI to read yet.
          await failPlanBuild(job.data as PlanBuildJob, error);
          break;
        case QUEUE.renderSubmit:
          await failRenderSubmit(job.data as RenderSubmitJob, error);
          break;
      }
    } catch (markError) {
      log.error({ err: (markError as Error).message }, "could not record failure on meeting");
    }
  });
}

/**
 * The repeatable sweeps. `jobId` is fixed on each so restarting a worker
 * replaces the schedule rather than adding a second one — without it, every
 * deploy would leave another sweep running forever.
 */
await calendarSyncQueue.add(
  "sweep",
  {},
  { repeat: { pattern: CALENDAR_SWEEP_PATTERN }, jobId: "calendar-sweep" },
);

await mediaPurgeReferencesQueue.add(
  "sweep",
  {},
  { repeat: { pattern: MEDIA_PURGE_SWEEP_PATTERN }, jobId: "media-purge-references-sweep" },
);

log.info(
  {
    queues: workers.map((w) => w.name),
    region: env.RECALL_REGION,
    model: env.OPENAI_MODEL,
    calendarSweep: CALENDAR_SWEEP_PATTERN,
    mediaPurgeSweep: MEDIA_PURGE_SWEEP_PATTERN,
  },
  "worker started",
);

async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, "worker shutting down");
  await Promise.all(workers.map((w) => w.close()));
  await closeQueues();
  await disconnect();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

export type { Job };
