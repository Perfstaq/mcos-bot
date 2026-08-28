import { MediaAnalysisStatus, MediaAssetKind } from "@prisma/client";
import { prisma, rawPrisma } from "../db.js";
import { env } from "../env.js";
import { deleteObjects } from "../integrations/studio-r2.js";
import { logger } from "../logger.js";
import { withTenantContext } from "./context.js";

const log = logger.child({ job: "media-purge" });

const DAY_MS = 86_400_000;

/**
 * `media.purge-references` — ARCHITECTURE §12.36 / §12.35's named gap.
 *
 * `04_STYLE_TRANSFER §5`: "store only the fingerprint long-term; the
 * reference video itself is deleted after analysis (or retained ≤30 days
 * with tenant consent)". `MediaAsset.purgedAt` and `MediaAnalysis.fingerprint`
 * exist for exactly this — Agent F put the fingerprint on its OWN row
 * precisely so the source video is disposable — but nothing purges anything.
 * This is that purge.
 *
 * The EditFingerprint is never touched: only `MediaAsset.r2Key`'s bytes are
 * deleted and `MediaAsset.purgedAt` is set. `MediaAnalysis` (and its
 * `fingerprint` column) is a separate row with its own FK to the tenant and
 * is never written by this job.
 */

/** The selection predicate, pulled out as a pure function so "never selects
 *  footage or renders" is a property of one small function anyone can read,
 *  not an artifact of a WHERE clause someone could loosen later. `kind` is
 *  checked here even though the caller already filters on it (§12's own
 *  discipline for structural guarantees: redundant on the happy path, load-
 *  bearing the moment this function is ever called from somewhere new). */
export function isEligibleForPurge(args: {
  kind: MediaAssetKind;
  purgedAt: Date | null;
  createdAt: Date;
  analysisStatus: MediaAnalysisStatus | null | undefined;
  fingerprint: unknown;
  now: Date;
  retentionDays: number;
}): boolean {
  if (args.kind !== MediaAssetKind.reference) return false;
  if (args.purgedAt) return false;
  if (args.analysisStatus !== MediaAnalysisStatus.succeeded) return false;
  if (args.fingerprint === null || args.fingerprint === undefined) return false;

  const cutoff = args.now.getTime() - args.retentionDays * DAY_MS;
  return args.createdAt.getTime() < cutoff;
}

export type SweepResult = {
  scanned: number;
  purged: number;
  errors: number;
};

/**
 * Sweep every tenant for reference reels eligible for purge.
 *
 * Enumerating candidates crosses tenants by definition — there is no single
 * tenant a scheduled sweep belongs to — so, exactly like
 * `calendar-sync.ts`'s `syncActiveConnections`, this is the one query here
 * that uses `rawPrisma`. `kind: reference` is pinned in that query itself
 * (not merely in `isEligibleForPurge`): there is no parameter that could
 * widen it to footage or renders. Every actual purge then runs inside its
 * own tenant context through `purgeReferenceAsset`, so invariant 5 is
 * enforced by the same mechanism as the rest of the codebase, not just by
 * this function's care.
 *
 * A per-asset failure is caught and counted rather than thrown, same posture
 * as `syncActiveConnections`: one broken R2 delete must not block every other
 * eligible tenant's purge for the day, and a row that failed simply stays
 * eligible and is retried on tomorrow's sweep — no separate retry mechanism
 * needed, since `purgedAt` only gets set on success.
 */
export async function sweepPurgeReferences(
  opts: { retentionDays?: number; limit?: number; now?: Date } = {},
): Promise<SweepResult> {
  const retentionDays = opts.retentionDays ?? env.RETENTION_DAYS;
  const limit = opts.limit ?? 500;
  const now = opts.now ?? new Date();

  const candidates = await rawPrisma.mediaAsset.findMany({
    where: { kind: MediaAssetKind.reference, purgedAt: null },
    select: {
      id: true,
      tenantId: true,
      kind: true,
      purgedAt: true,
      createdAt: true,
      analysis: { select: { status: true, fingerprint: true } },
    },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  let purged = 0;
  let errors = 0;

  for (const asset of candidates) {
    const eligible = isEligibleForPurge({
      kind: asset.kind,
      purgedAt: asset.purgedAt,
      createdAt: asset.createdAt,
      analysisStatus: asset.analysis?.status,
      fingerprint: asset.analysis?.fingerprint,
      now,
      retentionDays,
    });
    if (!eligible) continue;

    try {
      const didPurge = await purgeReferenceAsset(asset.tenantId, asset.id);
      if (didPurge) purged += 1;
    } catch (error) {
      errors += 1;
      log.error(
        { assetId: asset.id, tenantId: asset.tenantId, err: (error as Error).message },
        "reference purge failed, will retry on the next sweep",
      );
    }
  }

  log.info({ scanned: candidates.length, purged, errors, retentionDays }, "media.purge-references swept");
  return { scanned: candidates.length, purged, errors };
}

/**
 * Purge one reference asset: delete its R2 object, then mark it purged.
 *
 * Runs entirely inside `withTenantContext(tenantId, …)` and re-reads the row
 * through the tenant-SCOPED `prisma` client rather than trusting the caller's
 * `assetId` — `db.ts`'s extension merges `tenantId` into every read, so an
 * `assetId` that belongs to a different tenant resolves to `null` here,
 * exactly as if it did not exist. That is what makes tenant isolation
 * structural rather than a property of this function's own bookkeeping (see
 * the "HOSTILE" tenant-isolation test in media-purge.test.ts).
 *
 * Delete-then-mark, same order as the meeting-purge path in
 * `routes/meetings.ts`: `DeleteObjectCommand` on a key that is already gone
 * is not an error, so a crash between the two steps just makes the next
 * sweep repeat a no-op delete before it finishes the job — never a purge
 * that is "half done" in a way a retry cannot recover.
 *
 * Returns whether it actually purged anything, so a caller sweeping many
 * assets can count real work versus a stale/already-purged/foreign id.
 */
export async function purgeReferenceAsset(tenantId: string, assetId: string): Promise<boolean> {
  return withTenantContext(tenantId, async () => {
    const asset = await prisma.mediaAsset.findUnique({ where: { id: assetId } });
    if (!asset || asset.kind !== MediaAssetKind.reference || asset.purgedAt) return false;

    await deleteObjects([asset.r2Key]);
    await prisma.mediaAsset.update({ where: { id: assetId }, data: { purgedAt: new Date() } });
    return true;
  });
}
