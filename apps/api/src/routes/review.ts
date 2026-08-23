import type { FastifyInstance } from "fastify";
import { ClaimStatus, ClaimType, MeetingStatus, ReviewAction } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db.js";
import { ApiError, requireCtx } from "../http.js";
import { CLAIM_TYPE_LABEL } from "../domain/claims.js";
import { formatTimestamp } from "../domain/transcript.js";

const querySchema = z.object({
  status: z.nativeEnum(ClaimStatus).default(ClaimStatus.proposed),
  type: z.nativeEnum(ClaimType).optional(),
  meeting_id: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

const noteSchema = z.object({ note: z.string().trim().max(1000).optional() }).default({});
const editSchema = z.object({
  text: z.string().trim().min(3).max(2000),
  note: z.string().trim().max(1000).optional(),
});

/**
 * The review gate. This is the only write path into context memory, and every
 * decision that passes through it lands in review_decisions — an append-only
 * audit log that is never updated and never deleted.
 */
export async function reviewRoutes(app: FastifyInstance): Promise<void> {
  app.get("/review-queue", async (request) => {
    requireCtx(request);
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) throw ApiError.badRequest("Invalid query", parsed.error.flatten());
    const { status, type, meeting_id, limit } = parsed.data;

    const claims = await prisma.candidateClaim.findMany({
      where: {
        status,
        ...(type ? { type } : {}),
        ...(meeting_id ? { meetingId: meeting_id } : {}),
      },
      orderBy: [{ type: "asc" }, { confidence: "desc" }, { timestampMs: "asc" }],
      take: limit,
      include: {
        meeting: { select: { id: true, title: true, meetingUrl: true, startedAt: true } },
        segments: { include: { segment: true } },
      },
    });

    const byType = await prisma.candidateClaim.groupBy({
      by: ["type"],
      where: { status: ClaimStatus.proposed },
      _count: { _all: true },
    });

    return {
      claims: claims.map(serializeClaim),
      counts_by_type: Object.fromEntries(byType.map((r) => [r.type, r._count._all])),
      total: claims.length,
    };
  });

  app.post("/claims/:id/approve", async (request) => {
    const ctx = requireCtx(request);
    const { id } = request.params as { id: string };
    const parsed = noteSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw ApiError.badRequest("Invalid body", parsed.error.flatten());

    return decide({
      claimId: id,
      reviewer: ctx.reviewer,
      action: ReviewAction.approve,
      status: ClaimStatus.approved,
      note: parsed.data.note,
    });
  });

  app.post("/claims/:id/reject", async (request) => {
    const ctx = requireCtx(request);
    const { id } = request.params as { id: string };
    const parsed = noteSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw ApiError.badRequest("Invalid body", parsed.error.flatten());

    return decide({
      claimId: id,
      reviewer: ctx.reviewer,
      action: ReviewAction.reject,
      status: ClaimStatus.rejected,
      note: parsed.data.note,
    });
  });

  /**
   * Edit-then-approve is ONE action, not two.
   *
   * A reviewer who rewrites a claim has already decided to keep it; making
   * them press approve afterwards adds a step and invites half-finished edits
   * sitting in the queue looking approved. The audit row records both the text
   * they were shown and the text they wrote.
   */
  app.patch("/claims/:id", async (request) => {
    const ctx = requireCtx(request);
    const { id } = request.params as { id: string };
    const parsed = editSchema.safeParse(request.body);
    if (!parsed.success) throw ApiError.badRequest("Invalid edit", parsed.error.flatten());

    return decide({
      claimId: id,
      reviewer: ctx.reviewer,
      action: ReviewAction.edit_approve,
      status: ClaimStatus.edited,
      note: parsed.data.note,
      editedText: parsed.data.text,
    });
  });

  /** The audit log, readable. Append-only, newest first. */
  app.get("/review-decisions", async (request) => {
    requireCtx(request);
    const limit = Math.min(Number((request.query as { limit?: string }).limit ?? 100), 500);
    const decisions = await prisma.reviewDecision.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
      include: { claim: { select: { id: true, type: true, text: true, meetingId: true } } },
    });
    return {
      decisions: decisions.map((d) => ({
        id: d.id,
        action: d.action,
        reviewer: d.reviewer,
        at: d.createdAt.toISOString(),
        note: d.note,
        previous_text: d.previousText,
        edited_text: d.editedText,
        claim: d.claim,
      })),
    };
  });
}

