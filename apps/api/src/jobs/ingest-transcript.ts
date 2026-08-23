import { ArtifactKind, EvidenceKind, MeetingStatus } from "@prisma/client";
import { prisma } from "../db.js";
import { runWithContext } from "../context.js";
import { transition, markFailed } from "../domain/state.js";
import { parseTranscript } from "../domain/transcript.js";
import { getTranscript, type RecallTranscriptEntry } from "../integrations/recall.js";
import { keys, putObject } from "../integrations/r2.js";
import { extractQueue, type IngestTranscriptJob } from "../queue.js";
import { logger } from "../logger.js";
import { withTenantContext } from "./context.js";

const log = logger.child({ job: "ingest-transcript" });

/**
 * Transcript completion handler.
 *
 * The raw JSON goes to R2 unmodified — that copy is the evidence of record and
 * is never rewritten. The parsed segments go to Postgres, where they become
 * the citable unit: a claim points at segment rows, and a reviewer reads the
 * quote back out of them.
 */
export async function ingestTranscript(job: IngestTranscriptJob): Promise<void> {
  await withTenantContext(job.tenantId, async () => {
    const meeting = await prisma.meeting.findUnique({
      where: { id: job.meetingId },
      select: { id: true, tenantId: true, deletedAt: true },
    });
    if (!meeting || meeting.deletedAt) return;

    const existing = await prisma.transcript.findUnique({ where: { meetingId: meeting.id } });
    if (existing) {
      log.info({ meetingId: meeting.id }, "transcript already ingested");
      await enqueueExtraction(meeting.id, meeting.tenantId);
      return;
    }

    const artifact = await getTranscript(job.transcriptId);
    const downloadUrl = artifact.data?.download_url;
    if (!downloadUrl) {
      throw new Error(
        `transcript ${job.transcriptId} has no download_url (status ${artifact.status?.code ?? "absent"})`,
      );
    }

    const response = await fetch(downloadUrl);
    if (!response.ok) {
      throw new Error(`transcript download failed (${response.status}) for ${job.transcriptId}`);
    }
    const rawBody = await response.text();

    let entries: RecallTranscriptEntry[];
    try {
      const decoded = JSON.parse(rawBody);
      entries = Array.isArray(decoded) ? (decoded as RecallTranscriptEntry[]) : [];
    } catch {
      throw new Error(`transcript ${job.transcriptId} is not valid JSON`);
    }

    const parsed = parseTranscript(entries);
    if (parsed.segments.length === 0) {
      await markFailed(prisma, {
        meetingId: meeting.id,
        stage: "ingest-transcript",
        reason: "transcript contained no speech",
      });
      return;
    }

    // Raw evidence to R2 first: if the database write fails and this job is
    // retried, the artifact is already safe from Recall's 7-day retention.
    const uploaded = await putObject({
      key: keys.transcriptJson(meeting.tenantId, meeting.id),
      body: rawBody,
      contentType: "application/json",
    });

    await prisma.$transaction(async (tx) => {
      await tx.artifact.upsert({
        where: { meetingId_kind: { meetingId: meeting.id, kind: ArtifactKind.transcript_json } },
        create: {
          tenantId: meeting.tenantId,
          meetingId: meeting.id,
          kind: ArtifactKind.transcript_json,
          r2Key: uploaded.key,
          contentType: uploaded.contentType,
          bytes: BigInt(uploaded.bytes),
          checksum: uploaded.checksum,
        },
        update: { bytes: BigInt(uploaded.bytes), checksum: uploaded.checksum, purgedAt: null },
      });

      const evidence = await tx.evidenceSource.create({
        data: {
          tenantId: meeting.tenantId,
          kind: EvidenceKind.meeting_transcript,
          meetingId: meeting.id,
          externalId: job.transcriptId,
          capturedAt: new Date(),
          metadata: {
            provider: "recallai_async",
            recall_transcript_id: job.transcriptId,
            r2_key: uploaded.key,
            language_code: parsed.languageCode,
          },
        },
      });

      const transcript = await tx.transcript.create({
        data: {
          tenantId: meeting.tenantId,
          meetingId: meeting.id,
          evidenceSourceId: evidence.id,
          provider: "recallai_async",
          languageCode: parsed.languageCode,
          recallTranscriptId: job.transcriptId,
          segmentCount: parsed.segments.length,
          wordCount: parsed.wordCount,
          durationMs: parsed.durationMs,
        },
      });

      await tx.transcriptSegment.createMany({
        data: parsed.segments.map((s) => ({
          tenantId: meeting.tenantId,
          transcriptId: transcript.id,
          idx: s.idx,
          speaker: s.speaker,
          speakerId: s.speakerId,
          startMs: s.startMs,
          endMs: s.endMs,
          text: s.text,
        })),
      });

      await transition(tx as never, {
        meetingId: meeting.id,
        to: MeetingStatus.transcript_ready,
        reason: `transcript ingested (${parsed.segments.length} segments)`,
      });
    });

    log.info(
      { meetingId: meeting.id, segments: parsed.segments.length, words: parsed.wordCount },
      "transcript ingested",
    );

    await enqueueExtraction(meeting.id, meeting.tenantId);
  });
}

async function enqueueExtraction(meetingId: string, tenantId: string): Promise<void> {
  await extractQueue.add("extract", { meetingId, tenantId }, { jobId: `extract-${meetingId}` });
}

export async function failTranscriptIngest(job: IngestTranscriptJob, error: Error): Promise<void> {
  await runWithContext(
    { tenantId: job.tenantId, tenantSlug: "", reviewer: "system:worker" },
    async () => {
      await markFailed(prisma, {
        meetingId: job.meetingId,
        stage: "ingest-transcript",
        reason: error.message.slice(0, 500),
      });
    },
  );
}
