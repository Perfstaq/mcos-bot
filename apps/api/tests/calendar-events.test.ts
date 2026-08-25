import crypto from "node:crypto";
import { AutoRecordMode, MeetingStatus } from "@prisma/client";
import Fastify, { type FastifyInstance } from "fastify";
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type Dispatcher } from "undici";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auth } from "../src/auth.js";
import { authBaseUrl, env } from "../src/env.js";
import { decideAutoRecord } from "../src/domain/auto-record.js";
import { registerCore } from "../src/http.js";
import type { SyncAttendee } from "../src/jobs/calendar-sync.js";
import { calendarEventRoutes } from "../src/routes/calendar-events.js";
import { preferenceRoutes } from "../src/routes/preferences.js";
import { db } from "./helpers.js";

/**
 * The calendar screen's backend, and the decision underneath it.
 *
 * Two halves. The first is pure: `decideAutoRecord` is the function that
 * answers "does a bot walk into this meeting", so its precedence is asserted
 * layer by layer rather than inferred from an endpoint's output. The second
 * drives the routes over HTTP with a real session, because the refusals are the
 * point — an endpoint that dispatches a bot when it should not is the failure
 * mode worth a test.
 *
 * The routes are not mounted in server.ts yet (the integrator owns that file),
 * so this builds the same stack the server does, exactly as sharing.test.ts does.
 */

const SESSION_COOKIE = `${authBaseUrl.startsWith("https") ? "__Secure-" : ""}better-auth.session_token`;

const DAY_MS = 86_400_000;

/* -------------------------------------------------------------------------
 * The decision
 * ---------------------------------------------------------------------- */

const insider: SyncAttendee = {
  email: "priya@perfstaq.example",
  name: "Priya Raman",
  optional: false,
  resource: false,
  response: "accepted",
};
const outsider: SyncAttendee = {
  email: "daniel@freshworks.example",
  name: "Daniel Okafor",
  optional: false,
  resource: false,
  response: "accepted",
};

/** A calendar nobody has configured: not opted in, no rules. */
const pristineConnection = {
  autoRecord: false,
  autoRecordRules: {},
  email: "priya@perfstaq.example",
};

/** Opted in, and narrowed to calls with someone from outside. */
const rulesConnection = {
  autoRecord: true,
  autoRecordRules: { externalOnly: true },
  email: "priya@perfstaq.example",
};

function event(overrides: Partial<Parameters<typeof decideAutoRecord>[0]["event"]> = {}) {
  return {
    title: "Pricing review",
    organizerEmail: "priya@perfstaq.example",
    attendees: [insider, outsider],
    meetingUrl: "https://meet.google.com/kqr-mpxz-abc",
    cancelled: false,
    allDay: false,
    override: null,
    ...overrides,
  };
}

