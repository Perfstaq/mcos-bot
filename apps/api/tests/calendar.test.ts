import { MockAgent, setGlobalDispatcher } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  extractGoogleMeetingUrl,
  listGoogleEvents,
  type GoogleEvent,
} from "../src/integrations/google-calendar.js";
import {
  extractMicrosoftMeetingUrl,
  listMicrosoftEvents,
  parseGraphDateTime,
  type MicrosoftEvent,
} from "../src/integrations/microsoft-calendar.js";
import {
  normalizeGoogle,
  normalizeMicrosoft,
  passesAutoRecordRules,
  type SyncAttendee,
} from "../src/jobs/calendar-sync.js";

/**
 * Calendar sync.
 *
 * The event payloads below are shaped like the real ones — the entry-point
 * array Google actually sends, the entity-encoded HTML body Outlook actually
 * sends — because the parsing is the part that breaks, and a hand-tidied
 * fixture would never catch it.
 */

/* -------------------------------------------------------------------------
 * Fixtures
 * ---------------------------------------------------------------------- */

const googleWithConference: GoogleEvent = {
  id: "3vp0c2s9q1k4hb8u6m1n0d7e5f",
  status: "confirmed",
  summary: "Perfstaq <> Freshworks — pricing",
  // A stale Zoom link left in the body must lose to the configured conference.
  description:
    'Agenda in the doc. Old line: <a href="https://us02web.zoom.us/j/89123456789?pwd=aB3&amp;uname=Priya">Zoom</a>',
  location: "Google Meet (joining info in the description)",
  iCalUID: "3vp0c2s9q1k4hb8u6m1n0d7e5f@google.com",
  hangoutLink: "https://meet.google.com/kqr-mpxz-abc",
  start: { dateTime: "2026-09-02T10:00:00+04:00", timeZone: "Asia/Dubai" },
  end: { dateTime: "2026-09-02T10:45:00+04:00", timeZone: "Asia/Dubai" },
  organizer: { email: "Priya@perfstaq.example", displayName: "Priya Raman" },
  attendees: [
    { email: "Priya@perfstaq.example", displayName: "Priya Raman", responseStatus: "accepted", organizer: true, self: true },
    { email: "daniel@freshworks.example", displayName: "Daniel Okafor", responseStatus: "accepted" },
    { email: "boardroom-2@perfstaq.example", displayName: "Boardroom 2", resource: true, responseStatus: "accepted" },
  ],
  conferenceData: {
    conferenceId: "kqr-mpxz-abc",
    conferenceSolution: { key: { type: "hangoutsMeet" }, name: "Google Meet" },
    entryPoints: [
      {
        entryPointType: "video",
        uri: "https://meet.google.com/kqr-mpxz-abc",
        label: "meet.google.com/kqr-mpxz-abc",
      },
      { entryPointType: "more", uri: "https://tel.meet/kqr-mpxz-abc?pin=9182736450" },
      {
        entryPointType: "phone",
        uri: "tel:+971-4-123-4567",
        label: "+971 4 123 4567",
        meetingCode: "918273645",
      },
    ],
  },
};

const googleZoomInDescription: GoogleEvent = {
  id: "7hd91kf0s2m4nb",
  status: "confirmed",
  summary: "Deal review",
  description:
    '<p>Daniel is hosting.</p><p><a href="https://perfstaq.zoom.us/j/84512345678?pwd=Z1lkQ&amp;from=addon" target="_blank">Join Zoom Meeting</a></p>',
  start: { dateTime: "2026-09-04T13:00:00Z" },
  end: { dateTime: "2026-09-04T13:30:00Z" },
  organizer: { email: "daniel@freshworks.example" },
};

const googleWebexInLocation: GoogleEvent = {
  id: "kf82ms0d1p",
  status: "confirmed",
  summary: "Security review",
  location: "https://perfstaq.webex.com/perfstaq/j.php?MTID=m9f2c1de4b7",
  start: { dateTime: "2026-09-05T08:00:00Z" },
  end: { dateTime: "2026-09-05T09:00:00Z" },
};

const googleNoJoinableUrl: GoogleEvent = {
  id: "ps91mz0d8f",
  status: "confirmed",
  summary: "Offsite planning",
  // docs.google.com is not meet.google.com, and a blog about Zoom is not Zoom.
  description:
    "Notes: https://docs.google.com/document/d/1aBcD/edit and https://zoom-tips.example.com/how-to-join",
  location: "Meeting room 4, level 12",
  start: { dateTime: "2026-09-06T06:00:00Z" },
  end: { dateTime: "2026-09-06T08:00:00Z" },
};

