import {
  ActionItemOrigin,
  ActionItemStatus,
  ArtifactKind,
  ClaimType,
  CollaboratorRole,
  EvidenceKind,
  MeetingStatus,
  MeetingVisibility,
} from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "./helpers.js";
import { runWithContext } from "../src/context.js";
import { disconnect } from "../src/db.js";
import type { Actor } from "../src/authz.js";
import {
  libraryMeetingsQuery,
  libraryNotesQuery,
  listLibraryMeetings,
  listLibraryNotes,
} from "../src/routes/library.js";

/**
 * The library selects its page with raw SQL and then hydrates it through the
 * tenant-scoped client, so every call here is wrapped the way the request
 * lifecycle wraps it. That matters for what the tenancy test proves: the
 * extension can only filter the aggregate queries, which are keyed by ids the
 * raw statement already chose. If that statement ever stops filtering
 * `tenant_id` itself, a rival tenant's meeting still arrives as a card — with
 * empty counts — and the assertion below fails rather than quietly passing.
 *
 * The loaders are called directly rather than over HTTP for the same reason
 * search.test.ts does: the route is four lines of validation, and going through
 * Fastify would mean minting a Better Auth session per assertion to test SQL.
 */

let tenantId: string;
let rivalTenantId: string;

const OWNER = "user_owner";
const COLLEAGUE = "user_colleague";
const OUTSIDER = "user_outsider";

function actorFor(tenant: string, overrides: Partial<Actor> = {}): Actor {
  // Nothing in library.ts reads the user table — visibility is decided from
  // meetings and meeting_collaborators — so `organizationId` is inert here and
  // the suite needs no organization rows.
  return {
    userId: OWNER,
    email: "owner@library.test",
    name: "Owner",
    organizationId: "org_test",
    tenantId: tenant,
    role: "member",
    ...overrides,
  };
}

function withTenant<T>(tenant: string, fn: () => Promise<T>): Promise<T> {
  return runWithContext({ tenantId: tenant, tenantSlug: "test", reviewer: "owner@library.test" }, fn);
}

function meetings(actor: Actor, query: Record<string, unknown> = {}) {
  return withTenant(actor.tenantId, () =>
    listLibraryMeetings(actor, libraryMeetingsQuery.parse(query)),
  );
}

function notes(actor: Actor, query: Record<string, unknown> = {}) {
  return withTenant(actor.tenantId, () => listLibraryNotes(actor, libraryNotesQuery.parse(query)));
}

/* --- fixtures ------------------------------------------------------------- */

type SeedSegment = { speaker: string; startMs: number; text: string };

const CONVERSATION: SeedSegment[] = [
  { speaker: "Priya Raman", startMs: 12_000, text: "the renewal hinges on the migration guide" },
  { speaker: "Priya Raman", startMs: 30_000, text: "and on who owns the follow-up" },
  { speaker: "Daniel Okafor", startMs: 48_000, text: "I can own the follow-up" },
];