describe("decideAutoRecord", () => {
  it("lets a per-event override beat the connection and the personal default", () => {
    // Everything below the override says record: the calendar is opted in, the
    // event passes its rules, and the personal mode is "all".
    const off = decideAutoRecord({
      preference: { autoRecordMode: AutoRecordMode.all },
      connection: rulesConnection,
      event: event({ override: false }),
    });
    expect(off).toMatchObject({ record: false, decidedBy: "event_override" });

    // And the other direction: everything below says no.
    const on = decideAutoRecord({
      preference: { autoRecordMode: AutoRecordMode.none },
      connection: pristineConnection,
      event: event({ override: true }),
    });
    expect(on).toMatchObject({ record: true, decidedBy: "event_override" });
  });

  it("lets the connection's rules beat the personal default", () => {
    // Personal mode says record everything; the calendar says external only.
    const internal = decideAutoRecord({
      preference: { autoRecordMode: AutoRecordMode.all },
      connection: rulesConnection,
      event: event({ attendees: [insider] }),
    });
    expect(internal).toMatchObject({ record: false, decidedBy: "connection" });

    // Personal mode says record nothing; the calendar is opted in and passes.
    const external = decideAutoRecord({
      preference: { autoRecordMode: AutoRecordMode.none },
      connection: rulesConnection,
      event: event(),
    });
    expect(external).toMatchObject({ record: true, decidedBy: "connection" });
  });

  it("never lets a personal default drag an opted-out calendar into recording", () => {
    // The connection has an opinion — rules, but switched off — so the ladder
    // stops there. This is the case that must not fail open.
    const decision = decideAutoRecord({
      preference: { autoRecordMode: AutoRecordMode.all },
      connection: { ...rulesConnection, autoRecord: false },
      event: event(),
    });
    expect(decision).toMatchObject({ record: false, decidedBy: "connection" });
  });

  it("falls through to the personal default only for a calendar nobody configured", () => {
    const withMode = (mode: AutoRecordMode, e = event()) =>
      decideAutoRecord({
        preference: { autoRecordMode: mode },
        connection: pristineConnection,
        event: e,
      });

    expect(withMode(AutoRecordMode.none)).toMatchObject({ record: false, decidedBy: "preference" });
    expect(withMode(AutoRecordMode.all)).toMatchObject({ record: true, decidedBy: "preference" });

    // external: an outside attendee is required.
    expect(withMode(AutoRecordMode.external)).toMatchObject({ record: true });
    expect(withMode(AutoRecordMode.external, event({ attendees: [insider] }))).toMatchObject({
      record: false,
    });

    // owned: the connected mailbox must be the organiser.
    expect(withMode(AutoRecordMode.owned)).toMatchObject({ record: true });
    expect(
      withMode(AutoRecordMode.owned, event({ organizerEmail: "daniel@freshworks.example" })),
    ).toMatchObject({ record: false });
  });

  it("reads a missing preference row as the enum default", () => {
    expect(
      decideAutoRecord({ preference: null, connection: pristineConnection, event: event() }),
    ).toMatchObject({ record: false, decidedBy: "preference" });
  });

  it("fails closed on an event there is nothing to join, override or not", () => {
    const cases = [
      event({ cancelled: true, override: true }),
      event({ allDay: true, override: true }),
      event({ meetingUrl: null, override: true }),
    ];
    for (const candidate of cases) {
      expect(
        decideAutoRecord({
          preference: { autoRecordMode: AutoRecordMode.all },
          connection: rulesConnection,
          event: candidate,
        }),
      ).toMatchObject({ record: false, decidedBy: "ineligible" });
    }
  });

  it("keeps an unparseable rules blob authoritative rather than demoting it", () => {
    // A rules column we cannot read still means somebody configured this
    // calendar. Treating it as "untouched" would hand the decision to a
    // personal mode of "all" and record a call nobody opted in to.
    const decision = decideAutoRecord({
      preference: { autoRecordMode: AutoRecordMode.all },
      connection: { ...pristineConnection, autoRecordRules: { minAttendee: 2 } },
      event: event(),
    });
    expect(decision).toMatchObject({ record: false, decidedBy: "connection" });
  });

  it("fails closed on `owned` when the event has no organiser", () => {
    expect(
      decideAutoRecord({
        preference: { autoRecordMode: AutoRecordMode.owned },
        connection: pristineConnection,
        event: event({ organizerEmail: null }),
      }),
    ).toMatchObject({ record: false });
  });
});

/* -------------------------------------------------------------------------
 * The routes
 * ---------------------------------------------------------------------- */

type Person = { userId: string; email: string; cookie: string };
type Workspace = { organizationId: string; tenantId: string; owner: Person };

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerCore(app);
  await app.register(
    async (api) => {
      await api.register(calendarEventRoutes);
      await api.register(preferenceRoutes);
    },
    { prefix: "/api/v1" },
  );
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await db.$disconnect();
});

beforeEach(async () => {
  // One statement, for the same reason sharing.test.ts gives: two truncates
  // race for locks on `user` against a connection still finishing a session
  // lookup, and deadlock.
  await db.$executeRawUnsafe(
    `TRUNCATE TABLE "tenants", "organization", "user", "verification" CASCADE`,
  );
});

