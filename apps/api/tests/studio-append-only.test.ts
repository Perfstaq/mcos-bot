import { describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { AppendOnlyViolationError } from "../src/domain/append-only.js";

/**
 * RenderPlan joined APPEND_ONLY_MODELS in the Prisma migration commit
 * (G13 reproducibility — a plan embeds everything its render consumes, so
 * an in-place edit would invalidate the G1a score after the fact). Before
 * this test, removing "RenderPlan" from the set failed nothing — exactly
 * the silent-failure shape append-only.ts's own header comment warns about
 * for BriefVersion/BriefClaim.
 *
 * `assertAppendOnly` runs before tenant context is even checked (db.ts),
 * so this needs no seeded tenant/plan row: an update/delete on a
 * non-existent id still throws before the query ever reaches Postgres.
 */
describe("RenderPlan append-only enforcement", () => {
  it("refuses update/updateMany/delete/deleteMany", async () => {
    await expect(
      prisma.renderPlan.update({ where: { id: "does-not-exist" }, data: { seed: 99 } }),
    ).rejects.toBeInstanceOf(AppendOnlyViolationError);

    await expect(
      prisma.renderPlan.updateMany({ where: {}, data: { seed: 99 } }),
    ).rejects.toBeInstanceOf(AppendOnlyViolationError);

    await expect(prisma.renderPlan.delete({ where: { id: "does-not-exist" } })).rejects.toBeInstanceOf(
      AppendOnlyViolationError,
    );

    await expect(prisma.renderPlan.deleteMany({ where: {} })).rejects.toBeInstanceOf(AppendOnlyViolationError);
  });

  it("still allows create and read operations", async () => {
    // No `.rejects` here — these operations are allowed by the guard; they
    // may still fail for OTHER reasons (missing FKs, no tenant context),
    // but never with AppendOnlyViolationError.
    await expect(prisma.renderPlan.findMany({ where: {} })).resolves.toBeInstanceOf(Array);
  });

  it("the violation error text does not misattribute a RenderPlan write to a brief version", () => {
    const error = new AppendOnlyViolationError("RenderPlan", "update");
    expect(error.message).not.toMatch(/brief version/i);
    expect(error.message).toMatch(/RenderPlan/);
  });
});
