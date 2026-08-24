import {
  CalendarConnectionStatus,
  CalendarProvider,
  MeetingStatus,
  type CalendarConnection,
  type Prisma,
} from "@prisma/client";
import { z } from "zod";
import { requireContext } from "../context.js";
import { prisma, rawPrisma } from "../db.js";
import { transition } from "../domain/state.js";
import {
  extractGoogleMeetingUrl,
  listGoogleEvents,
  refreshGoogleAccessToken,
  type GoogleDateTime,
  type GoogleEvent,
} from "../integrations/google-calendar.js";
import {
  extractMicrosoftMeetingUrl,
  listMicrosoftEvents,
  parseGraphDateTime,
  refreshMicrosoftAccessToken,
  type MicrosoftEvent,
} from "../integrations/microsoft-calendar.js";
import { createBot } from "../integrations/recall.js";
import { logger } from "../logger.js";
import { withTenantContext } from "./context.js";

const log = logger.child({ job: "calendar-sync" });

/**
 * Calendar → meeting pipeline.
 *
 * One pass per connection: refresh the grant, pull what changed since the last
 * sync token, mirror it into calendar_events, and dispatch a bot for the ones
 * the user opted into. Everything here is designed to be re-runnable — a sync
 * that dies halfway leaves the sync token untouched, so the next pass replays
 * the same window rather than skipping it.
 */

/** How far back a full sync reaches. Yesterday is enough to catch a meeting
 *  that was moved earlier this morning; older history is not actionable. */
const FULL_SYNC_LOOKBACK_DAYS = 1;

/** Graph pins its window inside the delta token, so this is the horizon a
 *  Microsoft connection sees until its next full resync. */
const GRAPH_WINDOW_DAYS = 120;

/** Refresh this far ahead of expiry, so a token cannot die mid-round. */
const TOKEN_SKEW_MS = 60_000;

export type CalendarSyncJob = { connectionId: string; tenantId: string };

export type CalendarSyncResult = {
  status: "synced" | "reauth_required" | "skipped";
  fetched: number;
  upserted: number;
  cancelled: number;
  dispatched: number;
  fullResync: boolean;
  error: string | null;
};

/* -------------------------------------------------------------------------
 * Entry points
 * ---------------------------------------------------------------------- */

export async function syncCalendarConnection(job: CalendarSyncJob): Promise<CalendarSyncResult> {
  return withTenantContext(job.tenantId, async () => {
    const connection = await prisma.calendarConnection.findUnique({
      where: { id: job.connectionId },
    });
    if (!connection || connection.status !== CalendarConnectionStatus.active) {
      return empty("skipped");
    }
    return runSync(connection);
  });
}

/**
 * Sweep every active connection. Enumerating them crosses tenants by
 * definition — there is no single tenant a scheduled sweep belongs to — so it
 * is the one query here that uses `rawPrisma`. Each connection is then synced
 * inside its own tenant context, and every write goes through the scoped
 * client as usual.
 */
export async function syncActiveConnections(limit = 500): Promise<CalendarSyncResult[]> {
  const due = await rawPrisma.calendarConnection.findMany({
    where: { status: CalendarConnectionStatus.active },
    select: { id: true, tenantId: true },
    orderBy: { lastSyncedAt: { sort: "asc", nulls: "first" } },
    take: limit,
  });

  const results: CalendarSyncResult[] = [];
  for (const connection of due) {
    try {
      results.push(
        await syncCalendarConnection({ connectionId: connection.id, tenantId: connection.tenantId }),
      );
    } catch (error) {
      // One broken calendar must not stop the sweep for everybody else.
      log.error(
        { connectionId: connection.id, err: (error as Error).message },
        "calendar sync failed",
      );
      results.push({ ...empty("skipped"), error: (error as Error).message.slice(0, 500) });
    }
  }
  return results;
}

/* -------------------------------------------------------------------------
 * One connection
 * ---------------------------------------------------------------------- */

