import { env } from "../env.js";

/**
 * Microsoft Graph calendar: token refresh, delta sync, meeting-URL parsing.
 *
 * Field names here are not guesses. Checked against the live reference on
 * 2026-08-24:
 *   calendarView delta + @odata.deltaLink — https://learn.microsoft.com/en-us/graph/delta-query-events
 *   410 / syncStateNotFound on expiry     — https://learn.microsoft.com/en-us/graph/delta-query-overview
 *   event resource properties             — https://learn.microsoft.com/en-us/graph/api/resources/event
 *   onlineMeeting.joinUrl                 — https://learn.microsoft.com/en-us/graph/api/resources/onlinemeetinginfo
 *   refresh_token grant                   — https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow
 *
 * The URL helpers at the bottom deliberately mirror the ones in
 * google-calendar.ts rather than importing them. Two provider adapters that
 * know nothing about each other is worth ~30 duplicated lines; the shared home
 * for them is a domain module nobody owns yet (see the handover notes).
 */

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const PAGE_SIZE = 100;

/**
 * The refresh must ask for Graph scopes only. Microsoft rejects a scope list
 * that spans resources, and the sign-in grant in auth.ts also carries the OIDC
 * scopes — so the consented set is reused narrowed, not replayed whole.
 */
const REFRESH_SCOPE = "https://graph.microsoft.com/Calendars.Read offline_access";

/* -------------------------------------------------------------------------
 * Token refresh
 * ---------------------------------------------------------------------- */

export type TokenRefreshResult =
  | {
      ok: true;
      accessToken: string;
      expiresAt: Date;
      refreshToken: string | null;
      scope: string | null;
    }
  | { ok: false; reason: "invalid_grant" | "transient"; detail: string };

