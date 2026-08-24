import { Queue, type ConnectionOptions } from "bullmq";
import { Redis } from "ioredis";
import { env } from "./env.js";

export const connection: ConnectionOptions = {
  url: env.REDIS_URL,
  // BullMQ requires this; blocking commands must not time out mid-wait.
  maxRetriesPerRequest: null,
} as ConnectionOptions;

export function newRedis(): Redis {
  return new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
}

export const QUEUE = {
  webhook: "webhook",
  ingestRecording: "ingest-recording",
  ingestTranscript: "ingest-transcript",
  extract: "extract",
  calendarSync: "calendar-sync",
  suggestActions: "suggest-actions",
} as const;

export type WebhookJob = { webhookEventId: string };
export type IngestRecordingJob = { meetingId: string; tenantId: string; recordingId: string };
export type IngestTranscriptJob = { meetingId: string; tenantId: string; transcriptId: string };
export type ExtractJob = { meetingId: string; tenantId: string };
/** A targeted sync carries both ids; a bare `{}` means "sweep every active
 *  connection". The shape mirrors jobs/calendar-sync.ts, which owns the work. */
export type CalendarSyncJob = { connectionId?: string; tenantId?: string };

export type SuggestActionsJob = { meetingId: string; tenantId: string };

/**
 * Retries are generous and backed off: every job in this pipeline talks to a
 * third party (Recall, R2, OpenAI) whose transient failures are routine.
 * Jobs are idempotent — see the dedupe key on webhook_events and the
 * (meeting, kind) uniqueness on artifacts.
 */
const defaultJobOptions = {
  attempts: 5,
  backoff: { type: "exponential" as const, delay: 5_000 },
  removeOnComplete: { age: 24 * 3600, count: 1_000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

export const webhookQueue = new Queue<WebhookJob>(QUEUE.webhook, { connection, defaultJobOptions });
export const ingestRecordingQueue = new Queue<IngestRecordingJob>(QUEUE.ingestRecording, {
  connection,
  defaultJobOptions,
});
export const ingestTranscriptQueue = new Queue<IngestTranscriptJob>(QUEUE.ingestTranscript, {
  connection,
  defaultJobOptions,
});
export const extractQueue = new Queue<ExtractJob>(QUEUE.extract, {
  connection,
  // Extraction is the expensive one; fewer attempts, longer backoff.
  defaultJobOptions: { ...defaultJobOptions, attempts: 3, backoff: { type: "exponential", delay: 15_000 } },
});

export const calendarSyncQueue = new Queue<CalendarSyncJob>(QUEUE.calendarSync, {
  connection,
  // A calendar sync that fails is retried by the next sweep anyway, so a long
  // retry chain here just delays the sweep behind a connection that is broken.
  defaultJobOptions: { ...defaultJobOptions, attempts: 2 },
});

/** How often the sweep runs. Google and Microsoft both push change
 *  notifications, but the watch channels expire and a poll is the floor that
 *  keeps a missed notification from stranding a calendar indefinitely. */
export const CALENDAR_SWEEP_PATTERN = "*/10 * * * *";

export const suggestActionsQueue = new Queue<SuggestActionsJob>(QUEUE.suggestActions, {
  connection,
  // Suggestions are a convenience layered on a meeting that is already fully
  // processed. A failure here must never look like the pipeline broke, so it
  // retries twice and then stops quietly.
  defaultJobOptions: { ...defaultJobOptions, attempts: 2 },
});

export const allQueues = [
  webhookQueue,
  ingestRecordingQueue,
  ingestTranscriptQueue,
  extractQueue,
  calendarSyncQueue,
  suggestActionsQueue,
];

export async function closeQueues(): Promise<void> {
  await Promise.all(allQueues.map((q) => q.close()));
}