async function runSync(connection: CalendarConnection): Promise<CalendarSyncResult> {
  const token = await resolveAccessToken(connection);
  if (!token.ok) {
    if (token.reason === "invalid_grant") {
      await markReauthRequired(connection.id, token.detail);
      return { ...empty("reauth_required"), error: token.detail };
    }
    throw new Error(token.detail);
  }

  const now = new Date();
  const windowStart = new Date(now.getTime() - FULL_SYNC_LOOKBACK_DAYS * 86_400_000);
  const windowEnd = new Date(now.getTime() + GRAPH_WINDOW_DAYS * 86_400_000);

  const page =
    connection.provider === CalendarProvider.google
      ? await pullGoogle(connection, token.accessToken, windowStart)
      : await pullMicrosoft(connection, token.accessToken, windowStart, windowEnd);

  let upserted = 0;
  let cancelled = 0;
  let dispatched = 0;

  for (const event of page.events) {
    if (!event.detail) {
      // A removal notice carries an id and nothing else. If we never stored the
      // event there is nothing to cancel, which is why this is updateMany.
      const marked = await prisma.calendarEvent.updateMany({
        where: { connectionId: connection.id, externalId: event.externalId },
        data: { cancelled: true, autoRecord: false },
      });
      cancelled += marked.count;
      continue;
    }

    const eligible = autoRecordEligible(connection, event);
    const row = await upsertEvent(connection, event, eligible);
    upserted += 1;
    if (event.cancelled) cancelled += 1;

    if (eligible && (await dispatchBot(connection, row, event, now))) dispatched += 1;
  }

  // The sync token is written last and only on a clean pass: persisting it
  // before the events would let a crash mid-loop advance the cursor past
  // changes that were never stored.
  await prisma.calendarConnection.update({
    where: { id: connection.id },
    data: { syncToken: page.syncToken, lastSyncedAt: new Date(), lastSyncError: null },
  });

  log.info(
    {
      connectionId: connection.id,
      provider: connection.provider,
      fetched: page.events.length,
      upserted,
      cancelled,
      dispatched,
      fullResync: page.fullResync,
    },
    "calendar synced",
  );

  return {
    status: "synced",
    fetched: page.events.length,
    upserted,
    cancelled,
    dispatched,
    fullResync: page.fullResync,
    error: null,
  };
}

type ProviderPage = { events: NormalizedEvent[]; syncToken: string | null; fullResync: boolean };

async function pullGoogle(
  connection: CalendarConnection,
  accessToken: string,
  windowStart: Date,
): Promise<ProviderPage> {
  const page = await listGoogleEvents({
    accessToken,
    calendarId: connection.calendarId,
    syncToken: connection.syncToken,
    timeMin: windowStart,
  });
  return {
    events: page.events.map(normalizeGoogle),
    syncToken: carryToken(page.nextSyncToken, connection.syncToken, page.fullResync),
    fullResync: page.fullResync,
  };
}

async function pullMicrosoft(
  connection: CalendarConnection,
  accessToken: string,
  windowStart: Date,
  windowEnd: Date,
): Promise<ProviderPage> {
  const page = await listMicrosoftEvents({
    accessToken,
    deltaLink: connection.syncToken,
    windowStart,
    windowEnd,
  });
  return {
    events: page.events.map(normalizeMicrosoft),
    syncToken: carryToken(page.deltaLink, connection.syncToken, page.fullResync),
    fullResync: page.fullResync,
  };
}

/**
 * Which cursor to store when a round ends without a new one.
 *
 * Google only emits `nextSyncToken` on the final page, and a round that ended
 * early has nothing better to offer than the cursor it resumed from — replaying
 * a window costs one page. But once a token has already been rejected, keeping
 * it would 410 again on every future sync, so a resync that produced no
 * replacement clears it and starts clean next time.
 */
