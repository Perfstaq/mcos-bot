import { MeetingStatus, Prisma, type AutoRecordMode } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { hasRole, requireActor, type Actor } from "../authz.js";
import { prisma } from "../db.js";
import { decideAutoRecord, type AutoRecordDecision } from "../domain/auto-record.js";
import { transition } from "../domain/state.js";
import { ApiError, requireCtx } from "../http.js";
import { createBot } from "../integrations/recall.js";
import type { SyncAttendee } from "../jobs/calendar-sync.js";
import { logger } from "../logger.js";
import { loadOrCreate as loadPreference } from "./preferences.js";

const log = logger.child({ route: "calendar-events" });

/**
 * The calendar screen: a window of events, a per-event recording toggle, and
 * the button that sends a bot into a call that is happening right now.
 *
 * Events are read through their connection, which is what carries the OAuth
 * grant and therefore the ownership. Reading is scoped to your own calendars
 * and widened for admins, matching `calendarRoutes`. Dispatching a bot is not
 * widened: see `record-now`.
 */

/** Two months. Wide enough for any grid the client draws, narrow enough that
 *  one request cannot ask for a year of somebody's calendar. */
const MAX_RANGE_DAYS = 62;

/** A second bound, on rows rather than days. A shared calendar with a busy
 *  resource booking on it can put thousands of events inside a legal window,
 *  and a grid that cannot draw them should not be made to download them. */
const MAX_EVENTS = 1000;

const DAY_MS = 86_400_000;

const rangeQuerySchema = z
  .object({
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    connection_id: z.string().uuid().optional(),
  })
  .superRefine((query, ctx) => {
    if (!query.from || !query.to) return;
    if (query.to.getTime() < query.from.getTime()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["to"],
        message: "`to` must not be earlier than `from`",
      });
      return;
    }
    if (query.to.getTime() - query.from.getTime() > MAX_RANGE_DAYS * DAY_MS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["to"],
        message: `Range must not exceed ${MAX_RANGE_DAYS} days`,
      });
    }
  });

const togglePatchSchema = z.object({ auto_record: z.boolean() }).strict();

/**
 * The attendee blob as calendar-sync writes it. Read back leniently — a row
 * written by an older sync must still render rather than 500 the whole grid —
 * but never trusted to be the right shape: this Json column is provider output.
 */
const storedAttendeeSchema = z.object({
  email: z.string().min(1),
  name: z.string().nullable().default(null),
  optional: z.boolean().default(false),
  resource: z.boolean().default(false),
  response: z.string().nullable().default(null),
});

const eventInclude = {
  connection: {
    select: {
      id: true,
      userId: true,
      provider: true,
      email: true,
      autoRecord: true,
      autoRecordRules: true,
    },
  },
  meeting: { select: { id: true, status: true, recallBotId: true } },
} satisfies Prisma.CalendarEventInclude;

type EventRow = Prisma.CalendarEventGetPayload<{ include: typeof eventInclude }>;

