import { Worker, type Job } from "bullmq";
import {
  CALENDAR_SWEEP_PATTERN,
  QUEUE,
  calendarSyncQueue,
  closeQueues,
  connection,
  type CalendarSyncJob,
  type ExtractJob,
  type IngestRecordingJob,
  type IngestTranscriptJob,
  type WebhookJob,
} from "./queue.js";
import { processWebhook } from "./jobs/webhook.js";
import { failRecordingIngest, ingestRecording } from "./jobs/ingest-recording.js";
import { failTranscriptIngest, ingestTranscript } from "./jobs/ingest-transcript.js";
import { failExtraction, runExtraction } from "./jobs/extract.js";
import { syncActiveConnections, syncCalendarConnection } from "./jobs/calendar-sync.js";
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
      }
    } catch (markError) {
      log.error({ err: (markError as Error).message }, "could not record failure on meeting");
    }
  });
}

/**
 * The repeatable sweep. `jobId` is fixed so restarting a worker replaces the
 * schedule rather than adding a second one — without it, every deploy would
 * leave another sweep running forever.
 */
await calendarSyncQueue.add(
  "sweep",
  {},
  { repeat: { pattern: CALENDAR_SWEEP_PATTERN }, jobId: "calendar-sweep" },
);

log.info(
  {
    queues: workers.map((w) => w.name),
    region: env.RECALL_REGION,
    model: env.OPENAI_MODEL,
    calendarSweep: CALENDAR_SWEEP_PATTERN,
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
