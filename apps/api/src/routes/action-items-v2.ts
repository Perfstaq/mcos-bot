import type { FastifyInstance } from "fastify";
import {
  ActionItemOrigin,
  ActionItemStatus,
  CollaboratorRole,
  MeetingVisibility,
  Prisma,
} from "@prisma/client";
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
 * The action-item inbox: suggestions, scopes and groups.
 *
 * One rule shapes every query in this file. A suggestion — `origin:
 * ai_suggested` with `acceptedAt` and `dismissedAt` both null — is a proposal,
 * and a proposal is not work. It is reachable only through
 * `/action-items/suggestions`; the working lists filter it out, and nothing
 * here promotes it on the model's behalf. That is the same gate the review
 * queue puts in front of `brief_versions`, for the same reason: a model may
 * put a question in front of a person, and may not put a task on their list.
 *
 * The second rule is that a suggestion carries its citation wherever it goes.
 * `sourceSegmentId` travels in the serialised payload rather than behind a
 * second request, because a suggestion shown without the words it came from is
 * a suggestion nobody checks before accepting.
 */

/** `groupName` null *is* the inbox (see the schema). A query string cannot
 *  carry null, so a sentinel is the only way for a client to ask for it. */
const INBOX = "inbox";

/** One bulk decision covers at most this many suggestions. Accept-all on a
 *  backlog of thousands should be several deliberate clicks, not one statement
 *  that holds a write lock over the whole table. */
const BULK_LIMIT = 500;

const SCOPES = ["mine", "assigned_by_me", "all"] as const;
type Scope = (typeof SCOPES)[number];

const statusFilter = z
  .union([z.nativeEnum(ActionItemStatus), z.array(z.nativeEnum(ActionItemStatus))])
  .optional();