function carryToken(fresh: string | null, previous: string | null, fullResync: boolean): string | null {
  if (fresh) return fresh;
  return fullResync ? null : previous;
}

/* -------------------------------------------------------------------------
 * Tokens
 * ---------------------------------------------------------------------- */

type ResolvedToken =
  | { ok: true; accessToken: string }
  | { ok: false; reason: "invalid_grant" | "transient"; detail: string };

/**
 * Get a usable access token for a connection.
 *
 * The tokens live in Better Auth's `account` table, which the tenancy
 * extension deliberately exempts — identity exists before a workspace does and
 * a user can belong to several. Reading it therefore needs `rawPrisma`; the
 * tenancy guarantee is upheld by only ever reaching the row through a
 * connection we already loaded through the scoped client.
 */
async function resolveAccessToken(connection: CalendarConnection): Promise<ResolvedToken> {
  const account = await rawPrisma.account.findFirst({
    // `providerId` is Better Auth's key for the social provider, which is
    // literally "google" / "microsoft" — the same strings as CalendarProvider.
    where: {
      userId: connection.userId,
      providerId: connection.provider,
      accountId: connection.providerAccountId,
    },
  });

  if (!account) {
    return {
      ok: false,
      reason: "invalid_grant",
      detail: `no linked ${connection.provider} account for this connection`,
    };
  }

  const expiresAt = account.accessTokenExpiresAt?.getTime() ?? 0;
  if (account.accessToken && expiresAt > Date.now() + TOKEN_SKEW_MS) {
    return { ok: true, accessToken: account.accessToken };
  }

  if (!account.refreshToken) {
    return {
      ok: false,
      reason: "invalid_grant",
      detail: `${connection.provider} account has no refresh token; re-consent is required`,
    };
  }

  const refreshed =
    connection.provider === CalendarProvider.google
      ? await refreshGoogleAccessToken(account.refreshToken)
      : await refreshMicrosoftAccessToken(account.refreshToken);

  if (!refreshed.ok) return refreshed;

  await rawPrisma.account.update({
    where: { id: account.id },
    data: {
      accessToken: refreshed.accessToken,
      accessTokenExpiresAt: refreshed.expiresAt,
      // Only overwrite what the provider actually re-issued. Microsoft rotates
      // the refresh token on every use; Google usually does not send one back,
      // and writing null there would destroy the grant.
      ...(refreshed.refreshToken ? { refreshToken: refreshed.refreshToken } : {}),
      ...(refreshed.scope ? { scope: refreshed.scope } : {}),
    },
  });

  return { ok: true, accessToken: refreshed.accessToken };
}

async function markReauthRequired(connectionId: string, detail: string): Promise<void> {
  await prisma.calendarConnection.update({
    where: { id: connectionId },
    data: {
      status: CalendarConnectionStatus.reauth_required,
      lastSyncError: detail.slice(0, 500),
    },
  });
  log.warn({ connectionId, detail }, "calendar connection needs re-consent");
}

/* -------------------------------------------------------------------------
 * Normalisation
 * ---------------------------------------------------------------------- */

export type SyncAttendee = {
  email: string;
  name: string | null;
  optional: boolean;
  /** Meeting rooms and equipment. Never counted as people. */
  resource: boolean;
  response: string | null;
};

export type NormalizedEvent = {
  externalId: string;
  cancelled: boolean;
  /** Null on a tombstone: a removal notice carries only the event id. */
  detail: {
    iCalUid: string | null;
    title: string | null;
    description: string | null;
    startsAt: Date;
    endsAt: Date;
    timezone: string | null;
    organizerEmail: string | null;
    attendees: SyncAttendee[];
    isRecurring: boolean;
    /** All-day blocks have no join time, so they are never auto-recorded. */
    allDay: boolean;
    meetingUrl: string | null;
    platform: string | null;
  } | null;
  raw: unknown;
};

