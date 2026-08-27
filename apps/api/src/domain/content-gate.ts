import {
  ContentArchetype,
  ContentBriefAction,
  ContentBriefStatus,
  ContentChannel,
  ContentMixSlot,
  EvidenceTier,
  ExpectedMetric,
  Prisma,
} from "@prisma/client";
import { prisma } from "../db.js";
import { ApiError } from "../http.js";
import { frameworkById, isKnownFrameworkId } from "./studio/frameworks.js";

/**
 * THE CONTENT-BRIEF GATE.
 *
 * ADR-6 (ARCHITECTURE.md §7) and §6's boundary table: this module is the only
 * place in `src/` that may write a `status` onto a content_brief.
 * `tests/content-gate.test.ts` enforces that statically, the same way
 * `tests/review-gate.test.ts` enforces it for `domain/review-gate.ts` — by
 * scanning every `contentBrief.<write>` call site in the tree.
 *
 * "Reuse the review gate" (05 §3) does not mean the same table:
 * `review_decisions.claim_id` is a required FK to `candidate_claims`
 * (schema.prisma:453), so a ContentBrief id cannot live there additively. What
 * is reused is the DISCIPLINE — one function, one transaction, the audit row
 * and the status change landing together or not at all — cloned here for a
 * brief's own append-only `ContentBriefDecision` table. `domain/review-gate.ts`
 * itself is off-limits (ARCHITECTURE.md §6) and is not touched or imported by
 * this file.
 */

export type ContentGateAction = "approve" | "reject" | "edit_approve" | "undo";

export type DecidedContentBrief = {
  id: string;
  status: ContentBriefStatus;
  hook_text: string;
  archetype: string;
  edited_from: string | null;
  decided_at: string | null;
};

export type ContentGateResult = {
  brief: DecidedContentBrief;
  decision_id: string;
  /** The row this decision produced (edit-approve) or withdrew (undo), if any. */
  result_brief: DecidedContentBrief | null;
};

/** A ContentBrief row as it exists inside a gate transaction. */
type BriefRow = {
  id: string;
  tenantId: string;
  briefVersionId: string;
  claimIds: string[];
  claimSnapshots: Prisma.JsonValue;
  frameworkId: string;
  frameworkEvidenceTier: EvidenceTier;
  archetype: ContentArchetype;
  hookText: string;
  emphasisWord: string;
  beats: Prisma.JsonValue;
  channel: ContentChannel;
  contentMixSlot: ContentMixSlot;
  expectedMetric: ExpectedMetric;
  status: ContentBriefStatus;
  editedFromId: string | null;
  generatedByModel: string;
  generationNote: string | null;
  createdAt: Date;
  decidedAt: Date | null;
};

function serialize(brief: BriefRow): DecidedContentBrief {
  return {
    id: brief.id,
    status: brief.status,
    hook_text: brief.hookText,
    archetype: brief.archetype,
    edited_from: brief.editedFromId,
    decided_at: brief.decidedAt?.toISOString() ?? null,
  };
}

type Tx = Omit<typeof prisma, "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends">;

type Settled = {
  brief: BriefRow;
  decisionId: string;
  result: BriefRow | null;
};

/** Prisma's "the record you asked to update was not there". */
const RECORD_NOT_FOUND = "P2025";

/**
 * Record one human decision about one ContentBrief.
 *
 * Runs in a single transaction: brief status, any successor row, and the
 * content_brief_decisions entry either all land or none do — the same
 * one-transaction discipline as `domain/review-gate.ts`'s `recordDecision`.
 */
export async function recordContentBriefDecision(args: {
  contentBriefId: string;
  reviewer: string;
  action: ContentGateAction;
  /** Required for `edit_approve` — the fields the reviewer rewrote. */
  edits?: ContentBriefEdits;
  note?: string;
  /** Refuses the decision if the caller's belief about the current status is stale. */
  expectStatus?: ContentBriefStatus;
}): Promise<ContentGateResult> {
  return prisma.$transaction(async (tx) => {
    const brief = (await tx.contentBrief.findUnique({
      where: { id: args.contentBriefId },
    })) as BriefRow | null;
    if (!brief) throw ApiError.notFound(`Content brief ${args.contentBriefId} not found`);

    if (args.expectStatus && brief.status !== args.expectStatus) {
      throw ApiError.conflict(
        `Content brief ${brief.id} was ${brief.status} by someone else while this batch was being prepared`,
      );
    }

    switch (args.action) {
      case "approve":
        return finish(await settle(tx, brief, ContentBriefStatus.approved, ContentBriefAction.approve, args));
      case "reject":
        return finish(await settle(tx, brief, ContentBriefStatus.rejected, ContentBriefAction.reject, args));
      case "edit_approve":
        return finish(await editApprove(tx, brief, args));
      case "undo":
        return finish(await undo(tx, brief, args));
    }
  });
}