async function decide(args: {
  claimId: string;
  reviewer: string;
  action: ReviewAction;
  status: ClaimStatus;
  note?: string;
  editedText?: string;
}) {
  return prisma.$transaction(async (tx) => {
    const claim = await tx.candidateClaim.findUnique({
      where: { id: args.claimId },
      include: { meeting: { select: { id: true, status: true } } },
    });
    if (!claim) throw ApiError.notFound(`Claim ${args.claimId} not found`);

    const previousText = claim.editedText ?? claim.text;

    const updated = await tx.candidateClaim.update({
      where: { id: claim.id },
      data: {
        status: args.status,
        decidedAt: new Date(),
        ...(args.editedText ? { editedText: args.editedText } : {}),
        // A re-decision after a merge makes the claim eligible for the next
        // brief version, which is how an edit reaches the brief as a delta.
        ...(claim.mergedAt ? { mergedAt: null } : {}),
      },
    });

    await tx.reviewDecision.create({
      data: {
        tenantId: claim.tenantId,
        claimId: claim.id,
        action: args.action,
        reviewer: args.reviewer,
        previousText,
        editedText: args.editedText ?? null,
        note: args.note ?? null,
      },
    });

    // Once nothing is left proposed, the meeting has been fully reviewed.
    const remaining = await tx.candidateClaim.count({
      where: { meetingId: claim.meetingId, status: ClaimStatus.proposed },
    });
    if (remaining === 0 && claim.meeting.status === MeetingStatus.in_review) {
      await tx.meeting.update({
        where: { id: claim.meetingId },
        data: { updatedAt: new Date() },
      });
    }

    return {
      claim: {
        id: updated.id,
        type: updated.type,
        status: updated.status,
        text: updated.editedText ?? updated.text,
        decided_at: updated.decidedAt?.toISOString() ?? null,
      },
      remaining_in_meeting: remaining,
    };
  });
}

type ClaimRow = {
  id: string;
  type: ClaimType;
  text: string;
  editedText: string | null;
  confidence: number;
  status: ClaimStatus;
  verbatimQuote: string;
  speaker: string;
  timestampMs: number;
  createdAt: Date;
  meeting: { id: string; title: string | null; meetingUrl: string; startedAt: Date | null };
  segments: Array<{ segment: { id: string; idx: number; speaker: string; startMs: number; text: string } }>;
};

/**
 * Provenance travels with the claim, always. The review card cannot render
 * without the quote, speaker and timestamp, because a reviewer approving a
 * claim they cannot check is not a review gate.
 */
function serializeClaim(claim: ClaimRow) {
  return {
    id: claim.id,
    type: claim.type,
    type_label: CLAIM_TYPE_LABEL[claim.type],
    text: claim.editedText ?? claim.text,
    original_text: claim.text,
    confidence: claim.confidence,
    status: claim.status,
    created_at: claim.createdAt.toISOString(),
    evidence: {
      verbatim_quote: claim.verbatimQuote,
      speaker: claim.speaker,
      timestamp_ms: claim.timestampMs,
      timestamp_label: formatTimestamp(claim.timestampMs),
      segments: claim.segments
        .map((s) => ({
          id: s.segment.id,
          idx: s.segment.idx,
          speaker: s.segment.speaker,
          start_ms: s.segment.startMs,
          text: s.segment.text,
        }))
        .sort((a, b) => a.start_ms - b.start_ms),
    },
    meeting: {
      id: claim.meeting.id,
      title: claim.meeting.title,
      meeting_url: claim.meeting.meetingUrl,
      started_at: claim.meeting.startedAt?.toISOString() ?? null,
    },
  };
}
