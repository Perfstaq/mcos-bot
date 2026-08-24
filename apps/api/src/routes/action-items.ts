import type { FastifyInstance } from "fastify";
import { ActionItemStatus, Prisma } from "@prisma/client";
import { z } from "zod";
import {
  hasRole,
  meetingAccess,
  requireActor,
  requireMeetingRead,
  requireMeetingWrite,
  type Actor,
} from "../authz.js";
import { prisma } from "../db.js";
import { ApiError } from "../http.js";
import { assertWorkspaceMember } from "./agenda.js";

/**
 * Action items: what a meeting produced that someone still has to do.
 *
 * The one structural rule here is provenance. An item the machine lifted out of
 * the transcript carries `sourceSegmentId` back to the words it came from, for
 * the same reason a claim carries its evidence: the first serious disagreement
 * about an action item is always about whether it was ever agreed, and "the
 * extractor said so" is not an answer. An item a human typed carries no source,
 * and says so — the two must not be confusable after the fact.
 */

const statusFilter = z
  .union([z.nativeEnum(ActionItemStatus), z.array(z.nativeEnum(ActionItemStatus))])
  .optional();

const createSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    description: z.string().trim().max(4000).optional(),
    status: z.nativeEnum(ActionItemStatus).default(ActionItemStatus.open),
    due_at: z.string().datetime({ offset: true }).nullable().optional(),
    assignee_user_id: z.string().min(1).optional(),
    /**
     * How this item came to exist. Declared by the caller rather than inferred
     * from whether a segment id happens to be present, so that an extractor
     * that loses its citation fails loudly instead of quietly downgrading its
     * output to "a human typed this".
     */
    origin: z.enum(["manual", "transcript"]).default("manual"),
    source_segment_id: z.string().uuid().optional(),
  })
  .superRefine((body, ctx) => {
    if (body.origin === "transcript" && !body.source_segment_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["source_segment_id"],
        message: "An action item lifted from the transcript must cite the segment it came from",
      });
    }
  });

