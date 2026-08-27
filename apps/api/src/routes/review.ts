import type { FastifyInstance } from "fastify";
import { ClaimStatus, ClaimType } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db.js";
import { ApiError, requireCtx } from "../http.js";
import { CLAIM_TYPE_LABEL, confidenceBand } from "../domain/claims.js";
import { bulkApprove, recordDecision } from "../domain/review-gate.js";
import { formatTimestamp } from "../domain/transcript.js";

const querySchema = z.object({
  status: z.nativeEnum(ClaimStatus).default(ClaimStatus.proposed),
  type: z.nativeEnum(ClaimType).optional(),
  meeting_id: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

const decisionsQuerySchema = z.object({
  meeting_id: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const noteSchema = z.object({ note: z.string().trim().max(1000).optional() }).default({});
const editSchema = z.object({
  text: z.string().trim().min(3).max(2000),
  note: z.string().trim().max(1000).optional(),
});
const bulkSchema = z.object({
  claim_ids: z.array(z.string().uuid()).min(1).max(200),
  note: z.string().trim().max(1000).optional(),
});

/**
 * The review gate's HTTP surface.
 *
 * Every route here is a thin shell around `domain/review-gate.ts`, which is the
 * only code path in the service allowed to write a claim's status. Keeping the
 * routes dumb is what makes that claim checkable — see the static assertion in
 * tests/review-gate.test.ts.
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
      where: { status: ClaimStatus.proposed, ...(meeting_id ? { meetingId: meeting_id } : {}) },
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

    return recordDecision({
      claimId: id,
      reviewer: ctx.reviewer,
      action: "approve",
      note: parsed.data.note,
    });
  });

  app.post("/claims/:id/reject", async (request) => {
    const ctx = requireCtx(request);
    const { id } = request.params as { id: string };
    const parsed = noteSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw ApiError.badRequest("Invalid body", parsed.error.flatten());

    return recordDecision({
      claimId: id,
      reviewer: ctx.reviewer,
      action: "reject",
      note: parsed.data.note,
    });
  });

  /**
   * Edit-then-approve is ONE action, not two. The gate writes the rewrite as a
   * new approved claim and supersedes the original, so the text a human was
   * shown survives alongside the text they wrote.
   */
  app.patch("/claims/:id", async (request) => {
    const ctx = requireCtx(request);
    const { id } = request.params as { id: string };
    const parsed = editSchema.safeParse(request.body);
    if (!parsed.success) throw ApiError.badRequest("Invalid edit", parsed.error.flatten());

    return recordDecision({
      claimId: id,
      reviewer: ctx.reviewer,
      action: "edit_approve",
      text: parsed.data.text,
      note: parsed.data.note,
    });
  });

  /**
   * Undo. Not a delete — a second decision that reverses the first, with both
   * kept. Registered before `/claims/:id/...` siblings is unnecessary in
   * Fastify's radix router, but the shape matters: this is a write, so it is a
   * POST, and it goes through the same gate as everything else.
   */
  app.post("/claims/:id/undo", async (request) => {
    const ctx = requireCtx(request);
    const { id } = request.params as { id: string };
    const parsed = noteSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw ApiError.badRequest("Invalid body", parsed.error.flatten());

    return recordDecision({
      claimId: id,
      reviewer: ctx.reviewer,
      action: "undo",
      note: parsed.data.note,
    });
  });

  /**
   * Keep every high-confidence claim in one action.
   *
   * Answers 200 with both halves rather than failing the batch: the reviewer
   * needs to know which ones were held back and why, and a 4xx that discards
   * thirteen good approvals over one flagged claim is not an improvement.
   */
  app.post("/claims/bulk-approve", async (request) => {
    const ctx = requireCtx(request);
    const parsed = bulkSchema.safeParse(request.body);
    if (!parsed.success) throw ApiError.badRequest("Invalid batch", parsed.error.flatten());

    const result = await bulkApprove({
      claimIds: parsed.data.claim_ids,
      reviewer: ctx.reviewer,
      note: parsed.data.note,
    });

    return {
      ...result,
      approved_count: result.approved.length,
      error_count: result.errors.length,
    };
  });

  /** The audit log, readable. Append-only, newest first. */
  app.get("/review-decisions", async (request) => {
    requireCtx(request);
    const parsed = decisionsQuerySchema.safeParse(request.query);
    if (!parsed.success) throw ApiError.badRequest("Invalid query", parsed.error.flatten());
    const { meeting_id, limit } = parsed.data;

    const decisions = await prisma.reviewDecision.findMany({
      where: meeting_id ? { claim: { meetingId: meeting_id } } : {},
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
      include: {
        claim: { select: { id: true, type: true, text: true, editedText: true, meetingId: true } },
      },
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
        result_claim_id: d.resultClaimId,
        claim: {
          id: d.claim.id,
          type: d.claim.type,
          type_label: CLAIM_TYPE_LABEL[d.claim.type],
          text: d.claim.editedText ?? d.claim.text,
          meeting_id: d.claim.meetingId,
        },
      })),
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
  editedFromId: string | null;
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
    confidence_band: confidenceBand(claim.confidence),
    status: claim.status,
    edited_from: claim.editedFromId,
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
