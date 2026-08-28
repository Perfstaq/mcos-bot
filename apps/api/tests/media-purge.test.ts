import crypto from "node:crypto";
import { MediaAnalysisStatus, MediaAssetKind } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb, seedTenant } from "./helpers.js";

/**
 * `media.purge-references` — ARCHITECTURE §12.36's retention sweep.
 *
 * §12.35 named the gap: `MediaAsset.purgedAt` exists, its comment already
 * declares the policy, M1's ingest paths already use the column for
 * `Artifact.purgedAt` — and nothing purges references. This is that job.
 *
 * R2 is mocked, exactly as `pipeline.test.ts` mocks it: this file is about
 * selection, idempotency, tenant isolation and the fingerprint surviving —
 * not about S3. Every row this test asserts on is a REAL row in the real
 * test Postgres database (`db`, `resetDb`, `seedTenant` from helpers.ts) —
 * nothing here is asserted against an in-memory fixture.
 */

const deletedKeys: string[][] = [];
const deleteObjects = vi.fn(async (keys: string[]) => {
  deletedKeys.push(keys);
});

vi.mock("../src/integrations/r2.js", () => ({
  keys: {
    recordingAudio: (t: string, m: string) => `${t}/meetings/${m}/recording.mp3`,
    recordingVideo: (t: string, m: string) => `${t}/meetings/${m}/recording.mp4`,
    transcriptJson: (t: string, m: string) => `${t}/meetings/${m}/transcript.json`,
    meetingPrefix: (t: string, m: string) => `${t}/meetings/${m}/`,
  },
  streamUrlToR2: vi.fn(),
  putObject: vi.fn(),
  presignGet: vi.fn(async (key: string) => ({
    url: `https://r2.test/${key}?sig=presigned`,
    expiresAt: new Date(Date.now() + 3_600_000),
  })),
  deleteObjects,
  objectExists: vi.fn(async () => true),
  r2: {},
}));

const DAY_MS = 86_400_000;

let tenantId: string;

// Imported lazily so the vi.mock factory above is installed first.
let isEligibleForPurge: typeof import("../src/jobs/media-purge.js")["isEligibleForPurge"];
let purgeReferenceAsset: typeof import("../src/jobs/media-purge.js")["purgeReferenceAsset"];
let sweepPurgeReferences: typeof import("../src/jobs/media-purge.js")["sweepPurgeReferences"];

beforeAll(async () => {
  const mod = await import("../src/jobs/media-purge.js");
  isEligibleForPurge = mod.isEligibleForPurge;
  purgeReferenceAsset = mod.purgeReferenceAsset;
  sweepPurgeReferences = mod.sweepPurgeReferences;
});

afterAll(async () => {
  await db.$disconnect();
});

beforeEach(async () => {
  await resetDb();
  deletedKeys.length = 0;
  deleteObjects.mockClear();
  tenantId = (await seedTenant()).id;
});

afterEach(() => {
  delete process.env.RETENTION_DAYS;
});

/** A `MediaAsset` + (optionally) its `MediaAnalysis`, shaped to match exactly
 *  what `media-analyze.ts` writes for a `reference` asset that finished
 *  successfully — `status: succeeded` and `fingerprint` set together, in the
 *  same update, per `jobs/media-analyze.ts:133-147`. */
async function seedAsset(opts: {
  kind?: MediaAssetKind;
  ageDays?: number;
  purged?: boolean;
  analysis?: "succeeded-fingerprinted" | "succeeded-no-fingerprint" | "failed" | "none";
  tenant?: string;
}) {
  const kind = opts.kind ?? MediaAssetKind.reference;
  const ageDays = opts.ageDays ?? 45;
  const owner = opts.tenant ?? tenantId;
  const asset = await db.mediaAsset.create({
    data: {
      tenantId: owner,
      kind,
      r2Key: `${owner}/studio/${kind}/${crypto.randomUUID()}.mp4`,
      contentType: "video/mp4",
      bytes: 12_345n,
      createdAt: new Date(Date.now() - ageDays * DAY_MS),
      purgedAt: opts.purged ? new Date() : null,
    },
  });

  const mode = opts.analysis ?? "succeeded-fingerprinted";
  if (mode !== "none") {
    await db.mediaAnalysis.create({
      data: {
        tenantId: owner,
        assetId: asset.id,
        status: mode === "failed" ? MediaAnalysisStatus.failed : MediaAnalysisStatus.succeeded,
        ...(mode === "succeeded-fingerprinted"
          ? {
              fingerprint: { rhythm: { cutsPerMin: 32 }, framing: "letterbox" },
              fingerprintVersion: "test-1",
            }
          : {}),
        analyzerVersion: "0.2.0+faster-whisper1.1.0+librosa0.11.0+whisper-model-base",
        finishedAt: new Date(),
      },
    });
  }

  return asset;
}

/* --------------------------------------------------------- selection (pure) */

