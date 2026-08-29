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
  digest: "digest",
  // Content Studio (additive — ARCHITECTURE.md §2/§8). `mediaAnalyze` and
  // `renderQc` are consumed by `worker-media.ts` (the ffmpeg/Python-sidecar
  // image); `planBuild` and `renderSubmit` stay on the existing lean
  // `worker.ts` — see queue.ts's own doc comment on each below for why.
  mediaAnalyze: "media.analyze",
  planBuild: "plan.build",
  renderSubmit: "render.submit",
  renderQc: "render.qc",
  mediaPurgeReferences: "media.purge-references",
} as const;

export type WebhookJob = { webhookEventId: string };
export type IngestRecordingJob = { meetingId: string; tenantId: string; recordingId: string };
export type IngestTranscriptJob = { meetingId: string; tenantId: string; transcriptId: string };
export type ExtractJob = { meetingId: string; tenantId: string };
/** Rides the same trigger as extraction (transcript_ready) but not the same
 *  queue: a stalled or slow digest call must never hold back extraction, and
 *  a failed one must never look like the pipeline broke — see jobs/digest.ts. */
export type DigestJob = { meetingId: string; tenantId: string };
/** A targeted sync carries both ids; a bare `{}` means "sweep every active
 *  connection". The shape mirrors jobs/calendar-sync.ts, which owns the work. */
export type CalendarSyncJob = { connectionId?: string; tenantId?: string };

export type SuggestActionsJob = { meetingId: string; tenantId: string };

/** Runs the Python sidecar's `words`+`beats` stages (and, later, scenes/
 *  motion/faces) over a `MediaAsset`, writing the result into its
 *  `MediaAnalysis` row (03_RENDER_PIPELINE §1/§3: ffmpeg-optional, GPU-
 *  optional, faster-whisper on CPU acceptable at this scale). */
export type MediaAnalyzeJob = { tenantId: string; assetId: string; mediaAnalysisId: string };
/** Pure computation, no LLM call (the LLM already ran at ContentBrief
 *  generation) — builds the beat-snapped rhythm plan + caption chunks +
 *  shot assignment into a `RenderPlan` row. Scores G1a (musical intent)
 *  against the plan's own embedded beat grid before the job is allowed to
 *  succeed (ADR-8): a plan that fails G1a must never reach `render.submit`.
 *
 *  `planId` is pre-allocated by `routes/content.ts` at enqueue time, before
 *  the row exists — `RenderPlan` is APPEND_ONLY (no in-place update is even
 *  possible, see domain/append-only.ts), so the row can only be written once,
 *  complete, by whichever job processor performs this computation; it cannot
 *  be created empty by the route and filled in later. `contentBriefId` /
 *  `templateId` / `footageAssetId` are additive here (nothing consumed this
 *  type before Agent B's routes/content.ts — no queued job or worker
 *  registration existed for `plan.build` yet) and are exactly what
 *  `POST /content/plans` already validated (approved-only content brief,
 *  existing template, existing footage) before enqueueing. */
export type PlanBuildJob = {
  tenantId: string;
  planId: string;
  contentBriefId: string;
  templateId: string;
  footageAssetId: string;
};
/** Deploys/reuses the `packages/render` Lambda site bundle, feeds it
 *  presigned R2 footage URLs, and polls for completion (ADR-7). */
export type RenderSubmitJob = { tenantId: string; renderId: string };
/** Runs `scripts/qc-render.ts` (07_QUALITY_GATES §1) against a finished
 *  render: G1b (render fidelity) plus G2-G14, writing `Render.qc`. */
export type RenderQcJob = { tenantId: string; renderId: string };
/** The daily reference-reel retention sweep (04 §5, ARCHITECTURE §12.36).
 *  Crosses tenants by definition — same shape as `{}` on the calendar sweep
 *  above — so it carries no payload at all rather than an unused optional
 *  field. See `jobs/media-purge.ts`. */
export type MediaPurgeReferencesJob = Record<string, never>;

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

