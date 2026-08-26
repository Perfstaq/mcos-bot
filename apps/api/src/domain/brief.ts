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

/** Two live claims in one edit lineage — see the guard in mergeApprovedClaims. */
export class ConflictingLineageError extends Error {
  constructor(readonly claimId: string) {
    super(
      `Two approved claims share the edit lineage of ${claimId}. ` +
        "Reject one of them before merging.",
    );
    this.name = "ConflictingLineageError";
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

    // A claim's identity in the brief is its EDIT LINEAGE, not its row id.
    // Edit-approve writes a new candidate_claim and supersedes the original
    // (see domain/review-gate.ts), so keying the brief off row ids would turn
    // every rewrite into "one claim removed, a different one added" instead of
    // the edit it plainly is — and would carry the stale original forward
    // alongside its own replacement.
    const briefKey = (claim: { id: string; editedFromId: string | null }) => claim.editedFromId ?? claim.id;

    const previousByClaimId = new Map(carried.map((c) => [c.claimId, c]));
    const pendingIds = new Set(pending.map(briefKey));

    // A claim already in the brief that has since been rejected drops out of
    // the next version. It stays in every version that already contained it.
    //
    // "The claim" here is the lineage's CURRENT member, not its root. A root
    // superseded by an edit that was itself later rejected must drop out, and
    // an edit withdrawn by undo — which marks the abandoned successor rejected
    // and reproposes the root — must not, because the reviewer restored the
    // claim rather than throwing it away.
    const rootIds = carried.map((c) => c.claimId);
    const lineage = rootIds.length
      ? await tx.candidateClaim.findMany({
          where: { OR: [{ id: { in: rootIds } }, { editedFromId: { in: rootIds } }] },
          select: { id: true, editedFromId: true, status: true },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        })
      : [];

    const membersByRoot = new Map<string, typeof lineage>();
    for (const member of lineage) {
      const key = member.editedFromId ?? member.id;
      const list = membersByRoot.get(key);
      if (list) list.push(member);
      else membersByRoot.set(key, [member]);
    }

    const rejectedIds = new Set<string>();
    for (const [root, members] of membersByRoot) {
      const rootRow = members.find((m) => m.id === root);
      // A superseded root hands the lineage to its newest live successor;
      // anything else is still speaking for itself.
      const current =
        rootRow?.status === ClaimStatus.superseded
          ? (members.filter((m) => m.id !== root && m.status !== ClaimStatus.superseded).at(-1) ?? rootRow)
          : rootRow;
      if (current?.status === ClaimStatus.rejected) rejectedIds.add(root);
    }

    let added = 0;
    let edited = 0;
    for (const claim of pending) {
      if (previousByClaimId.has(briefKey(claim))) edited += 1;
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

    // A lineage is exactly one row in the brief, so two pending claims sharing
    // a root is not a merge we can perform — it is a gate bug that has already
    // happened. Saying so beats a raw unique-constraint 500 from createMany,
    // which tells whoever is paged nothing about which claims collided.
    const seenKeys = new Set<string>();
    for (const claim of pending) {
      const key = briefKey(claim);
      if (seenKeys.has(key)) {
        throw new ConflictingLineageError(key);
      }
      seenKeys.add(key);
    }

    if (pending.length > 0) {
      await tx.briefClaim.createMany({
        data: pending.map((claim) => ({
          tenantId: args.tenantId,
          briefVersionId: created.id,
          claimId: briefKey(claim),
          meetingId: claim.meetingId,
          type: claim.type,
          text: claim.editedText ?? claim.text,
          verbatimQuote: claim.verbatimQuote,
          speaker: claim.speaker,
          timestampMs: claim.timestampMs,
          confidence: claim.confidence,
          evidenceRedacted: false,
          introducedInVersion: previousByClaimId.get(briefKey(claim))?.introducedInVersion ?? version,
        })),
      });

      // Stamp the lineage ROOTS too, not just the claims that were merged.
      //
      // brief_claims.claim_id points at the root, and brief_claims cascades
      // from candidate_claims. Deleting a meeting purges every claim that never
      // reached a brief — `mergedAt: null` — so an unstamped superseded root
      // would be swept up by that purge and take a published brief version's
      // row with it. A version is immutable; nothing downstream may delete a
      // row out of one.
      const mergedAt = new Date();
      const mergedIds = [
        ...new Set([
          ...pending.map((c) => c.id),
          ...pending.map((c) => c.editedFromId).filter((id): id is string => id !== null),
        ]),
      ];
      await tx.candidateClaim.updateMany({
        where: { id: { in: mergedIds } },
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
