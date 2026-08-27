import { EvidenceKind, MeetingStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runWithContext } from "../src/context.js";
import { env } from "../src/env.js";
import { buildExcerpt, runDigest } from "../src/jobs/digest.js";
import { db, resetDb, seedTenant } from "./helpers.js";

/**
 * The digest job never talks to a network in this suite — a mocked
 * `generateMeetingDigest`, exactly the way tests/helpers/llm-mock.ts stands
 * in for `extractFromChunk` elsewhere. What is under test is the job's own
 * contract: it is a label, not memory, and a failure in it must be invisible
 * to everything the review gate and the meeting state machine care about.
 */
vi.mock("../src/integrations/openai.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/integrations/openai.js")>();
  return { ...actual, generateMeetingDigest: vi.fn() };
});

import { generateMeetingDigest } from "../src/integrations/openai.js";

const mockDigest = vi.mocked(generateMeetingDigest);

async function createMeeting(
  tenantId: string,
  overrides: { title?: string | null } = {},
): Promise<string> {
  const meeting = await db.meeting.create({
    data: {
      tenantId,
      title: overrides.title ?? null,
      meetingUrl: "https://meet.google.com/digest-test",
      status: MeetingStatus.transcript_ready,
    },
  });

  const evidence = await db.evidenceSource.create({
    data: { tenantId, kind: EvidenceKind.meeting_transcript, meetingId: meeting.id, capturedAt: new Date() },
  });
  const transcript = await db.transcript.create({
    data: {
      tenantId,
      meetingId: meeting.id,
      evidenceSourceId: evidence.id,
      provider: "test",
      segmentCount: 2,
      wordCount: 20,
      durationMs: 60_000,
    },
  });
  await db.transcriptSegment.createMany({
    data: [
      { tenantId, transcriptId: transcript.id, idx: 0, speaker: "Priya Raman", startMs: 0, endMs: 4_000, text: "Let's talk about the Q3 renewal risk on the Acme account." },
      { tenantId, transcriptId: transcript.id, idx: 1, speaker: "Daniel Okafor", startMs: 4_000, endMs: 9_000, text: "Right, they flagged pricing as the blocker again." },
    ],
  });

  return meeting.id;
}

