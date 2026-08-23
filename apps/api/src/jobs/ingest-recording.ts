import { ArtifactKind, MeetingStatus } from "@prisma/client";
import { prisma } from "../db.js";
import { runWithContext } from "../context.js";
import { env } from "../env.js";
import { markFailed } from "../domain/state.js";
import { createAsyncTranscript, getRecording } from "../integrations/recall.js";
import { keys, streamUrlToR2 } from "../integrations/r2.js";
import type { IngestRecordingJob } from "../queue.js";
import { logger } from "../logger.js";
import { withTenantContext } from "./context.js";

const log = logger.child({ job: "ingest-recording" });

/**
 * Recording completion handler.
 *
 * Two things happen here and the order matters. Recall retains media for about
 * seven days, so the artifact is pulled into R2 immediately — this handler is
 * the only place that download is guaranteed to succeed. Only then do we kick
 * off async transcription, because a transcript is worth nothing if the audio
 * it describes has expired.
 */
export async function ingestRecording(job: IngestRecordingJob): Promise<void> {
  await withTenantContext(job.tenantId, async () => {
    const meeting = await prisma.meeting.findUnique({
      where: { id: job.meetingId },
      select: { id: true, tenantId: true, recallTranscriptId: true, deletedAt: true },
    });
    if (!meeting || meeting.deletedAt) return;

    const recording = await getRecording(job.recordingId);

    const audioUrl = recording.media_shortcuts?.audio_mixed?.data?.download_url;
    if (!audioUrl) {
      // The recording is done but its mixed audio is still rendering. Throwing
      // hands this back to BullMQ's exponential backoff rather than inventing a
      // poll loop.
      throw new Error(
        `audio_mixed not ready for recording ${job.recordingId} ` +
          `(status ${recording.media_shortcuts?.audio_mixed?.status?.code ?? "absent"})`,
      );
    }

    await storeArtifact({
      meetingId: meeting.id,
      tenantId: meeting.tenantId,
      kind: ArtifactKind.recording_audio,
      key: keys.recordingAudio(meeting.tenantId, meeting.id),
      url: audioUrl,
      contentType: "audio/mpeg",
    });

    if (env.RECALL_CAPTURE_VIDEO) {
      const videoUrl = recording.media_shortcuts?.video_mixed?.data?.download_url;
      if (videoUrl) {
        await storeArtifact({
          meetingId: meeting.id,
          tenantId: meeting.tenantId,
          kind: ArtifactKind.recording_video,
          key: keys.recordingVideo(meeting.tenantId, meeting.id),
          url: videoUrl,
          contentType: "video/mp4",
        });
      }
    }

    // A transcript already exists if this job is a redelivery, or if the
    // transcript.done webhook overtook us. Asking twice would bill twice.
    const existingTranscriptId =
      meeting.recallTranscriptId ?? recording.media_shortcuts?.transcript?.id ?? null;

    if (existingTranscriptId) {
      log.info({ meetingId: meeting.id, existingTranscriptId }, "transcript already requested");
      return;
    }

    const transcript = await createAsyncTranscript(job.recordingId);
    await prisma.meeting.update({
      where: { id: meeting.id },
      data: { recallTranscriptId: transcript.id },
    });
    log.info({ meetingId: meeting.id, transcriptId: transcript.id }, "async transcript requested");
  });
}

async function storeArtifact(args: {
  meetingId: string;
  tenantId: string;
  kind: ArtifactKind;
  key: string;
  url: string;
  contentType: string;
}): Promise<void> {
  const existing = await prisma.artifact.findUnique({
    where: { meetingId_kind: { meetingId: args.meetingId, kind: args.kind } },
  });
  // Artifacts are immutable once written. A retry that finds one already there
  // has nothing to do.
  if (existing && !existing.purgedAt) return;

  const uploaded = await streamUrlToR2({
    url: args.url,
    key: args.key,
    contentType: args.contentType,
  });

  await prisma.artifact.upsert({
    where: { meetingId_kind: { meetingId: args.meetingId, kind: args.kind } },
    create: {
      tenantId: args.tenantId,
      meetingId: args.meetingId,
      kind: args.kind,
      r2Key: uploaded.key,
      contentType: uploaded.contentType,
      bytes: BigInt(uploaded.bytes),
      checksum: uploaded.checksum,
      sourceUrl: stripQuery(args.url),
    },
    update: {
      r2Key: uploaded.key,
      bytes: BigInt(uploaded.bytes),
      checksum: uploaded.checksum,
      purgedAt: null,
    },
  });

  log.info(
    { meetingId: args.meetingId, kind: args.kind, bytes: uploaded.bytes, key: uploaded.key },
    "artifact stored",
  );
}

/** Recall download URLs are presigned; the signature is noise in an audit log. */
function stripQuery(url: string): string {
  const idx = url.indexOf("?");
  return idx === -1 ? url : url.slice(0, idx);
}

export async function failRecordingIngest(job: IngestRecordingJob, error: Error): Promise<void> {
  await runWithContext(
    { tenantId: job.tenantId, tenantSlug: "", reviewer: "system:worker" },
    async () => {
      await markFailed(prisma, {
        meetingId: job.meetingId,
        stage: "ingest-recording",
        reason: error.message.slice(0, 500),
      });
    },
  );
}

export { MeetingStatus };
