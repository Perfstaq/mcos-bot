import { ClaimStatus, ClaimType, MeetingStatus, ReviewAction } from "@prisma/client";
import { prisma } from "../db.js";
import { ApiError } from "../http.js";
import { confidenceBand, editDedupeKey } from "./claims.js";

/**
 * THE REVIEW GATE.
 *
 * This module is the only place in `src/` that may write a `status` onto a
 * candidate_claim. Everything else — extraction, the merge, the purge — either
 * creates claims at the schema default (`proposed`) or touches columns that are
 * not the status. `tests/review-gate.test.ts` enforces that statically, by
 * scanning every `candidateClaim.<write>` call site in the tree, so a new write
 * path cannot be added by accident in some future route file.
 *
 * The reason it is one function and not four routes: the audit row and the
 * status change have to be the same transaction. A claim that is approved with
 * no decision row behind it is indistinguishable, later, from a claim the
 * machine approved itself — and "a human decided this" is the only thing the
 * brief's provenance actually rests on.
 */

export type GateAction = "approve" | "reject" | "edit_approve" | "undo";

export type DecidedClaim = {
  id: string;
  type: ClaimType;
  status: ClaimStatus;
  text: string;
  confidence: number;
  edited_from: string | null;
  decided_at: string | null;
};

export type GateResult = {
  claim: DecidedClaim;
  decision_id: string;
  /** The row the decision produced (edit) or withdrew (undo), if any. */
  result_claim: DecidedClaim | null;
  remaining_in_meeting: number;
};

export type BulkErrorCode = "not_found" | "not_high_confidence" | "already_decided";

export type BulkResult = {
  approved: DecidedClaim[];
  errors: Array<{ claim_id: string; code: BulkErrorCode; message: string }>;
};

/** A claim as it exists inside a gate transaction. */
type ClaimRow = {
  id: string;
  tenantId: string;
  meetingId: string;
  evidenceSourceId: string;
  extractionRunId: string;
  type: ClaimType;
  text: string;
  editedText: string | null;
  confidence: number;
  status: ClaimStatus;
  verbatimQuote: string;
  speaker: string;
  timestampMs: number;
  editedFromId: string | null;
  decidedAt: Date | null;
  mergedAt: Date | null;
};

/** What the reviewer was looking at when they decided. */
function currentText(claim: ClaimRow): string {
  return claim.editedText ?? claim.text;
}

function serialize(claim: ClaimRow): DecidedClaim {
  return {
    id: claim.id,
    type: claim.type,
    status: claim.status,
    text: currentText(claim),
    confidence: claim.confidence,
    edited_from: claim.editedFromId,
    decided_at: claim.decidedAt?.toISOString() ?? null,
  };
}

/**
 * Record one human decision about one claim.
 *
 * Runs in a single transaction: claim status, any successor row, and the
 * review_decisions entry either all land or none do.
 */
export async function recordDecision(args: {
  claimId: string;
  reviewer: string;
  action: GateAction;
  /** Required for `edit_approve` — the text the reviewer wrote. */
  text?: string;
  note?: string;
}): Promise<GateResult> {
  return prisma.$transaction(async (tx) => {
    // Tenant-scoped by the client extension in db.ts: a claim belonging to
    // another workspace simply does not exist from here, which is why every
    // cross-tenant attempt surfaces as a 404 and not a 403.
    const claim = (await tx.candidateClaim.findUnique({
      where: { id: args.claimId },
    })) as ClaimRow | null;
    if (!claim) throw ApiError.notFound(`Claim ${args.claimId} not found`);

    switch (args.action) {
      case "approve":
        return finish(tx, await settle(tx, claim, ClaimStatus.approved, ReviewAction.approve, args));
      case "reject":
        return finish(tx, await settle(tx, claim, ClaimStatus.rejected, ReviewAction.reject, args));
      case "edit_approve":
        return finish(tx, await editApprove(tx, claim, args));
      case "undo":
        return finish(tx, await undo(tx, claim, args));
    }
  });
}

type Tx = Omit<typeof prisma, "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends">;

type Settled = {
  claim: ClaimRow;
  decisionId: string;
  result: ClaimRow | null;
};