const updateSchema = z
  .object({
    title: z.string().trim().min(1).max(300).optional(),
    description: z.string().trim().max(4000).nullable().optional(),
    status: z.nativeEnum(ActionItemStatus).optional(),
    due_at: z.string().datetime({ offset: true }).nullable().optional(),
    assignee_user_id: z.string().min(1).nullable().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, { message: "No fields to update" });

const meetingListSchema = z.object({
  status: statusFilter,
  assignee_user_id: z.string().min(1).optional(),
  due_before: z.string().datetime({ offset: true }).optional(),
  due_after: z.string().datetime({ offset: true }).optional(),
});

const inboxSchema = meetingListSchema.extend({
  meeting_id: z.string().uuid().optional(),
  /**
   * Open work whose due date has passed. Cheaper to ask for than to assemble.
   * Spelled out rather than `z.coerce.boolean()`, which reads `?overdue=false`
   * as true — `Boolean("false")` is the JavaScript footgun underneath.
   */
  overdue: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export async function actionItemRoutes(app: FastifyInstance): Promise<void> {
  app.get("/meetings/:id/action-items", async (request) => {
    const actor = requireActor(request);
    const { id } = request.params as { id: string };
    await requireMeetingRead(actor, id);

    const parsed = meetingListSchema.safeParse(request.query);
    if (!parsed.success) throw ApiError.badRequest("Invalid query", parsed.error.flatten());

    const items = await prisma.actionItem.findMany({
      where: { meetingId: id, ...filters(parsed.data) },
      orderBy: [{ status: "asc" }, { dueAt: "asc" }, { createdAt: "asc" }],
      include: { source: { select: { id: true, idx: true, speaker: true, startMs: true } } },
    });
    return { action_items: items.map(serializeActionItem) };
  });

  app.post("/meetings/:id/action-items", async (request, reply) => {
    const actor = requireActor(request);
    const { id } = request.params as { id: string };
    await requireMeetingWrite(actor, id);

    const parsed = createSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw ApiError.badRequest("Invalid action item", parsed.error.flatten().fieldErrors);
    }
    const body = parsed.data;
    if (body.assignee_user_id) await assertWorkspaceMember(actor, body.assignee_user_id);

    // A citation that does not resolve to a real segment of *this* meeting is
    // dropped at the boundary rather than stored, exactly as extraction does
    // with claims. Provenance that points at nothing is worse than none: it
    // reads as evidence right up until someone follows it.
    if (body.source_segment_id) {
      const segment = await prisma.transcriptSegment.findFirst({
        where: { id: body.source_segment_id, transcript: { meetingId: id } },
        select: { id: true },
      });
      if (!segment) {
        throw ApiError.unprocessable(
          `Segment ${body.source_segment_id} is not part of meeting ${id}'s transcript`,
        );
      }
    }

    const done = body.status === ActionItemStatus.done;
    const item = await prisma.actionItem.create({
      data: {
        tenantId: actor.tenantId,
        meetingId: id,
        title: body.title,
        description: body.description ?? null,
        status: body.status,
        dueAt: body.due_at ? new Date(body.due_at) : null,
        assigneeUserId: body.assignee_user_id ?? null,
        createdByUserId: actor.userId,
        sourceSegmentId: body.source_segment_id ?? null,
        completedAt: done ? new Date() : null,
      },
      include: { source: { select: { id: true, idx: true, speaker: true, startMs: true } } },
    });

    return reply.status(201).send({ item: serializeActionItem(item) });
  });

  app.patch("/action-items/:itemId", async (request) => {
    const actor = requireActor(request);
    const { itemId } = request.params as { itemId: string };

    const existing = await prisma.actionItem.findUnique({ where: { id: itemId } });
    if (!existing) throw ApiError.notFound(`Action item ${itemId} not found`);

    const parsed = updateSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw ApiError.badRequest("Invalid patch", parsed.error.flatten().fieldErrors);
    }
    const patch = parsed.data;
    await requirePatchAccess(actor, existing, Object.keys(patch));
    if (patch.assignee_user_id) await assertWorkspaceMember(actor, patch.assignee_user_id);

    // `completedAt` is derived, never sent. Letting a client set both it and
    // `status` independently is how you end up with a done item that was never
    // completed and an open one that was.
    const completion =
      patch.status === undefined || patch.status === existing.status
        ? {}
        : { completedAt: patch.status === ActionItemStatus.done ? new Date() : null };

    const item = await prisma.actionItem.update({
      where: { id: itemId },
      data: {
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.due_at !== undefined ? { dueAt: patch.due_at ? new Date(patch.due_at) : null } : {}),
        ...(patch.assignee_user_id !== undefined
          ? { assigneeUserId: patch.assignee_user_id }
          : {}),
        ...completion,
      },
      include: { source: { select: { id: true, idx: true, speaker: true, startMs: true } } },
    });

    return { item: serializeActionItem(item) };
  });

  app.delete("/action-items/:itemId", async (request, reply) => {
    const actor = requireActor(request);
    const { itemId } = request.params as { itemId: string };

    const existing = await prisma.actionItem.findUnique({ where: { id: itemId } });
    if (!existing) throw ApiError.notFound(`Action item ${itemId} not found`);
    // Deleting is not something an assignee gets to do just because they are
    // the assignee: closing your own item is the status patch above.
    if (existing.meetingId) {
      await requireMeetingWrite(actor, existing.meetingId);
    } else {
      requireStandaloneAccess(actor, existing);
    }

    await prisma.actionItem.delete({ where: { id: itemId } });
    return reply.status(204).send();
  });

  /**
   * Everything assigned to one person, across every meeting in the workspace.
   *
   * Defaults to the caller. Asking for somebody else's list needs the admin
   * role, because "what is Priya on the hook for" is a management question and
   * not a side effect of being able to open a meeting.
   *
   * This deliberately does not re-filter by meeting visibility: an item on a
   * private meeting still shows up in the assignee's list, because assigning it
   * to them was the decision to tell them about it.
   */
  app.get("/action-items", async (request) => {
    const actor = requireActor(request);
    const parsed = inboxSchema.safeParse(request.query);
    if (!parsed.success) throw ApiError.badRequest("Invalid query", parsed.error.flatten());
    const query = parsed.data;

    const assignee = query.assignee_user_id ?? actor.userId;
    if (assignee !== actor.userId && !hasRole(actor, "admin")) {
      throw new ApiError(403, "forbidden", "Only an admin can read another member's action items");
    }
    if (query.meeting_id) await requireMeetingRead(actor, query.meeting_id);

    // Nested under AND rather than merged in: `overdue` constrains status and
    // due date, and both are also filterable on their own. Spreading it would
    // silently overwrite whichever the caller asked for.
    const overdue = query.overdue
      ? {
          AND: [
            { dueAt: { lt: new Date() } },
            { status: { in: [ActionItemStatus.open, ActionItemStatus.in_progress] } },
          ],
        }
      : {};

    const items = await prisma.actionItem.findMany({
      where: {
        ...filters({ ...query, assignee_user_id: assignee }),
        ...(query.meeting_id ? { meetingId: query.meeting_id } : {}),
        ...overdue,
      },
      orderBy: [{ status: "asc" }, { dueAt: "asc" }, { createdAt: "asc" }],
      take: query.limit,
      include: {
        meeting: { select: { id: true, title: true, startedAt: true } },
        source: { select: { id: true, idx: true, speaker: true, startMs: true } },
      },
    });

    return {
      assignee_user_id: assignee,
      action_items: items.map((item) => ({
        ...serializeActionItem(item),
        meeting: item.meeting
          ? {
              id: item.meeting.id,
              title: item.meeting.title,
              started_at: item.meeting.startedAt?.toISOString() ?? null,
            }
          : null,
      })),
    };
  });
}