const listSchema = z.object({
  scope: z.enum(SCOPES).default("mine"),
  status: statusFilter,
  group: z.string().trim().min(1).max(120).optional(),
  meeting_id: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

const groupsSchema = z.object({ scope: z.enum(SCOPES).default("mine") });

const suggestionListSchema = z.object({
  meeting_id: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

/**
 * Accepting is the moment the proposal becomes somebody's problem, so it takes
 * the same three fields a person would immediately reach for afterwards. One
 * round trip, and — more to the point — one decision.
 */
const acceptSchema = z.object({
  assignee_user_id: z.string().min(1).nullable().optional(),
  due_at: z.string().datetime({ offset: true }).nullable().optional(),
  group_name: z.string().trim().max(120).nullable().optional(),
});

const bulkSchema = z.object({
  /** Absent means "every pending suggestion I can act on". Present narrows it
   *  to what the client actually had on screen, which is what a user believes
   *  they clicked. */
  ids: z.array(z.string().uuid()).min(1).max(BULK_LIMIT).optional(),
  meeting_id: z.string().uuid().optional(),
});

const patchSchema = z
  .object({
    assignee_user_id: z.string().min(1).nullable().optional(),
    due_at: z.string().datetime({ offset: true }).nullable().optional(),
    status: z.nativeEnum(ActionItemStatus).optional(),
    group_name: z.string().trim().max(120).nullable().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, { message: "No fields to update" });

/** The pending state, spelled once. Every list in this file is defined by
 *  whether it includes or excludes it. */
const PENDING: Prisma.ActionItemWhereInput = {
  origin: ActionItemOrigin.ai_suggested,
  acceptedAt: null,
  dismissedAt: null,
};

/** Its complement: work someone actually signed up for. A dismissed suggestion
 *  is gone from every list, including the suggestion inbox. */
const COMMITTED: Prisma.ActionItemWhereInput = {
  dismissedAt: null,
  OR: [{ origin: ActionItemOrigin.manual }, { acceptedAt: { not: null } }],
};

const ITEM_INCLUDE = {
  source: { select: { id: true, idx: true, speaker: true, startMs: true, text: true } },
  meeting: { select: { id: true, title: true, startedAt: true } },
  assignee: { select: { id: true, name: true, email: true } },
} as const;

const createSchema = z.object({
  title: z.string().trim().min(1).max(500),
  description: z.string().trim().max(4000).optional(),
  assignee_user_id: z.string().optional(),
  due_at: z.string().datetime({ offset: true }).optional(),
  group_name: z.string().trim().max(120).optional(),
});

export async function actionItemsV2Routes(app: FastifyInstance): Promise<void> {
  /**
   * The suggestion inbox. Newest first: a suggestion is about a meeting that
   * just happened, and one from three weeks ago has already been overtaken by
   * whether the thing got done.
   */
  app.get("/action-items/suggestions", async (request) => {
    const actor = requireActor(request);
    const parsed = suggestionListSchema.safeParse(request.query);
    if (!parsed.success) throw ApiError.badRequest("Invalid query", parsed.error.flatten());
    const query = parsed.data;
    if (query.meeting_id) await requireMeetingRead(actor, query.meeting_id);

    const items = await prisma.actionItem.findMany({
      where: {
        AND: [
          PENDING,
          visibleItems(actor, "read"),
          ...(query.meeting_id ? [{ meetingId: query.meeting_id }] : []),
        ],
      },
      orderBy: [{ createdAt: "desc" }],
      take: query.limit,
      include: ITEM_INCLUDE,
    });

    return { suggestions: items.map(serializeItem) };
  });

  app.post("/action-items/suggestions/:id/accept", async (request) => {
    const actor = requireActor(request);
    const { id } = request.params as { id: string };

    const parsed = acceptSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw ApiError.badRequest("Invalid acceptance", parsed.error.flatten().fieldErrors);
    }
    const body = parsed.data;

    const existing = await loadSuggestion(id);
    await requireDecisionAccess(actor, existing);
    if (body.assignee_user_id) await assertWorkspaceMember(actor, body.assignee_user_id);

    // A decided suggestion stays decided. Re-applying the same decision is a
    // no-op — two people can be looking at the same inbox, and a second click
    // must not be an error — but flipping a dismissal into an acceptance is a
    // new decision and has to be made on a fresh suggestion, not by undoing.
    if (existing.dismissedAt) {
      throw ApiError.conflict(`Suggestion ${id} was dismissed and cannot be accepted`);
    }
    if (existing.acceptedAt) return { item: serializeItem(existing) };

    const item = await prisma.actionItem.update({
      where: { id },
      data: {
        acceptedAt: new Date(),
        ...(body.assignee_user_id !== undefined
          ? { assigneeUserId: body.assignee_user_id }
          : {}),
        ...(body.due_at !== undefined
          ? { dueAt: body.due_at ? new Date(body.due_at) : null }
          : {}),
        ...(body.group_name !== undefined ? { groupName: emptyToNull(body.group_name) } : {}),
        // `createdByUserId` means "a person put this on the list". The job
        // leaves it null precisely so that accepting can fill it in: this is
        // the click that made the item real, and whoever made it should be on
        // the record for it.
        ...(existing.createdByUserId ? {} : { createdByUserId: actor.userId }),
      },
      include: ITEM_INCLUDE,
    });

    return { item: serializeItem(item) };
  });

  app.post("/action-items/suggestions/:id/dismiss", async (request) => {
    const actor = requireActor(request);
    const { id } = request.params as { id: string };

    const existing = await loadSuggestion(id);
    await requireDecisionAccess(actor, existing);

    if (existing.acceptedAt) {
      throw ApiError.conflict(`Suggestion ${id} was accepted and cannot be dismissed`);
    }
    // Idempotent by design: dismissing is the cheap half of the decision, and
    // the client that retries a dropped response must not be told it lost.
    if (existing.dismissedAt) return { item: serializeItem(existing) };

    const item = await prisma.actionItem.update({
      where: { id },
      data: { dismissedAt: new Date() },
      include: ITEM_INCLUDE,
    });

    return { item: serializeItem(item) };
  });

  app.post("/action-items/suggestions/accept-all", async (request) => {
    const actor = requireActor(request);
    const ids = await bulkTargets(actor, request.body);
    if (ids.length === 0) return { accepted: 0, ids: [] };

    const now = new Date();
    // The ids came out of a tenant-scoped, visibility-filtered read, so the
    // update needs no second filter to stay inside the caller's workspace —
    // there is no id in this list that the caller could not already act on.
    await prisma.$transaction([
      prisma.actionItem.updateMany({ where: { id: { in: ids } }, data: { acceptedAt: now } }),
      prisma.actionItem.updateMany({
        where: { id: { in: ids }, createdByUserId: null },
        data: { createdByUserId: actor.userId },
      }),
    ]);

    return { accepted: ids.length, ids };
  });

  app.post("/action-items/suggestions/dismiss-all", async (request) => {
    const actor = requireActor(request);
    const ids = await bulkTargets(actor, request.body);
    if (ids.length === 0) return { dismissed: 0, ids: [] };

    await prisma.actionItem.updateMany({
      where: { id: { in: ids } },
      data: { dismissedAt: new Date() },
    });

    return { dismissed: ids.length, ids };
  });

  /**
   * Create an action item outside any meeting.
   *
   * The meeting-scoped create lives in action-items.ts and requires a segment
   * citation when it lifts something from a transcript. This one is the plain
   * case — someone typing into the inbox — so there is nothing to cite and
   * `origin` stays `manual`.
   */
  app.post("/action-items", async (request, reply) => {
    const actor = requireActor(request);

    const parsed = createSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw ApiError.badRequest("Invalid action item", parsed.error.flatten());
    const body = parsed.data;

    if (body.assignee_user_id) await assertWorkspaceMember(actor, body.assignee_user_id);

    const item = await prisma.actionItem.create({
      data: {
        tenantId: actor.tenantId,
        title: body.title,
        description: body.description ?? null,
        assigneeUserId: body.assignee_user_id ?? actor.userId,
        createdByUserId: actor.userId,
        dueAt: body.due_at ? new Date(body.due_at) : null,
        groupName: body.group_name ?? null,
        origin: ActionItemOrigin.manual,
      },
      include: ITEM_INCLUDE,
    });

    return reply.status(201).send({ item: serializeItem(item) });
  });

  /**
   * The working lists.
   *
   * `scope` is the whole product surface: My items, Assigned to others, and
   * everything in the workspace. It is deliberately not an assignee filter the
   * caller can point at anybody — "what is Priya on the hook for" is a
   * management question, and the answer to it is `scope=all` plus the
   * visibility rules, not a user id in a query string.
   */
  app.get("/action-items", async (request) => {
    const actor = requireActor(request);
    const parsed = listSchema.safeParse(request.query);
    if (!parsed.success) throw ApiError.badRequest("Invalid query", parsed.error.flatten());
    const query = parsed.data;
    if (query.meeting_id) await requireMeetingRead(actor, query.meeting_id);

    const statuses = query.status === undefined ? undefined : [query.status].flat();

    const items = await prisma.actionItem.findMany({
      where: {
        AND: [
          COMMITTED,
          visibleItems(actor, "read"),
          scopeFilter(actor, query.scope),
          ...(statuses ? [{ status: { in: statuses } }] : []),
          ...(query.group !== undefined ? [groupFilter(query.group)] : []),
          ...(query.meeting_id ? [{ meetingId: query.meeting_id }] : []),
        ],
      },
      orderBy: [{ status: "asc" }, { dueAt: "asc" }, { createdAt: "asc" }],
      take: query.limit,
      include: ITEM_INCLUDE,
    });

    const redacted = await redactUnreadableSources(actor, items);
    return {
      scope: query.scope,
      action_items: items.map((item) => {
        const serialized = serializeItem(item);
        if (!item.meetingId || !redacted.has(item.meetingId)) return serialized;
        return { ...serialized, source: null, source_redacted: true };
      }),
    };
  });

  /**
   * The named buckets, with counts, so the rail can render "Top priority (4)"
   * without pulling every item down first. Counting in SQL rather than in the
   * client is the difference between a rail that is right and a rail that is
   * right about the first two hundred items.
   */
  app.get("/action-items/groups", async (request) => {
    const actor = requireActor(request);
    const parsed = groupsSchema.safeParse(request.query);
    if (!parsed.success) throw ApiError.badRequest("Invalid query", parsed.error.flatten());
    const { scope } = parsed.data;

    const rows = await prisma.actionItem.groupBy({
      by: ["groupName"],
      where: { AND: [COMMITTED, visibleItems(actor, "read"), scopeFilter(actor, scope)] },
      _count: { _all: true },
      orderBy: { groupName: "asc" },
    });

    return {
      scope,
      groups: rows.map((row) => ({
        group_name: row.groupName,
        // The sentinel is resolved here rather than in each client, so "the
        // inbox" means the same string on every screen that filters by it.
        key: row.groupName ?? INBOX,
        count: row._count._all,
      })),
    };
  });

  /**
   * Assignee, due date, status, group. Everything else about an item — its
   * title, its provenance — is a statement about the meeting rather than about
   * the plan, and belongs to the route that owns the meeting's output.
   */
  app.patch("/action-items/:id", async (request) => {
    const actor = requireActor(request);
    const { id } = request.params as { id: string };

    const parsed = patchSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw ApiError.badRequest("Invalid patch", parsed.error.flatten().fieldErrors);
    const patch = parsed.data;

    const existing = await prisma.actionItem.findUnique({
      where: { id },
      select: {
        id: true,
        meetingId: true,
        status: true,
        origin: true,
        acceptedAt: true,
        dismissedAt: true,
        assigneeUserId: true,
        createdByUserId: true,
      },
    });
    if (!existing) throw ApiError.notFound(`Action item ${id} not found`);

    // Editing a pending suggestion into shape would be a way to commit work
    // without ever deciding to. Accept it first — the accept route takes the
    // same fields, so this costs nobody a round trip.
    if (
      existing.origin === ActionItemOrigin.ai_suggested &&
      !existing.acceptedAt &&
      !existing.dismissedAt
    ) {
      throw ApiError.conflict(`Suggestion ${id} must be accepted before it can be edited`);
    }

    await requirePatchAccess(actor, existing, Object.keys(patch));
    if (patch.assignee_user_id) await assertWorkspaceMember(actor, patch.assignee_user_id);

    // `completedAt` is derived, never sent — letting a client set it alongside
    // `status` is how you end up with a done item that was never completed.
    const completion =
      patch.status === undefined || patch.status === existing.status
        ? {}
        : { completedAt: patch.status === ActionItemStatus.done ? new Date() : null };

    const item = await prisma.actionItem.update({
      where: { id },
      data: {
        ...(patch.assignee_user_id !== undefined
          ? { assigneeUserId: patch.assignee_user_id }
          : {}),
        ...(patch.due_at !== undefined
          ? { dueAt: patch.due_at ? new Date(patch.due_at) : null }
          : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.group_name !== undefined ? { groupName: emptyToNull(patch.group_name) } : {}),
        ...completion,
      },
      include: ITEM_INCLUDE,
    });

    return { item: serializeItem(item) };
  });
}

/* ---------------------------------------------------------------------- */

type DecidableItem = {
  meetingId: string | null;
  assigneeUserId: string | null;
  createdByUserId: string | null;
};

/**
 * Which items this actor is allowed to see, or to act on, expressed as a
 * filter rather than as a per-row check.
 *
 * The branches mirror `meetingAccess` in authz.ts clause for clause — creator,
 * admin, collaborator, workspace-visible — because a list that disagreed with
 * the single-item check would either leak a private meeting's items or hide
 * items whose meeting opens fine when clicked. It is expressed in SQL because
 * the alternative is one `meetingAccess` round trip per row.
 *
 * An item with no meeting has nothing to inherit visibility from, so it falls
 * back to the people it is actually about.
 */
function visibleItems(actor: Actor, mode: "read" | "write"): Prisma.ActionItemWhereInput {
  if (hasRole(actor, "admin")) return {};

  const collaborator =
    mode === "write"
      ? { some: { userId: actor.userId, role: CollaboratorRole.editor } }
      : { some: { userId: actor.userId } };

  return {
    OR: [
      {
        meetingId: null,
        OR: [{ assigneeUserId: actor.userId }, { createdByUserId: actor.userId }],
      },
      { meeting: { is: { visibility: MeetingVisibility.workspace } } },
      { meeting: { is: { createdByUserId: actor.userId } } },
      { meeting: { is: { collaborators: collaborator } } },
      // Work assigned to you is yours to see, even when the meeting it came
      // from is not. Hiding it made assignment fail silently: the item existed,
      // the assignee never saw it, and nothing anywhere said so.
      //
      // Reading it is not the same as reading the meeting. The citation carries
      // a verbatim transcript line, so `redactUnreadableSources` strips it back
      // to the title before the response leaves — the same shape the deletion
      // path uses, where a claim survives and its evidence is redacted.
      ...(mode === "read" ? [{ assigneeUserId: actor.userId }] : []),
    ],
  };
}

/**
 * Strip the citation from items whose meeting the actor cannot read.
 *
 * Only reachable through the assignee branch above. One extra query, and only
 * when such items are actually present.
 */
async function redactUnreadableSources<T extends { meetingId: string | null }>(
  actor: Actor,
  items: T[],
): Promise<Set<string>> {
  const meetingIds = [...new Set(items.map((i) => i.meetingId).filter((id): id is string => Boolean(id)))];
  if (meetingIds.length === 0 || hasRole(actor, "admin")) return new Set();

  const readable = await prisma.meeting.findMany({
    where: {
      id: { in: meetingIds },
      OR: [
        { visibility: MeetingVisibility.workspace },
        { createdByUserId: actor.userId },
        { collaborators: { some: { userId: actor.userId } } },
      ],
    },
    select: { id: true },
  });

  const ok = new Set(readable.map((m) => m.id));
  return new Set(meetingIds.filter((id) => !ok.has(id)));
}

function scopeFilter(actor: Actor, scope: Scope): Prisma.ActionItemWhereInput {
  switch (scope) {
    case "mine":
      return { assigneeUserId: actor.userId };
    case "assigned_by_me":
      // Work I handed to somebody else. An item I created and kept is mine,
      // and would otherwise show up in both lists — which is exactly the
      // double-counting that makes "assigned to others" useless as a number.
      return {
        createdByUserId: actor.userId,
        assigneeUserId: { not: null },
        NOT: { assigneeUserId: actor.userId },
      };
    case "all":
      return {};
  }
}

function groupFilter(group: string): Prisma.ActionItemWhereInput {
  return group.toLowerCase() === INBOX ? { groupName: null } : { groupName: group };
}

/**
 * An empty group name is the inbox, not a bucket called "". The alternative is
 * a rail that grows a nameless chip the first time somebody clears the field.
 */
function emptyToNull(value: string | null | undefined): string | null {
  return value ? value : null;
}

async function loadSuggestion(id: string): Promise<SerializableItem> {
  const item = await prisma.actionItem.findUnique({ where: { id }, include: ITEM_INCLUDE });
  if (!item) throw ApiError.notFound(`Suggestion ${id} not found`);
  // Accept and dismiss are meaningless on an item a person typed, and letting
  // them through would put a manual item into a state no list queries for.
  if (item.origin !== ActionItemOrigin.ai_suggested) {
    throw ApiError.conflict(`Action item ${id} was not proposed by the model`);
  }
  return item;
}

/**
 * Deciding on a suggestion is a write to the meeting's output, so it takes
 * write access to that meeting — a viewer-collaborator can read the proposal
 * and cannot commit the workspace to it.
 */
async function requireDecisionAccess(actor: Actor, item: DecidableItem): Promise<void> {
  if (!item.meetingId) {
    requireStandaloneAccess(actor, item);
    return;
  }
  await requireMeetingWrite(actor, item.meetingId);
}

/**
 * Who may change an existing item. Deliberately identical to the rule in
 * routes/action-items.ts: write access to the meeting, plus one narrow
 * exception for the assignee of a meeting they can only read, who must still
 * be able to move their own item's status or the item is a message they can
 * only answer by asking somebody else to click for them.
 */
async function requirePatchAccess(
  actor: Actor,
  item: DecidableItem,
  fields: string[],
): Promise<void> {
  if (!item.meetingId) {
    requireStandaloneAccess(actor, item);
    return;
  }

  const access = await meetingAccess(actor, item.meetingId);
  if (!access.canRead) throw ApiError.notFound("Action item not found");
  if (access.canWrite) return;

  const statusOnly = fields.length > 0 && fields.every((field) => field === "status");
  if (item.assigneeUserId === actor.userId && statusOnly) return;

  throw new ApiError(403, "forbidden", "Read-only access to this meeting");
}

function requireStandaloneAccess(actor: Actor, item: DecidableItem): void {
  const own = item.assigneeUserId === actor.userId || item.createdByUserId === actor.userId;
  if (own || hasRole(actor, "admin")) return;
  throw new ApiError(403, "forbidden", "This action item belongs to someone else");
}

/**
 * The ids a bulk decision will touch.
 *
 * Resolved by a read first rather than folded into an `updateMany` filter, for
 * two reasons: the response can then say exactly which suggestions moved, and
 * the visibility rules above involve a relation, which belongs in a select.
 */
async function bulkTargets(actor: Actor, body: unknown): Promise<string[]> {
  const parsed = bulkSchema.safeParse(body ?? {});
  if (!parsed.success) throw ApiError.badRequest("Invalid selection", parsed.error.flatten());
  const query = parsed.data;
  if (query.meeting_id) await requireMeetingRead(actor, query.meeting_id);

  const targets = await prisma.actionItem.findMany({
    where: {
      AND: [
        PENDING,
        visibleItems(actor, "write"),
        ...(query.ids ? [{ id: { in: query.ids } }] : []),
        ...(query.meeting_id ? [{ meetingId: query.meeting_id }] : []),
      ],
    },
    select: { id: true },
    orderBy: { createdAt: "asc" },
    take: BULK_LIMIT,
  });

  return targets.map((target) => target.id);
}

type SerializableItem = {
  id: string;
  meetingId: string | null;
  title: string;
  description: string | null;
  status: ActionItemStatus;
  dueAt: Date | null;
  origin: ActionItemOrigin;
  groupName: string | null;
  acceptedAt: Date | null;
  dismissedAt: Date | null;
  assigneeUserId: string | null;
  createdByUserId: string | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /** Required rather than optional, so a caller that forgot to `include` it
   *  cannot serialise a cited suggestion as if a human had typed it. */
  source: { id: string; idx: number; speaker: string; startMs: number; text: string } | null;
  meeting: { id: string; title: string | null; startedAt: Date | null } | null;
  assignee: { id: string; name: string; email: string } | null;
};

function serializeItem(item: SerializableItem) {
  return {
    id: item.id,
    meeting_id: item.meetingId,
    title: item.title,
    description: item.description,
    status: item.status,
    due_at: item.dueAt?.toISOString() ?? null,
    origin: item.origin,
    group_name: item.groupName,
    group_key: item.groupName ?? INBOX,
    accepted_at: item.acceptedAt?.toISOString() ?? null,
    dismissed_at: item.dismissedAt?.toISOString() ?? null,
    /** True only for the pending state, so no client has to re-derive the
     *  three-field predicate that defines it. */
    pending: item.origin === ActionItemOrigin.ai_suggested && !item.acceptedAt && !item.dismissedAt,
    assignee_user_id: item.assigneeUserId,
    assignee: item.assignee
      ? { id: item.assignee.id, name: item.assignee.name, email: item.assignee.email }
      : null,
    created_by_user_id: item.createdByUserId,
    completed_at: item.completedAt?.toISOString() ?? null,
    created_at: item.createdAt.toISOString(),
    updated_at: item.updatedAt.toISOString(),
    meeting: item.meeting
      ? {
          id: item.meeting.id,
          title: item.meeting.title,
          started_at: item.meeting.startedAt?.toISOString() ?? null,
        }
      : null,
    // The citation travels with the item, including the words themselves: a
    // suggestion is accepted or dismissed on the strength of its evidence, and
    // evidence behind a second request is evidence nobody reads.
    source: item.source
      ? {
          segment_id: item.source.id,
          idx: item.source.idx,
          speaker: item.source.speaker,
          start_ms: item.source.startMs,
          text: item.source.text,
        }
      : null,
  };
}