export async function calendarEventRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Events for a date window, ordered by start.
   *
   * The grid positions events by time, so the ordering is part of the contract
   * rather than a convenience — and it is `(startsAt, id)` because two events
   * beginning in the same minute must not swap places between two requests and
   * make the layout jump.
   */
  app.get("/calendar/events/range", async (request) => {
    const actor = requireActor(request);
    requireCtx(request);

    const parsed = rangeQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) throw ApiError.badRequest("Invalid range", parsed.error.flatten());

    const from = parsed.data.from ?? startOfDay(new Date());
    const to = parsed.data.to ?? new Date(from.getTime() + 7 * DAY_MS);
    // Only one bound was supplied, so the pair was never checked above.
    if (to.getTime() < from.getTime()) throw ApiError.badRequest("`to` must not be earlier than `from`");
    if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY_MS) {
      throw ApiError.badRequest(`Range must not exceed ${MAX_RANGE_DAYS} days`);
    }

    const events = await prisma.calendarEvent.findMany({
      where: {
        // An event that started before the window but runs into it still has to
        // be drawn, so the overlap test is on both ends rather than on `startsAt`.
        startsAt: { lt: to },
        endsAt: { gt: from },
        ...(parsed.data.connection_id ? { connectionId: parsed.data.connection_id } : {}),
        connection: visibleTo(actor),
      },
      orderBy: [{ startsAt: "asc" }, { id: "asc" }],
      take: MAX_EVENTS + 1,
      include: eventInclude,
    });

    const truncated = events.length > MAX_EVENTS;
    const page = truncated ? events.slice(0, MAX_EVENTS) : events;

    // One read for the whole page: the ladder's bottom rung is the same row for
    // every event, and it is only meaningful for the caller's own calendars.
    const preference = page.some((event) => event.connection.userId === actor.userId)
      ? await loadPreference(actor.userId)
      : null;

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      truncated,
      events: page.map((event) => serializeEvent(event, actor, preference)),
    };
  });

  /**
   * The per-event recording toggle.
   *
   * Writes BOTH columns, and the pair is the point. `autoRecord` is what the
   * read path and the dispatcher look at; `autoRecordOverride` records that a
   * human chose it, which is what stops the next sync recomputing the flag from
   * the connection's rules and quietly undoing the toggle. Setting only the
   * first was the original bug: the switch worked and then reverted itself up
   * to ten minutes later, with nothing in the UI to explain why.
   */
  app.patch("/calendar/events/:id", async (request) => {
    const actor = requireActor(request);
    requireCtx(request);
    const { id } = request.params as { id: string };

    const parsed = togglePatchSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw ApiError.badRequest("Invalid update", parsed.error.flatten());
    const autoRecord = parsed.data.auto_record;

    const event = await loadEvent(actor, id);

    if (autoRecord) {
      // Switching recording on for something a bot can never join would leave a
      // toggle sitting in a state that does nothing. Say so instead.
      if (event.cancelled) throw ApiError.unprocessable("This event is cancelled");
      if (!event.meetingUrl) throw ApiError.unprocessable("This event has no joinable link");
    } else if (event.botDispatched) {
      // The flag is not what holds the booking — the bot is already with Recall
      // and the meeting row exists. Letting the switch flip would read as
      // "recording cancelled" while a recorder still joins the call.
      throw ApiError.conflict(
        "A bot is already booked for this event; cancel the meeting to stop the recording",
      );
    }

    const updated = await prisma.calendarEvent.update({
      where: { id: event.id },
      data: { autoRecord, autoRecordOverride: autoRecord },
      include: eventInclude,
    });

    const preference =
      updated.connection.userId === actor.userId ? await loadPreference(actor.userId) : null;
    return { event: serializeEvent(updated, actor, preference) };
  });

  /**
   * Record this call, now.
   *
   * Restricted to the person whose calendar it is, and deliberately not widened
   * to admins the way reading is. An admin needs to see why a colleague's sync
   * is stuck; putting a recorder into a colleague's call is not an
   * administrative act, and there is no consent story in which it is one.
   */
  app.post("/calendar/events/:id/record-now", async (request) => {
    const actor = requireActor(request);
    const ctx = requireCtx(request);
    const { id } = request.params as { id: string };

    const event = await loadEvent(actor, id, { ownerOnly: true });

    if (event.cancelled) throw ApiError.unprocessable("This event is cancelled");
    if (!event.meetingUrl) throw ApiError.unprocessable("This event has no joinable link");
    if (event.botDispatched) {
      throw ApiError.conflict("A bot has already been dispatched for this event");
    }

    // Claim the flag before calling Recall, exactly as the sync does: a
    // double-click and a sync landing at the same moment would otherwise both
    // read `botDispatched: false` and put two bots in the same call.
    const claimed = await prisma.calendarEvent.updateMany({
      where: { id: event.id, botDispatched: false },
      data: { botDispatched: true, autoRecord: true },
    });
    if (claimed.count === 0) {
      throw ApiError.conflict("A bot has already been dispatched for this event");
    }

    const meeting = await prisma.meeting.create({
      data: {
        tenantId: actor.tenantId,
        title: event.title,
        meetingUrl: event.meetingUrl,
        joinAt: new Date(),
        platform: event.platform,
        status: MeetingStatus.draft,
        createdByUserId: actor.userId,
        organizerEmail: event.organizerEmail,
      },
    });
    await prisma.calendarEvent.update({ where: { id: event.id }, data: { meetingId: meeting.id } });

    try {
      // No `join_at`. Recall's bot_create reference: "You can create ad-hoc bots
      // by omitting the join_at or setting it to a time that is less than 10
      // minutes in the future." (https://docs.recall.ai/reference/bot_create)
      // Scheduling one ten minutes out is the opposite of what this button says.
      const bot = await createBot({
        meetingUrl: event.meetingUrl,
        metadata: { mcos_meeting_id: meeting.id, mcos_tenant: ctx.tenantSlug },
      });
      await transition(prisma, {
        meetingId: meeting.id,
        to: MeetingStatus.bot_scheduled,
        reason: `record-now from calendar event ${event.externalId}`,
        patch: { recallBotId: bot.id },
      });
    } catch (error) {
      // The claim is NOT released, for the same reason the sync keeps it: a
      // second press would create a second meeting row and orphan this one. The
      // meeting is parked in `failed`, which is where the existing retry path
      // picks it up — so the id goes back to the caller to retry against.
      await transition(prisma, {
        meetingId: meeting.id,
        to: MeetingStatus.failed,
        reason: "record-now bot dispatch failed",
        patch: { failureReason: (error as Error).message.slice(0, 500), failedStage: "dispatch" },
      });
      log.error(
        { eventId: event.id, meetingId: meeting.id, err: (error as Error).message },
        "record-now dispatch failed",
      );
      throw new ApiError(502, "bot_dispatch_failed", (error as Error).message, {
        meeting_id: meeting.id,
      });
    }

    const fresh = await prisma.calendarEvent.findUniqueOrThrow({
      where: { id: event.id },
      include: eventInclude,
    });
    return { event: serializeEvent(fresh, actor, await loadPreference(actor.userId)) };
  });
}