export const digestQueue = new Queue<DigestJob>(QUEUE.digest, {
  connection,
  // Same posture as suggestActionsQueue: a convenience layered on top of an
  // already-processed meeting. Two attempts, then quiet — jobs/digest.ts
  // already treats every failure as non-fatal, so a worker-level retry storm
  // would just delay the fallback the job already provides for free.
  defaultJobOptions: { ...defaultJobOptions, attempts: 2 },
});

/**
 * Content Studio queues (additive). Per 03_RENDER_PIPELINE §3:
 *
 * | Queue                  | Concurrency | Timeout | Notes                              |
 * |------------------------|-------------|---------|-------------------------------------|
 * | media.analyze          | 2           | 15m     | worker-media.ts; ffmpeg + sidecar   |
 * | plan.build             | 4           | 60s     | worker.ts; pure computation         |
 * | render.submit          | 4           | 20m     | worker.ts; Remotion Lambda API calls|
 * | render.qc              | 4           | 5m      | worker-media.ts; PySceneDetect+ffmpeg|
 * | media.purge-references | 1           | n/a     | worker.ts; R2 delete + Prisma only, daily sweep (ARCHITECTURE §12.36) |
 *
 * Concurrency is set on each `Worker` (worker.ts/worker-media.ts), not here.
 * "Timeout" has no first-class BullMQ primitive; it is enforced two ways —
 * `lockDuration` on the consuming Worker (a stalled/crashed job is reclaimed
 * rather than held forever) and, where a stage shells out to a subprocess
 * (media.analyze's `execFileSync` into services/analyzer), the processor's
 * own timeout on that call. 03 §7's failure states — `analyze_failed`,
 * `plan_infeasible`, `render_failed`, `qc_failed(metric, value)` — are always
 * surfaced on the `Render`/`MediaAnalysis` row, never silent.
 *
 * Retries: 2 with exponential backoff (03 §3), same posture as
 * suggestActionsQueue/digestQueue — a third automatic retry on a render job
 * just delays the honest failure the UI already knows how to show.
 * `media.purge-references` reuses this posture too even though it is a sweep,
 * not a single-resource job — see its own doc comment on why a per-asset
 * failure never fails the whole run.
 */
const studioJobOptions = { ...defaultJobOptions, attempts: 2 };

export const mediaAnalyzeQueue = new Queue<MediaAnalyzeJob>(QUEUE.mediaAnalyze, {
  connection,
  defaultJobOptions: studioJobOptions,
});
export const planBuildQueue = new Queue<PlanBuildJob>(QUEUE.planBuild, {
  connection,
  defaultJobOptions: studioJobOptions,
});
export const renderSubmitQueue = new Queue<RenderSubmitJob>(QUEUE.renderSubmit, {
  connection,
  defaultJobOptions: studioJobOptions,
});
export const renderQcQueue = new Queue<RenderQcJob>(QUEUE.renderQc, {
  connection,
  defaultJobOptions: studioJobOptions,
});
export const mediaPurgeReferencesQueue = new Queue<MediaPurgeReferencesJob>(QUEUE.mediaPurgeReferences, {
  connection,
  defaultJobOptions: studioJobOptions,
});

/** How often the reference-reel retention sweep runs. Daily, off-peak — there
 *  is no freshness requirement (unlike the calendar sweep's missed-webhook
 *  concern above): a reel that turns eligible at noon can wait until the next
 *  early-morning pass without anyone noticing. */
export const MEDIA_PURGE_SWEEP_PATTERN = "0 4 * * *";

export const allQueues = [
  webhookQueue,
  ingestRecordingQueue,
  ingestTranscriptQueue,
  extractQueue,
  calendarSyncQueue,
  suggestActionsQueue,
  digestQueue,
  mediaAnalyzeQueue,
  planBuildQueue,
  renderSubmitQueue,
  renderQcQueue,
  mediaPurgeReferencesQueue,
];

export async function closeQueues(): Promise<void> {
  await Promise.all(allQueues.map((q) => q.close()));
}