describe("runDigest", () => {
  beforeEach(async () => {
    await resetDb();
    mockDigest.mockReset();
  });

  it("sets the title and digest when the meeting has none", async () => {
    const tenant = await seedTenant();
    const meetingId = await createMeeting(tenant.id);
    mockDigest.mockResolvedValue({
      title: "Acme renewal risk and the pricing objection",
      digest: "The team discussed a Q3 renewal risk on the Acme account. Pricing was raised again as the sticking point. No next step was recorded in this excerpt.",
      // env.DIGEST_MODEL, not a hardcoded model id: this asserts jobs/digest.ts
      // stores the model generateMeetingDigest says it actually used, not
      // whatever env.DIGEST_MODEL happens to be at storage time — those two
      // are only guaranteed to match because nothing here overrides `model`.
      model: env.DIGEST_MODEL,
      inputTokens: 400,
      outputTokens: 60,
    });

    await runWithContext(
      { tenantId: tenant.id, tenantSlug: tenant.slug, reviewer: "test" },
      () => runDigest({ meetingId, tenantId: tenant.id }),
    );

    const meeting = await db.meeting.findUniqueOrThrow({ where: { id: meetingId } });
    expect(meeting.title).toBe("Acme renewal risk and the pricing objection");
    expect(meeting.digest).toContain("Acme account");
    expect(meeting.digestModel).toBe(env.DIGEST_MODEL);
    expect(meeting.digestPromptVersion).toBe("meeting_digest/v1-openai");
    expect(meeting.digestGeneratedAt).not.toBeNull();
    expect(meeting.status).toBe(MeetingStatus.transcript_ready);
  });

  it("never overwrites a title a human already gave the meeting", async () => {
    const tenant = await seedTenant();
    const meetingId = await createMeeting(tenant.id, { title: "Acme renewal — Priya + Daniel" });
    mockDigest.mockResolvedValue({
      title: "A model-invented title",
      digest: "Three sentences of summary go here for the excerpt provided in this fixture today.",
      model: env.DIGEST_MODEL,
      inputTokens: 400,
      outputTokens: 60,
    });

    await runWithContext(
      { tenantId: tenant.id, tenantSlug: tenant.slug, reviewer: "test" },
      () => runDigest({ meetingId, tenantId: tenant.id }),
    );

    const meeting = await db.meeting.findUniqueOrThrow({ where: { id: meetingId } });
    expect(meeting.title).toBe("Acme renewal — Priya + Daniel");
    expect(meeting.digest).not.toBeNull();
  });

  it("is idempotent — a meeting that already has a digest is left alone", async () => {
    const tenant = await seedTenant();
    const meetingId = await createMeeting(tenant.id);
    await db.meeting.update({ where: { id: meetingId }, data: { digest: "Already generated." } });

    await runWithContext(
      { tenantId: tenant.id, tenantSlug: tenant.slug, reviewer: "test" },
      () => runDigest({ meetingId, tenantId: tenant.id }),
    );

    expect(mockDigest).not.toHaveBeenCalled();
    const meeting = await db.meeting.findUniqueOrThrow({ where: { id: meetingId } });
    expect(meeting.digest).toBe("Already generated.");
  });

  it("is invisible on failure: no throw, no status change, meeting falls back to its URL", async () => {
    const tenant = await seedTenant();
    const meetingId = await createMeeting(tenant.id);
    mockDigest.mockRejectedValue(new Error("model refused"));

    await expect(
      runWithContext(
        { tenantId: tenant.id, tenantSlug: tenant.slug, reviewer: "test" },
        () => runDigest({ meetingId, tenantId: tenant.id }),
      ),
    ).resolves.toBeUndefined();

    const meeting = await db.meeting.findUniqueOrThrow({ where: { id: meetingId } });
    expect(meeting.digest).toBeNull();
    expect(meeting.title).toBeNull();
    expect(meeting.status).toBe(MeetingStatus.transcript_ready);
    expect(meeting.failedStage).toBeNull();
    expect(meeting.failureReason).toBeNull();
  });

  it("does nothing for a meeting with no transcript yet, without throwing", async () => {
    const tenant = await seedTenant();
    const meeting = await db.meeting.create({
      data: { tenantId: tenant.id, meetingUrl: "https://meet.google.com/no-transcript", status: MeetingStatus.bot_scheduled },
    });

    await runWithContext(
      { tenantId: tenant.id, tenantSlug: tenant.slug, reviewer: "test" },
      () => runDigest({ meetingId: meeting.id, tenantId: tenant.id }),
    );

    expect(mockDigest).not.toHaveBeenCalled();
  });

  it("does nothing for a deleted meeting", async () => {
    const tenant = await seedTenant();
    const meetingId = await createMeeting(tenant.id);
    await db.meeting.update({ where: { id: meetingId }, data: { deletedAt: new Date() } });

    await runWithContext(
      { tenantId: tenant.id, tenantSlug: tenant.slug, reviewer: "test" },
      () => runDigest({ meetingId, tenantId: tenant.id }),
    );

    expect(mockDigest).not.toHaveBeenCalled();
  });
});

describe("buildExcerpt", () => {
  it("still returns a non-empty excerpt when the first segment alone exceeds the cap", () => {
    // Regression test: the loop used to compare `length + line.length` against
    // the cap and `break` on the first line that didn't fit — for a single
    // segment longer than the whole 8,000-char cap (one person talking
    // uninterrupted, no natural break), that comparison fails on the very
    // first iteration, before anything was ever pushed, producing an empty
    // excerpt rather than a truncated one.
    const huge = "word ".repeat(3_000); // ~15,000 chars, well over the cap
    const excerpt = buildExcerpt([{ speaker: "Priya Raman", startMs: 0, text: huge }]);

    expect(excerpt.length).toBeGreaterThan(0);
    expect(excerpt).toContain("Priya Raman");
  });

  it("stops before a line that doesn't fit once at least one line is already in", () => {
    const first = "word ".repeat(50); // small, fits easily
    const huge = "word ".repeat(3_000); // would not fit alongside `first`
    const excerpt = buildExcerpt([
      { speaker: "Priya Raman", startMs: 0, text: first },
      { speaker: "Daniel Okafor", startMs: 4_000, text: huge },
    ]);

    expect(excerpt).toContain("Priya Raman");
    expect(excerpt).not.toContain("Daniel Okafor");
  });
});