/* ---------------------------------------------------------------------- */

/** Tenancy is already enforced by the Prisma extension; this narrows within it. */
function visibleTo(actor: Actor): { userId?: string } {
  return hasRole(actor, "admin") ? {} : { userId: actor.userId };
}

async function loadEvent(
  actor: Actor,
  id: string,
  opts: { ownerOnly?: boolean } = {},
): Promise<EventRow> {
  const event = await prisma.calendarEvent.findUnique({ where: { id }, include: eventInclude });
  // 404 rather than 403 for a calendar that is not yours to see, for the same
  // reason as requireMeetingRead: confirming a colleague's meeting exists is
  // itself a disclosure.
  if (!event) throw ApiError.notFound(`Calendar event ${id} not found`);

  if (event.connection.userId !== actor.userId) {
    if (!hasRole(actor, "admin")) throw ApiError.notFound(`Calendar event ${id} not found`);
    // An admin can already see this one, so hiding it now would be a lie. The
    // refusal is about the action, not the existence of the event.
    if (opts.ownerOnly) {
      throw new ApiError(403, "forbidden", "Only the calendar's owner can start a recording");
    }
  }

  return event;
}

function serializeEvent(
  event: EventRow,
  actor: Actor,
  preference: { autoRecordMode: AutoRecordMode } | null,
) {
  const attendees = parseAttendees(event.attendees);

  return {
    id: event.id,
    connection_id: event.connectionId,
    provider: event.connection.provider,
    calendar_email: event.connection.email,
    external_id: event.externalId,
    title: event.title,
    starts_at: event.startsAt.toISOString(),
    ends_at: event.endsAt.toISOString(),
    timezone: event.timezone,
    organizer_email: event.organizerEmail,
    attendees: attendees.map((a) => ({
      email: a.email,
      name: a.name,
      optional: a.optional,
      resource: a.resource,
      response: a.response,
    })),
    // Rooms and equipment are attendees to a calendar API and not to a person
    // reading "4 people". The full list is still above for the popover.
    attendee_count: attendees.filter((a) => !a.resource).length,
    is_recurring: event.isRecurring,
    cancelled: event.cancelled,
    meeting_url: event.meetingUrl,
    platform: event.platform,
    auto_record: event.autoRecord,
    bot_dispatched: event.botDispatched,
    auto_record_decision: describeDecision(event, actor, preference, attendees),
    meeting_id: event.meetingId,
    meeting: event.meeting
      ? { id: event.meeting.id, status: event.meeting.status, recall_bot_id: event.meeting.recallBotId }
      : null,
  };
}

/**
 * Why the toggle looks the way it does.
 *
 * The stored `auto_record` is what the last sync decided; this is the same
 * ladder re-run for display, so the popover can say "auto-record is on for this
 * calendar" instead of leaving the user to guess who turned it on. Computed
 * only for the caller's own calendars — the reasons are phrased in terms of
 * *your* settings, and an admin looking at a colleague's row would be reading a
 * sentence about the wrong person's preferences.
 */
function describeDecision(
  event: EventRow,
  actor: Actor,
  preference: { autoRecordMode: AutoRecordMode } | null,
  attendees: SyncAttendee[],
): AutoRecordDecision | null {
  if (event.connection.userId !== actor.userId) return null;

  return decideAutoRecord({
    preference,
    connection: {
      autoRecord: event.connection.autoRecord,
      autoRecordRules: event.connection.autoRecordRules,
      email: event.connection.email,
    },
    event: {
      title: event.title,
      organizerEmail: event.organizerEmail,
      attendees,
      meetingUrl: event.meetingUrl,
      cancelled: event.cancelled,
      allDay: event.allDay,
      override: event.autoRecordOverride,
    },
  });
}

/** Provider output, read back defensively: one malformed attendee must cost
 *  that attendee, not the whole day's grid. */
function parseAttendees(raw: unknown): SyncAttendee[] {
  if (!Array.isArray(raw)) return [];
  const people: SyncAttendee[] = [];
  for (const entry of raw) {
    const parsed = storedAttendeeSchema.safeParse(entry);
    if (parsed.success) people.push(parsed.data);
  }
  return people;
}

function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setUTCHours(0, 0, 0, 0);
  return copy;
}
