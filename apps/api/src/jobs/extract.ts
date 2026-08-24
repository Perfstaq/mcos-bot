import { ExtractionStatus, MeetingStatus, Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { runWithContext } from "../context.js";
import { env } from "../env.js";
import { markFailed, transition } from "../domain/state.js";
import { chunkBySpeakerTurns, segmentHandle } from "../domain/chunking.js";
import { dedupeKey, quoteAppearsIn } from "../domain/claims.js";
import { PROMPT_VERSION, extractFromChunk, type ProposedClaim } from "../integrations/openai.js";
import { suggestActionsQueue, type ExtractJob } from "../queue.js";
import { logger } from "../logger.js";
import { withTenantContext } from "./context.js";

const log = logger.child({ job: "extract" });

/**
 * Extraction proposes; it never writes memory.
 *
 * Everything this job produces lands in candidate_claims with status
 * `proposed`. The only write path into brief_versions is a human decision in
 * the review queue. There is deliberately no flag, no confidence threshold and
 * no "auto-approve above 0.95" here — that would be a second write path, and a
 * second write path is the thing this architecture exists to prevent.
 */
export async function runExtraction(job: ExtractJob): Promise<void> {
  await withTenantContext(job.tenantId, async () => {
    const meeting = await prisma.meeting.findUnique({
      where: { id: job.meetingId },
      select: { id: true, tenantId: true, title: true, status: true, deletedAt: true },
    });
    if (!meeting || meeting.deletedAt) return;

    const transcript = await prisma.transcript.findUnique({
      where: { meetingId: meeting.id },
      include: { segments: { orderBy: { idx: "asc" } } },
    });
    if (!transcript) throw new Error(`No transcript for meeting ${meeting.id}`);

    // Idempotency: a redelivered job on an already-extracted meeting is a no-op.
    const alreadyExtracted = await prisma.extractionRun.findFirst({
      where: { meetingId: meeting.id, status: ExtractionStatus.succeeded },
    });
    if (alreadyExtracted) {
      log.info({ meetingId: meeting.id }, "extraction already succeeded, skipping");
      return;
    }

    await transition(prisma, {
      meetingId: meeting.id,
      to: MeetingStatus.extracting,
      reason: "extraction started",
    });

    const chunks = chunkBySpeakerTurns(
      transcript.segments.map((s) => ({
        id: s.id,
        idx: s.idx,
        speaker: s.speaker,
        startMs: s.startMs,
        text: s.text,
      })),
    );

    const run = await prisma.extractionRun.create({
      data: {
        tenantId: meeting.tenantId,
        meetingId: meeting.id,
        model: env.OPENAI_MODEL,
        promptVersion: PROMPT_VERSION,
        chunkCount: chunks.length,
      },
    });

    // Handle → segment row, so a cited "s0012" resolves to a real foreign key.
    const byHandle = new Map(transcript.segments.map((s) => [segmentHandle(s.idx), s]));

    let proposed = 0;
    let dropped = 0;
    let duplicates = 0;
    let persisted = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    const seen = new Set<string>();

    try {
      for (const chunk of chunks) {
        const result = await extractFromChunk({ chunk, meetingTitle: meeting.title });
        inputTokens += result.inputTokens;
        outputTokens += result.outputTokens;
        proposed += result.claims.length;

        for (const claim of result.claims) {
          const validated = validate(claim, byHandle);
          if (!validated) {
            dropped += 1;
            continue;
          }

          const key = dedupeKey(claim.type, claim.text);
          if (seen.has(key)) {
            duplicates += 1;
            continue;
          }
          seen.add(key);

          const written = await persist({
            tenantId: meeting.tenantId,
            meetingId: meeting.id,
            evidenceSourceId: transcript.evidenceSourceId,
            extractionRunId: run.id,
            claim,
            segmentIds: validated.segmentIds,
            key,
          });
          if (written) persisted += 1;
          else duplicates += 1;
        }
      }
    } catch (error) {
      await prisma.extractionRun.update({
        where: { id: run.id },
        data: {
          status: ExtractionStatus.failed,
          finishedAt: new Date(),
          error: (error as Error).message.slice(0, 500),
          proposedCount: proposed,
          droppedCount: dropped,
          duplicateCount: duplicates,
          persistedCount: persisted,
          inputTokens,
          outputTokens,
        },
      });
      throw error;
    }

    await prisma.extractionRun.update({
      where: { id: run.id },
      data: {
        status: ExtractionStatus.succeeded,
        finishedAt: new Date(),
        proposedCount: proposed,
        droppedCount: dropped,
        duplicateCount: duplicates,
        persistedCount: persisted,
        inputTokens,
        outputTokens,
      },
    });

    await transition(prisma, {
      meetingId: meeting.id,
      to: MeetingStatus.in_review,
      reason: `${persisted} claims proposed`,
    });

    log.info(
      { meetingId: meeting.id, chunks: chunks.length, proposed, dropped, duplicates, persisted },
      "extraction complete",
    );

    // Action-item suggestions ride the same trigger but not the same job: a
    // failure to suggest a follow-up must not mark a successfully extracted
    // meeting as failed.
    await suggestActionsQueue.add(
      "suggest",
      { meetingId: meeting.id, tenantId: meeting.tenantId },
      { jobId: `suggest-${meeting.id}` },
    );
  });
}

type SegmentRow = { id: string; idx: number; text: string };

/**
 * The evidence gate. A claim that fails any of these never reaches a reviewer:
 *
 *   - cites a segment id that does not exist (the model invented a handle)
 *   - cites nothing after unknown handles are removed
 *   - quotes text that does not appear in the segments it cites
 *
 * Dropping these is the point. A reviewer approving a claim is vouching for
 * the evidence attached to it, so unverifiable evidence must never be shown as
 * if it were real.
 */
function validate(
  claim: ProposedClaim,
  byHandle: Map<string, SegmentRow>,
): { segmentIds: string[] } | null {
  const resolved = claim.evidence.transcript_segment_ids
    .map((handle) => byHandle.get(handle.trim()))
    .filter((s): s is SegmentRow => Boolean(s));

  if (resolved.length === 0) return null;
  if (!quoteAppearsIn(claim.evidence.verbatim_quote, resolved.map((s) => s.text))) return null;

  return { segmentIds: resolved.map((s) => s.id) };
}

async function persist(args: {
  tenantId: string;
  meetingId: string;
  evidenceSourceId: string;
  extractionRunId: string;
  claim: ProposedClaim;
  segmentIds: string[];
  key: string;
}): Promise<boolean> {
  try {
    await prisma.$transaction(async (tx) => {
      const created = await tx.candidateClaim.create({
        data: {
          tenantId: args.tenantId,
          meetingId: args.meetingId,
          evidenceSourceId: args.evidenceSourceId,
          extractionRunId: args.extractionRunId,
          type: args.claim.type,
          text: args.claim.text,
          confidence: args.claim.confidence,
          verbatimQuote: args.claim.evidence.verbatim_quote,
          speaker: args.claim.evidence.speaker,
          timestampMs: args.claim.evidence.timestamp_ms,
          dedupeKey: args.key,
        },
      });

      await tx.claimSegment.createMany({
        data: args.segmentIds.map((segmentId) => ({ claimId: created.id, segmentId })),
        skipDuplicates: true,
      });
    });
    return true;
  } catch (error) {
    // Unique violation on (tenant_id, dedupe_key) — the same claim was already
    // proposed, by an earlier chunk or an earlier run. Collapsing it is the
    // designed behaviour, not a failure.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return false;
    }
    throw error;
  }
}

export async function failExtraction(job: ExtractJob, error: Error): Promise<void> {
  await runWithContext(
    { tenantId: job.tenantId, tenantSlug: "", reviewer: "system:worker" },
    async () => {
      await markFailed(prisma, {
        meetingId: job.meetingId,
        stage: "extract",
        reason: error.message.slice(0, 500),
      });
    },
  );
}
