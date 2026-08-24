import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { requireActor, requireMeetingRead, requireMeetingWrite, type Actor } from "../authz.js";
import { prisma, rawPrisma } from "../db.js";
import { ApiError } from "../http.js";

/**
 * The structured half of a meeting's preparation.
 *
 * Agenda items live outside the notes CRDT because they are not prose: an item
 * has an owner, a duration and a done state, and none of those survive being a
 * paragraph someone can retype. The price is that ordering becomes a shared
 * mutable integer, which is what most of this file is about.
 */

const createSchema = z.object({
  title: z.string().trim().min(1).max(300),
  description: z.string().trim().max(4000).optional(),
  duration_mins: z.number().int().min(0).max(24 * 60).optional(),
  owner_user_id: z.string().min(1).optional(),
});

const updateSchema = z
  .object({
    title: z.string().trim().min(1).max(300).optional(),
    description: z.string().trim().max(4000).nullable().optional(),
    duration_mins: z.number().int().min(0).max(24 * 60).nullable().optional(),
    owner_user_id: z.string().min(1).nullable().optional(),
    completed: z.boolean().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, { message: "No fields to update" });

const reorderSchema = z.object({ item_ids: z.array(z.string().uuid()).min(1) });

/**
 * Postgres cannot always order two serializable transactions, and says so with
 * `serialization_failure` (40001) or `deadlock_detected` (40P01). Both are retry
 * signals rather than errors — the loser reruns against the order the winner
 * committed. Prisma maps the first to P2034 and leaves the second as an unknown
 * request error carrying only the SQLSTATE, so both shapes have to be matched.
 */
const WRITE_CONFLICT = "P2034";
const RETRYABLE_SQLSTATE = /\b(40001|40P01)\b/;
const CONFLICT_ATTEMPTS = 5;

const SERIALIZABLE = {
  isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
} as const;

export async function agendaRoutes(app: FastifyInstance): Promise<void> {
  app.get("/meetings/:id/agenda", async (request) => {
    const actor = requireActor(request);
    const { id } = request.params as { id: string };
    await requireMeetingRead(actor, id);

    const items = await prisma.agendaItem.findMany({
      where: { meetingId: id },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    });
    return { agenda: items.map(serializeAgendaItem) };
  });

  /**
   * Append an item.
   *
   * The position is computed inside the same serializable transaction that
   * writes the row, for the same reason the reorder below is: two people adding
   * an item at once would otherwise both read the same `max(position)` and both
   * claim it.
   */
  app.post("/meetings/:id/agenda", async (request, reply) => {
    const actor = requireActor(request);
    const { id } = request.params as { id: string };
    await requireMeetingWrite(actor, id);

    const parsed = createSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw ApiError.badRequest("Invalid agenda item", parsed.error.flatten().fieldErrors);
    }
    const body = parsed.data;
    if (body.owner_user_id) await assertWorkspaceMember(actor, body.owner_user_id);

    const item = await retryOnConflict(() =>
      prisma.$transaction(async (tx) => {
        const last = await tx.agendaItem.findFirst({
          where: { meetingId: id },
          orderBy: { position: "desc" },
          select: { position: true },
        });
        return tx.agendaItem.create({
          data: {
            tenantId: actor.tenantId,
            meetingId: id,
            position: last ? last.position + 1 : 0,
            title: body.title,
            description: body.description ?? null,
            durationMins: body.duration_mins ?? null,
            ownerUserId: body.owner_user_id ?? null,
            createdByUserId: actor.userId,
          },
        });
      }, SERIALIZABLE),
    );

    return reply.status(201).send({ item: serializeAgendaItem(item) });
  });

  app.patch("/agenda-items/:itemId", async (request) => {
    const actor = requireActor(request);
    const { itemId } = request.params as { itemId: string };

    const existing = await prisma.agendaItem.findUnique({ where: { id: itemId } });
    if (!existing) throw ApiError.notFound(`Agenda item ${itemId} not found`);
    await requireMeetingWrite(actor, existing.meetingId);

    const parsed = updateSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw ApiError.badRequest("Invalid patch", parsed.error.flatten().fieldErrors);
    }
    const patch = parsed.data;
    if (patch.owner_user_id) await assertWorkspaceMember(actor, patch.owner_user_id);

    // Position is deliberately not patchable. Moving one item is a statement
    // about where every other item ends up, and the reorder route is the only
    // place that can say that without leaving holes or collisions behind.
    const item = await prisma.agendaItem.update({
      where: { id: itemId },
      data: {
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.duration_mins !== undefined ? { durationMins: patch.duration_mins } : {}),
        ...(patch.owner_user_id !== undefined ? { ownerUserId: patch.owner_user_id } : {}),
        ...(patch.completed !== undefined ? { completed: patch.completed } : {}),
      },
    });
    return { item: serializeAgendaItem(item) };
  });

  app.delete("/agenda-items/:itemId", async (request, reply) => {
    const actor = requireActor(request);
    const { itemId } = request.params as { itemId: string };

    const existing = await prisma.agendaItem.findUnique({ where: { id: itemId } });
    if (!existing) throw ApiError.notFound(`Agenda item ${itemId} not found`);
    await requireMeetingWrite(actor, existing.meetingId);

    await retryOnConflict(() =>
      prisma.$transaction(async (tx) => {
        await tx.agendaItem.delete({ where: { id: itemId } });
        // Close the gap in the same transaction. Positions that stay dense are
        // what lets the reorder route treat "0..n-1" as an invariant it can
        // check rather than a shape it has to hope for.
        const remaining = await tx.agendaItem.findMany({
          where: { meetingId: existing.meetingId },
          orderBy: [{ position: "asc" }, { createdAt: "asc" }],
          select: { id: true, position: true },
        });
        const compacted = byId(remaining.map((item) => item.id));
        for (const { id, position } of compacted) {
          await tx.agendaItem.update({ where: { id }, data: { position } });
        }
      }, SERIALIZABLE),
    );

    return reply.status(204).send();
  });

  /**
   * Rewrite the whole order in one transaction.
   *
   * The body is the complete list of item ids, not a delta, because a delta is
   * unverifiable: "move item 4 to position 2" means something different to a
   * client whose list is one item out of date, and it means it silently. A full
   * list is checked against what is actually stored, so a stale client is told
   * to refresh instead of shuffling somebody else's agenda.
   *
   * Serializable is what stops two simultaneous drags from interleaving their
   * per-row updates into duplicate positions. Read Committed would happily let
   * both transactions read the same starting order and write halves of two
   * different results.
   */
  app.post("/meetings/:id/agenda/reorder", async (request) => {
    const actor = requireActor(request);
    const { id } = request.params as { id: string };
    await requireMeetingWrite(actor, id);

    const parsed = reorderSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw ApiError.badRequest("Invalid reorder", parsed.error.flatten().fieldErrors);
    }
    const itemIds = parsed.data.item_ids;
    if (new Set(itemIds).size !== itemIds.length) {
      throw ApiError.badRequest("item_ids contains duplicates");
    }

    const items = await retryOnConflict(() =>
      prisma.$transaction(async (tx) => {
        const current = await tx.agendaItem.findMany({
          where: { meetingId: id },
          select: { id: true },
        });
        const currentIds = new Set(current.map((item) => item.id));
        const sameSet =
          currentIds.size === itemIds.length && itemIds.every((itemId) => currentIds.has(itemId));
        if (!sameSet) {
          throw ApiError.conflict(
            "The agenda changed since this order was computed — reload and reorder again",
          );
        }

        // Written in id order rather than in the order the client dragged them
        // into. Two people reordering the same agenda touch the same rows, and
        // each update takes a row lock: acquiring them in a canonical order
        // turns a deadlock — which Postgres resolves by killing a transaction —
        // into a queue. The final positions are unaffected by write order.
        for (const { id: itemId, position } of byId(itemIds)) {
          await tx.agendaItem.update({ where: { id: itemId }, data: { position } });
        }

        return tx.agendaItem.findMany({
          where: { meetingId: id },
          orderBy: [{ position: "asc" }, { createdAt: "asc" }],
        });
      }, SERIALIZABLE),
    );

    return { agenda: items.map(serializeAgendaItem) };
  });
}

