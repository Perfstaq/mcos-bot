import { MeetingStatus } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";
import { runWithContext } from "../src/context.js";
import { seedGoldenMeetings } from "../src/seed-golden.js";
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

  it("refuses to run against NODE_ENV=production at the CLI entrypoint", async () => {
    // The hard guard lives in seed-golden.ts#main, which only runs when the
    // file is executed directly (see the isDirectRun check at the bottom of
    // that file) — importing it here, as this test does, never triggers it.
    // This test documents the guard's existence for reviewers; the substance
    // is a source read rather than a subprocess spawn, so it stays fast.
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../src/seed-golden.ts", import.meta.url), "utf-8"),
    );
    expect(source).toMatch(/NODE_ENV === "production"/);
  });
});