/** Approve or reject: one status, one audit row, nothing else moves. */
async function settle(
  tx: Tx,
  claim: ClaimRow,
  status: typeof ClaimStatus.approved | typeof ClaimStatus.rejected,
  action: typeof ReviewAction.approve | typeof ReviewAction.reject,
  args: { reviewer: string; note?: string },
): Promise<Settled> {
  refuseSuperseded(claim);

  const updated = (await tx.candidateClaim.update({
    where: { id: claim.id },
    data: {
      status,
      decidedAt: new Date(),
      // Re-deciding a claim that already reached the brief makes it eligible
      // for the next version, which is how a change of mind becomes a delta
      // rather than a silent rewrite of history.
      ...(claim.mergedAt ? { mergedAt: null } : {}),
    },
  })) as ClaimRow;

  const decision = await tx.reviewDecision.create({
    data: {
      tenantId: claim.tenantId,
      claimId: claim.id,
      action,
      reviewer: args.reviewer,
      previousText: currentText(claim),
      editedText: null,
      note: args.note ?? null,
    },
  });

  return { claim: updated, decisionId: decision.id, result: null };
}

/**
 * Edit-then-approve is ONE action, not two.
 *
 * A reviewer who rewrites a claim has already decided to keep it; making them
 * press approve afterwards adds a step and invites half-finished edits sitting
 * in the queue looking approved.
 *
 * The rewrite becomes a NEW row rather than an overwrite. The claim a human was
 * shown is evidence of what they agreed to, and editing it in place destroys
 * that: six months later "the model proposed X and a human approved it" would
 * read as "the model proposed Y", with Y being text no model ever wrote. The
 * original is kept, marked superseded, and the successor carries the identical
 * evidence — same quote, same speaker, same timestamp, same segment links.
 */
async function editApprove(
  tx: Tx,
  claim: ClaimRow,
  args: { reviewer: string; text?: string; note?: string },
): Promise<Settled> {
  refuseSuperseded(claim);
  const text = args.text?.trim();
  if (!text) throw ApiError.badRequest("An edit needs the text the reviewer wrote");

  // Provenance travels with the edit. A rewritten claim that lost its segment
  // links would be a claim nobody can check, which invariant 2 forbids.
  const links = await tx.claimSegment.findMany({ where: { claimId: claim.id } });
  if (links.length === 0) {
    throw ApiError.unprocessable(`Claim ${claim.id} has no evidence linkage and cannot be approved`);
  }

  const rootId = claim.editedFromId ?? claim.id;
  const revision = await tx.candidateClaim.count({ where: { editedFromId: rootId } });

  const successor = (await tx.candidateClaim.create({
    data: {
      tenantId: claim.tenantId,
      meetingId: claim.meetingId,
      evidenceSourceId: claim.evidenceSourceId,
      extractionRunId: claim.extractionRunId,
      type: claim.type,
      text,
      confidence: claim.confidence,
      status: ClaimStatus.approved,
      verbatimQuote: claim.verbatimQuote,
      speaker: claim.speaker,
      timestampMs: claim.timestampMs,
      dedupeKey: editDedupeKey(rootId, revision, text),
      editedFromId: rootId,
      decidedAt: new Date(),
    },
  })) as ClaimRow;

  await tx.claimSegment.createMany({
    data: links.map((link) => ({ claimId: successor.id, segmentId: link.segmentId })),
    skipDuplicates: true,
  });

  const superseded = (await tx.candidateClaim.update({
    where: { id: claim.id },
    data: { status: ClaimStatus.superseded, decidedAt: new Date() },
  })) as ClaimRow;

  // One human action, one audit row. Hung off the claim the reviewer was
  // actually looking at, pointing forward at what it produced.
  const decision = await tx.reviewDecision.create({
    data: {
      tenantId: claim.tenantId,
      claimId: claim.id,
      action: ReviewAction.edit_approve,
      reviewer: args.reviewer,
      previousText: currentText(claim),
      editedText: text,
      note: args.note ?? null,
      resultClaimId: successor.id,
    },
  });

  return { claim: superseded, decisionId: decision.id, result: successor };
}

/**
 * Undo the last decision on a claim by making another one.
 *
 * The reversed decision stays in the log — deleting it would make the audit
 * trail a record of what someone currently thinks rather than of what happened,
 * and the trail is the product. Once a decision has reached a brief version it
 * can no longer be undone: brief versions are immutable, so the honest way to
 * change your mind at that point is a fresh decision that lands in the next one.
 */