async function seedMeeting(args: {
  tenantId?: string;
  title: string | null;
  startedAt?: Date | null;
  status?: MeetingStatus;
  visibility?: MeetingVisibility;
  createdByUserId?: string | null;
  collaborators?: { userId: string; role?: CollaboratorRole }[];
  segments?: SeedSegment[];
  notes?: string;
  noteEditorUserId?: string | null;
  recording?: "present" | "purged";
  durationMs?: number | null;
}) {
  const tenant = args.tenantId ?? tenantId;
  const meeting = await db.meeting.create({
    data: {
      tenantId: tenant,
      title: args.title,
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      status: args.status ?? MeetingStatus.merged,
      visibility: args.visibility ?? MeetingVisibility.workspace,
      createdByUserId: args.createdByUserId === undefined ? OWNER : args.createdByUserId,
      startedAt: args.startedAt === undefined ? new Date("2026-08-01T10:00:00Z") : args.startedAt,
      durationMs: args.durationMs ?? null,
    },
  });

  for (const collaborator of args.collaborators ?? []) {
    await db.meetingCollaborator.create({
      data: {
        tenantId: tenant,
        meetingId: meeting.id,
        userId: collaborator.userId,
        role: collaborator.role ?? CollaboratorRole.viewer,
      },
    });
  }

  let evidenceSourceId: string | null = null;
  const segmentIds: string[] = [];

  if (args.segments?.length) {
    const evidence = await db.evidenceSource.create({
      data: {
        tenantId: tenant,
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
        tenantId: tenant,
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
          tenantId: tenant,
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

  if (args.notes !== undefined) {
    await db.meetingNote.create({
      data: {
        tenantId: tenant,
        meetingId: meeting.id,
        state: Buffer.from([]),
        plainText: args.notes,
        revision: 3,
        updatedByUserId: args.noteEditorUserId === undefined ? COLLEAGUE : args.noteEditorUserId,
      },
    });
  }

  if (args.recording) {
    await db.artifact.create({
      data: {
        tenantId: tenant,
        meetingId: meeting.id,
        kind: ArtifactKind.recording_audio,
        r2Key: `${tenant}/meetings/${meeting.id}/recording.mp3`,
        contentType: "audio/mpeg",
        bytes: BigInt(4_812_004),
        checksum: "sha256:test",
        purgedAt: args.recording === "purged" ? new Date() : null,
      },
    });
  }

  return { id: meeting.id, evidenceSourceId, segmentIds };
}

async function seedClaim(args: { meetingId: string; evidenceSourceId: string; text: string }) {
  const run = await db.extractionRun.create({
    data: {
      tenantId,
      meetingId: args.meetingId,
      model: "test",
      promptVersion: "test/v1",
      status: "succeeded",
    },
  });
  await db.candidateClaim.create({
    data: {
      tenantId,
      meetingId: args.meetingId,
      evidenceSourceId: args.evidenceSourceId,
      extractionRunId: run.id,
      type: ClaimType.positioning_statement,
      text: args.text,
      confidence: 0.9,
      verbatimQuote: "the migration guide is what gets us in the door",
      speaker: "Priya Raman",
      timestampMs: 12_000,
      dedupeKey: `test-${args.meetingId}-${args.text.slice(0, 20)}`,
    },
  });
}

beforeEach(async () => {
  // One statement, not two: CASCADE reaches the domain tables from `tenants`
  // and the collaborator/note rows from `user`, and splitting it leaves a window
  // for two connections to take the same locks in opposite orders.
  await db.$executeRawUnsafe(`TRUNCATE TABLE "tenants", "user" CASCADE`);

  tenantId = (await db.tenant.create({ data: { slug: "library-test", name: "Library Test" } })).id;
  rivalTenantId = (await db.tenant.create({ data: { slug: "library-rival", name: "Rival Co" } })).id;

  for (const [id, name, email] of [
    [OWNER, "Owner", "owner@library.test"],
    [COLLEAGUE, "Colleague", "colleague@library.test"],
    [OUTSIDER, "Outsider", "outsider@library.test"],
  ] as const) {
    await db.user.create({ data: { id, name, email, emailVerified: true } });
  }
});

afterAll(async () => {
  await disconnect();
  await db.$disconnect();
});

/* --- scopes --------------------------------------------------------------- */

describe("library scopes", () => {
  it("shows the whole workspace shelf under scope=all", async () => {
    const mine = await seedMeeting({ title: "Pricing committee" });
    const theirs = await seedMeeting({ title: "Renewal review", createdByUserId: COLLEAGUE });

    const page = await meetings(actorFor(tenantId));

    expect(page.meetings.map((m) => m.id).sort()).toEqual([mine.id, theirs.id].sort());
  });

  it("narrows scope=mine to what the actor created", async () => {
    const mine = await seedMeeting({ title: "Pricing committee" });
    await seedMeeting({ title: "Renewal review", createdByUserId: COLLEAGUE });

    const page = await meetings(actorFor(tenantId), { scope: "mine" });

    expect(page.meetings.map((m) => m.id)).toEqual([mine.id]);
  });

  it("puts a meeting somebody shared under scope=shared_with_me", async () => {
    // Private and explicitly shared is the case the rail exists for: a
    // workspace-visible meeting was never anybody's to share.
    const shared = await seedMeeting({
      title: "Renewal review",
      visibility: MeetingVisibility.private,
      createdByUserId: COLLEAGUE,
      collaborators: [{ userId: OWNER, role: CollaboratorRole.editor }],
    });
    await seedMeeting({ title: "Pricing committee", createdByUserId: COLLEAGUE });

    const page = await meetings(actorFor(tenantId), { scope: "shared_with_me" });

    expect(page.meetings.map((m) => m.id)).toEqual([shared.id]);
  });

  it("drops a deleted meeting off the shelf", async () => {
    const meeting = await seedMeeting({ title: "Renewal review", notes: "worth keeping" });

    const before = await meetings(actorFor(tenantId));
    const notesBefore = await notes(actorFor(tenantId));
    await db.meeting.update({ where: { id: meeting.id }, data: { deletedAt: new Date() } });

    expect(before.meetings).toHaveLength(1);
    expect(notesBefore.notes).toHaveLength(1);
    expect((await meetings(actorFor(tenantId))).meetings).toEqual([]);
    expect((await notes(actorFor(tenantId))).notes).toEqual([]);
  });

  it("keeps my own meeting out of shared_with_me even when I am a collaborator on it", async () => {
    // Adding yourself to your own meeting happens; it must not make the meeting
    // appear on both rails, or the split stops splitting anything.
    await seedMeeting({
      title: "Pricing committee",
      createdByUserId: OWNER,
      collaborators: [{ userId: OWNER, role: CollaboratorRole.editor }],
    });

    const shared = await meetings(actorFor(tenantId), { scope: "shared_with_me" });
    const mine = await meetings(actorFor(tenantId), { scope: "mine" });

    expect(shared.meetings).toEqual([]);
    expect(mine.meetings).toHaveLength(1);
  });

  it("never returns somebody else's private meeting, under any scope", async () => {
    const secret = await seedMeeting({
      title: "Board prep",
      visibility: MeetingVisibility.private,
      createdByUserId: COLLEAGUE,
    });

    for (const scope of ["all", "mine", "shared_with_me"] as const) {
      const page = await meetings(actorFor(tenantId, { userId: OUTSIDER }), { scope });
      expect(page.meetings.map((m) => m.id)).not.toContain(secret.id);
    }

    // The fixture is real, not merely missing: its creator still sees it.
    const asCreator = await meetings(actorFor(tenantId, { userId: COLLEAGUE }), { scope: "mine" });
    expect(asCreator.meetings.map((m) => m.id)).toEqual([secret.id]);
  });

  it("shows a private meeting to a workspace admin, matching meetingAccess", async () => {
    const secret = await seedMeeting({
      title: "Board prep",
      visibility: MeetingVisibility.private,
      createdByUserId: COLLEAGUE,
    });

    const asAdmin = await meetings(actorFor(tenantId, { userId: OUTSIDER, role: "admin" }));

    expect(asAdmin.meetings.map((m) => m.id)).toEqual([secret.id]);
  });
});

/* --- the card ------------------------------------------------------------- */

describe("library cards", () => {
  it("carries everything the card renders in one call", async () => {
    const meeting = await seedMeeting({
      title: "Renewal review",
      startedAt: new Date("2026-08-05T09:00:00Z"),
      segments: CONVERSATION,
      notes: "we agreed to ship the migration guide before the renewal call",
      recording: "present",
    });
    await seedClaim({
      meetingId: meeting.id,
      evidenceSourceId: meeting.evidenceSourceId!,
      text: "The migration guide is the wedge into mid-market renewals",
    });
    await db.actionItem.create({
      data: { tenantId, meetingId: meeting.id, title: "Draft the migration guide" },
    });

    const [card] = (await meetings(actorFor(tenantId))).meetings;

    expect(card).toMatchObject({
      id: meeting.id,
      title: "Renewal review",
      status: MeetingStatus.merged,
      started_at: "2026-08-05T09:00:00.000Z",
      // Measured off the media (last segment + 5s), not off the calendar.
      duration_ms: 53_000,
      duration_label: "0:53",
      has_notes: true,
    });
    // Ordered by turns taken: Priya spoke twice, Daniel once.
    expect(card?.participants).toEqual(["Priya Raman", "Daniel Okafor"]);
    expect(card?.participant_count).toBe(2);
    expect(card?.transcript).toEqual({ available: true, segment_count: 3 });
    expect(card?.claim_counts).toMatchObject({ proposed: 1, total: 1 });
    expect(card?.action_item_counts).toMatchObject({ open: 1, total: 1, suggested: 0 });
    expect(card?.recording).toEqual({
      playable: true,
      unavailable_reason: null,
      content_type: "audio/mpeg",
      bytes: 4_812_004,
    });
  });

  it("falls back to the calendar duration only when there is no transcript", async () => {
    await seedMeeting({ title: "Pricing committee", durationMs: 1_800_000 });

    const [card] = (await meetings(actorFor(tenantId))).meetings;

    expect(card?.duration_ms).toBe(1_800_000);
    expect(card?.duration_label).toBe("30:00");
    expect(card?.transcript).toEqual({ available: false, segment_count: 0 });
  });

  it("reports no duration rather than a zero-length one", async () => {
    await seedMeeting({ title: "Pricing committee" });

    const [card] = (await meetings(actorFor(tenantId))).meetings;

    expect(card?.duration_ms).toBeNull();
    expect(card?.duration_label).toBeNull();
  });

  it("says a note nobody typed in is not a note", async () => {
    await seedMeeting({ title: "Pricing committee", notes: "   \n\n  " });

    const [card] = (await meetings(actorFor(tenantId))).meetings;

    expect(card?.has_notes).toBe(false);
  });

  it("counts an unaccepted suggestion as a suggestion, not as work somebody owes", async () => {
    const meeting = await seedMeeting({ title: "Renewal review" });
    await db.actionItem.createMany({
      data: [
        { tenantId, meetingId: meeting.id, title: "Typed by a person" },
        {
          tenantId,
          meetingId: meeting.id,
          title: "Proposed by a model",
          origin: ActionItemOrigin.ai_suggested,
        },
        {
          tenantId,
          meetingId: meeting.id,
          title: "Proposed and accepted",
          origin: ActionItemOrigin.ai_suggested,
          acceptedAt: new Date(),
          status: ActionItemStatus.in_progress,
        },
        {
          tenantId,
          meetingId: meeting.id,
          title: "Proposed and dismissed",
          origin: ActionItemOrigin.ai_suggested,
          dismissedAt: new Date(),
          status: ActionItemStatus.cancelled,
        },
      ],
    });

    const [card] = (await meetings(actorFor(tenantId))).meetings;

    expect(card?.action_item_counts).toMatchObject({
      open: 1,
      in_progress: 1,
      cancelled: 1,
      total: 3,
      suggested: 1,
    });
  });
});

/* --- recordings ----------------------------------------------------------- */

describe("library recordings", () => {
  it("reports a purged recording as unplayable rather than handing back a dead reference", async () => {
    await seedMeeting({ title: "Renewal review", recording: "purged" });

    const [card] = (await meetings(actorFor(tenantId))).meetings;

    expect(card?.recording).toEqual({
      playable: false,
      unavailable_reason: "purged",
      content_type: null,
      bytes: null,
    });
    // Nothing on the card can be turned back into a key or a URL for an object
    // that no longer exists in R2.
    expect(JSON.stringify(card)).not.toContain("recording.mp3");
  });

  it("distinguishes never-recorded from purged", async () => {
    await seedMeeting({ title: "Pricing committee" });

    const [card] = (await meetings(actorFor(tenantId))).meetings;

    expect(card?.recording.unavailable_reason).toBe("not_recorded");
  });

  it("filters to meetings that can actually be played", async () => {
    const playable = await seedMeeting({ title: "Renewal review", recording: "present" });
    const purged = await seedMeeting({ title: "Board sync", recording: "purged" });
    const never = await seedMeeting({ title: "Pricing committee" });

    const withRecording = await meetings(actorFor(tenantId), { has_recording: "true" });
    const without = await meetings(actorFor(tenantId), { has_recording: "false" });

    expect(withRecording.meetings.map((m) => m.id)).toEqual([playable.id]);
    expect(without.meetings.map((m) => m.id).sort()).toEqual([purged.id, never.id].sort());
  });

  it("reads has_recording=false as false", async () => {
    // `z.coerce.boolean()` would read it as true; the parse is the assertion.
    expect(libraryMeetingsQuery.parse({ has_recording: "false" }).has_recording).toBe(false);
  });
});

/* --- filters and search --------------------------------------------------- */

describe("library filters", () => {
  it("matches a title through the full-text index", async () => {
    const wanted = await seedMeeting({ title: "Pricing committee" });
    await seedMeeting({ title: "Weekly engineering sync" });

    const page = await meetings(actorFor(tenantId), { q: "pricing" });

    expect(page.meetings.map((m) => m.id)).toEqual([wanted.id]);
  });

  it("still finds the meeting when the search box has a typo in it", async () => {
    const wanted = await seedMeeting({ title: "Positioning review" });
    await seedMeeting({ title: "Weekly engineering sync" });

    const page = await meetings(actorFor(tenantId), { q: "positoning" });

    expect(page.meetings.map((m) => m.id)).toEqual([wanted.id]);
  });

  it("treats an empty search box as no filter — a library is still a library", async () => {
    await seedMeeting({ title: "Pricing committee" });
    await seedMeeting({ title: "Weekly engineering sync" });

    expect((await meetings(actorFor(tenantId), { q: "   " })).meetings).toHaveLength(2);
  });

  it("does not let a search reach a meeting the actor cannot read", async () => {
    await seedMeeting({
      title: "Pricing committee",
      visibility: MeetingVisibility.private,
      createdByUserId: COLLEAGUE,
    });

    const page = await meetings(actorFor(tenantId, { userId: OUTSIDER }), { q: "pricing" });

    expect(page.meetings).toEqual([]);
  });

  it("filters by status and by when the meeting happened", async () => {
    const august = await seedMeeting({
      title: "Renewal review",
      startedAt: new Date("2026-08-05T09:00:00Z"),
    });
    await seedMeeting({
      title: "Pricing committee",
      startedAt: new Date("2026-07-01T09:00:00Z"),
    });
    // Never started, so it has no date to be inside the range — which is the
    // documented behaviour, not an accident of the fixture.
    await seedMeeting({ title: "Failed dispatch", status: MeetingStatus.failed, startedAt: null });

    const ranged = await meetings(actorFor(tenantId), {
      from: "2026-08-01T00:00:00Z",
      to: "2026-08-31T00:00:00Z",
    });
    const failed = await meetings(actorFor(tenantId), { status: MeetingStatus.failed });

    expect(ranged.meetings.map((m) => m.id)).toEqual([august.id]);
    expect(failed.meetings.map((m) => m.title)).toEqual(["Failed dispatch"]);
  });
});

/* --- pagination ----------------------------------------------------------- */

describe("library pagination", () => {
  /**
   * Two of these share a start time and one has none at all: the tie exercises
   * the id half of the keyset, and the undated row exercises the NULLS LAST
   * tail, which is where an off-by-one either loops forever or ends early.
   */
  async function seedShelf() {
    return {
      alpha: await seedMeeting({ title: "Alpha", startedAt: new Date("2026-08-10T10:00:00Z") }),
      bravo: await seedMeeting({ title: "Bravo", startedAt: new Date("2026-08-09T10:00:00Z") }),
      charlie: await seedMeeting({ title: "Charlie", startedAt: new Date("2026-08-09T10:00:00Z") }),
      delta: await seedMeeting({ title: "Delta", startedAt: new Date("2026-08-08T10:00:00Z") }),
      echo: await seedMeeting({ title: "Echo", startedAt: null }),
    };
  }

  async function pageThrough(actor: Actor, limit: number): Promise<string[]> {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let round = 0; round < 20; round += 1) {
      const page: Awaited<ReturnType<typeof listLibraryMeetings>> = await meetings(actor, {
        limit,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...page.meetings.map((m) => m.id));
      cursor = page.next_cursor;
      if (!cursor) return seen;
    }
    throw new Error("pagination did not terminate");
  }

  it("hands out every meeting exactly once, in the same order as one big page", async () => {
    await seedShelf();

    const wholeShelf = (await meetings(actorFor(tenantId), { limit: 50 })).meetings.map((m) => m.id);
    const paged = await pageThrough(actorFor(tenantId), 2);

    expect(paged).toEqual(wholeShelf);
    expect(new Set(paged).size).toBe(5);
  });

  it("sorts undated meetings to the end of the shelf, not the front", async () => {
    const shelf = await seedShelf();

    const order = (await meetings(actorFor(tenantId), { limit: 50 })).meetings.map((m) => m.title);

    expect(order[0]).toBe("Alpha");
    expect(order.at(-1)).toBe("Echo");
    expect(shelf.echo.id).toBeDefined();
  });

  it("does not shift a page when a newer meeting lands mid-listing", async () => {
    await seedShelf();

    const first = await meetings(actorFor(tenantId), { limit: 2 });
    const undisturbed = await pageThrough(actorFor(tenantId), 2);

    // A recording finishes while somebody is on page one. Offset pagination
    // would push a card the reader has already seen onto page two.
    await seedMeeting({ title: "Foxtrot", startedAt: new Date("2026-08-11T10:00:00Z") });

    const rest: string[] = [];
    let cursor = first.next_cursor;
    while (cursor) {
      const page = await meetings(actorFor(tenantId), { limit: 2, cursor });
      rest.push(...page.meetings.map((m) => m.id));
      cursor = page.next_cursor;
    }

    expect([...first.meetings.map((m) => m.id), ...rest]).toEqual(undisturbed);
    expect(rest).not.toContain(first.meetings[0]?.id);
  });

  it("stops rather than offering a cursor onto an empty page", async () => {
    await seedMeeting({ title: "Alpha" });
    await seedMeeting({ title: "Bravo" });

    const page = await meetings(actorFor(tenantId), { limit: 2 });

    expect(page.meetings).toHaveLength(2);
    expect(page.next_cursor).toBeNull();
  });

  it("rejects a cursor it did not issue", async () => {
    await expect(meetings(actorFor(tenantId), { cursor: "not-a-cursor" })).rejects.toMatchObject({
      status: 400,
    });
  });
});

/* --- tenancy -------------------------------------------------------------- */

describe("library tenancy", () => {
  it("never returns another tenant's meeting, under any scope or filter", async () => {
    const mine = await seedMeeting({ title: "Renewal review", recording: "present" });
    const theirs = await seedMeeting({
      tenantId: rivalTenantId,
      title: "Renewal review",
      recording: "present",
      collaborators: [{ userId: OWNER, role: CollaboratorRole.editor }],
    });

    const all = await meetings(actorFor(tenantId));
    const searched = await meetings(actorFor(tenantId), { q: "renewal" });
    const shared = await meetings(actorFor(tenantId), { scope: "shared_with_me" });
    const admin = await meetings(actorFor(tenantId, { role: "admin" }));

    for (const page of [all, searched, admin]) {
      expect(page.meetings.map((m) => m.id)).toEqual([mine.id]);
    }
    // A collaborator row in the rival tenant must not pull the meeting across.
    expect(shared.meetings).toEqual([]);
    expect(theirs.id).not.toBe(mine.id);
  });

  it("does not leak another tenant's notes", async () => {
    await seedMeeting({
      tenantId: rivalTenantId,
      title: "Renewal review",
      notes: "their private planning",
    });

    expect((await notes(actorFor(tenantId))).notes).toEqual([]);
  });
});

/* --- notes ---------------------------------------------------------------- */

describe("library notes", () => {
  it("lists the meetings somebody wrote in, with an excerpt and the last editor", async () => {
    const written = await seedMeeting({
      title: "Renewal review",
      startedAt: new Date("2026-08-05T09:00:00Z"),
      notes: "  we agreed to ship\n\nthe migration guide   before the renewal call  ",
      noteEditorUserId: COLLEAGUE,
    });
    await seedMeeting({ title: "Pricing committee" });

    const page = await notes(actorFor(tenantId));

    expect(page.notes).toHaveLength(1);
    expect(page.notes[0]).toMatchObject({
      meeting_id: written.id,
      title: "Renewal review",
      started_at: "2026-08-05T09:00:00.000Z",
    });
    // Whitespace collapsed, so a card is one readable line rather than the
    // paragraph breaks of the source document.
    expect(page.notes[0]?.note.excerpt).toBe(
      "we agreed to ship the migration guide before the renewal call",
    );
    expect(page.notes[0]?.note.revision).toBe(3);
    expect(page.notes[0]?.note.last_editor).toMatchObject({
      user_id: COLLEAGUE,
      name: "Colleague",
      email: "colleague@library.test",
    });
  });

  it("truncates a long note instead of shipping the whole document", async () => {
    await seedMeeting({ title: "Renewal review", notes: "pricing ".repeat(200) });

    const [entry] = (await notes(actorFor(tenantId))).notes;

    expect(entry?.note.excerpt.length).toBeLessThanOrEqual(281);
    expect(entry?.note.excerpt.endsWith("…")).toBe(true);
  });

  it("leaves out a note nobody has typed in", async () => {
    await seedMeeting({ title: "Renewal review", notes: "" });
    await seedMeeting({ title: "Pricing committee", notes: "\n \t\n" });

    expect((await notes(actorFor(tenantId))).notes).toEqual([]);
  });

  it("reports no editor rather than inventing one", async () => {
    await seedMeeting({ title: "Renewal review", notes: "seeded, never edited by a person", noteEditorUserId: null });

    const [entry] = (await notes(actorFor(tenantId))).notes;

    expect(entry?.note.last_editor).toBeNull();
  });

  it("hides the note on a meeting the actor cannot read", async () => {
    await seedMeeting({
      title: "Board prep",
      visibility: MeetingVisibility.private,
      createdByUserId: COLLEAGUE,
      notes: "the roadmap slips a quarter if we hire late",
    });

    const asOutsider = await notes(actorFor(tenantId, { userId: OUTSIDER }));
    const asCreator = await notes(actorFor(tenantId, { userId: COLLEAGUE }));

    expect(asOutsider.notes).toEqual([]);
    expect(asCreator.notes).toHaveLength(1);
  });

  it("filters notes by the meeting's title and pages the rest", async () => {
    await seedMeeting({
      title: "Renewal review",
      startedAt: new Date("2026-08-10T10:00:00Z"),
      notes: "one",
    });
    await seedMeeting({
      title: "Pricing committee",
      startedAt: new Date("2026-08-09T10:00:00Z"),
      notes: "two",
    });
    await seedMeeting({
      title: "Weekly engineering sync",
      startedAt: new Date("2026-08-08T10:00:00Z"),
      notes: "three",
    });

    const searched = await notes(actorFor(tenantId), { q: "pricing" });
    const first = await notes(actorFor(tenantId), { limit: 2 });
    const second = await notes(actorFor(tenantId), { limit: 2, cursor: first.next_cursor! });

    expect(searched.notes.map((n) => n.title)).toEqual(["Pricing committee"]);
    expect(first.notes.map((n) => n.title)).toEqual(["Renewal review", "Pricing committee"]);
    expect(second.notes.map((n) => n.title)).toEqual(["Weekly engineering sync"]);
    expect(second.next_cursor).toBeNull();
  });
});