describe("GET /calendar/events/range", () => {
  it("rejects an inverted range", async () => {
    const { owner } = await workspaceWithCalendar();
    const response = await get(owner, {
      from: "2026-09-10T00:00:00.000Z",
      to: "2026-09-03T00:00:00.000Z",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("bad_request");
  });

  it("caps the window at 62 days", async () => {
    const { owner } = await workspaceWithCalendar();
    const from = new Date("2026-09-01T00:00:00.000Z");

    const tooWide = await get(owner, {
      from: from.toISOString(),
      to: new Date(from.getTime() + 63 * DAY_MS).toISOString(),
    });
    expect(tooWide.statusCode).toBe(400);
    // The cap is reported per-field, the way every other route here reports a
    // rejected query, so the client can put it next to the control that caused it.
    expect(tooWide.json().error.details.fieldErrors.to).toContain(
      "Range must not exceed 62 days",
    );

    const atTheLimit = await get(owner, {
      from: from.toISOString(),
      to: new Date(from.getTime() + 62 * DAY_MS).toISOString(),
    });
    expect(atTheLimit.statusCode).toBe(200);
  });

  it("returns the window in start order with what the grid needs", async () => {
    const workspace = await workspaceWithCalendar();
    const connectionId = workspace.connectionId;

    await createEvent(workspace, {
      externalId: "late",
      title: "Deal review",
      startsAt: new Date("2026-09-03T13:00:00.000Z"),
      endsAt: new Date("2026-09-03T13:30:00.000Z"),
    });
    await createEvent(workspace, {
      externalId: "early",
      title: "Pricing review",
      startsAt: new Date("2026-09-03T10:00:00.000Z"),
      endsAt: new Date("2026-09-03T10:45:00.000Z"),
      autoRecord: true,
    });
    // Outside the window entirely.
    await createEvent(workspace, {
      externalId: "next-year",
      startsAt: new Date("2027-01-05T10:00:00.000Z"),
      endsAt: new Date("2027-01-05T11:00:00.000Z"),
    });

    const response = await get(workspace.owner, {
      from: "2026-09-01T00:00:00.000Z",
      to: "2026-09-08T00:00:00.000Z",
    });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.events.map((e: { external_id: string }) => e.external_id)).toEqual([
      "early",
      "late",
    ]);

    const first = body.events[0];
    expect(first).toMatchObject({
      title: "Pricing review",
      connection_id: connectionId,
      timezone: "Asia/Dubai",
      organizer_email: "priya@perfstaq.example",
      platform: "google_meet",
      auto_record: true,
      bot_dispatched: false,
      cancelled: false,
      meeting_id: null,
    });
    expect(first.starts_at).toBe("2026-09-03T10:00:00.000Z");
    expect(first.meeting_url).toBe("https://meet.google.com/kqr-mpxz-abc");
    // The boardroom is an attendee to Google and not to a person reading "2".
    expect(first.attendee_count).toBe(2);
    expect(first.attendees.map((a: { name: string }) => a.name)).toEqual([
      "Priya Raman",
      "Daniel Okafor",
      "Boardroom 2",
    ]);
    expect(first.auto_record_decision.decidedBy).toBe("connection");
  });

  it("does not return another person's calendar to a plain member", async () => {
    const workspace = await workspaceWithCalendar();
    await createEvent(workspace, { externalId: "private-to-priya" });

    const colleague = await signIn("daniel@freshworks.example", "Daniel Okafor");
    await auth.api.addMember({
      body: {
        userId: colleague.userId,
        role: "member",
        organizationId: workspace.organizationId,
      },
    });

    const response = await get(colleague, {
      from: "2026-09-01T00:00:00.000Z",
      to: "2026-09-08T00:00:00.000Z",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().events).toEqual([]);
  });
});

describe("PATCH /calendar/events/:id", () => {
  it("keeps a per-event override across reads and repeated writes", async () => {
    const workspace = await workspaceWithCalendar();
    const event = await createEvent(workspace, { externalId: "toggle-me" });

    const on = await patch(workspace.owner, event.id, { auto_record: true });
    expect(on.statusCode).toBe(200);
    expect(on.json().event.auto_record).toBe(true);

    const reread = await get(workspace.owner, {
      from: "2026-09-01T00:00:00.000Z",
      to: "2026-09-08T00:00:00.000Z",
    });
    expect(reread.json().events[0].auto_record).toBe(true);

    // And back off again — the toggle is not one-way.
    const off = await patch(workspace.owner, event.id, { auto_record: false });
    expect(off.json().event.auto_record).toBe(false);
    await expect(
      db.calendarEvent.findUniqueOrThrow({ where: { id: event.id } }),
    ).resolves.toMatchObject({ autoRecord: false });
  });

  it("refuses to switch recording on for an event a bot cannot join", async () => {
    const workspace = await workspaceWithCalendar();
    const cancelled = await createEvent(workspace, { externalId: "gone", cancelled: true });
    const linkless = await createEvent(workspace, { externalId: "no-link", meetingUrl: null });

    expect((await patch(workspace.owner, cancelled.id, { auto_record: true })).statusCode).toBe(422);
    expect((await patch(workspace.owner, linkless.id, { auto_record: true })).statusCode).toBe(422);

    // Switching *off* stays available: it can never send a bot anywhere.
    expect((await patch(workspace.owner, cancelled.id, { auto_record: false })).statusCode).toBe(200);
  });

  it("refuses to switch recording off once a bot is booked", async () => {
    const workspace = await workspaceWithCalendar();
    const event = await createEvent(workspace, {
      externalId: "already-booked",
      autoRecord: true,
      botDispatched: true,
    });

    const response = await patch(workspace.owner, event.id, { auto_record: false });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toMatch(/cancel the meeting/i);
  });

  it("rejects a body that is not the toggle", async () => {
    const workspace = await workspaceWithCalendar();
    const event = await createEvent(workspace, { externalId: "strict" });
    expect((await patch(workspace.owner, event.id, { auto_record: "yes" })).statusCode).toBe(400);
    expect((await patch(workspace.owner, event.id, { autoRecord: true })).statusCode).toBe(400);
  });
});

describe("POST /calendar/events/:id/record-now", () => {
  it("refuses an event that already has a bot", async () => {
    const workspace = await workspaceWithCalendar();
    const event = await createEvent(workspace, { externalId: "dispatched", botDispatched: true });

    const response = await recordNow(workspace.owner, event.id);
    expect(response.statusCode).toBe(409);
    expect(await db.meeting.count()).toBe(0);
  });

  it("refuses a cancelled event and one with no link", async () => {
    const workspace = await workspaceWithCalendar();
    const cancelled = await createEvent(workspace, { externalId: "gone", cancelled: true });
    const linkless = await createEvent(workspace, { externalId: "no-link", meetingUrl: null });

    expect((await recordNow(workspace.owner, cancelled.id)).statusCode).toBe(422);
    expect((await recordNow(workspace.owner, linkless.id)).statusCode).toBe(422);
    expect(await db.meeting.count()).toBe(0);
  });

  it("refuses an admin who does not own the calendar", async () => {
    const workspace = await workspaceWithCalendar();
    const event = await createEvent(workspace, { externalId: "not-yours" });

    const admin = await signIn("ops@perfstaq.example", "Ops Admin");
    await auth.api.addMember({
      body: { userId: admin.userId, role: "admin", organizationId: workspace.organizationId },
    });

    const response = await recordNow(admin, event.id);
    // Visible to an admin, so 403 rather than the 404 a stranger would get:
    // the refusal is about the action, not about the event's existence.
    expect(response.statusCode).toBe(403);
    expect(await db.meeting.count()).toBe(0);
  });

  describe("with Recall answering", () => {
    let agent: MockAgent;
    let previous: Dispatcher;

    beforeEach(() => {
      previous = getGlobalDispatcher();
      agent = new MockAgent();
      agent.disableNetConnect();
      setGlobalDispatcher(agent);
    });

    afterEach(async () => {
      setGlobalDispatcher(previous);
      await agent.close();
    });

    it("books an ad-hoc bot and links the meeting to the event", async () => {
      const workspace = await workspaceWithCalendar();
      const event = await createEvent(workspace, { externalId: "join-now" });

      let sent: Record<string, unknown> = {};
      agent
        .get(`https://${env.RECALL_REGION}.recall.ai`)
        .intercept({ method: "POST", path: "/api/v1/bot/" })
        .reply(201, (opts: { body?: string | null }) => {
          sent = JSON.parse(opts.body ?? "{}");
          return { id: "bot-record-now" };
        });

      const response = await recordNow(workspace.owner, event.id);
      expect(response.statusCode).toBe(200);

      // No join_at: Recall treats a bot without one as ad-hoc, which is what
      // "record now" means. A scheduled bot would sit and wait.
      expect(sent).toMatchObject({ meeting_url: "https://meet.google.com/kqr-mpxz-abc" });
      expect(sent).not.toHaveProperty("join_at");

      const stored = await db.calendarEvent.findUniqueOrThrow({ where: { id: event.id } });
      expect(stored.botDispatched).toBe(true);
      expect(stored.meetingId).not.toBeNull();

      const meeting = await db.meeting.findUniqueOrThrow({ where: { id: stored.meetingId! } });
      expect(meeting).toMatchObject({
        status: MeetingStatus.bot_scheduled,
        recallBotId: "bot-record-now",
        createdByUserId: workspace.owner.userId,
      });
      expect(response.json().event.meeting.recall_bot_id).toBe("bot-record-now");
    });

    it("parks the meeting in failed and keeps the claim when Recall refuses", async () => {
      const workspace = await workspaceWithCalendar();
      const event = await createEvent(workspace, { externalId: "recall-says-no" });

      agent
        .get(`https://${env.RECALL_REGION}.recall.ai`)
        .intercept({ method: "POST", path: "/api/v1/bot/" })
        .reply(400, { detail: "meeting_url is not a supported meeting" });

      const response = await recordNow(workspace.owner, event.id);
      expect(response.statusCode).toBe(502);

      const meetingId = response.json().error.details.meeting_id;
      await expect(db.meeting.findUniqueOrThrow({ where: { id: meetingId } })).resolves.toMatchObject(
        { status: MeetingStatus.failed, failedStage: "dispatch" },
      );

      // The claim is deliberately not released: a second press would create a
      // second meeting and orphan this one. Retrying goes through the meeting.
      const stored = await db.calendarEvent.findUniqueOrThrow({ where: { id: event.id } });
      expect(stored.botDispatched).toBe(true);
      expect((await recordNow(workspace.owner, event.id)).statusCode).toBe(409);
      expect(await db.meeting.count()).toBe(1);
    });
  });
});

describe("preferences", () => {
  it("creates the row on demand and validates the mode", async () => {
    const { owner } = await workspaceWithCalendar();

    const first = await app.inject({
      method: "GET",
      url: "/api/v1/preferences",
      headers: { cookie: owner.cookie },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().preferences).toMatchObject({
      auto_record_mode: AutoRecordMode.none,
      recording_method: "bot",
    });

    const updated = await app.inject({
      method: "PATCH",
      url: "/api/v1/preferences",
      headers: { cookie: owner.cookie },
      payload: { auto_record_mode: "external", timezone: "Asia/Dubai" },
    });
    expect(updated.json().preferences).toMatchObject({
      auto_record_mode: AutoRecordMode.external,
      timezone: "Asia/Dubai",
    });

    const nonsense = await app.inject({
      method: "PATCH",
      url: "/api/v1/preferences",
      headers: { cookie: owner.cookie },
      payload: { auto_record_mode: "sometimes" },
    });
    expect(nonsense.statusCode).toBe(400);

    const badZone = await app.inject({
      method: "PATCH",
      url: "/api/v1/preferences",
      headers: { cookie: owner.cookie },
      payload: { timezone: "Middle/Earth" },
    });
    expect(badZone.statusCode).toBe(400);
  });

  it("feeds the calendar's decision for a calendar nobody configured", async () => {
    const workspace = await workspaceWithCalendar({ autoRecord: false, autoRecordRules: {} });
    await createEvent(workspace, { externalId: "follows-my-default" });

    await app.inject({
      method: "PATCH",
      url: "/api/v1/preferences",
      headers: { cookie: workspace.owner.cookie },
      payload: { auto_record_mode: "all" },
    });

    const response = await get(workspace.owner, {
      from: "2026-09-01T00:00:00.000Z",
      to: "2026-09-08T00:00:00.000Z",
    });
    expect(response.json().events[0].auto_record_decision).toMatchObject({
      record: true,
      decidedBy: "preference",
    });
  });
});

/* -------------------------------------------------------------------------
 * Harness
 * ---------------------------------------------------------------------- */

function get(person: Person, query: Record<string, string>) {
  return app.inject({
    method: "GET",
    url: "/api/v1/calendar/events/range",
    query,
    headers: { cookie: person.cookie },
  });
}

function patch(person: Person, id: string, payload: unknown) {
  return app.inject({
    method: "PATCH",
    url: `/api/v1/calendar/events/${id}`,
    headers: { cookie: person.cookie },
    payload,
  });
}

function recordNow(person: Person, id: string) {
  return app.inject({
    method: "POST",
    url: `/api/v1/calendar/events/${id}/record-now`,
    headers: { cookie: person.cookie },
    payload: {},
  });
}

/**
 * The session cookie Better Auth would have issued, minted directly — the same
 * shortcut sharing.test.ts documents at length: credential sign-up cannot run
 * against this schema, and the cookie below is still verified by the real
 * `getSession` and resolved by the real `resolveActor`.
 */
async function signIn(email: string, name: string): Promise<Person> {
  const id = `user-${crypto.randomBytes(8).toString("hex")}`;
  const user = await db.user.create({ data: { id, name, email, emailVerified: true } });

  const token = crypto.randomBytes(32).toString("base64url");
  await db.session.create({
    data: {
      id: `session-${id}`,
      token,
      userId: user.id,
      expiresAt: new Date(Date.now() + DAY_MS),
    },
  });

  const signature = crypto
    .createHmac("sha256", env.BETTER_AUTH_SECRET)
    .update(token)
    .digest("base64");
  return {
    userId: user.id,
    email,
    cookie: `${SESSION_COOKIE}=${encodeURIComponent(`${token}.${signature}`)}`,
  };
}

type CalendarWorkspace = Workspace & { connectionId: string };

async function workspaceWithCalendar(
  connection: { autoRecord?: boolean; autoRecordRules?: unknown } = {},
): Promise<CalendarWorkspace> {
  const owner = await signIn("priya@perfstaq.example", "Priya Raman");
  const organization = await auth.api.createOrganization({
    body: { name: "Perfstaq", slug: `perfstaq-${crypto.randomBytes(4).toString("hex")}` },
    headers: new Headers({ cookie: owner.cookie }),
  });
  if (!organization) throw new Error("createOrganization returned nothing");

  const tenant = await db.tenant.findUniqueOrThrow({ where: { organizationId: organization.id } });
  const row = await db.calendarConnection.create({
    data: {
      tenantId: tenant.id,
      userId: owner.userId,
      provider: "google",
      providerAccountId: `google-${crypto.randomBytes(4).toString("hex")}`,
      email: owner.email,
      autoRecord: connection.autoRecord ?? true,
      autoRecordRules: (connection.autoRecordRules ?? {}) as object,
    },
  });

  return {
    organizationId: organization.id,
    tenantId: tenant.id,
    owner,
    connectionId: row.id,
  };
}

async function createEvent(
  workspace: CalendarWorkspace,
  overrides: {
    externalId: string;
    title?: string;
    startsAt?: Date;
    endsAt?: Date;
    meetingUrl?: string | null;
    cancelled?: boolean;
    autoRecord?: boolean;
    botDispatched?: boolean;
  },
) {
  return db.calendarEvent.create({
    data: {
      tenantId: workspace.tenantId,
      connectionId: workspace.connectionId,
      externalId: overrides.externalId,
      title: overrides.title ?? "Pricing review",
      startsAt: overrides.startsAt ?? new Date("2026-09-03T10:00:00.000Z"),
      endsAt: overrides.endsAt ?? new Date("2026-09-03T10:45:00.000Z"),
      timezone: "Asia/Dubai",
      organizerEmail: "priya@perfstaq.example",
      attendees: [
        { ...insider },
        { ...outsider },
        {
          email: "boardroom-2@perfstaq.example",
          name: "Boardroom 2",
          optional: false,
          resource: true,
          response: "accepted",
        },
      ],
      meetingUrl:
        overrides.meetingUrl === undefined
          ? "https://meet.google.com/kqr-mpxz-abc"
          : overrides.meetingUrl,
      platform: "google_meet",
      cancelled: overrides.cancelled ?? false,
      autoRecord: overrides.autoRecord ?? false,
      botDispatched: overrides.botDispatched ?? false,
    },
  });
}