async function undo(
  tx: Tx,
  claim: ClaimRow,
  args: { reviewer: string; note?: string },
): Promise<Settled> {
  const last = await tx.reviewDecision.findFirst({
    where: { claimId: claim.id },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  if (!last) throw ApiError.conflict(`Claim ${claim.id} has no decision to undo`);
  if (last.action === ReviewAction.undo) {
    throw ApiError.conflict(`The last decision on claim ${claim.id} was already undone`);
  }
  if (claim.mergedAt) {
    throw ApiError.conflict(
      `Claim ${claim.id} is already part of a brief version. Decide it again instead — ` +
        "brief versions are never rewritten.",
    );
  }

  let withdrawn: ClaimRow | null = null;
  if (last.action === ReviewAction.edit_approve && last.resultClaimId) {
    const successor = (await tx.candidateClaim.findUnique({
      where: { id: last.resultClaimId },
    })) as ClaimRow | null;
    if (successor?.mergedAt) {
      throw ApiError.conflict(
        `The edit of claim ${claim.id} is already part of a brief version and cannot be withdrawn`,
      );
    }
    if (successor) {
      // Marked, never deleted. A withdrawn edit is a thing that happened.
      withdrawn = (await tx.candidateClaim.update({
        where: { id: successor.id },
        data: { status: ClaimStatus.rejected, decidedAt: new Date() },
      })) as ClaimRow;
    }
  }

  const restored = (await tx.candidateClaim.update({
    where: { id: claim.id },
    data: { status: ClaimStatus.proposed, decidedAt: null },
  })) as ClaimRow;

  const decision = await tx.reviewDecision.create({
    data: {
      tenantId: claim.tenantId,
      claimId: claim.id,
      action: ReviewAction.undo,
      reviewer: args.reviewer,
      previousText: currentText(claim),
      editedText: null,
      note: args.note ?? `undo of ${last.action}`,
      resultClaimId: withdrawn?.id ?? null,
    },
  });

  return { claim: restored, decisionId: decision.id, result: withdrawn };
}

function refuseSuperseded(claim: ClaimRow): void {
  if (claim.status === ClaimStatus.superseded) {
    throw ApiError.conflict(
      `Claim ${claim.id} was replaced by an edit and is history now. Decide its successor instead.`,
    );
  }
}

async function finish(tx: Tx, settled: Settled): Promise<GateResult> {
  const remaining = await tx.candidateClaim.count({
    where: { meetingId: settled.claim.meetingId, status: ClaimStatus.proposed },
  });

  // Once nothing is left proposed, the meeting has been fully reviewed.
  if (remaining === 0) {
    await tx.meeting.updateMany({
      where: { id: settled.claim.meetingId, status: MeetingStatus.in_review },
      data: { updatedAt: new Date() },
    });
  }

  return {
    claim: serialize(settled.claim),
    decision_id: settled.decisionId,
    result_claim: settled.result ? serialize(settled.result) : null,
    remaining_in_meeting: remaining,
  };
}

/**
 * Keep every high-confidence proposal in one action.
 *
 * The bulk path is deliberately stricter than the single one. A reviewer
 * pressing "keep all" has read a count, not fourteen claims — so anything the
 * model was not confident about, and anything a human has already ruled on,
 * comes back as a per-id error instead of being swept along. Partial success is
 * the point: one bad id must not cost the reviewer the other thirteen.
 */
export async function bulkApprove(args: {
  claimIds: string[];
  reviewer: string;
  note?: string;
}): Promise<BulkResult> {
  const approved: DecidedClaim[] = [];
  const errors: BulkResult["errors"] = [];

  // Preserve the caller's order, drop repeats: approving the same id twice in
  // one batch would write two audit rows for one human action.
  const ids = [...new Set(args.claimIds)];

  for (const claimId of ids) {
    const claim = (await prisma.candidateClaim.findUnique({ where: { id: claimId } })) as ClaimRow | null;

    if (!claim) {
      errors.push({ claim_id: claimId, code: "not_found", message: "No such claim in this workspace" });
      continue;
    }
    if (claim.status !== ClaimStatus.proposed) {
      errors.push({
        claim_id: claimId,
        code: "already_decided",
        message: `Already ${claim.status} — decide it individually to change that`,
      });
      continue;
    }
    if (confidenceBand(claim.confidence) !== "high") {
      errors.push({
        claim_id: claimId,
        code: "not_high_confidence",
        message: `Flagged at ${Math.round(claim.confidence * 100)}% confidence — read it before keeping it`,
      });
      continue;
    }

    const result = await recordDecision({
      claimId,
      reviewer: args.reviewer,
      action: "approve",
      note: args.note,
    });
    approved.push(result.claim);
  }

  return { approved, errors };
}