describe("isEligibleForPurge — the selection predicate", () => {
  const base = {
    kind: MediaAssetKind.reference,
    purgedAt: null as Date | null,
    analysisStatus: MediaAnalysisStatus.succeeded,
    fingerprint: { rhythm: {} } as unknown,
    now: new Date("2026-08-28T00:00:00Z"),
    retentionDays: 30,
  };

  it("selects a reference asset older than the retention window, fingerprinted, unpurged", () => {
    expect(isEligibleForPurge({ ...base, createdAt: new Date("2026-07-01T00:00:00Z") })).toBe(true);
  });

  it("does NOT select a reference asset younger than the retention window", () => {
    expect(isEligibleForPurge({ ...base, createdAt: new Date("2026-08-20T00:00:00Z") })).toBe(false);
  });

  it("does NOT select one whose fingerprint extraction never succeeded", () => {
    expect(
      isEligibleForPurge({
        ...base,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        analysisStatus: MediaAnalysisStatus.failed,
        fingerprint: null,
      }),
    ).toBe(false);
    expect(
      isEligibleForPurge({
        ...base,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        analysisStatus: MediaAnalysisStatus.succeeded,
        fingerprint: null,
      }),
    ).toBe(false);
  });

  it("does NOT select one already purged", () => {
    expect(
      isEligibleForPurge({ ...base, createdAt: new Date("2026-01-01T00:00:00Z"), purgedAt: new Date() }),
    ).toBe(false);
  });

  it("HOSTILE: never selects footage or renders, even when every other field looks eligible", () => {
    const oldAndFingerprinted = { ...base, createdAt: new Date("2026-01-01T00:00:00Z") };
    expect(isEligibleForPurge({ ...oldAndFingerprinted, kind: MediaAssetKind.footage })).toBe(false);
    expect(isEligibleForPurge({ ...oldAndFingerprinted, kind: MediaAssetKind.render })).toBe(false);
    expect(isEligibleForPurge({ ...oldAndFingerprinted, kind: MediaAssetKind.music })).toBe(false);
  });

  it("respects a non-default retentionDays", () => {
    const fiveDaysOld = { ...base, createdAt: new Date(base.now.getTime() - 5 * DAY_MS) };
    expect(isEligibleForPurge({ ...fiveDaysOld, retentionDays: 30 })).toBe(false);
    expect(isEligibleForPurge({ ...fiveDaysOld, retentionDays: 3 })).toBe(true);
  });
});

/* -------------------------------------------------------- the sweep, on real rows */

describe("media.purge-references — selection against real rows", () => {
  it("purges an old, fingerprinted, unpurged reference asset", async () => {
    const asset = await seedAsset({ ageDays: 45 });

    const result = await sweepPurgeReferences();

    expect(result.purged).toBe(1);
    expect(deleteObjects).toHaveBeenCalledTimes(1);
    expect(deleteObjects).toHaveBeenCalledWith([asset.r2Key]);

    const row = await db.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } });
    expect(row.purgedAt).not.toBeNull();
  });

  it("does NOT purge a reference asset younger than RETENTION_DAYS", async () => {
    const asset = await seedAsset({ ageDays: 10 });

    const result = await sweepPurgeReferences();

    expect(result.purged).toBe(0);
    expect(deleteObjects).not.toHaveBeenCalled();
    const row = await db.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } });
    expect(row.purgedAt).toBeNull();
  });

  it("does NOT purge an old reference asset whose fingerprint extraction never succeeded", async () => {
    await seedAsset({ ageDays: 45, analysis: "failed" });
    await seedAsset({ ageDays: 45, analysis: "none" });
    await seedAsset({ ageDays: 45, analysis: "succeeded-no-fingerprint" });

    const result = await sweepPurgeReferences();

    expect(result.purged).toBe(0);
    expect(deleteObjects).not.toHaveBeenCalled();
  });

  it("does NOT purge an asset that is already purged", async () => {
    const asset = await seedAsset({ ageDays: 90, purged: true });

    const result = await sweepPurgeReferences();

    expect(result.purged).toBe(0);
    expect(deleteObjects).not.toHaveBeenCalled();
    const row = await db.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } });
    expect(row.purgedAt!.getTime()).toBe(asset.purgedAt!.getTime());
  });

  it("HOSTILE: never purges footage or renders, even old and (implausibly) fingerprinted", async () => {
    const footage = await seedAsset({ kind: MediaAssetKind.footage, ageDays: 400 });
    const render = await seedAsset({ kind: MediaAssetKind.render, ageDays: 400 });
    const music = await seedAsset({ kind: MediaAssetKind.music, ageDays: 400 });

    const result = await sweepPurgeReferences();

    expect(result.purged).toBe(0);
    expect(deleteObjects).not.toHaveBeenCalled();

    for (const asset of [footage, render, music]) {
      const row = await db.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } });
      expect(row.purgedAt).toBeNull();
    }
  });

  it("respects a non-default retentionDays override", async () => {
    const asset = await seedAsset({ ageDays: 5 });

    const untouched = await sweepPurgeReferences({ retentionDays: 30 });
    expect(untouched.purged).toBe(0);

    const purged = await sweepPurgeReferences({ retentionDays: 3 });
    expect(purged.purged).toBe(1);

    const row = await db.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } });
    expect(row.purgedAt).not.toBeNull();
  });

  it("reads RETENTION_DAYS from the real environment when no override is given", async () => {
    vi.resetModules();
    process.env.RETENTION_DAYS = "3";
    const fresh = await import("../src/jobs/media-purge.js");

    const asset = await seedAsset({ ageDays: 5 });
    const result = await fresh.sweepPurgeReferences();

    expect(result.purged).toBe(1);
    const row = await db.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } });
    expect(row.purgedAt).not.toBeNull();
  });
});

