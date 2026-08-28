import { env } from "../env.js";

/**
 * Google Calendar: token refresh, incremental event sync, meeting-URL parsing.
 *
 * Field names here are not guesses. Checked against the live reference on
 * 2026-08-24:
 *   events.list params + 410 behaviour — https://developers.google.com/workspace/calendar/api/v3/reference/events/list
 *   incremental sync rules            — https://developers.google.com/workspace/calendar/api/guides/sync
 *   refresh_token grant               — https://developers.google.com/identity/protocols/oauth2/web-server
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";

/** Google caps events.list at 2500; 250 keeps a stalled page cheap to retry. */
const PAGE_SIZE = 250;

/* -------------------------------------------------------------------------
 * Token refresh
 * ---------------------------------------------------------------------- */

/**
 * A refresh either works, is permanently dead, or failed for a reason worth
 * retrying. The three are returned rather than thrown because the caller has
 * to react differently to each — and conflating "Google is down" with "the
 * user revoked us" is exactly the bug `reauth_required` exists to prevent.
 */
export type TokenRefreshResult =
  | {
      ok: true;
      accessToken: string;
      expiresAt: Date;
      /** Google only re-issues one on rotation; null means keep the old one. */
      refreshToken: string | null;
      scope: string | null;
    }
  | { ok: false; reason: "invalid_grant" | "transient"; detail: string };

export async function refreshGoogleAccessToken(refreshToken: string): Promise<TokenRefreshResult> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return { ok: false, reason: "transient", detail: "Google OAuth client is not configured" };
  }

  // Note: `scope` is not a parameter of the refresh_token grant for Google —
  // the new access token carries whatever the original grant consented to.
  const body = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: body.toString(),
  });

  const text = await response.text();
  if (!response.ok) {
    const error = readOAuthError(text);
    // invalid_grant is the one terminal answer: the refresh token was revoked,
    // expired, or the user changed their password. Retrying it is free traffic
    // that will never succeed.
    return {
      ok: false,
      reason: error === "invalid_grant" ? "invalid_grant" : "transient",
      detail: `google token refresh ${response.status}: ${text.slice(0, 300)}`,
    };
  }

  const payload = JSON.parse(text) as {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
    scope?: string;
  };
  if (!payload.access_token) {
    return { ok: false, reason: "transient", detail: "google token response had no access_token" };
  }

  return {
    ok: true,
    accessToken: payload.access_token,
    // 60s of slack: a token that expires mid-flight fails the request it was
    // fetched for, and the retry costs a whole sync cycle.
    expiresAt: new Date(Date.now() + ((payload.expires_in ?? 3600) - 60) * 1000),
    refreshToken: payload.refresh_token ?? null,
    scope: payload.scope ?? null,
  };
}

function readOAuthError(body: string): string | null {
  try {
    return (JSON.parse(body) as { error?: string }).error ?? null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------
 * Event listing
 * ---------------------------------------------------------------------- */

export type GoogleDateTime = { dateTime?: string; date?: string; timeZone?: string };

export type GoogleAttendee = {
  email?: string;
  displayName?: string;
  responseStatus?: string;
  self?: boolean;
  optional?: boolean;
  resource?: boolean;
  organizer?: boolean;
};

export type GoogleEntryPoint = {
  entryPointType?: string;
  uri?: string;
  label?: string;
  meetingCode?: string;
};

export type GoogleEvent = {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  iCalUID?: string;
  recurringEventId?: string;
  hangoutLink?: string;
  start?: GoogleDateTime;
  end?: GoogleDateTime;
  organizer?: { email?: string; displayName?: string; self?: boolean };
  attendees?: GoogleAttendee[];
  conferenceData?: {
    conferenceId?: string;
    conferenceSolution?: { key?: { type?: string }; name?: string };
    entryPoints?: GoogleEntryPoint[];
  };
};

export type GoogleEventPage = {
  events: GoogleEvent[];
  /** Present only on the last page of a round. Persist it, resume from it. */
  nextSyncToken: string | null;
  /** True when a dead sync token forced this call to start over from scratch. */
  fullResync: boolean;
};

const SYNC_TOKEN_EXPIRED = Symbol("google-sync-token-expired");

/**
 * List events, incrementally when a sync token is supplied.
 *
 * A 410 means the token is dead — Google's documented recovery is to drop
 * local state and re-list from scratch, so that is what happens here rather
 * than surfacing an error and leaving the calendar frozen at whatever the
 * last successful round saw.
 */
export async function listGoogleEvents(args: {
  accessToken: string;
  calendarId: string;
  syncToken?: string | null;
  /** Lower bound for a FULL sync only; forbidden alongside a sync token. */
  timeMin: Date;
  /**
   * Upper bound, under the same rule as `timeMin`.
   *
   * Not optional, because omitting it is not a smaller version of this call —
   * it is a different one. `singleEvents` expands recurrences into individual
   * instances, and an open-ended daily event has no last instance to stop at,
   * so Google keeps paginating towards its own horizon. The first real sync of
   * one ordinary calendar returned 5037 events from a handful of dailies.
   */
  timeMax: Date;
}): Promise<GoogleEventPage> {
  const token = args.syncToken?.trim() || null;

  if (token) {
    const incremental = await drain(
      args.accessToken,
      args.calendarId,
      token,
      args.timeMin,
      args.timeMax,
    );
    if (incremental !== SYNC_TOKEN_EXPIRED) return { ...incremental, fullResync: false };
  }

  const full = await drain(args.accessToken, args.calendarId, null, args.timeMin, args.timeMax);
  if (full === SYNC_TOKEN_EXPIRED) {
    // Only a request carrying a sync token can 410. Getting here means Google
    // changed its contract, and guessing at a recovery would loop forever.
    throw new Error("google events.list returned 410 for a full sync");
  }
  return { ...full, fullResync: Boolean(token) };
}

async function drain(
  accessToken: string,
  calendarId: string,
  syncToken: string | null,
  timeMin: Date,
  timeMax: Date,
): Promise<{ events: GoogleEvent[]; nextSyncToken: string | null } | typeof SYNC_TOKEN_EXPIRED> {
  const events: GoogleEvent[] = [];
  let pageToken: string | null = null;
  let nextSyncToken: string | null = null;

  do {
    const url = new URL(`${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events`);
    // Every list request in a sync round must carry the same parameters as the
    // initial one, so these three are set unconditionally. The window is the
    // exception: `timeMin`/`timeMax` are the parameters Google refuses
    // alongside a sync token, because the token already encodes the window it
    // was issued for. That is also why narrowing the horizon only takes effect
    // at the next full resync — the token outlives the constant.
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("showDeleted", "true");
    url.searchParams.set("maxResults", String(PAGE_SIZE));
    if (syncToken) {
      url.searchParams.set("syncToken", syncToken);
    } else {
      url.searchParams.set("timeMin", timeMin.toISOString());
      url.searchParams.set("timeMax", timeMax.toISOString());
    }
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const response = await fetch(url.toString(), {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
    });

    if (response.status === 410) return SYNC_TOKEN_EXPIRED;
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`google events.list failed (${response.status}): ${body.slice(0, 300)}`);
    }

    const page = (await response.json()) as {
      items?: GoogleEvent[];
      nextPageToken?: string;
      nextSyncToken?: string;
    };
    events.push(...(page.items ?? []));
    nextSyncToken = page.nextSyncToken ?? null;
    pageToken = page.nextPageToken ?? null;
  } while (pageToken);

  return { events, nextSyncToken };
}