export function normalizeGoogle(event: GoogleEvent): NormalizedEvent {
  const cancelled = event.status === "cancelled";
  const startsAt = parseGoogleDateTime(event.start);
  const endsAt = parseGoogleDateTime(event.end);

  // An incremental sync reports a deletion as `{id, status: "cancelled"}` with
  // no times at all, so a missing start is a tombstone, not a parse failure.
  if (!startsAt || !endsAt) {
    return { externalId: event.id, cancelled: true, detail: null, raw: event };
  }

  const organizerEmail = event.organizer?.email?.toLowerCase() ?? null;
  const attendees = withOrganizer(
    (event.attendees ?? [])
      .filter((a): a is typeof a & { email: string } => Boolean(a.email))
      .map((a) => ({
        email: a.email.toLowerCase(),
        name: a.displayName ?? null,
        optional: Boolean(a.optional),
        resource: Boolean(a.resource),
        response: a.responseStatus ?? null,
      })),
    organizerEmail,
  );

  const link = cancelled ? null : extractGoogleMeetingUrl(event);

  return {
    externalId: event.id,
    cancelled,
    detail: {
      iCalUid: event.iCalUID ?? null,
      title: event.summary ?? null,
      description: event.description ?? null,
      startsAt,
      endsAt,
      timezone: event.start?.timeZone ?? null,
      organizerEmail,
      attendees,
      isRecurring: Boolean(event.recurringEventId),
      allDay: Boolean(event.start?.date && !event.start?.dateTime),
      meetingUrl: link?.url ?? null,
      platform: link?.platform ?? null,
    },
    raw: event,
  };
}

export function normalizeMicrosoft(event: MicrosoftEvent): NormalizedEvent {
  const removed = Boolean(event["@removed"]);
  const startsAt = parseGraphDateTime(event.start);
  const endsAt = parseGraphDateTime(event.end);

  if (removed || !startsAt || !endsAt) {
    return { externalId: event.id, cancelled: true, detail: null, raw: event };
  }

  const cancelled = event.isCancelled === true;
  const organizerEmail = event.organizer?.emailAddress?.address?.toLowerCase() ?? null;

  // Graph leaves the organiser out of `attendees`; Google includes them. They
  // are normalised to the same rule here so an attendee-count threshold means
  // the same thing on both providers.
  const attendees = withOrganizer(
    (event.attendees ?? [])
      .filter((a): a is typeof a & { emailAddress: { address: string } } =>
        Boolean(a.emailAddress?.address),
      )
      .map((a) => ({
        email: a.emailAddress.address.toLowerCase(),
        name: a.emailAddress.name ?? null,
        optional: a.type === "optional",
        resource: a.type === "resource",
        response: a.status?.response ?? null,
      })),
    organizerEmail,
  );

  const link = cancelled ? null : extractMicrosoftMeetingUrl(event);

  return {
    externalId: event.id,
    cancelled,
    detail: {
      iCalUid: event.iCalUId ?? null,
      title: event.subject ?? null,
      description: event.bodyPreview ?? null,
      startsAt,
      endsAt,
      timezone: event.start?.timeZone ?? null,
      organizerEmail,
      attendees,
      isRecurring: Boolean(event.seriesMasterId) || event.type === "seriesMaster",
      allDay: event.isAllDay === true,
      meetingUrl: link?.url ?? null,
      platform: link?.platform ?? null,
    },
    raw: event,
  };
}

function withOrganizer(attendees: SyncAttendee[], organizerEmail: string | null): SyncAttendee[] {
  if (!organizerEmail || attendees.some((a) => a.email === organizerEmail)) return attendees;
  return [
    { email: organizerEmail, name: null, optional: false, resource: false, response: "accepted" },
    ...attendees,
  ];
}