async function guardedUpdate(
  tx: Tx,
  brief: BriefRow,
  where: { status: ContentBriefStatus },
  data: Record<string, unknown>,
): Promise<BriefRow> {
  try {
    return (await tx.contentBrief.update({
      where: { id: brief.id, ...where },
      data,
    })) as BriefRow;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === RECORD_NOT_FOUND) {
      throw ApiError.conflict(
        `Content brief ${brief.id} changed while you were deciding it. Reload the queue and look again.`,
      );
    }
    throw error;
  }
}

function refuseSuperseded(brief: BriefRow): void {
  if (brief.status === ContentBriefStatus.superseded) {
    throw ApiError.conflict(
      `Content brief ${brief.id} was replaced by an edit and is history now. Decide its successor instead.`,
    );
  }
}

/** Approve or reject: one status, one audit row, nothing else moves. */
async function settle(
  tx: Tx,
  brief: BriefRow,
  status: typeof ContentBriefStatus.approved | typeof ContentBriefStatus.rejected,
  action: typeof ContentBriefAction.approve | typeof ContentBriefAction.reject,
  args: { reviewer: string; note?: string },
): Promise<Settled> {
  refuseSuperseded(brief);

  if (brief.status === status) {
    throw ApiError.conflict(`Content brief ${brief.id} is already ${status}`);
  }

  const updated = await guardedUpdate(tx, brief, { status: brief.status }, { status, decidedAt: new Date() });

  const decision = await tx.contentBriefDecision.create({
    data: {
      tenantId: brief.tenantId,
      contentBriefId: brief.id,
      action,
      reviewer: args.reviewer,
      note: args.note ?? null,
    },
  });

  return { brief: updated, decisionId: decision.id, result: null };
}

export type ContentBriefEdits = {
  hookText?: string;
  emphasisWord?: string;
  beats?: unknown;
  /** A reviewer may redirect the brief to a different catalogued framework —
   *  its evidence tier is re-resolved and re-frozen, same as at generation. */
  frameworkId?: string;
};

/**
 * Edit-then-approve is ONE action, not two — same reasoning as
 * `review-gate.ts`'s `editApprove`. The rewrite becomes a NEW row: the brief a
 * human was shown is evidence of what they agreed to, and rewriting it in
 * place destroys that. `claimIds`/`claimSnapshots` always carry forward
 * untouched — an edit changes copy or framing, not provenance; changing which
 * claims back a brief is a new generation, not an edit.
 */
async function editApprove(
  tx: Tx,
  brief: BriefRow,
  args: { reviewer: string; edits?: ContentBriefEdits; note?: string },
): Promise<Settled> {
  refuseSuperseded(brief);

  const edits = args.edits ?? {};
  const hookText = edits.hookText?.trim();
  const emphasisWord = edits.emphasisWord?.trim();
  const frameworkId = edits.frameworkId;

  if (!hookText && !emphasisWord && edits.beats === undefined && !frameworkId) {
    throw ApiError.badRequest("An edit needs at least one changed field");
  }
  if (frameworkId && !isKnownFrameworkId(frameworkId)) {
    throw ApiError.unprocessable(`Unknown framework_id "${frameworkId}"`);
  }
  const framework = frameworkId ? frameworkById(frameworkId) : undefined;

  const rootId = brief.editedFromId ?? brief.id;

  // Written directly as `approved` — a new row created already-decided, the
  // same shape as `review-gate.ts`'s successor claim. This file is the only
  // one in `src/` permitted to write a `status:` onto a content_brief (see
  // the source-scan guard in tests/content-gate.test.ts), so this is exactly
  // the write the guard exists to find here.
  const successor = (await tx.contentBrief.create({
    data: {
      tenantId: brief.tenantId,
      briefVersionId: brief.briefVersionId,
      claimIds: brief.claimIds,
      claimSnapshots: brief.claimSnapshots as Prisma.InputJsonValue,
      frameworkId: framework?.id ?? brief.frameworkId,
      frameworkEvidenceTier: framework?.evidenceTier ?? brief.frameworkEvidenceTier,
      archetype: brief.archetype,
      hookText: hookText ?? brief.hookText,
      emphasisWord: emphasisWord ?? brief.emphasisWord,
      beats: (edits.beats ?? brief.beats) as Prisma.InputJsonValue,
      channel: brief.channel,
      contentMixSlot: brief.contentMixSlot,
      expectedMetric: brief.expectedMetric,
      status: ContentBriefStatus.approved,
      generatedByModel: brief.generatedByModel,
      generationNote: brief.generationNote,
      editedFromId: rootId,
      decidedAt: new Date(),
    },
  })) as unknown as BriefRow;

  const superseded = await guardedUpdate(
    tx,
    brief,
    { status: brief.status },
    { status: ContentBriefStatus.superseded, decidedAt: new Date() },
  );

  const decision = await tx.contentBriefDecision.create({
    data: {
      tenantId: brief.tenantId,
      contentBriefId: brief.id,
      action: ContentBriefAction.edit_approve,
      reviewer: args.reviewer,
      note: args.note ?? null,
      resultBriefId: successor.id,
    },
  });

  return { brief: superseded, decisionId: decision.id, result: successor };
}