/* -------------------------------------------------------------------------
 * Meeting URL extraction
 * ---------------------------------------------------------------------- */

export type MeetingLink = { url: string; platform: string };

/**
 * Find the link a bot can actually join.
 *
 * Order is deliberate: structured conferencing data is what the organiser
 * configured, while a URL in the description is whatever somebody pasted. An
 * event whose description merely links to a Zoom marketing page must not be
 * treated as a Zoom call, which is why unrecognised hosts return null and the
 * event is stored with no meeting URL rather than dispatched.
 */
export function extractGoogleMeetingUrl(event: GoogleEvent): MeetingLink | null {
  for (const entry of event.conferenceData?.entryPoints ?? []) {
    if (entry.entryPointType !== "video" || !entry.uri) continue;
    const link = asMeetingLink(entry.uri);
    if (link) return link;
  }

  if (event.hangoutLink) {
    const link = asMeetingLink(event.hangoutLink);
    if (link) return link;
  }

  // Location before description: a one-line location is far more likely to be
  // the real join link than a body that also quotes last week's invite.
  return scanForMeetingUrl(event.location) ?? scanForMeetingUrl(event.description);
}

const URL_PATTERN = /https?:\/\/[^\s<>"'\\]+/gi;

export function scanForMeetingUrl(text: string | null | undefined): MeetingLink | null {
  if (!text) return null;
  for (const match of text.matchAll(URL_PATTERN)) {
    const candidate = match[0];
    if (!candidate) continue;
    const link = asMeetingLink(candidate);
    if (link) return link;
  }
  return null;
}

function asMeetingLink(raw: string): MeetingLink | null {
  const url = cleanUrl(raw);
  const platform = detectPlatform(url);
  return platform ? { url, platform } : null;
}

/** Calendar bodies are HTML, so a raw URL arrives entity-encoded and often
 *  wrapped in punctuation that is not part of it. */
function cleanUrl(raw: string): string {
  return raw
    .replace(/&amp;/gi, "&")
    .replace(/&#3[89];/g, "&")
    .replace(/[.,;:!?)\]}>]+$/, "");
}

/**
 * Host-exact platform detection.
 *
 * routes/meetings.ts does substring matching on the hostname, which is fine
 * for a URL a human typed into the create form. Here the input is an arbitrary
 * calendar body, so `zoom-tips.example.com` must not read as Zoom — a false
 * positive here books a bot into a page that is not a meeting.
 */
export function detectPlatform(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  const at = (domain: string) => host === domain || host.endsWith(`.${domain}`);

  if (at("zoom.us") || at("zoom.com") || at("zoomgov.com")) return "zoom";
  if (at("meet.google.com")) return "google_meet";
  if (at("teams.microsoft.com") || at("teams.live.com") || at("teams.microsoft.us")) {
    return "microsoft_teams";
  }
  if (at("webex.com") || at("webex.com.cn")) return "webex";
  return null;
}
