import { MeetingStatus } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";
import { runWithContext } from "../src/context.js";
import { assertNotProduction, seedGoldenMeetings } from "../src/seed-golden.js";
import { db, resetDb, seedTenant } from "./helpers.js";

/**
 * Exercises the reusable half of seed-golden.ts — `seedGoldenMeetings` — with
 * a lightweight test tenant (tests/helpers.ts#seedTenant), not the real
 * Better-Auth-backed demo workspace. The CLI entrypoint (`main` in
 * src/seed-golden.ts) additionally resolves/creates that workspace; it is
 * deliberately not exercised here — pipeline.test.ts truncates the `tenants`
 * table before every test in this suite, which would orphan the Organization
 * row a real workspace creation leaves behind and break on a second run. The
 * CLI path is verified by hand: `npm run db:seed:demo && npm run seed:golden`
 * against a real Postgres, documented in the PR.
 */
describe("seedGoldenMeetings", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("produces two transcript_ready meetings with queryable segments", async () => {
    const tenant = await seedTenant();

    const summary = await runWithContext(
      { tenantId: tenant.id, tenantSlug: tenant.slug, reviewer: "test" },
      () => seedGoldenMeetings(tenant.id),
    );

    expect(summary.meetings).toHaveLength(2);
    expect(summary.meetings.every((m) => !m.reused)).toBe(true);

    for (const m of summary.meetings) {
      const meeting = await db.meeting.findUniqueOrThrow({ where: { id: m.meetingId } });
      expect(meeting.status).toBe(MeetingStatus.transcript_ready);
      expect(meeting.tenantId).toBe(tenant.id);

      const transcript = await db.transcript.findUniqueOrThrow({
        where: { meetingId: m.meetingId },
        include: { segments: true },
      });
      expect(transcript.segments.length).toBeGreaterThan(0);
      expect(transcript.segments.length).toBe(m.segmentCount);

      // No extraction, no claims, no brief — the gate is the only write path.
      expect(await db.extractionRun.count({ where: { meetingId: m.meetingId } })).toBe(0);
      expect(await db.candidateClaim.count({ where: { meetingId: m.meetingId } })).toBe(0);
    }

    expect(await db.briefVersion.count({ where: { tenantId: tenant.id } })).toBe(0);
  });

  it("is idempotent — running it twice does not duplicate meetings", async () => {
    const tenant = await seedTenant();

    await runWithContext(
      { tenantId: tenant.id, tenantSlug: tenant.slug, reviewer: "test" },
      () => seedGoldenMeetings(tenant.id),
    );
    const second = await runWithContext(
      { tenantId: tenant.id, tenantSlug: tenant.slug, reviewer: "test" },
      () => seedGoldenMeetings(tenant.id),
    );

    expect(second.meetings.every((m) => m.reused)).toBe(true);
    expect(await db.meeting.count({ where: { tenantId: tenant.id } })).toBe(2);
  });

  it("seeds a second tenant without colliding on recallBotId/recallTranscriptId", async () => {
    // Regression test: these seeded meetings have no real Recall bot behind
    // them, and recallBotId/recallTranscriptId are globally @unique on
    // Meeting. A synthetic-but-fixed value per fixture (e.g.
    // "golden-freshworks-bot") collided with P2002 the moment a second
    // tenant on the same database seeded the same fixtures — exactly what
    // this test seeds.
    const tenantA = await seedTenant("tenant-a");
    const tenantB = await seedTenant("tenant-b");

    await runWithContext(
      { tenantId: tenantA.id, tenantSlug: tenantA.slug, reviewer: "test" },
      () => seedGoldenMeetings(tenantA.id),
    );
    const summaryB = await runWithContext(
      { tenantId: tenantB.id, tenantSlug: tenantB.slug, reviewer: "test" },
      () => seedGoldenMeetings(tenantB.id),
    );

    expect(summaryB.meetings).toHaveLength(2);
    expect(summaryB.meetings.every((m) => !m.reused)).toBe(true);
    expect(await db.meeting.count({ where: { tenantId: tenantB.id } })).toBe(2);
  });
});

/**
 * `assertNotProduction` is the hard guard `main` calls before touching
 * anything. `main` itself only runs when seed-golden.ts is executed directly
 * (see the isDirectRun check at the bottom of that file), so it is not
 * exercised by importing the module in a test — this tests the guard
 * function itself, behaviorally, rather than grepping the source for the
 * check.
 */
describe("assertNotProduction", () => {
  it("throws when NODE_ENV is production", () => {
    expect(() => assertNotProduction("production")).toThrow(/production/);
  });

  it("does not throw for development", () => {
    expect(() => assertNotProduction("development")).not.toThrow();
  });

  it("does not throw for test", () => {
    expect(() => assertNotProduction("test")).not.toThrow();
  });
});
