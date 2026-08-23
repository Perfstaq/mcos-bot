import { MeetingStatus } from "@prisma/client";
import { prisma, rawPrisma } from "../db.js";
import { runWithContext } from "../context.js";
import { env } from "../env.js";
import { markFailed, transition } from "../domain/state.js";
import {
  isActionable,
  isFailureEvent,
  readIds,
  statusForBotEvent,
  type RecallWebhookPayload,
} from "../domain/webhook.js";
import { ingestRecordingQueue, ingestTranscriptQueue, type WebhookJob } from "../queue.js";
import { logger } from "../logger.js";

const log = logger.child({ job: "webhook" });

/**
 * Process one already-verified, already-persisted webhook.
 *
 * The HTTP handler did the signature check, wrote the raw payload and acked.
 * Everything expensive happens here, and everything here is idempotent: a
 * redelivered webhook is deduped at insert, and a re-run of this function hits
 * the state machine's rank guard instead of rewinding the meeting.
 */
export async function processWebhook(job: WebhookJob): Promise<void> {
  const event = await rawPrisma.webhookEvent.findUnique({ where: { id: job.webhookEventId } });
  if (!event) {
    log.warn({ webhookEventId: job.webhookEventId }, "webhook event vanished");
    return;
  }
  if (event.processedAt) return;

  const payload = event.payload as RecallWebhookPayload;
  const ids = readIds(payload);

  if (!isActionable(ids.eventType)) {
    await markProcessed(event.id);
    return;
  }

  const botId = ids.botId;
  if (!botId) {
    await markProcessed(event.id, "no bot id in payload");
    return;
  }

  const meeting = await rawPrisma.meeting.findUnique({
    where: { recallBotId: botId },
    select: { id: true, tenantId: true },
  });

  if (!meeting) {
    // A bot this workspace dispatched from another environment, or a stale
    // redelivery after the meeting was purged. Logged, not an error.
    log.warn({ botId, event: ids.eventType }, "webhook for unknown bot");
    await markProcessed(event.id, "unknown bot");
    return;
  }

  const tenant = await rawPrisma.tenant.findUnique({ where: { id: meeting.tenantId } });
  if (!tenant) {
    await markProcessed(event.id, "unknown tenant");
    return;
  }

  await rawPrisma.webhookEvent.update({
    where: { id: event.id },
    data: { tenantId: tenant.id },
  });

  await runWithContext(
    { tenantId: tenant.id, tenantSlug: tenant.slug, reviewer: "system:recall-webhook" },
    async () => {
      await handle({ meetingId: meeting.id, tenantId: tenant.id, ids });
    },
  );

  await markProcessed(event.id);
}

async function handle(args: {
  meetingId: string;
  tenantId: string;
  ids: ReturnType<typeof readIds>;
}): Promise<void> {
  const { ids, meetingId, tenantId } = args;

  if (isFailureEvent(ids.eventType)) {
    await markFailed(prisma, {
      meetingId,
      stage: ids.eventType,
      reason: ids.subCode ? `${ids.eventType} (${ids.subCode})` : ids.eventType,
    });
    return;
  }

  const botStatus = statusForBotEvent(ids.eventType);
  if (botStatus) {
    const patch =
      botStatus === MeetingStatus.recording
        ? { startedAt: new Date() }
        : botStatus === MeetingStatus.call_ended
          ? { endedAt: new Date() }
          : {};
    const result = await transition(prisma, {
      meetingId,
      to: botStatus,
      reason: ids.eventType,
      patch,
    });
    log.info({ meetingId, event: ids.eventType, applied: result.applied }, "bot status");
    return;
  }

  if (ids.eventType === "recording.done" && ids.recordingId) {
    await transition(prisma, {
      meetingId,
      to: MeetingStatus.media_processing,
      reason: "recording.done",
      patch: { recallRecordingId: ids.recordingId },
    });
    await ingestRecordingQueue.add(
      "ingest",
      { meetingId, tenantId, recordingId: ids.recordingId },
      // Recall's own recording id makes the job idempotent across redeliveries.
      { jobId: `recording-${ids.recordingId}` },
    );
    return;
  }

  if (ids.eventType === "transcript.done" && ids.transcriptId) {
    await prisma.meeting.update({
      where: { id: meetingId },
      data: { recallTranscriptId: ids.transcriptId },
    });
    await ingestTranscriptQueue.add(
      "ingest",
      { meetingId, tenantId, transcriptId: ids.transcriptId },
      { jobId: `transcript-${ids.transcriptId}` },
    );
  }
}

async function markProcessed(id: string, error?: string): Promise<void> {
  await rawPrisma.webhookEvent.update({
    where: { id },
    data: { processedAt: new Date(), ...(error ? { error } : {}) },
  });
}

export const webhookJobConcurrency = env.NODE_ENV === "test" ? 1 : 8;