function parseGoogleDateTime(value: GoogleDateTime | null | undefined): Date | null {
  const raw = value?.dateTime ?? (value?.date ? `${value.date}T00:00:00Z` : null);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/* -------------------------------------------------------------------------
 * Auto-record
 * ---------------------------------------------------------------------- */

/**
 * The narrowing rules stored on a connection. `.strict()` on purpose: a typo
 * like `minAttendee` must be rejected at the API boundary rather than silently
 * widening what gets recorded.
 */
export const autoRecordRulesSchema = z
  .object({
    /** Only record calls with someone from outside the user's own domain. */
    externalOnly: z.boolean().optional(),
    minAttendees: z.number().int().min(0).max(500).optional(),
    titleExcludes: z.array(z.string().trim().min(1).max(120)).max(50).optional(),
  })
  .strict();

export type AutoRecordRules = z.infer<typeof autoRecordRulesSchema>;

/**
 * Read rules off the Json column. A malformed value degrades to "no rules"
 * rather than throwing: a bad row should not wedge the whole sync, and the
 * `autoRecord` flag is still the switch that decides whether any of this runs.
 */
export function parseAutoRecordRules(value: unknown): AutoRecordRules {
  const parsed = autoRecordRulesSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : {};
}

/**
 * Does this event pass the connection's narrowing rules?
 *
 * Every rule fails closed. An event we cannot judge — no attendee domains, no
 * title to test — is not recorded, because the cost of a bot joining a call it
 * had no business joining is much higher than the cost of missing one.
 */
export function passesAutoRecordRules(args: {
  rules: AutoRecordRules;
  title: string | null;
  attendees: SyncAttendee[];
  /** The connected mailbox. "External" is judged relative to its domain. */
  connectionEmail: string;
}): boolean {
  const { rules } = args;

  if (rules.titleExcludes?.length) {
    const title = (args.title ?? "").toLowerCase();
    if (rules.titleExcludes.some((needle) => title.includes(needle.toLowerCase()))) return false;
  }

  // Rooms and equipment are attendees to the calendar API and not to a human
  // reading "at least three people were invited".
  const people = args.attendees.filter((a) => !a.resource);

  if (rules.minAttendees !== undefined && people.length < rules.minAttendees) return false;

  if (rules.externalOnly) {
    const own = domainOf(args.connectionEmail);
    if (!own) return false;
    if (!people.some((a) => domainOf(a.email) !== null && domainOf(a.email) !== own)) return false;
  }

  return true;
}

function domainOf(email: string): string | null {
  const at = email.lastIndexOf("@");
  return at > 0 ? email.slice(at + 1).toLowerCase() : null;
}

function autoRecordEligible(connection: CalendarConnection, event: NormalizedEvent): boolean {
  if (!connection.autoRecord) return false;
  if (event.cancelled || !event.detail) return false;
  if (!event.detail.meetingUrl || event.detail.allDay) return false;

  return passesAutoRecordRules({
    rules: parseAutoRecordRules(connection.autoRecordRules),
    title: event.detail.title,
    attendees: event.detail.attendees,
    connectionEmail: connection.email,
  });
}

/* -------------------------------------------------------------------------
 * Persistence and dispatch
 * ---------------------------------------------------------------------- */

async function upsertEvent(
  connection: CalendarConnection,
  event: NormalizedEvent,
  eligible: boolean,
) {
  const detail = event.detail!;
  const fields = {
    iCalUid: detail.iCalUid,
    title: detail.title,
    description: detail.description,
    startsAt: detail.startsAt,
    endsAt: detail.endsAt,
    timezone: detail.timezone,
    organizerEmail: detail.organizerEmail,
    attendees: detail.attendees as unknown as Prisma.InputJsonValue,
    isRecurring: detail.isRecurring,
    cancelled: event.cancelled,
    meetingUrl: detail.meetingUrl,
    platform: detail.platform,
    allDay: detail.allDay ?? false,
    raw: (event.raw ?? {}) as Prisma.InputJsonValue,
  };

  // `botDispatched` and `meetingId` are absent from the update on purpose:
  // an edited event must never un-dispatch a bot that is already booked.
  //
  // `autoRecord` is absent for a related reason. It is recomputed from the
  // connection's rules on every pass, so including it here overwrote whatever a
  // human had chosen for this one event — the toggle appeared to work and then
  // quietly undid itself on the next sweep, up to ten minutes later. The user's
  // choice lives in `autoRecordOverride`, which the sync never writes, and the
  // update below honours it when it is set.
  const existing = await prisma.calendarEvent.findUnique({
    where: { connectionId_externalId: { connectionId: connection.id, externalId: event.externalId } },
    select: { autoRecordOverride: true },
  });

  return prisma.calendarEvent.upsert({
    where: { connectionId_externalId: { connectionId: connection.id, externalId: event.externalId } },
    create: {
      tenantId: connection.tenantId,
      connectionId: connection.id,
      externalId: event.externalId,
      autoRecord: eligible,
      ...fields,
    },
    update: {
      ...fields,
      autoRecord: existing?.autoRecordOverride ?? eligible,
    },
  });
}

/**
 * Book a bot for an event, at most once, and never for the past.
 *
 * The dispatch flag is claimed with a conditional update before Recall is
 * called. A manual sync racing the scheduled sweep would otherwise both read
 * `botDispatched: false` and put two bots in the same call.
 */
async function dispatchBot(
  connection: CalendarConnection,
  row: { id: string; botDispatched: boolean },
  event: NormalizedEvent,
  now: Date,
): Promise<boolean> {
  const detail = event.detail;
  if (!detail?.meetingUrl || row.botDispatched) return false;

  // Never retroactive. A sync that discovers a call which started an hour ago
  // must not send a bot into it — the meeting is already underway and nobody
  // consented to a recorder arriving late.
  if (detail.startsAt.getTime() <= now.getTime()) return false;

  const claimed = await prisma.calendarEvent.updateMany({
    where: { id: row.id, botDispatched: false },
    data: { botDispatched: true },
  });
  if (claimed.count === 0) return false;

  const ctx = requireContext();
  const meeting = await prisma.meeting.create({
    data: {
      tenantId: connection.tenantId,
      title: detail.title,
      meetingUrl: detail.meetingUrl,
      joinAt: detail.startsAt,
      platform: detail.platform,
      status: MeetingStatus.draft,
      createdByUserId: connection.userId,
      organizerEmail: detail.organizerEmail,
    },
  });
  await prisma.calendarEvent.update({ where: { id: row.id }, data: { meetingId: meeting.id } });

  try {
    const bot = await createBot({
      meetingUrl: detail.meetingUrl,
      joinAt: detail.startsAt,
      metadata: { mcos_meeting_id: meeting.id, mcos_tenant: ctx.tenantSlug },
    });
    await transition(prisma, {
      meetingId: meeting.id,
      to: MeetingStatus.bot_scheduled,
      reason: `auto-record from calendar event ${event.externalId}`,
      patch: { recallBotId: bot.id },
    });
  } catch (error) {
    // The claim is deliberately NOT released. A meeting url Recall refuses will
    // refuse it again on every sync, and an auto-retry loop would hammer the
    // API forever. The meeting is parked in `failed` where the existing
    // POST /meetings/:id/retry path can pick it up on a human's say-so.
    await transition(prisma, {
      meetingId: meeting.id,
      to: MeetingStatus.failed,
      reason: "auto-record bot dispatch failed",
      patch: {
        failureReason: (error as Error).message.slice(0, 500),
        failedStage: "dispatch",
      },
    });
    log.error(
      { connectionId: connection.id, meetingId: meeting.id, err: (error as Error).message },
      "auto-record dispatch failed",
    );
    return false;
  }

  return true;
}

function empty(status: CalendarSyncResult["status"]): CalendarSyncResult {
  return {
    status,
    fetched: 0,
    upserted: 0,
    cancelled: 0,
    dispatched: 0,
    fullResync: false,
    error: null,
  };
}
