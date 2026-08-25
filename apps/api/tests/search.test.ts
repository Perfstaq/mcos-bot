import {
  ArtifactKind,
  ClaimType,
  EvidenceKind,
  MeetingStatus,
  MeetingVisibility,
} from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, resetDb, seedTenant } from "./helpers.js";
import { runWithContext } from "../src/context.js";
import { disconnect } from "../src/db.js";
import type { Actor } from "../src/authz.js";
import { search } from "../src/domain/search.js";
import { loadPlayback } from "../src/routes/playback.js";

/**
 * Search runs on raw SQL, so none of these tests establish an
 * AsyncLocalStorage context: the point is that the queries filter `tenant_id`
 * from the actor themselves. If a statement in domain/search.ts ever starts
 * leaning on the Prisma extension instead, the tenancy test below stops
 * passing rather than quietly passing for the wrong reason.
 *
 * Playback does go through the tenant-scoped client, so those tests wrap the
 * call the way the request lifecycle does.
 */

let tenantId: string;
let rivalTenantId: string;

const MEMBER = "user_member";
const OUTSIDER = "user_outsider";

function actorFor(tenant: string, overrides: Partial<Actor> = {}): Actor {
  // Nothing on either path reads the user table — visibility is decided from
  // meetings and meeting_collaborators — so the actor can be a plain value and
  // the suite needs no Better Auth rows.
  return {
    userId: MEMBER,
    email: "reviewer@test.example",
    name: "Test Reviewer",
    organizationId: "org_test",
    tenantId: tenant,
    role: "member",
    ...overrides,
  };
}

function withTenant<T>(tenant: string, fn: () => Promise<T>): Promise<T> {
  return runWithContext({ tenantId: tenant, tenantSlug: "test", reviewer: "reviewer@test.example" }, fn);
}

type SeedSegment = { speaker: string; startMs: number; text: string };

async function seedMeeting(args: {
  tenantId: string;
  title: string;
  visibility?: MeetingVisibility;
  createdByUserId?: string | null;
  segments?: SeedSegment[];
  notes?: string;
  recording?: "present" | "purged";
}) {
  const meeting = await db.meeting.create({
    data: {
      tenantId: args.tenantId,
      title: args.title,
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      status: MeetingStatus.in_review,
      visibility: args.visibility ?? MeetingVisibility.workspace,
      createdByUserId: args.createdByUserId ?? null,
      startedAt: new Date("2026-08-01T10:00:00Z"),
    },
  });

  let evidenceSourceId: string | null = null;
  const segmentIds: string[] = [];

  if (args.segments?.length) {
    const evidence = await db.evidenceSource.create({
      data: {
        tenantId: args.tenantId,
        kind: EvidenceKind.meeting_transcript,
        meetingId: meeting.id,
        externalId: `transcript-${meeting.id}`,
        capturedAt: new Date(),
      },
    });
    evidenceSourceId = evidence.id;

    const last = args.segments[args.segments.length - 1]!;
    const transcript = await db.transcript.create({
      data: {
        tenantId: args.tenantId,
        meetingId: meeting.id,
        evidenceSourceId: evidence.id,
        provider: "test",
        languageCode: "en",
        segmentCount: args.segments.length,
        wordCount: args.segments.reduce((n, s) => n + s.text.split(/\s+/).length, 0),
        durationMs: last.startMs + 5_000,
      },
    });

    for (const [idx, segment] of args.segments.entries()) {
      const row = await db.transcriptSegment.create({
        data: {
          tenantId: args.tenantId,
          transcriptId: transcript.id,
          idx,
          speaker: segment.speaker,
          startMs: segment.startMs,
          endMs: segment.startMs + 4_000,
          text: segment.text,
        },
      });
      segmentIds.push(row.id);
    }
  }

  if (args.notes) {
    await db.meetingNote.create({
      data: {
        tenantId: args.tenantId,
        meetingId: meeting.id,
        state: Buffer.from([]),
        plainText: args.notes,
      },
    });
  }

  if (args.recording) {
    await db.artifact.create({
      data: {
        tenantId: args.tenantId,
        meetingId: meeting.id,
        kind: ArtifactKind.recording_audio,
        r2Key: `${args.tenantId}/meetings/${meeting.id}/recording.mp3`,
        contentType: "audio/mpeg",
        bytes: BigInt(4_812_004),
        checksum: "sha256:test",
        purgedAt: args.recording === "purged" ? new Date() : null,
      },
    });
  }

  return { id: meeting.id, evidenceSourceId, segmentIds };
}

/**
 * A claim that made it through the review gate and into the brief. `versions`
 * is how a carried-forward claim actually looks on disk: one candidate claim,
 * one brief_claims row per version that still contains it.
 */