/* ---------------------------------------------------------------------- */

function filters(query: {
  status?: ActionItemStatus | ActionItemStatus[];
  assignee_user_id?: string;
  due_before?: string;
  due_after?: string;
}): Prisma.ActionItemWhereInput {
  const statuses = query.status === undefined ? undefined : [query.status].flat();
  const due =
    query.due_before || query.due_after
      ? {
          ...(query.due_after ? { gte: new Date(query.due_after) } : {}),
          ...(query.due_before ? { lte: new Date(query.due_before) } : {}),
        }
      : undefined;

  return {
    ...(statuses ? { status: { in: statuses } } : {}),
    ...(query.assignee_user_id ? { assigneeUserId: query.assignee_user_id } : {}),
    ...(due ? { dueAt: due } : {}),
  };
}

type OwnedItem = {
  meetingId: string | null;
  assigneeUserId: string | null;
  createdByUserId: string | null;
};

/**
 * Who may change an existing item.
 *
 * Write access to the meeting is the normal answer. The exception is the
 * assignee of a meeting they can only read: they must still be able to move
 * their own item's status, or the item is a message they can only answer by
 * asking somebody else to click for them. It stays narrow — status and nothing
 * else, since retitling or reassigning is editing the meeting's output.
 */
async function requirePatchAccess(
  actor: Actor,
  item: OwnedItem,
  fields: string[],
): Promise<void> {
  if (!item.meetingId) {
    requireStandaloneAccess(actor, item);
    return;
  }

  const access = await meetingAccess(actor, item.meetingId);
  if (!access.canRead) throw ApiError.notFound(`Action item not found`);
  if (access.canWrite) return;

  const statusOnly = fields.length > 0 && fields.every((field) => field === "status");
  if (item.assigneeUserId === actor.userId && statusOnly) return;

  throw new ApiError(403, "forbidden", "Read-only access to this meeting");
}

/**
 * An item with no meeting has nothing to inherit permission from, so it falls
 * back to the people it is actually about.
 */
function requireStandaloneAccess(actor: Actor, item: OwnedItem): void {
  const own = item.assigneeUserId === actor.userId || item.createdByUserId === actor.userId;
  if (own || hasRole(actor, "admin")) return;
  throw new ApiError(403, "forbidden", "This action item belongs to someone else");
}

function serializeActionItem(item: {
  id: string;
  meetingId: string | null;
  title: string;
  description: string | null;
  status: ActionItemStatus;
  dueAt: Date | null;
  assigneeUserId: string | null;
  createdByUserId: string | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /** Required, not optional: a caller that forgot to `include` it would
   *  otherwise serialise a cited item as if a human had typed it. */
  source: { id: string; idx: number; speaker: string; startMs: number } | null;
}) {
  return {
    id: item.id,
    meeting_id: item.meetingId,
    title: item.title,
    description: item.description,
    status: item.status,
    due_at: item.dueAt?.toISOString() ?? null,
    assignee_user_id: item.assigneeUserId,
    created_by_user_id: item.createdByUserId,
    completed_at: item.completedAt?.toISOString() ?? null,
    created_at: item.createdAt.toISOString(),
    updated_at: item.updatedAt.toISOString(),
    // The citation travels with the item, not behind a second request: an
    // action item shown without its provenance is an action item nobody checks.
    source: item.source
      ? {
          segment_id: item.source.id,
          idx: item.source.idx,
          speaker: item.source.speaker,
          start_ms: item.source.startMs,
        }
      : null,
  };
}
