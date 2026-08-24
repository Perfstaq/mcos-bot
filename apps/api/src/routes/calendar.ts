import type { FastifyInstance } from "fastify";
import type { CalendarConnection } from "@prisma/client";
import { z } from "zod";
import { hasRole, requireActor, type Actor } from "../authz.js";
import { prisma } from "../db.js";
import { ApiError, requireCtx } from "../http.js";
import {
  autoRecordRulesSchema,
  parseAutoRecordRules,
  syncCalendarConnection,
} from "../jobs/calendar-sync.js";

const patchSchema = z
  .object({
    auto_record: z.boolean().optional(),
    auto_record_rules: autoRecordRulesSchema.optional(),
  })
  .refine((body) => body.auto_record !== undefined || body.auto_record_rules !== undefined, {
    message: "Provide auto_record, auto_record_rules, or both",
  });

const eventsQuerySchema = z
  .object({
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: "from must be before to" });

/**
 * Calendar connections and the events synced off them.
 *
 * Connections belong to a person, not to a workspace: they carry that person's
 * OAuth grant. So the default scope is "mine", widened to the whole workspace
 * for admins who have to be able to see why a teammate's sync is stuck.
 */
export async function calendarRoutes(app: FastifyInstance): Promise<void> {
  app.get("/calendar/connections", async (request) => {
    const actor = requireActor(request);
    requireCtx(request);

    const connections = await prisma.calendarConnection.findMany({
      where: visibleTo(actor),
      orderBy: { createdAt: "asc" },
      include: { _count: { select: { events: true } } },
    });

    return {
      connections: connections.map((c) => ({
        ...serializeConnection(c),
        event_count: c._count.events,
      })),
    };
  });

  /**
   * Sync now.
   *
   * This runs inline rather than enqueuing: there is no calendar queue yet, and
   * `queue.ts` is not ours to extend. A single connection is one or two API
   * round-trips, so the request stays short — but see the handover notes, the
   * scheduled sweep needs a real queue.
   */
  app.post("/calendar/connections/:id/sync", async (request) => {
    const actor = requireActor(request);
    requireCtx(request);
    const { id } = request.params as { id: string };
    const connection = await loadConnection(actor, id);

    try {
      const result = await syncCalendarConnection({
        connectionId: connection.id,
        tenantId: connection.tenantId,
      });
      const fresh = await prisma.calendarConnection.findUnique({ where: { id: connection.id } });
      return {
        sync: {
          status: result.status,
          fetched: result.fetched,
          upserted: result.upserted,
          cancelled: result.cancelled,
          dispatched: result.dispatched,
          full_resync: result.fullResync,
          error: result.error,
        },
        connection: fresh ? serializeConnection(fresh) : null,
      };
    } catch (error) {
      // A transient provider failure is the provider's fault, not the caller's.
      throw new ApiError(502, "calendar_sync_failed", (error as Error).message);
    }
  });

  app.patch("/calendar/connections/:id", async (request) => {
    const actor = requireActor(request);
    requireCtx(request);
    const { id } = request.params as { id: string };
    const parsed = patchSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw ApiError.badRequest("Invalid connection update", parsed.error.flatten());
    }

    const connection = await loadConnection(actor, id);
    const updated = await prisma.calendarConnection.update({
      where: { id: connection.id },
      data: {
        ...(parsed.data.auto_record !== undefined ? { autoRecord: parsed.data.auto_record } : {}),
        ...(parsed.data.auto_record_rules !== undefined
          ? { autoRecordRules: parsed.data.auto_record_rules }
          : {}),
      },
    });

    return { connection: serializeConnection(updated) };
  });

  /**
   * Disconnect a calendar.
   *
   * The connection and its mirrored events go; meetings that were already
   * recorded do not. `CalendarEvent.meetingId` is the only link between them
   * and it is the event that holds it, so deleting here cannot take a
   * transcript with it.
   */
  app.delete("/calendar/connections/:id", async (request, reply) => {
    const actor = requireActor(request);
    requireCtx(request);
    const { id } = request.params as { id: string };
    const connection = await loadConnection(actor, id);

    await prisma.calendarConnection.delete({ where: { id: connection.id } });
    return reply.status(204).send();
  });

  app.get("/calendar/events", async (request) => {
    const actor = requireActor(request);
    requireCtx(request);
    const parsed = eventsQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) throw ApiError.badRequest("Invalid query", parsed.error.flatten());

    const from = parsed.data.from ?? new Date();
    const to = parsed.data.to ?? new Date(from.getTime() + 30 * 86_400_000);

    const events = await prisma.calendarEvent.findMany({
      where: {
        startsAt: { gte: from, lte: to },
        connection: visibleTo(actor),
      },
      orderBy: { startsAt: "asc" },
      take: parsed.data.limit,
      include: {
        connection: { select: { id: true, provider: true, email: true } },
        meeting: { select: { id: true, status: true, recallBotId: true } },
      },
    });

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      events: events.map((e) => ({
        id: e.id,
        connection_id: e.connectionId,
        provider: e.connection.provider,
        calendar_email: e.connection.email,
        external_id: e.externalId,
        title: e.title,
        starts_at: e.startsAt.toISOString(),
        ends_at: e.endsAt.toISOString(),
        timezone: e.timezone,
        organizer_email: e.organizerEmail,
        attendees: e.attendees,
        is_recurring: e.isRecurring,
        cancelled: e.cancelled,
        meeting_url: e.meetingUrl,
        platform: e.platform,
        auto_record: e.autoRecord,
        bot_dispatched: e.botDispatched,
        meeting: e.meeting
          ? { id: e.meeting.id, status: e.meeting.status, recall_bot_id: e.meeting.recallBotId }
          : null,
      })),
    };
  });
}

/* ---------------------------------------------------------------------- */

/** Tenancy is already enforced by the Prisma extension; this narrows within it. */
function visibleTo(actor: Actor): { userId?: string } {
  return hasRole(actor, "admin") ? {} : { userId: actor.userId };
}

async function loadConnection(actor: Actor, id: string): Promise<CalendarConnection> {
  const connection = await prisma.calendarConnection.findUnique({ where: { id } });
  // 404 rather than 403, for the same reason as requireMeetingRead: confirming
  // that a colleague's calendar connection exists is itself a disclosure.
  if (!connection || (connection.userId !== actor.userId && !hasRole(actor, "admin"))) {
    throw ApiError.notFound(`Calendar connection ${id} not found`);
  }
  return connection;
}

function serializeConnection(c: CalendarConnection) {
  return {
    id: c.id,
    provider: c.provider,
    email: c.email,
    calendar_id: c.calendarId,
    status: c.status,
    // The sync token is a resume cursor and, for Microsoft, a full URL with an
    // opaque token in it. It is operational state, not something the client
    // needs, so only its presence is reported.
    has_sync_token: Boolean(c.syncToken),
    last_synced_at: c.lastSyncedAt?.toISOString() ?? null,
    last_sync_error: c.lastSyncError,
    auto_record: c.autoRecord,
    auto_record_rules: parseAutoRecordRules(c.autoRecordRules),
    created_at: c.createdAt.toISOString(),
  };
}