async function seedBriefClaim(args: {
  tenantId: string;
  meetingId: string;
  evidenceSourceId: string;
  text: string;
  quote: string;
  versions?: number[];
}) {
  const run = await db.extractionRun.create({
    data: {
      tenantId: args.tenantId,
      meetingId: args.meetingId,
      model: "test",
      promptVersion: "test/v1",
      status: "succeeded",
    },
  });
  const claim = await db.candidateClaim.create({
    data: {
      tenantId: args.tenantId,
      meetingId: args.meetingId,
      evidenceSourceId: args.evidenceSourceId,
      extractionRunId: run.id,
      type: ClaimType.positioning_statement,
      text: args.text,
      confidence: 0.9,
      verbatimQuote: args.quote,
      speaker: "Priya Raman",
      timestampMs: 42_000,
      dedupeKey: `test-${args.meetingId}-${args.text.slice(0, 20)}`,
    },
  });
  for (const version of args.versions ?? [1]) {
    const briefVersion = await db.briefVersion.create({
      data: { tenantId: args.tenantId, version, createdBy: "reviewer@test.example", totalCount: 1 },
    });
    await db.briefClaim.create({
      data: {
        tenantId: args.tenantId,
        briefVersionId: briefVersion.id,
        claimId: claim.id,
        meetingId: args.meetingId,
        type: ClaimType.positioning_statement,
        text: args.text,
        verbatimQuote: args.quote,
        speaker: "Priya Raman",
        timestampMs: 42_000,
        confidence: 0.9,
        introducedInVersion: (args.versions ?? [1])[0]!,
      },
    });
  }
}

const SUPPORT_COST: SeedSegment[] = [
  {
    speaker: "Priya Raman",
    startMs: 12_000,
    text: "we should flatten the support cost curve rather than sell a better help desk",
  },
  {
    speaker: "Daniel Okafor",
    startMs: 48_000,
    text: "support is fine but the cost of the whole platform came up again later in the call",
  },
];

beforeEach(async () => {
  await resetDb();
  tenantId = (await seedTenant()).id;
  rivalTenantId = (await db.tenant.create({ data: { slug: "rival-co", name: "Rival Co" } })).id;
});

afterAll(async () => {
  await disconnect();
  await db.$disconnect();
});