const microsoftTeams: MicrosoftEvent = {
  id: "AAMkADk0MGFkODE3LWE4MmYtNDRhOS04OGQAAA=",
  iCalUId: "040000008200E00074C5B7101A82E00800000000A1B2C3D4",
  subject: "Weekly pipeline",
  bodyPreview: "________________________________ Microsoft Teams meeting Join on your computer",
  body: {
    contentType: "html",
    content:
      '<html><body><div>________________________________</div><div><a href="https://teams.microsoft.com/l/meetup-join/19%3ameeting_ZmQ4NTk%40thread.v2/0?context=%7b%22Tid%22%3a%22aaaabbbb%22%7d">Click here to join the meeting</a></div></body></html>',
  },
  start: { dateTime: "2026-09-03T09:00:00.0000000", timeZone: "UTC" },
  end: { dateTime: "2026-09-03T09:30:00.0000000", timeZone: "UTC" },
  location: { displayName: "Microsoft Teams Meeting" },
  organizer: { emailAddress: { name: "Priya Raman", address: "priya@perfstaq.example" } },
  attendees: [
    {
      emailAddress: { name: "Daniel Okafor", address: "Daniel@freshworks.example" },
      type: "required",
      status: { response: "accepted" },
    },
    {
      emailAddress: { name: "Boardroom 2", address: "boardroom-2@perfstaq.example" },
      type: "resource",
      status: { response: "accepted" },
    },
  ],
  isAllDay: false,
  isCancelled: false,
  isOnlineMeeting: true,
  onlineMeetingProvider: "teamsForBusiness",
  onlineMeeting: {
    joinUrl:
      "https://teams.microsoft.com/l/meetup-join/19%3ameeting_ZmQ4NTk%40thread.v2/0?context=%7b%22Tid%22%3a%22aaaabbbb%22%7d",
    conferenceId: "412345678",
  },
  type: "occurrence",
  seriesMasterId: "AAMkADk0MGFkODE3LWE4MmYtNDRhOS04OGQBBB=",
};

const microsoftZoomInBody: MicrosoftEvent = {
  id: "AAMkADVxSCCC=",
  subject: "Vendor sync",
  body: {
    contentType: "html",
    content:
      '<div>Join: <a href="https://us06web.zoom.us/j/91234567890?pwd=Qmx5Zw&amp;src=outlook">https://us06web.zoom.us/j/91234567890</a></div>',
  },
  start: { dateTime: "2026-09-07T11:00:00.0000000", timeZone: "UTC" },
  end: { dateTime: "2026-09-07T11:45:00.0000000", timeZone: "UTC" },
  organizer: { emailAddress: { address: "ops@perfstaq.example" } },
  isOnlineMeeting: false,
  onlineMeeting: null,
};

/* -------------------------------------------------------------------------
 * URL extraction
 * ---------------------------------------------------------------------- */

describe("meeting URL extraction — Google", () => {
  it("prefers the configured conference over links in the body", () => {
    expect(extractGoogleMeetingUrl(googleWithConference)).toEqual({
      url: "https://meet.google.com/kqr-mpxz-abc",
      platform: "google_meet",
    });
  });

  it("reads a Zoom link out of an HTML description and un-escapes it", () => {
    expect(extractGoogleMeetingUrl(googleZoomInDescription)).toEqual({
      url: "https://perfstaq.zoom.us/j/84512345678?pwd=Z1lkQ&from=addon",
      platform: "zoom",
    });
  });

  it("reads a Webex link out of the location", () => {
    expect(extractGoogleMeetingUrl(googleWebexInLocation)).toEqual({
      url: "https://perfstaq.webex.com/perfstaq/j.php?MTID=m9f2c1de4b7",
      platform: "webex",
    });
  });

  it("returns null when nothing in the event is joinable", () => {
    // Host-exact matching is the point: a doc link and a blog post about Zoom
    // must not book a bot.
    expect(extractGoogleMeetingUrl(googleNoJoinableUrl)).toBeNull();
  });
});