/* --------------------------------------------------------------- idempotency */

describe("media.purge-references — idempotent", () => {
  it("running the sweep twice purges once; the second run is a no-op", async () => {
    const asset = await seedAsset({ ageDays: 45 });

    const first = await sweepPurgeReferences();
    const second = await sweepPurgeReferences();

    expect(first.purged).toBe(1);
    expect(second.purged).toBe(0);
    expect(deleteObjects).toHaveBeenCalledTimes(1);
    expect(deleteObjects).toHaveBeenCalledWith([asset.r2Key]);
  });

  it("calling purgeReferenceAsset directly twice for the same asset deletes R2 once", async () => {
    const asset = await seedAsset({ ageDays: 45 });

    await purgeReferenceAsset(tenantId, asset.id);
    await purgeReferenceAsset(tenantId, asset.id);

    expect(deleteObjects).toHaveBeenCalledTimes(1);
  });
});

/* ----------------------------------------------------- the fingerprint survives */

describe("media.purge-references — the EditFingerprint is the retained artifact", () => {
  it("leaves MediaAnalysis.fingerprint intact and readable after the video is gone", async () => {
    const asset = await seedAsset({ ageDays: 45 });
    const before = await db.mediaAnalysis.findUniqueOrThrow({ where: { assetId: asset.id } });

    await sweepPurgeReferences();

    const assetAfter = await db.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } });
    expect(assetAfter.purgedAt).not.toBeNull();
    // The row survives — only the bytes go (deleteObjects, mocked above, is
    // what would delete the R2 object; the asset row and its r2Key are never
    // touched beyond purgedAt).
    expect(assetAfter.r2Key).toBe(asset.r2Key);

    const analysisAfter = await db.mediaAnalysis.findUniqueOrThrow({ where: { assetId: asset.id } });
    expect(analysisAfter.id).toBe(before.id);
    expect(analysisAfter.fingerprint).toEqual(before.fingerprint);
    expect(analysisAfter.status).toBe(MediaAnalysisStatus.succeeded);
  });
});

/* --------------------------------------------------------------- invariant 5 */

describe("media.purge-references — tenant isolation", () => {
  it("purges each tenant's own eligible reference and never crosses into the other's", async () => {
    const otherTenant = await db.tenant.create({ data: { slug: `other-${crypto.randomUUID()}`, name: "Other" } });
    const mine = await seedAsset({ ageDays: 45, tenant: tenantId });
    const theirs = await seedAsset({ ageDays: 45, tenant: otherTenant.id });

    const result = await sweepPurgeReferences();

    expect(result.purged).toBe(2);
    const mineAfter = await db.mediaAsset.findUniqueOrThrow({ where: { id: mine.id } });
    const theirsAfter = await db.mediaAsset.findUniqueOrThrow({ where: { id: theirs.id } });
    expect(mineAfter.purgedAt).not.toBeNull();
    expect(theirsAfter.purgedAt).not.toBeNull();
    expect(mineAfter.tenantId).toBe(tenantId);
    expect(theirsAfter.tenantId).toBe(otherTenant.id);
  });

  it("HOSTILE: purgeReferenceAsset cannot act on another tenant's asset id under a foreign tenant context", async () => {
    const otherTenant = await db.tenant.create({ data: { slug: `other-${crypto.randomUUID()}`, name: "Other" } });
    const theirs = await seedAsset({ ageDays: 45, tenant: otherTenant.id });

    // Calling with tenantId (mine) but theirs.id: the tenant-scoped Prisma
    // client can only ever see rows under `tenantId`, so this must resolve to
    // "nothing to do" rather than reaching across into the other tenant's row.
    await purgeReferenceAsset(tenantId, theirs.id);

    expect(deleteObjects).not.toHaveBeenCalled();
    const row = await db.mediaAsset.findUniqueOrThrow({ where: { id: theirs.id } });
    expect(row.purgedAt).toBeNull();
  });
});