export async function refreshMicrosoftAccessToken(
  refreshToken: string,
): Promise<TokenRefreshResult> {
  if (!env.MICROSOFT_CLIENT_ID || !env.MICROSOFT_CLIENT_SECRET) {
    return { ok: false, reason: "transient", detail: "Microsoft OAuth client is not configured" };
  }

  const body = new URLSearchParams({
    client_id: env.MICROSOFT_CLIENT_ID,
    client_secret: env.MICROSOFT_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
    scope: REFRESH_SCOPE,
  });

  const response = await fetch(
    `https://login.microsoftonline.com/${env.MICROSOFT_TENANT_ID}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: body.toString(),
    },
  );

  const text = await response.text();
  if (!response.ok) {
    const error = readOAuthError(text);
    // Entra reports a revoked, expired or password-invalidated refresh token as
    // invalid_grant (AADSTS7000xx in error_codes). Nothing but re-consent fixes
    // it, so the caller must stop rather than back off and try again.
    return {
      ok: false,
      reason: error === "invalid_grant" ? "invalid_grant" : "transient",
      detail: `microsoft token refresh ${response.status}: ${text.slice(0, 300)}`,
    };
  }

  const payload = JSON.parse(text) as {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
    scope?: string;
  };
  if (!payload.access_token) {
    return { ok: false, reason: "transient", detail: "microsoft token response had no access_token" };
  }

  return {
    ok: true,
    accessToken: payload.access_token,
    expiresAt: new Date(Date.now() + ((payload.expires_in ?? 3600) - 60) * 1000),
    // Entra rotates the refresh token on every use and expects the old one to
    // be discarded; keeping the stale one loses access at the next rotation.
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
 * Delta sync
 * ---------------------------------------------------------------------- */

export type GraphDateTime = { dateTime?: string; timeZone?: string };

export type MicrosoftAttendee = {
  emailAddress?: { address?: string; name?: string };
  /** "required" | "optional" | "resource" */
  type?: string;
  status?: { response?: string; time?: string };
};

export type MicrosoftEvent = {
  id: string;
  iCalUId?: string;
  subject?: string | null;
  bodyPreview?: string | null;
  body?: { contentType?: string; content?: string } | null;
  location?: { displayName?: string } | null;
  start?: GraphDateTime | null;
  end?: GraphDateTime | null;
  organizer?: { emailAddress?: { address?: string; name?: string } } | null;
  attendees?: MicrosoftAttendee[];
  isAllDay?: boolean;
  isCancelled?: boolean;
  isOnlineMeeting?: boolean;
  onlineMeetingProvider?: string;
  /** Legacy and documented as deprecated; joinUrl is the one to prefer. */
  onlineMeetingUrl?: string | null;
  onlineMeeting?: { joinUrl?: string | null; conferenceId?: string | null } | null;
  /** "singleInstance" | "occurrence" | "exception" | "seriesMaster" */
  type?: string;
  seriesMasterId?: string | null;
  "@removed"?: { reason?: string };
};

export type MicrosoftEventPage = {
  events: MicrosoftEvent[];
  /** Full URL, not a bare token — Graph hands back a link and expects it back. */
  deltaLink: string | null;
  fullResync: boolean;
};

const DELTA_TOKEN_EXPIRED = Symbol("microsoft-delta-token-expired");

/**
 * Pull calendar changes, incrementally when a delta link is supplied.
 *
 * Graph pins the calendarView window inside the delta token, so the window
 * arguments matter only on a full sync. That also means an event scheduled
 * past the pinned horizon is invisible until the next full sync — see the
 * handover notes for the column that would let this roll forward properly.
 */
export async function listMicrosoftEvents(args: {
  accessToken: string;
  deltaLink?: string | null;
  windowStart: Date;
  windowEnd: Date;
}): Promise<MicrosoftEventPage> {
  const stored = args.deltaLink?.trim() || null;
  // The delta link round-trips through our database before it is handed a
  // bearer token, so its origin is checked rather than trusted. A rewritten
  // row must not turn into an access-token leak to someone else's host.
  const resume = stored && isGraphUrl(stored) ? stored : null;

  if (resume) {
    const incremental = await drain(args.accessToken, resume);
    if (incremental !== DELTA_TOKEN_EXPIRED) return { ...incremental, fullResync: false };
  }

  const initial = new URL(`${GRAPH_BASE}/me/calendarView/delta`);
  initial.searchParams.set("startDateTime", args.windowStart.toISOString());
  initial.searchParams.set("endDateTime", args.windowEnd.toISOString());

  const full = await drain(args.accessToken, initial.toString());
  if (full === DELTA_TOKEN_EXPIRED) {
    throw new Error("microsoft calendarView delta reported an expired token for a full sync");
  }
  return { ...full, fullResync: Boolean(stored) };
}

async function drain(
  accessToken: string,
  startUrl: string,
): Promise<{ events: MicrosoftEvent[]; deltaLink: string | null } | typeof DELTA_TOKEN_EXPIRED> {
  const events: MicrosoftEvent[] = [];
  let url: string | null = startUrl;
  let deltaLink: string | null = null;

  while (url) {
    const response: Response = await fetch(url, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
        prefer: `odata.maxpagesize=${PAGE_SIZE}`,
      },
    });

    const text = await response.text();
    if (!response.ok) {
      // Graph signals a dead state token as 410, and sometimes as a 4xx whose
      // body carries syncStateNotFound / resyncRequired. Both mean the same
      // thing: throw the token away and re-read the window.
      if (response.status === 410 || isResyncRequired(text)) return DELTA_TOKEN_EXPIRED;
      throw new Error(
        `microsoft calendarView delta failed (${response.status}): ${text.slice(0, 300)}`,
      );
    }

    const page = JSON.parse(text) as {
      value?: MicrosoftEvent[];
      "@odata.nextLink"?: string;
      "@odata.deltaLink"?: string;
    };
    events.push(...(page.value ?? []));
    deltaLink = page["@odata.deltaLink"] ?? null;

    const next = page["@odata.nextLink"] ?? null;
    url = next && isGraphUrl(next) ? next : null;
  }

  return { events, deltaLink };
}

function isGraphUrl(url: string): boolean {
  return url.startsWith(`${GRAPH_BASE}/`);
}

const RESYNC_CODES = new Set(["syncstatenotfound", "resyncrequired", "synestatenotfound"]);

function isResyncRequired(body: string): boolean {
  try {
    const code = (JSON.parse(body) as { error?: { code?: string } }).error?.code;
    return typeof code === "string" && RESYNC_CODES.has(code.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Graph returns naive local times plus a separate timeZone, and defaults the
 * whole response to UTC unless a `Prefer: outlook.timezone` header asks
 * otherwise — which this module never sends, precisely so the parse below is
 * unambiguous.
 */
export function parseGraphDateTime(value: GraphDateTime | null | undefined): Date | null {
  const raw = value?.dateTime;
  if (!raw) return null;
  const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/.test(raw);
  const parsed = new Date(hasOffset ? raw : `${raw}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/* -------------------------------------------------------------------------
 * Meeting URL extraction
 * ---------------------------------------------------------------------- */

export type MeetingLink = { url: string; platform: string };

/**
 * Find the link a bot can actually join.
 *
 * onlineMeeting.joinUrl is the organiser's configured conference and wins.
 * onlineMeetingUrl is the deprecated Skype-era field and is only worth reading
 * when joinUrl is absent. Everything after that is somebody's pasted text, and
 * an unrecognised host yields null so the event is stored without a URL rather
 * than dispatched at a page that is not a meeting.
 */
export function extractMicrosoftMeetingUrl(event: MicrosoftEvent): MeetingLink | null {
  const joinUrl = event.onlineMeeting?.joinUrl;
  if (joinUrl) {
    const link = asMeetingLink(joinUrl);
    if (link) return link;
  }

  if (event.onlineMeetingUrl) {
    const link = asMeetingLink(event.onlineMeetingUrl);
    if (link) return link;
  }

  return (
    scanForMeetingUrl(event.location?.displayName) ??
    scanForMeetingUrl(event.body?.content) ??
    scanForMeetingUrl(event.bodyPreview)
  );
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

/** Outlook bodies are HTML, so a raw URL arrives entity-encoded and often
 *  wrapped in punctuation that is not part of it. */
function cleanUrl(raw: string): string {
  return raw
    .replace(/&amp;/gi, "&")
    .replace(/&#3[89];/g, "&")
    .replace(/[.,;:!?)\]}>]+$/, "");
}

/** Host-exact, for the same reason as the Google copy: an arbitrary meeting
 *  body must not let `zoom-tips.example.com` book a bot. */
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