/* ---------------------------------------------------------------------- */

/**
 * Rerun a transaction Postgres refused to order.
 *
 * Retrying is only safe because every caller recomputes its decision from a
 * fresh read *inside* the transaction — nothing is carried across an attempt,
 * so the retry sees the order the winner committed rather than the one its
 * caller started from.
 */
async function retryOnConflict<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (!isWriteConflict(error) || attempt >= CONFLICT_ATTEMPTS) throw error;
      // Jittered, or four clients that collided once collide again in lockstep.
      await sleep(Math.random() * 10 * attempt);
    }
  }
}

function isWriteConflict(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return error.code === WRITE_CONFLICT;
  }
  return (
    error instanceof Prisma.PrismaClientUnknownRequestError &&
    RETRYABLE_SQLSTATE.test(error.message)
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The target order, re-sorted so the row locks are always taken in id order. */
function byId(orderedIds: string[]): Array<{ id: string; position: number }> {
  return orderedIds
    .map((id, position) => ({ id, position }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Refuse to hand an item to someone outside the workspace.
 *
 * `owner_user_id` is a foreign key into Better Auth's `user` table, which has
 * no tenant column — the tenancy extension cannot catch this one. Without the
 * check, any user id in the system is assignable, which both breaks the meaning
 * of "my agenda items" and confirms that a given user id exists.
 *
 * Exported because action items need exactly the same guard. It wants to live
 * in authz.ts next to the other membership checks; that file is the
 * integrator's, so it sits here and is imported rather than copied — a security
 * check that exists twice is a security check that will disagree with itself.
 */
export async function assertWorkspaceMember(actor: Actor, userId: string): Promise<void> {
  const membership = await rawPrisma.member.findFirst({
    where: { organizationId: actor.organizationId, userId },
    select: { id: true },
  });
  if (!membership) throw ApiError.badRequest(`User ${userId} is not a member of this workspace`);
}

function serializeAgendaItem(item: {
  id: string;
  meetingId: string;
  position: number;
  title: string;
  description: string | null;
  durationMins: number | null;
  completed: boolean;
  ownerUserId: string | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: item.id,
    meeting_id: item.meetingId,
    position: item.position,
    title: item.title,
    description: item.description,
    duration_mins: item.durationMins,
    completed: item.completed,
    owner_user_id: item.ownerUserId,
    created_by_user_id: item.createdByUserId,
    created_at: item.createdAt.toISOString(),
    updated_at: item.updatedAt.toISOString(),
  };
}