/**
 * Undo the last decision on a brief by making another one — never a delete.
 * Once a decision has reached `plan.build` (i.e. a RenderPlan references this
 * brief) it can no longer be undone: RenderPlan is append-only (G13), so
 * un-approving a brief a plan was already built from would leave the plan
 * pointing at a brief history no longer agrees was ever approved.
 */
async function undo(tx: Tx, brief: BriefRow, args: { reviewer: string; note?: string }): Promise<Settled> {
  const last = await tx.contentBriefDecision.findFirst({
    where: { contentBriefId: brief.id },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  if (!last) throw ApiError.conflict(`Content brief ${brief.id} has no decision to undo`);
  if (last.action === ContentBriefAction.undo) {
    throw ApiError.conflict(`The last decision on content brief ${brief.id} was already undone`);
  }

  const successor =
    last.action === ContentBriefAction.edit_approve && last.resultBriefId
      ? ((await tx.contentBrief.findUnique({ where: { id: last.resultBriefId } })) as BriefRow | null)
      : null;

  if (successor) {
    const plansOnSuccessor = await tx.renderPlan.count({ where: { contentBriefId: successor.id } });
    if (plansOnSuccessor > 0) {
      throw ApiError.conflict(
        `The edit of content brief ${brief.id} already has a render plan built from it and cannot be withdrawn`,
      );
    }
    if (successor.status === ContentBriefStatus.superseded) {
      throw ApiError.conflict(
        `The edit of content brief ${brief.id} was itself edited. Undo the newer edit first.`,
      );
    }
  } else {
    const plansOnRoot = await tx.renderPlan.count({ where: { contentBriefId: brief.id } });
    if (plansOnRoot > 0) {
      throw ApiError.conflict(
        `Content brief ${brief.id} already has a render plan built from it. Decide again instead.`,
      );
    }
  }

  let withdrawn: BriefRow | null = null;
  if (successor) {
    withdrawn = await guardedUpdate(
      tx,
      successor,
      { status: successor.status },
      { status: ContentBriefStatus.rejected, decidedAt: new Date() },
    );
  }

  const restored = await guardedUpdate(
    tx,
    brief,
    { status: brief.status },
    { status: ContentBriefStatus.proposed, decidedAt: null },
  );

  const decision = await tx.contentBriefDecision.create({
    data: {
      tenantId: brief.tenantId,
      contentBriefId: brief.id,
      action: ContentBriefAction.undo,
      reviewer: args.reviewer,
      note: args.note ?? `undo of ${last.action}`,
      resultBriefId: withdrawn?.id ?? null,
    },
  });

  return { brief: restored, decisionId: decision.id, result: withdrawn };
}

function finish(settled: Settled): ContentGateResult {
  return {
    brief: serialize(settled.brief),
    decision_id: settled.decisionId,
    result_brief: settled.result ? serialize(settled.result) : null,
  };
}

/**
 * The enforcement point for 05 §3 / ARCHITECTURE.md §6: "Only `status='approved'`
 * briefs can enter `plan.build`." Called by the plan-creation service, never
 * by a route directly — service layer, not route layer.
 */
export async function requireApprovedContentBrief(contentBriefId: string): Promise<{ id: string; tenantId: string }> {
  const brief = await prisma.contentBrief.findUnique({
    where: { id: contentBriefId },
    select: { id: true, tenantId: true, status: true },
  });
  if (!brief) throw ApiError.notFound(`Content brief ${contentBriefId} not found`);
  if (brief.status !== ContentBriefStatus.approved) {
    throw ApiError.unprocessable(
      `Content brief ${contentBriefId} is ${brief.status}, not approved. Only approved briefs may enter plan.build.`,
    );
  }
  return { id: brief.id, tenantId: brief.tenantId };
}