describe("meeting URL extraction — Microsoft", () => {
  it("takes onlineMeeting.joinUrl for a Teams meeting", () => {
    expect(extractMicrosoftMeetingUrl(microsoftTeams)).toEqual({
      url: microsoftTeams.onlineMeeting!.joinUrl,
      platform: "microsoft_teams",
    });
  });

  it("falls back to the HTML body when there is no onlineMeeting", () => {
    expect(extractMicrosoftMeetingUrl(microsoftZoomInBody)).toEqual({
      url: "https://us06web.zoom.us/j/91234567890?pwd=Qmx5Zw&src=outlook",
      platform: "zoom",
    });
  });

  it("reads the deprecated onlineMeetingUrl when joinUrl is absent", () => {
    const legacy: MicrosoftEvent = {
      ...microsoftZoomInBody,
      id: "AAMkADVxSDDD=",
      body: { contentType: "text", content: "Dial in from the room." },
      onlineMeetingUrl: "https://perfstaq.webex.com/perfstaq/j.php?MTID=mabc123",
    };
    expect(extractMicrosoftMeetingUrl(legacy)).toEqual({
      url: "https://perfstaq.webex.com/perfstaq/j.php?MTID=mabc123",
      platform: "webex",
    });
  });

  it("returns null for an event with no joinable link", () => {
    const inPerson: MicrosoftEvent = {
      id: "AAMkADVxSEEE=",
      subject: "Coffee",
      body: { contentType: "text", content: "Ground floor cafe. Agenda: https://example.com/notes" },
      start: { dateTime: "2026-09-08T07:00:00.0000000", timeZone: "UTC" },
      end: { dateTime: "2026-09-08T07:30:00.0000000", timeZone: "UTC" },
    };
    expect(extractMicrosoftMeetingUrl(inPerson)).toBeNull();
  });
});

describe("event normalisation", () => {
  it("parses Graph's offsetless local time as UTC", () => {
    expect(parseGraphDateTime({ dateTime: "2026-09-03T09:00:00.0000000", timeZone: "UTC" })).toEqual(
      new Date("2026-09-03T09:00:00Z"),
    );
  });

  it("treats a Google cancellation notice as a tombstone", () => {
    // What an incremental sync actually delivers for a deleted event.
    const normalized = normalizeGoogle({ id: "7hd91kf0s2m4nb", status: "cancelled" });
    expect(normalized.cancelled).toBe(true);
    expect(normalized.detail).toBeNull();
  });

  it("treats a Graph @removed entry as a tombstone", () => {
    const normalized = normalizeMicrosoft({
      id: "AAMkADVxSCCC=",
      "@removed": { reason: "deleted" },
    });
    expect(normalized.cancelled).toBe(true);
    expect(normalized.detail).toBeNull();
  });

  it("puts the Graph organiser into the attendee list, as Google already does", () => {
    const microsoft = normalizeMicrosoft(microsoftTeams);
    const google = normalizeGoogle(googleWithConference);
    // Graph omits the organiser from `attendees`; without normalisation the
    // same three-person meeting would count 2 on one provider and 3 on the other.
    expect(microsoft.detail!.attendees.map((a) => a.email)).toEqual([
      "priya@perfstaq.example",
      "daniel@freshworks.example",
      "boardroom-2@perfstaq.example",
    ]);
    expect(google.detail!.attendees).toHaveLength(3);
    expect(google.detail!.attendees[0]!.email).toBe("priya@perfstaq.example");
  });

  it("does not look for a meeting URL on a cancelled event", () => {
    const normalized = normalizeMicrosoft({ ...microsoftTeams, isCancelled: true });
    expect(normalized.cancelled).toBe(true);
    expect(normalized.detail!.meetingUrl).toBeNull();
  });
});

/* -------------------------------------------------------------------------
 * Auto-record rules
 * ---------------------------------------------------------------------- */

const attendee = (email: string, extra: Partial<SyncAttendee> = {}): SyncAttendee => ({
  email,
  name: null,
  optional: false,
  resource: false,
  response: "accepted",
  ...extra,
});

const internal = [attendee("priya@perfstaq.example"), attendee("sam@perfstaq.example")];
const mixed = [attendee("priya@perfstaq.example"), attendee("daniel@freshworks.example")];

