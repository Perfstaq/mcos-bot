import { ClaimStatus, ClaimType, MeetingStatus, type BriefClaim } from "@prisma/client";
import { prisma } from "../db.js";
import { transition } from "./state.js";
import { CLAIM_TYPES } from "./claims.js";

export class NothingToMergeError extends Error {
  constructor() {
    super("No approved claims are waiting to be merged");
    this.name = "NothingToMergeError";
  }
}

/**
 * Merge every approved-but-unmerged claim into a new brief version.
 *
 * Version N is materialised as N-1's claims plus the delta, not derived by
 * replaying history. That costs a few hundred rows per version and buys three
 * things: reading version N is one query, diffing is a set comparison, and the
 * text of a claim is frozen at the moment it was merged — editing a claim
 * later cannot retroactively rewrite what an earlier version of the brief said.
 *
 * Append-only holds throughout: no brief_versions or brief_claims row is ever
 * updated or deleted.
 */
export async function mergeApprovedClaims(args: {
  tenantId: string;
  reviewer: string;
  note?: string | null;
}): Promise<{ version: number; added: number; removed: number; edited: number; total: number }> {
  return prisma.$transaction(async (tx) => {
    const previous = await tx.briefVersion.findFirst({
      orderBy: { version: "desc" },
      include: { claims: true },
    });

    const pending = await tx.candidateClaim.findMany({
      where: { status: { in: [ClaimStatus.approved, ClaimStatus.edited] }, mergedAt: null },
      orderBy: [{ type: "asc" }, { timestampMs: "asc" }],
    });

    const carried: BriefClaim[] = previous?.claims ?? [];
    if (pending.length === 0 && carried.length === 0) throw new NothingToMergeError();

    const previousByClaimId = new Map(carried.map((c) => [c.claimId, c]));
    const pendingIds = new Set(pending.map((c) => c.id));

    // A claim already in the brief that has since been rejected drops out of
    // the next version. It stays in every version that already contained it.
    const rejected = carried.length
      ? await tx.candidateClaim.findMany({
          where: { id: { in: carried.map((c) => c.claimId) }, status: ClaimStatus.rejected },
          select: { id: true },
        })
      : [];
    const rejectedIds = new Set(rejected.map((r) => r.id));

    let added = 0;
    let edited = 0;
    for (const claim of pending) {
      if (previousByClaimId.has(claim.id)) edited += 1;
      else added += 1;
    }
    const removed = rejectedIds.size;

    if (added === 0 && edited === 0 && removed === 0) throw new NothingToMergeError();

    const version = (previous?.version ?? 0) + 1;

    const carriedForward = carried.filter(
      (c) => !pendingIds.has(c.claimId) && !rejectedIds.has(c.claimId),
    );

    const created = await tx.briefVersion.create({
      data: {
        tenantId: args.tenantId,
        version,
        createdBy: args.reviewer,
        note: args.note ?? null,
        addedCount: added,
        removedCount: removed,
        editedCount: edited,
        totalCount: carriedForward.length + pending.length,
      },
    });

    if (carriedForward.length > 0) {
      await tx.briefClaim.createMany({
        data: carriedForward.map((c) => ({
          tenantId: args.tenantId,
          briefVersionId: created.id,
          claimId: c.claimId,
          meetingId: c.meetingId,
          type: c.type,
          text: c.text,
          verbatimQuote: c.verbatimQuote,
          speaker: c.speaker,
          timestampMs: c.timestampMs,
          confidence: c.confidence,
          evidenceRedacted: c.evidenceRedacted,
          introducedInVersion: c.introducedInVersion,
        })),
      });
    }

    if (pending.length > 0) {
      await tx.briefClaim.createMany({
        data: pending.map((claim) => ({
          tenantId: args.tenantId,
          briefVersionId: created.id,
          claimId: claim.id,
          meetingId: claim.meetingId,
          type: claim.type,
          text: claim.editedText ?? claim.text,
          verbatimQuote: claim.verbatimQuote,
          speaker: claim.speaker,
          timestampMs: claim.timestampMs,
          confidence: claim.confidence,
          evidenceRedacted: false,
          introducedInVersion: previousByClaimId.get(claim.id)?.introducedInVersion ?? version,
        })),
      });

      const mergedAt = new Date();
      await tx.candidateClaim.updateMany({
        where: { id: { in: pending.map((c) => c.id) } },
        data: { mergedAt },
      });

      // Every meeting that contributed to this version is done.
      const meetingIds = [...new Set(pending.map((c) => c.meetingId))];
      for (const meetingId of meetingIds) {
        const remaining = await tx.candidateClaim.count({
          where: { meetingId, status: ClaimStatus.proposed },
        });
        if (remaining === 0) {
          await transition(tx as never, {
            meetingId,
            to: MeetingStatus.merged,
            reason: `merged into brief v${version}`,
          });
        }
      }
    }

    return { version, added, removed, edited, total: created.totalCount };
  });
}

export type GroupedClaims = Array<{ type: ClaimType; label: string; claims: BriefClaim[] }>;

export function groupByType(claims: BriefClaim[]): Array<{ type: ClaimType; claims: BriefClaim[] }> {
  return CLAIM_TYPES.map((type) => ({
    type,
    claims: claims
      .filter((c) => c.type === type)
      .sort((a, b) => a.timestampMs - b.timestampMs),
  })).filter((g) => g.claims.length > 0);
}

export type BriefDiff = {
  from: number;
  to: number;
  added: BriefClaim[];
  removed: BriefClaim[];
  edited: Array<{ before: BriefClaim; after: BriefClaim }>;
  unchanged: number;
};

export function diffVersions(from: BriefClaim[], to: BriefClaim[], fromV: number, toV: number): BriefDiff {
  const fromMap = new Map(from.map((c) => [c.claimId, c]));
  const toMap = new Map(to.map((c) => [c.claimId, c]));

  const added = to.filter((c) => !fromMap.has(c.claimId));
  const removed = from.filter((c) => !toMap.has(c.claimId));

  const edited: Array<{ before: BriefClaim; after: BriefClaim }> = [];
  let unchanged = 0;
  for (const after of to) {
    const before = fromMap.get(after.claimId);
    if (!before) continue;
    if (before.text !== after.text) edited.push({ before, after });
    else unchanged += 1;
  }

  return { from: fromV, to: toV, added, removed, edited, unchanged };
}