describe("cross-meeting search", () => {
  it("returns nothing for an empty query rather than everything", async () => {
    await seedMeeting({ tenantId, title: "Pricing committee", segments: SUPPORT_COST });

    expect(await search({ actor: actorFor(tenantId), query: "" })).toEqual([]);
    expect(await search({ actor: actorFor(tenantId), query: "   " })).toEqual([]);
  });

  it("puts the meeting named by the query above the calls that merely mention it", async () => {
    await seedMeeting({ tenantId, title: "Pricing committee" });
    await seedMeeting({
      tenantId,
      title: "Weekly engineering sync",
      segments: [
        { speaker: "Priya Raman", startMs: 5_000, text: "pricing came up with the mid-market team" },
      ],
    });

    const hits = await search({ actor: actorFor(tenantId), query: "pricing" });

    expect(hits[0]?.kind).toBe("meeting");
    expect(hits[0]?.meetingTitle).toBe("Pricing committee");
    expect(hits.map((h) => h.kind)).toContain("transcript");
  });

  it("ranks the segment where the terms sit together above the one where they drift apart", async () => {
    const meeting = await seedMeeting({ tenantId, title: "Renewal review", segments: SUPPORT_COST });

    const hits = await search({
      actor: actorFor(tenantId),
      query: "support cost",
      kinds: ["transcript"],
    });

    expect(hits).toHaveLength(2);
    expect(hits[0]?.segmentId).toBe(meeting.segmentIds[0]);
    expect(hits[1]?.segmentId).toBe(meeting.segmentIds[1]);
    expect(hits[0]!.rank).toBeGreaterThan(hits[1]!.rank);
  });

  it("treats a quoted phrase as a phrase", async () => {
    const meeting = await seedMeeting({ tenantId, title: "Renewal review", segments: SUPPORT_COST });

    const loose = await search({ actor: actorFor(tenantId), query: "support cost", kinds: ["transcript"] });
    const phrase = await search({
      actor: actorFor(tenantId),
      query: '"support cost"',
      kinds: ["transcript"],
    });

    expect(loose).toHaveLength(2);
    expect(phrase).toHaveLength(1);
    expect(phrase[0]?.segmentId).toBe(meeting.segmentIds[0]);
  });

  it("carries enough provenance to jump to the moment", async () => {
    const meeting = await seedMeeting({ tenantId, title: "Renewal review", segments: SUPPORT_COST });

    const [hit] = await search({
      actor: actorFor(tenantId),
      query: '"support cost"',
      kinds: ["transcript"],
    });

    expect(hit).toMatchObject({
      kind: "transcript",
      meetingId: meeting.id,
      meetingTitle: "Renewal review",
      segmentId: meeting.segmentIds[0],
      startMs: 12_000,
      endMs: 16_000,
      speaker: "Priya Raman",
      evidenceRedacted: false,
    });
    expect(hit?.snippet).toContain("<mark>");
  });

  it("escapes the transcript before it highlights it", async () => {
    await seedMeeting({
      tenantId,
      title: "Renewal review",
      segments: [
        { speaker: "Priya Raman", startMs: 1_000, text: '<script>evil()</script> pricing was discussed' },
      ],
    });

    const [hit] = await search({ actor: actorFor(tenantId), query: "pricing", kinds: ["transcript"] });

    expect(hit?.snippet).toContain("<mark>pricing</mark>");
    expect(hit?.snippet).not.toContain("<script>");
  });

  it("searches notes, action items and approved brief claims alongside the transcript", async () => {
    const meeting = await seedMeeting({
      tenantId,
      title: "Renewal review",
      segments: SUPPORT_COST,
      notes: "we agreed to ship the migration guide before the renewal call",
    });
    await db.actionItem.create({
      data: {
        tenantId,
        meetingId: meeting.id,
        title: "Draft the migration guide",
        description: "Owner is Priya, due before the renewal",
        sourceSegmentId: meeting.segmentIds[1],
      },
    });
    await seedBriefClaim({
      tenantId,
      meetingId: meeting.id,
      evidenceSourceId: meeting.evidenceSourceId!,
      text: "The migration guide is the wedge into mid-market renewals",
      quote: "the migration guide is what gets us in the door",
    });

    const hits = await search({ actor: actorFor(tenantId), query: "migration guide" });
    const kinds = hits.map((h) => h.kind);

    expect(kinds).toContain("note");
    expect(kinds).toContain("action_item");
    expect(kinds).toContain("claim");

    // An action item lifted from the transcript keeps its citation, so its hit
    // can seek into the recording just like a transcript hit can.
    const action = hits.find((h) => h.kind === "action_item");
    expect(action?.segmentId).toBe(meeting.segmentIds[1]);
    expect(action?.startMs).toBe(48_000);
    expect(action?.speaker).toBe("Daniel Okafor");
  });

  it("returns only the current brief version, not one hit per merge", async () => {
    const meeting = await seedMeeting({ tenantId, title: "Renewal review", segments: SUPPORT_COST });
    await seedBriefClaim({
      tenantId,
      meetingId: meeting.id,
      evidenceSourceId: meeting.evidenceSourceId!,
      text: "The migration guide is the wedge into mid-market renewals",
      quote: "the migration guide is what gets us in the door",
      versions: [1, 2, 3],
    });

    const hits = await search({ actor: actorFor(tenantId), query: "migration guide", kinds: ["claim"] });

    expect(hits).toHaveLength(1);
  });

  it("restricts the corpora when a kind is named", async () => {
    await seedMeeting({
      tenantId,
      title: "Pricing committee",
      segments: [{ speaker: "Priya Raman", startMs: 1_000, text: "pricing came up again" }],
    });

    const hits = await search({ actor: actorFor(tenantId), query: "pricing", kinds: ["transcript"] });

    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.kind === "transcript")).toBe(true);
  });

  it("narrows to one meeting when asked", async () => {
    const wanted = await seedMeeting({ tenantId, title: "Renewal review", segments: SUPPORT_COST });
    await seedMeeting({ tenantId, title: "Another renewal review", segments: SUPPORT_COST });

    const hits = await search({
      actor: actorFor(tenantId),
      query: "support cost",
      kinds: ["transcript"],
      meetingId: wanted.id,
    });

    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.meetingId === wanted.id)).toBe(true);
  });
});