describe("autoRecordRules", () => {
  const base = { title: "Pipeline review", connectionEmail: "priya@perfstaq.example" };

  it("records everything when no rules are set", () => {
    expect(passesAutoRecordRules({ ...base, rules: {}, attendees: internal })).toBe(true);
  });

  it("excludes on a title substring, case-insensitively", () => {
    expect(
      passesAutoRecordRules({
        ...base,
        title: "Weekly 1:1 — Priya / Sam",
        rules: { titleExcludes: ["1:1", "personal"] },
        attendees: internal,
      }),
    ).toBe(false);
    expect(
      passesAutoRecordRules({
        ...base,
        rules: { titleExcludes: ["1:1"] },
        attendees: internal,
      }),
    ).toBe(true);
  });

  it("counts people but not rooms toward minAttendees", () => {
    const withRoom = [...internal, attendee("boardroom-2@perfstaq.example", { resource: true })];
    expect(passesAutoRecordRules({ ...base, rules: { minAttendees: 3 }, attendees: withRoom })).toBe(
      false,
    );
    expect(passesAutoRecordRules({ ...base, rules: { minAttendees: 2 }, attendees: withRoom })).toBe(
      true,
    );
  });

  it("requires an attendee outside the connection's own domain when externalOnly is set", () => {
    expect(
      passesAutoRecordRules({ ...base, rules: { externalOnly: true }, attendees: internal }),
    ).toBe(false);
    expect(passesAutoRecordRules({ ...base, rules: { externalOnly: true }, attendees: mixed })).toBe(
      true,
    );
  });

  it("fails closed when externalOnly cannot be judged", () => {
    // A room is not a guest, and an event with nobody on it is not evidence of
    // an external call. Neither may be recorded.
    expect(
      passesAutoRecordRules({
        ...base,
        rules: { externalOnly: true },
        attendees: [attendee("boardroom-2@acme.example", { resource: true })],
      }),
    ).toBe(false);
    expect(
      passesAutoRecordRules({ ...base, rules: { externalOnly: true }, attendees: [] }),
    ).toBe(false);
  });

  it("applies every rule, not the first one that passes", () => {
    expect(
      passesAutoRecordRules({
        ...base,
        title: "Intro call 1:1 with Daniel",
        rules: { externalOnly: true, minAttendees: 2, titleExcludes: ["1:1"] },
        attendees: mixed,
      }),
    ).toBe(false);
  });
});

/* -------------------------------------------------------------------------
 * Expired sync tokens
 * ---------------------------------------------------------------------- */

