import type { FastifyInstance } from "fastify";
import { ArtifactKind, ClaimStatus, MeetingStatus, Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db.js";
import { ApiError, requireCtx } from "../http.js";
import { RETRY_STAGE_FOR_STATUS, transition } from "../domain/state.js";
import { createBot } from "../integrations/recall.js";
import { deleteObjects, presignGet } from "../integrations/r2.js";
import { extractQueue, ingestRecordingQueue } from "../queue.js";
// The append-only guard decides what counts as a redaction, so it owns the
// sentinel: a purge writing any other value would be refused as a rewrite.
import { REDACTED } from "../domain/append-only.js";

const createSchema = z.object({
  meeting_url: z.string().url("meeting_url must be a URL the bot can join"),
  join_at: z.string().datetime({ offset: true }).optional(),
  title: z.string().trim().min(1).max(200).optional(),
});

const listSchema = z.object({
  status: z.nativeEnum(MeetingStatus).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export async function meetingRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Create a meeting and dispatch a bot.
   *
   * Bot creation is modelled as scheduling even when the bot joins now — the
   * same call handles both, so a scheduled meeting needs no second code path.
   */
  app.post("/meetings", async (request, reply) => {
    const ctx = requireCtx(request);
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      throw ApiError.badRequest("Invalid meeting", parsed.error.flatten().fieldErrors);
    }
    const { meeting_url, join_at, title } = parsed.data;
    const joinAt = join_at ? new Date(join_at) : null;

    const meeting = await prisma.meeting.create({
      data: {
        tenantId: ctx.tenantId,
        meetingUrl: meeting_url,
        joinAt,
        title: title ?? null,
        status: MeetingStatus.draft,
        platform: detectPlatform(meeting_url),
      },
    });

    try {
      const bot = await createBot({
        meetingUrl: meeting_url,
        joinAt,
        metadata: { mcos_meeting_id: meeting.id, mcos_tenant: ctx.tenantSlug },
      });
      await transition(prisma, {
        meetingId: meeting.id,
        to: MeetingStatus.bot_scheduled,
        reason: joinAt ? `bot scheduled for ${joinAt.toISOString()}` : "bot dispatched",
        patch: { recallBotId: bot.id },
      });
    } catch (error) {
      await transition(prisma, {
        meetingId: meeting.id,
        to: MeetingStatus.failed,
        reason: "bot dispatch failed",
        patch: {
          failureReason: (error as Error).message.slice(0, 500),
          failedStage: "dispatch",
        },
      });
      throw new ApiError(502, "recall_dispatch_failed", (error as Error).message);
    }

    const fresh = await loadMeeting(meeting.id);
    return reply.status(201).send({ meeting: fresh });
  });

  app.get("/meetings", async (request) => {
    requireCtx(request);
    const parsed = listSchema.safeParse(request.query);
    if (!parsed.success) throw ApiError.badRequest("Invalid query", parsed.error.flatten());

    const meetings = await prisma.meeting.findMany({
      where: { deletedAt: null, ...(parsed.data.status ? { status: parsed.data.status } : {}) },
      orderBy: { createdAt: "desc" },
      take: parsed.data.limit,
      include: { artifacts: true, transcript: { select: { segmentCount: true, durationMs: true } } },
    });

    const counts = await claimCounts(meetings.map((m) => m.id));

    return {
      meetings: meetings.map((m) => ({
        ...serializeMeeting(m),
        artifacts: m.artifacts.map(serializeArtifact),
        transcript: m.transcript,
        claim_counts: counts.get(m.id) ?? emptyCounts(),
      })),
    };
  });

  app.get("/meetings/:id", async (request) => {
    requireCtx(request);
    const { id } = request.params as { id: string };
    const meeting = await loadMeeting(id);
    return { meeting };
  });

  /**
   * Retry a failed meeting from the stage it died in. Bot dispatch failures
   * re-dispatch; downstream failures re-enqueue the job that failed, since the
   * upstream artifacts are already in R2.
   */
  app.post("/meetings/:id/retry", async (request, reply) => {
    const ctx = requireCtx(request);
    const { id } = request.params as { id: string };

    const meeting = await prisma.meeting.findUnique({ where: { id, deletedAt: null } });
    if (!meeting) throw ApiError.notFound(`Meeting ${id} not found`);
    if (meeting.status !== MeetingStatus.failed) {
      throw ApiError.conflict(`Meeting is ${meeting.status}, not failed — nothing to retry`);
    }

    const priorStatus = await lastNonFailedStatus(meeting.id);
    const stage = meeting.failedStage ?? RETRY_STAGE_FOR_STATUS[priorStatus] ?? "dispatch";

    if (stage === "extract" && meeting.recallTranscriptId) {
      await transition(prisma, {
        meetingId: meeting.id,
        to: MeetingStatus.transcript_ready,
        reason: "retry: re-running extraction",
        force: true,
      });
      await extractQueue.add(
        "extract",
        { meetingId: meeting.id, tenantId: ctx.tenantId },
        { jobId: `extract-${meeting.id}-${Date.now()}` },
      );
    } else if (stage === "ingest-recording" && meeting.recallRecordingId) {
      await transition(prisma, {
        meetingId: meeting.id,
        to: MeetingStatus.media_processing,
        reason: "retry: re-ingesting recording",
        force: true,
      });
      await ingestRecordingQueue.add(
        "ingest",
        {
          meetingId: meeting.id,
          tenantId: ctx.tenantId,
          recordingId: meeting.recallRecordingId,
        },
        { jobId: `recording-${meeting.recallRecordingId}-${Date.now()}` },
      );
    } else {
      const bot = await createBot({
        meetingUrl: meeting.meetingUrl,
        joinAt: meeting.joinAt,
        metadata: { mcos_meeting_id: meeting.id, mcos_tenant: ctx.tenantSlug },
      });
      await transition(prisma, {
        meetingId: meeting.id,
        to: MeetingStatus.bot_scheduled,
        reason: "retry: bot re-dispatched",
        patch: { recallBotId: bot.id, failureReason: null, failedStage: null },
        force: true,
      });
    }

    return reply.status(202).send({ meeting: await loadMeeting(meeting.id) });
  });

  /**
   * Deletion path (consent / PDPL shaped, kept simple).
   *
   * R2 objects and the raw evidence rows are destroyed. Claims already merged
   * into a brief version SURVIVE — positioning memory does not silently lose
   * its content — but their evidence is marked redacted and the UI renders it
   * as such. The review audit log is never deleted.
   */
  app.delete("/meetings/:id", async (request, reply) => {
    requireCtx(request);
    const { id } = request.params as { id: string };

    const meeting = await prisma.meeting.findUnique({
      where: { id },
      include: { artifacts: true },
    });
    if (!meeting) throw ApiError.notFound(`Meeting ${id} not found`);

    await deleteObjects(meeting.artifacts.filter((a) => !a.purgedAt).map((a) => a.r2Key));

    const redactedAt = new Date();
    await prisma.$transaction(async (tx) => {
      await tx.briefClaim.updateMany({
        where: { meetingId: meeting.id },
        data: { evidenceRedacted: true, verbatimQuote: REDACTED },
      });
      await tx.artifact.updateMany({
        where: { meetingId: meeting.id },
        data: { purgedAt: redactedAt },
      });

      // Claims that never reached a brief are destroyed outright. Claims that
      // did are kept and scrubbed — the brief must not silently lose content.
      await tx.candidateClaim.deleteMany({ where: { meetingId: meeting.id, mergedAt: null } });
      await tx.candidateClaim.updateMany({
        where: { meetingId: meeting.id },
        data: { verbatimQuote: REDACTED },
      });

      // Deleting the transcript cascades its segments and, through them, the
      // claim_segments rows — so the surviving claims genuinely have no
      // evidence left to read, which is what `evidenceRedacted` announces.
      await tx.transcript.deleteMany({ where: { meetingId: meeting.id } });

      // The evidence_source row is append-only and is NOT deleted: removing it
      // would cascade into the merged claims and take the brief with it. It is
      // scrubbed to a tombstone instead.
      await tx.evidenceSource.updateMany({
        where: { meetingId: meeting.id },
        data: { externalId: null, metadata: { redacted: true, redacted_at: redactedAt.toISOString() } },
      });

      await tx.meeting.update({
        where: { id: meeting.id },
        data: { deletedAt: redactedAt, meetingUrl: REDACTED },
      });
    });

    return reply.status(204).send();
  });

  /** Presigned GET for an artifact. One hour; R2 allows up to seven days. */
  app.get("/meetings/:id/artifacts/:kind/url", async (request) => {
    requireCtx(request);
    const { id, kind } = request.params as { id: string; kind: string };
    if (!(kind in ArtifactKind)) throw ApiError.badRequest(`Unknown artifact kind "${kind}"`);

    const artifact = await prisma.artifact.findUnique({
      where: { meetingId_kind: { meetingId: id, kind: kind as ArtifactKind } },
    });
    if (!artifact) throw ApiError.notFound(`No ${kind} artifact for meeting ${id}`);
    if (artifact.purgedAt) throw ApiError.conflict("Artifact was purged");

    const { url, expiresAt } = await presignGet(artifact.r2Key);
    return { url, expires_at: expiresAt.toISOString() };
  });
}

/* ---------------------------------------------------------------------- */

async function loadMeeting(id: string) {
  const meeting = await prisma.meeting.findUnique({
    where: { id },
    include: {
      artifacts: true,
      transitions: { orderBy: { occurredAt: "asc" } },
      transcript: { select: { segmentCount: true, wordCount: true, durationMs: true, languageCode: true } },
      extractionRuns: { orderBy: { startedAt: "desc" }, take: 1 },
    },
  });
  if (!meeting) throw ApiError.notFound(`Meeting ${id} not found`);

  const counts = await claimCounts([meeting.id]);
  return {
    ...serializeMeeting(meeting),
    artifacts: meeting.artifacts.map(serializeArtifact),
    transitions: meeting.transitions.map((t) => ({
      from: t.fromStatus,
      to: t.toStatus,
      reason: t.reason,
      at: t.occurredAt.toISOString(),
    })),
    transcript: meeting.transcript,
    extraction: meeting.extractionRuns[0]
      ? {
          status: meeting.extractionRuns[0].status,
          model: meeting.extractionRuns[0].model,
          chunks: meeting.extractionRuns[0].chunkCount,
          proposed: meeting.extractionRuns[0].proposedCount,
          dropped: meeting.extractionRuns[0].droppedCount,
          duplicates: meeting.extractionRuns[0].duplicateCount,
          persisted: meeting.extractionRuns[0].persistedCount,
          error: meeting.extractionRuns[0].error,
        }
      : null,
    claim_counts: counts.get(meeting.id) ?? emptyCounts(),
  };
}

type Counts = Record<ClaimStatus, number> & { total: number };
const emptyCounts = (): Counts => ({
  proposed: 0,
  approved: 0,
  rejected: 0,
  edited: 0,
  superseded: 0,
  total: 0,
});

async function claimCounts(meetingIds: string[]): Promise<Map<string, Counts>> {
  const map = new Map<string, Counts>();
  if (meetingIds.length === 0) return map;

  const rows = await prisma.candidateClaim.groupBy({
    by: ["meetingId", "status"],
    where: { meetingId: { in: meetingIds } },
    _count: { _all: true },
  });

  for (const row of rows) {
    const entry = map.get(row.meetingId) ?? emptyCounts();
    entry[row.status] = row._count._all;
    entry.total += row._count._all;
    map.set(row.meetingId, entry);
  }
  return map;
}

async function lastNonFailedStatus(meetingId: string): Promise<MeetingStatus> {
  const prior = await prisma.stateTransition.findFirst({
    where: { meetingId, toStatus: { not: MeetingStatus.failed } },
    orderBy: { occurredAt: "desc" },
  });
  return prior?.toStatus ?? MeetingStatus.draft;
}

function serializeMeeting(m: {
  id: string;
  title: string | null;
  digest: string | null;
  meetingUrl: string;
  joinAt: Date | null;
  status: MeetingStatus;
  failureReason: string | null;
  failedStage: string | null;
  platform: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  createdAt: Date;
  recallBotId: string | null;
}) {
  return {
    id: m.id,
    title: m.title,
    digest: m.digest,
    meeting_url: m.meetingUrl,
    join_at: m.joinAt?.toISOString() ?? null,
    status: m.status,
    failure_reason: m.failureReason,
    failed_stage: m.failedStage,
    platform: m.platform,
    started_at: m.startedAt?.toISOString() ?? null,
    ended_at: m.endedAt?.toISOString() ?? null,
    created_at: m.createdAt.toISOString(),
    recall_bot_id: m.recallBotId,
  };
}

function serializeArtifact(a: {
  kind: ArtifactKind;
  r2Key: string;
  bytes: bigint;
  contentType: string;
  checksum: string | null;
  purgedAt: Date | null;
}) {
  return {
    kind: a.kind,
    r2_key: a.r2Key,
    bytes: Number(a.bytes),
    content_type: a.contentType,
    checksum: a.checksum,
    purged: Boolean(a.purgedAt),
  };
}

function detectPlatform(url: string): string | null {
  const host = safeHost(url);
  if (!host) return null;
  if (host.includes("zoom")) return "zoom";
  if (host.includes("meet.google")) return "google_meet";
  if (host.includes("teams.microsoft") || host.includes("teams.live")) return "microsoft_teams";
  if (host.includes("webex")) return "webex";
  return null;
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export { Prisma };