describe("search tenancy", () => {
  it("never returns another tenant's content", async () => {
    const mine = await seedMeeting({ tenantId, title: "Renewal review", segments: SUPPORT_COST });
    const theirs = await seedMeeting({
      tenantId: rivalTenantId,
      title: "Renewal review",
      segments: SUPPORT_COST,
      notes: "support cost is their problem too",
    });

    const hits = await search({ actor: actorFor(tenantId), query: "support cost" });

    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.meetingId === mine.id)).toBe(true);
    expect(hits.some((h) => h.meetingId === theirs.id)).toBe(false);
  });

  it("does not let a meeting_id filter reach across tenants", async () => {
    await seedMeeting({ tenantId, title: "Renewal review", segments: SUPPORT_COST });
    const theirs = await seedMeeting({
      tenantId: rivalTenantId,
      title: "Renewal review",
      segments: SUPPORT_COST,
    });

    const hits = await search({
      actor: actorFor(tenantId),
      query: "support cost",
      meetingId: theirs.id,
    });

    expect(hits).toEqual([]);
  });

  it("drops a deleted meeting out of the index", async () => {
    const meeting = await seedMeeting({
      tenantId,
      title: "Renewal review",
      segments: SUPPORT_COST,
      notes: "support cost is the whole conversation",
    });

    const before = await search({ actor: actorFor(tenantId), query: "support cost" });
    await db.meeting.update({ where: { id: meeting.id }, data: { deletedAt: new Date() } });
    const after = await search({ actor: actorFor(tenantId), query: "support cost" });

    expect(before.length).toBeGreaterThan(0);
    expect(after).toEqual([]);
  });

  it("hides a private meeting from a member and shows it to an admin", async () => {
    await seedMeeting({
      tenantId,
      title: "Board prep",
      visibility: MeetingVisibility.private,
      createdByUserId: null,
      segments: [
        { speaker: "Priya Raman", startMs: 2_000, text: "the roadmap slips a quarter if we hire late" },
      ],
    });

    const asMember = await search({ actor: actorFor(tenantId, { userId: OUTSIDER }), query: "roadmap" });
    const asAdmin = await search({
      actor: actorFor(tenantId, { userId: OUTSIDER, role: "admin" }),
      query: "roadmap",
    });

    expect(asMember).toEqual([]);
    expect(asAdmin.length).toBeGreaterThan(0);
  });
});

describe("recording playback", () => {
  it("returns a presigned url, a duration and the transcript in play order", async () => {
    const meeting = await seedMeeting({
      tenantId,
      title: "Renewal review",
      segments: SUPPORT_COST,
      recording: "present",
    });

    const playback = await withTenant(tenantId, () => loadPlayback(actorFor(tenantId), meeting.id));

    expect(playback.unavailable_reason).toBeNull();
    expect(playback.audio?.url).toContain(meeting.id);
    expect(playback.audio?.content_type).toBe("audio/mpeg");
    expect(playback.audio?.bytes).toBe(4_812_004);
    // Measured off the media, not off the calendar.
    expect(playback.meeting.duration_ms).toBe(53_000);
    expect(playback.transcript.segments.map((s) => s.start_ms)).toEqual([12_000, 48_000]);
    expect(playback.transcript.segments[0]).toMatchObject({
      speaker: "Priya Raman",
      start_ms: 12_000,
      end_ms: 16_000,
    });
  });

  it("says the recording was purged instead of handing back a dead url", async () => {
    const meeting = await seedMeeting({
      tenantId,
      title: "Renewal review",
      segments: SUPPORT_COST,
      recording: "purged",
    });

    const playback = await withTenant(tenantId, () => loadPlayback(actorFor(tenantId), meeting.id));

    expect(playback.audio).toBeNull();
    expect(playback.unavailable_reason).toBe("purged");
    // The transcript survives a purge of the media only until the meeting
    // itself is deleted, so it is still worth returning.
    expect(playback.transcript.segments).toHaveLength(2);
  });

  it("distinguishes a meeting that was never recorded from one that was purged", async () => {
    const meeting = await seedMeeting({ tenantId, title: "Renewal review", segments: SUPPORT_COST });

    const playback = await withTenant(tenantId, () => loadPlayback(actorFor(tenantId), meeting.id));

    expect(playback.audio).toBeNull();
    expect(playback.unavailable_reason).toBe("not_recorded");
  });

  it("404s a private meeting rather than confirming it exists", async () => {
    const meeting = await seedMeeting({
      tenantId,
      title: "Board prep",
      visibility: MeetingVisibility.private,
      createdByUserId: null,
      segments: SUPPORT_COST,
      recording: "present",
    });

    await expect(
      withTenant(tenantId, () => loadPlayback(actorFor(tenantId, { userId: OUTSIDER }), meeting.id)),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("404s a deleted meeting rather than reporting its recording as purged", async () => {
    const meeting = await seedMeeting({
      tenantId,
      title: "Renewal review",
      segments: SUPPORT_COST,
      recording: "purged",
    });
    await db.meeting.update({ where: { id: meeting.id }, data: { deletedAt: new Date() } });

    await expect(
      withTenant(tenantId, () => loadPlayback(actorFor(tenantId), meeting.id)),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("404s another tenant's meeting", async () => {
    const theirs = await seedMeeting({
      tenantId: rivalTenantId,
      title: "Renewal review",
      segments: SUPPORT_COST,
      recording: "present",
    });

    await expect(
      withTenant(tenantId, () => loadPlayback(actorFor(tenantId), theirs.id)),
    ).rejects.toMatchObject({ status: 404 });
  });
});