describe("incremental sync recovery", () => {
  let agent: MockAgent;

  // A fresh agent per test: interceptors are stateful, and a case that leaves
  // one unconsumed would otherwise answer the next case's request.
  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });

  afterEach(async () => {
    await agent.close();
  });

  it("falls back to a full resync when Google 410s on a stale sync token", async () => {
    const google = agent.get("https://www.googleapis.com");
    const requested: string[] = [];
    const isEvents = (path: string) => path.startsWith("/calendar/v3/calendars/primary/events");
    // Recorded from the reply, not the matcher: undici evaluates matchers
    // against every candidate interceptor, so counting there counts wrong.
    const record = <T>(body: T) => (opts: { path: string }) => {
      requested.push(opts.path);
      return body;
    };

    // Registered first so it wins for the one request carrying the dead token.
    google
      .intercept({ method: "GET", path: (p) => isEvents(p) && p.includes("syncToken=stale-token") })
      .reply(
        410,
        record({
          error: { code: 410, message: "Sync token is no longer valid, a full sync is required." },
        }),
      );
    google
      .intercept({ method: "GET", path: (p) => isEvents(p) && !p.includes("pageToken=") })
      .reply(
        200,
        record({
          kind: "calendar#events",
          items: [googleZoomInDescription],
          nextPageToken: "page-2",
        }),
      );
    google
      .intercept({ method: "GET", path: (p) => isEvents(p) && p.includes("pageToken=page-2") })
      .reply(
        200,
        record({
          kind: "calendar#events",
          items: [googleWebexInLocation],
          nextSyncToken: "fresh-sync-token",
        }),
      );

    const page = await listGoogleEvents({
      accessToken: "ya29.test",
      calendarId: "primary",
      syncToken: "stale-token",
      timeMin: new Date("2026-09-01T00:00:00Z"),
      timeMax: new Date("2026-12-30T00:00:00Z"),
    });

    expect(page.fullResync).toBe(true);
    expect(page.events.map((e) => e.id)).toEqual([
      googleZoomInDescription.id,
      googleWebexInLocation.id,
    ]);
    // Only the last page carries it, and that is the one that must be kept.
    expect(page.nextSyncToken).toBe("fresh-sync-token");

    // Google refuses the window alongside a sync token, and requires the other
    // parameters to be identical across every request in the round.
    expect(requested).toHaveLength(3);
    expect(requested[0]).not.toContain("timeMin=");
    expect(requested[0]).not.toContain("timeMax=");
    expect(requested[1]).toContain("timeMin=2026-09-01T00%3A00%3A00.000Z");
    expect(requested[2]).toContain("timeMin=");
    for (const path of requested) {
      expect(path).toContain("singleEvents=true");
      expect(path).toContain("showDeleted=true");
    }

    // The bound that stops `singleEvents` expanding open-ended recurrences
    // towards Google's own horizon. Both full-sync pages carry it, and both
    // carry the same one: a window that moved between pages would drop or
    // duplicate events across the page boundary.
    expect(requested[1]).toContain("timeMax=2026-12-30T00%3A00%3A00.000Z");
    expect(requested[2]).toContain("timeMax=2026-12-30T00%3A00%3A00.000Z");
  });

  it("falls back to a full resync when Graph reports syncStateNotFound", async () => {
    const graph = agent.get("https://graph.microsoft.com");
    const seen: string[] = [];
    const isDelta = (path: string) => path.startsWith("/v1.0/me/calendarView/delta");
    const record = <T>(body: T) => (opts: { path: string }) => {
      seen.push(opts.path);
      return body;
    };

    graph
      .intercept({ method: "GET", path: (p) => isDelta(p) && p.includes("%24deltatoken=stale") })
      .reply(
        410,
        record({
          error: { code: "syncStateNotFound", message: "The sync state generation is not found." },
        }),
      );
    graph
      .intercept({ method: "GET", path: (p) => isDelta(p) && p.includes("startDateTime=") })
      .reply(
        200,
        record({
          "@odata.context": "https://graph.microsoft.com/v1.0/$metadata#Collection(event)",
          "@odata.deltaLink":
            "https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=fresh-delta",
          value: [microsoftTeams, { id: microsoftZoomInBody.id, "@removed": { reason: "deleted" } }],
        }),
      );

    const page = await listMicrosoftEvents({
      accessToken: "eyJ0.test",
      deltaLink: "https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=stale",
      windowStart: new Date("2026-09-01T00:00:00Z"),
      windowEnd: new Date("2026-12-30T00:00:00Z"),
    });

    expect(page.fullResync).toBe(true);
    expect(page.events).toHaveLength(2);
    expect(page.deltaLink).toBe(
      "https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=fresh-delta",
    );
    expect(seen).toHaveLength(2);
    expect(seen[1]).toContain("startDateTime=2026-09-01T00%3A00%3A00.000Z");
  });

  it("falls back to a full resync on a bare 410 with no error code", async () => {
    // Graph's documented "synchronization reset" during tenant maintenance is a
    // 410 with a Location header and nothing useful in the body, so the status
    // alone has to be enough — the error-code path cannot carry this one.
    const graph = agent.get("https://graph.microsoft.com");
    graph
      .intercept({ method: "GET", path: (p) => p.includes("%24deltatoken=reset-me") })
      .reply(410, "", {
        headers: { location: "https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=" },
      });
    graph
      .intercept({ method: "GET", path: (p) => p.includes("startDateTime=") })
      .reply(200, {
        "@odata.deltaLink":
          "https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=after-reset",
        value: [microsoftZoomInBody],
      });

    const page = await listMicrosoftEvents({
      accessToken: "eyJ0.test",
      deltaLink: "https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=reset-me",
      windowStart: new Date("2026-09-01T00:00:00Z"),
      windowEnd: new Date("2026-12-30T00:00:00Z"),
    });

    expect(page.fullResync).toBe(true);
    expect(page.events.map((e) => e.id)).toEqual([microsoftZoomInBody.id]);
    expect(page.deltaLink).toContain("$deltatoken=after-reset");
  });

  it("refuses a stored delta link that does not point at Graph", async () => {
    const graph = agent.get("https://graph.microsoft.com");
    graph
      .intercept({ method: "GET", path: (p) => p.startsWith("/v1.0/me/calendarView/delta") })
      .reply(200, {
        "@odata.deltaLink":
          "https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=clean",
        value: [],
      });

    // Net connect is disabled, so a request to the attacker's host would throw
    // rather than quietly hand them a bearer token. Reaching a clean full sync
    // is the assertion.
    const page = await listMicrosoftEvents({
      accessToken: "eyJ0.test",
      deltaLink: "https://graph.microsoft.com.evil.example/v1.0/me/calendarView/delta?$deltatoken=x",
      windowStart: new Date("2026-09-01T00:00:00Z"),
      windowEnd: new Date("2026-12-30T00:00:00Z"),
    });

    expect(page.events).toEqual([]);
    expect(page.deltaLink).toContain("$deltatoken=clean");
  });
});
