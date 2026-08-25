import type { FastifyInstance } from "fastify";
import { ActionItemOrigin, ActionItemStatus, ClaimStatus, MeetingStatus, Prisma } from "@prisma/client";
import { z } from "zod";
import { hasRole, requireActor, type Actor } from "../authz.js";
import { prisma } from "../db.js";
import { ApiError, requireCtx } from "../http.js";
import { MAX_QUERY_LENGTH } from "../domain/search.js";
import { formatTimestamp } from "../domain/transcript.js";
import type { PlaybackUnavailable } from "./playback.js";

/**
 * The library: every meeting the actor may open, as a shelf of cards.
 *
 * TENANCY IS THIS FILE'S JOB, on the same terms as domain/search.ts. The page is
 * selected with `$queryRaw`, and the client extension in db.ts cannot see inside
 * a template string — it injects `tenant_id` into the queries it can parse, and
 * raw SQL is not one of them. So every statement below carries
 * `tenant_id = ${actor.tenantId}` itself, as a bound parameter, on the meetings
 * row and on every table joined to it, and any statement added later must too.
 * Everything interpolated is a bound parameter; nothing is concatenated.
 *
 * Raw SQL rather than Prisma because of the free-text filter. The GIN indexes
 * over `meetings` are *expression* indexes, and Postgres uses one only when the
 * predicate repeats the expression character for character (see the
 * full_text_search migration); Prisma has no way to emit
 * `to_tsvector('english', coalesce("title", ''))`. Keeping a single query shape
 * for the searched and unsearched cases is deliberate — two shapes drift, and
 * the visibility predicate is the one thing that must never drift.
 *
 * Ordering is recency, never relevance, even when `q` is set. A keyset cursor
 * has to be built out of the sort key, and `ts_rank_cd` is neither stable across
 * pages nor unique per row. Ranked results are what /search is for. A library is
 * a shelf, and a shelf is chronological.
 */

/** A card grid, not a table: the default page is what fills a screen. */
const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 100;

/** Enough of a note to recognise it, short enough that a page of them loads. */
const EXCERPT_CHARS = 280;

/**
 * Avatars on a card, not an attendee list. Diarisation occasionally invents a
 * long tail of "Speaker 7", and forty labels per card across a page of them is
 * noise; `participant_count` keeps the true number honest.
 */
const PARTICIPANT_LIMIT = 8;

export const LIBRARY_SCOPES = ["all", "mine", "shared_with_me"] as const;
export type LibraryScope = (typeof LIBRARY_SCOPES)[number];

/**
 * `has_recording` is spelled out rather than `z.coerce.boolean()`, which reads
 * `?has_recording=false` as true — `Boolean("false")` is the footgun underneath.
 * Same idiom as `overdue` in action-items.ts.
 */
export const libraryMeetingsQuery = z.object({
  scope: z.enum(LIBRARY_SCOPES).default("all"),
  q: z.string().max(MAX_QUERY_LENGTH, `Search is capped at ${MAX_QUERY_LENGTH} characters`).default(""),
  status: z.nativeEnum(MeetingStatus).optional(),
  has_recording: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  cursor: z.string().max(400).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
});
export type LibraryMeetingsQuery = z.infer<typeof libraryMeetingsQuery>;

export const libraryNotesQuery = z.object({
  q: z.string().max(MAX_QUERY_LENGTH, `Search is capped at ${MAX_QUERY_LENGTH} characters`).default(""),
  cursor: z.string().max(400).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
});
export type LibraryNotesQuery = z.infer<typeof libraryNotesQuery>;

export async function libraryRoutes(app: FastifyInstance): Promise<void> {
  /**
   * The shelf. `scope` picks the rail — everything, mine, shared with me — and
   * the filters narrow it; none of them can widen it past what the actor may
   * read.
   */
  app.get("/library/meetings", async (request) => {
    // Both, for the two halves of the read: requireCtx because the counts below
    // go through the tenant-scoped client, requireActor because the raw page
    // query has to be told the tenant and the user itself.
    requireCtx(request);
    const actor = requireActor(request);

    const parsed = libraryMeetingsQuery.safeParse(request.query);
    if (!parsed.success) {
      throw ApiError.badRequest("Invalid library query", parsed.error.flatten().fieldErrors);
    }
    return listLibraryMeetings(actor, parsed.data);
  });

  /** The Notes rail: meetings somebody actually wrote something in. */
  app.get("/library/notes", async (request) => {
    requireCtx(request);
    const actor = requireActor(request);

    const parsed = libraryNotesQuery.safeParse(request.query);
    if (!parsed.success) {
      throw ApiError.badRequest("Invalid library query", parsed.error.flatten().fieldErrors);
    }
    return listLibraryNotes(actor, parsed.data);
  });
}

/* -------------------------------------------------------------------------
 * Meetings
 * ---------------------------------------------------------------------- */

type MeetingRow = {
  id: string;
  title: string | null;
  status: MeetingStatus;
  platform: string | null;
  started_at: Date | null;
  created_at: Date;
  duration_ms: number | null;
  transcript_id: string | null;
  transcript_duration_ms: number | null;
  segment_count: number | null;
  artifact_id: string | null;
  artifact_purged_at: Date | null;
  artifact_content_type: string | null;
  /** BIGINT, so the driver hands back a bigint and JSON.stringify would throw. */
  artifact_bytes: bigint | null;
  has_notes: boolean;
};

export async function listLibraryMeetings(actor: Actor, query: LibraryMeetingsQuery) {
  const tenantId = actor.tenantId;
  const cursor = decodeCursor(query.cursor);

  // Both joins are on unique keys — `transcripts.meeting_id` and
  // `artifacts(meeting_id, kind)` — so neither can multiply a meeting into two
  // cards. A LEFT JOIN whose uniqueness is only conventional would need a
  // DISTINCT ON, and DISTINCT ON fights the keyset ordering.
  const rows = await prisma.$queryRaw<MeetingRow[]>(Prisma.sql`
    SELECT
      m."id",
      m."title",
      m."status",
      m."platform",
      m."started_at",
      m."created_at",
      m."duration_ms",
      t."id"                                    AS transcript_id,
      t."duration_ms"                           AS transcript_duration_ms,
      t."segment_count"                         AS segment_count,
      a."id"                                    AS artifact_id,
      a."purged_at"                             AS artifact_purged_at,
      a."content_type"                          AS artifact_content_type,
      a."bytes"                                 AS artifact_bytes,
      EXISTS (
        SELECT 1 FROM "meeting_notes" n
        WHERE n."meeting_id" = m."id"
          AND n."tenant_id" = ${tenantId}
          -- A note row is created by the first flush of the CRDT, so an empty
          -- one means "somebody opened the editor", not "somebody wrote". The
          -- regex rather than btrim(): btrim strips spaces only, and a note of
          -- three newlines would otherwise count as written-in.
          AND n."plain_text" ~ '[^[:space:]]'
      )                                         AS has_notes
    FROM "meetings" m
    LEFT JOIN "transcripts" t
      ON t."meeting_id" = m."id" AND t."tenant_id" = ${tenantId}
    -- Audio only, matching playback.ts: the audio track is always written, the
    -- video is optional, and the card's play affordance opens the player.
    LEFT JOIN "artifacts" a
      ON a."meeting_id" = m."id" AND a."tenant_id" = ${tenantId} AND a."kind" = 'recording_audio'
    WHERE m."tenant_id" = ${tenantId}
      AND m."deleted_at" IS NULL
      AND ${visibleToActor(actor)}
      ${scopeFilter(actor, query.scope)}
      ${statusFilter(query.status)}
      ${startedBetween(query.from, query.to)}
      ${recordingFilter(query.has_recording)}
      ${titleMatches(query.q)}
      ${keysetAfter(cursor)}
    ${SHELF_ORDER}
    LIMIT ${query.limit + 1}
  `);

  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  const nextCursor = rows.length > page.length && last ? encodeCursor(last.started_at, last.id) : null;

  if (page.length === 0) {
    return { scope: query.scope, meetings: [], next_cursor: null };
  }

  const ids = page.map((row) => row.id);
  const transcriptIds = page
    .map((row) => row.transcript_id)
    .filter((id): id is string => id !== null);

  // Four aggregates, each keyed by ids the query above already proved belong to
  // this tenant — so these go back through the extended client and are correct
  // twice over. One round of aggregates per page, never per card.
  const [speakers, claims, actions, suggestions] = await Promise.all([
    speakersByTranscript(transcriptIds),
    claimCounts(ids),
    actionCounts(ids),
    pendingSuggestionCounts(ids),
  ]);

  return {
    scope: query.scope,
    meetings: page.map((row) => {
      const talk = (row.transcript_id ? speakers.get(row.transcript_id) : undefined) ?? [];
      return {
        id: row.id,
        title: row.title,
        status: row.status,
        platform: row.platform,
        started_at: row.started_at?.toISOString() ?? null,
        // The fallback date for a meeting that was scheduled and never ran.
        created_at: row.created_at.toISOString(),
        ...duration(row),
        // Ordered by turns taken, so the eight that fit are the eight who were
        // actually in the conversation rather than eight arbitrary labels.
        participants: talk.slice(0, PARTICIPANT_LIMIT).map((s) => s.speaker),
        participant_count: talk.length,
        recording: recordingState(row),
        transcript: row.transcript_id
          ? { available: true, segment_count: row.segment_count ?? 0 }
          : { available: false, segment_count: 0 },
        claim_counts: claims.get(row.id) ?? emptyClaimCounts(),
        action_item_counts: {
          ...(actions.get(row.id) ?? emptyActionCounts()),
          suggested: suggestions.get(row.id) ?? 0,
        },
        has_notes: row.has_notes,
      };
    }),
    next_cursor: nextCursor,
  };
}

/**
 * Duration off the media, not off the calendar.
 *
 * `meetings.duration_ms` is calendar-shaped and frequently unset; the
 * transcript's is measured from the recording. Same precedence as playback.ts.
 * Null rather than 0 when neither exists — a card badged "0:00" reads as a
 * broken recording rather than as a meeting nobody has processed yet.
 */
function duration(row: Pick<MeetingRow, "transcript_duration_ms" | "duration_ms">) {
  const durationMs = row.transcript_duration_ms ?? row.duration_ms ?? null;
  return {
    duration_ms: durationMs,
    duration_label: durationMs === null ? null : formatTimestamp(durationMs),
  };
}

type RecordingState = {
  playable: boolean;
  unavailable_reason: PlaybackUnavailable | null;
  content_type: string | null;
  bytes: number | null;
};

/**
 * A purged artifact keeps its row — the deletion path sets `purged_at` and
 * destroys the object in R2. Reporting it as a recording would put a play button
 * on the card that fails several seconds after the click, which reads as a
 * broken product rather than as a recording somebody deliberately deleted. So
 * the card says which it is, and carries no size and no key for media that is
 * gone. Same vocabulary as playback.ts's `unavailable_reason`, so a client that
 * already handles one handles both.
 */
function recordingState(row: MeetingRow): RecordingState {
  if (row.artifact_id === null) {
    return { playable: false, unavailable_reason: "not_recorded", content_type: null, bytes: null };
  }
  if (row.artifact_purged_at !== null) {
    return { playable: false, unavailable_reason: "purged", content_type: null, bytes: null };
  }
  return {
    playable: true,
    unavailable_reason: null,
    content_type: row.artifact_content_type,
    bytes: row.artifact_bytes === null ? null : Number(row.artifact_bytes),
  };
}

/* -------------------------------------------------------------------------
 * Notes
 * ---------------------------------------------------------------------- */

type NoteRow = {
  meeting_id: string;
  title: string | null;
  started_at: Date | null;
  created_at: Date;
  note_id: string;
  plain_text: string;
  revision: number;
  updated_at: Date;
  updated_by_user_id: string | null;
  editor_name: string | null;
  editor_email: string | null;
  editor_image: string | null;
};

export async function listLibraryNotes(actor: Actor, query: LibraryNotesQuery) {
  const tenantId = actor.tenantId;
  const cursor = decodeCursor(query.cursor);

  // `user` carries no tenant_id — identity exists before a workspace does — so
  // it is joined off a note row this statement has already scoped, never
  // searched. Ordering is the meetings shelf, not note recency: sorting by
  // `updated_at` would reshuffle the list under a reader while somebody else is
  // typing, and would need a second cursor shape for the same screen.
  const rows = await prisma.$queryRaw<NoteRow[]>(Prisma.sql`
    SELECT
      m."id"                                    AS meeting_id,
      m."title",
      m."started_at",
      m."created_at",
      n."id"                                    AS note_id,
      n."plain_text",
      n."revision",
      n."updated_at",
      n."updated_by_user_id",
      u."name"                                  AS editor_name,
      u."email"                                 AS editor_email,
      u."image"                                 AS editor_image
    FROM "meeting_notes" n
    JOIN "meetings" m ON m."id" = n."meeting_id" AND m."tenant_id" = ${tenantId}
    LEFT JOIN "user" u ON u."id" = n."updated_by_user_id"
    WHERE n."tenant_id" = ${tenantId}
      AND m."deleted_at" IS NULL
      AND ${visibleToActor(actor)}
      AND n."plain_text" ~ '[^[:space:]]'
      ${titleMatches(query.q)}
      ${keysetAfter(cursor)}
    ${SHELF_ORDER}
    LIMIT ${query.limit + 1}
  `);

  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  const nextCursor =
    rows.length > page.length && last ? encodeCursor(last.started_at, last.meeting_id) : null;

  return {
    notes: page.map((row) => ({
      meeting_id: row.meeting_id,
      title: row.title,
      started_at: row.started_at?.toISOString() ?? null,
      created_at: row.created_at.toISOString(),
      note: {
        id: row.note_id,
        excerpt: excerpt(row.plain_text),
        revision: row.revision,
        updated_at: row.updated_at.toISOString(),
        last_editor: row.updated_by_user_id
          ? {
              user_id: row.updated_by_user_id,
              name: row.editor_name,
              email: row.editor_email,
              image: row.editor_image,
            }
          : null,
      },
    })),
    next_cursor: nextCursor,
  };
}

/**
 * Plain text, not a highlighted snippet. /search escapes before it marks up
 * (see toSnippet there) precisely because HTML assembled out of note text is a
 * stored-XSS vector; the library hands back text so the client renders it as
 * text and the question does not arise.
 */
function excerpt(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= EXCERPT_CHARS) return collapsed;
  return `${collapsed.slice(0, EXCERPT_CHARS).trimEnd()}…`;
}

/* -------------------------------------------------------------------------
 * Predicates
 * ---------------------------------------------------------------------- */

/**
 * NULLS LAST is the whole reason this is spelled out rather than left to
 * Postgres: the default for DESC is NULLS FIRST, which would float every
 * scheduled-but-never-recorded meeting above yesterday's recording and put the
 * emptiest cards at the top of the shelf.
 */
const SHELF_ORDER = Prisma.sql`ORDER BY m."started_at" DESC NULLS LAST, m."id" DESC`;

/**
 * The rule from meetingAccess() in authz.ts, restated as SQL against `meetings m`
 * — the same restatement domain/search.ts carries, and for the same reason:
 * deciding access per row in TypeScript means reading every candidate row first,
 * so a private meeting has already left the database by the time we decide it
 * should not have. If the visibility rules in authz.ts change, this changes with
 * them.
 */
function visibleToActor(actor: Actor): Prisma.Sql {
  if (hasRole(actor, "admin")) return Prisma.sql`TRUE`;
  return Prisma.sql`(
        m."visibility" = 'workspace'
        OR m."created_by_user_id" = ${actor.userId}
        OR EXISTS (
          SELECT 1 FROM "meeting_collaborators" mc
          WHERE mc."meeting_id" = m."id" AND mc."user_id" = ${actor.userId}
        )
      )`;
}

/**
 * The rails. Scope narrows what the visibility predicate already allowed and is
 * ANDed with it rather than substituted for it, so no rail can be a way around
 * access — including `mine` and `shared_with_me`, which happen to be subsets of
 * visible today and would stop being so the day the rules gain a clause.
 */
function scopeFilter(actor: Actor, scope: LibraryScope): Prisma.Sql {
  switch (scope) {
    case "mine":
      return Prisma.sql`AND m."created_by_user_id" = ${actor.userId}`;
    case "shared_with_me":
      // Shared *with* me, not by me. A meeting you created and then added
      // yourself to is still yours; letting it appear under both rails is what
      // makes a split shelf stop being a split.
      return Prisma.sql`
        AND m."created_by_user_id" IS DISTINCT FROM ${actor.userId}
        AND EXISTS (
          SELECT 1 FROM "meeting_collaborators" mc
          WHERE mc."meeting_id" = m."id"
            AND mc."user_id" = ${actor.userId}
            AND mc."tenant_id" = ${actor.tenantId}
        )`;
    case "all":
      return Prisma.empty;
  }
}

/**
 * The cast is on the parameter, not on the column. `m."status"::text = $1` would
 * work too and would throw away the (tenant_id, status) index; a text parameter
 * cast to the enum keeps the comparison on the indexed side.
 */
function statusFilter(status: MeetingStatus | undefined): Prisma.Sql {
  if (!status) return Prisma.empty;
  return Prisma.sql`AND m."status" = ${status}::"meeting_status"`;
}

/**
 * Bounded by when the meeting happened, which is the same key the shelf is
 * ordered by — so a date range and the cursor agree about what "before" means. A
 * meeting that never started has no date to filter by and drops out of a
 * date-bounded query rather than being silently dated by its creation time.
 */
function startedBetween(from: string | undefined, to: string | undefined): Prisma.Sql {
  const lower = from ? Prisma.sql`AND m."started_at" >= ${new Date(from)}` : Prisma.empty;
  const upper = to ? Prisma.sql`AND m."started_at" <= ${new Date(to)}` : Prisma.empty;
  return Prisma.sql`${lower} ${upper}`;
}

/**
 * "Has a recording" means "has one you can play". A purged artifact is a row
 * describing an object that no longer exists, so counting it here would put
 * meetings in the filtered-for-recordings rail whose cards then say the
 * recording is gone.
 */
function recordingFilter(hasRecording: boolean | undefined): Prisma.Sql {
  if (hasRecording === undefined) return Prisma.empty;
  return hasRecording
    ? Prisma.sql`AND a."id" IS NOT NULL AND a."purged_at" IS NULL`
    : Prisma.sql`AND (a."id" IS NULL OR a."purged_at" IS NOT NULL)`;
}

/**
 * Both expressions are copied character for character from the
 * full_text_search migration — `to_tsvector('english', coalesce(title,''))` and
 * the `lower(coalesce(title,''))` trigram index. Postgres uses an expression
 * index only on an exact match, so a stray `coalesce` argument here is not a
 * style difference, it is a sequential scan.
 *
 * `websearch_to_tsquery` so that "quoted phrases", `or` and a leading `-` work
 * the way a search box has taught people to expect, and so a stray bracket
 * yields an empty tsquery rather than an exception. The trigram tail is what
 * makes "positoning review" still find the positioning review.
 *
 * An empty box is not a filter: a library with nothing typed into it is still a
 * library, which is where this parts company with /search — that endpoint has no
 * shelf to fall back to and refuses to answer "everything".
 */
function titleMatches(raw: string): Prisma.Sql {
  const q = raw.trim().slice(0, MAX_QUERY_LENGTH);
  if (q.length === 0) return Prisma.empty;
  return Prisma.sql`
      AND (
        to_tsvector('english', coalesce(m."title", ''))
          @@ websearch_to_tsquery('english', ${q})
        OR lower(${q}) <% lower(coalesce(m."title", ''))
      )`;
}

/* -------------------------------------------------------------------------
 * Cursor
 * ---------------------------------------------------------------------- */

type ShelfCursor = { startedAt: Date | null; id: string };

/**
 * Keyset, not offset.
 *
 * OFFSET renumbers every page the moment a meeting is recorded, so a reader
 * paging through the shelf sees one card twice and never sees another. The
 * cursor carries the sort key of the last row handed out, which is stable
 * whatever arrives above it.
 *
 * Base64 because it is an implementation detail the client must not build on;
 * it is not a security boundary and is not treated as one — the tenant and the
 * visibility predicate come from the session on every request, so a forged
 * cursor can only ask for a different page of the actor's own shelf.
 */
function encodeCursor(startedAt: Date | null, id: string): string {
  return Buffer.from(`${startedAt?.toISOString() ?? ""}|${id}`, "utf8").toString("base64url");
}

function decodeCursor(raw: string | undefined): ShelfCursor | null {
  if (!raw) return null;

  // Buffer.from is lenient with garbage input, so nothing here can rely on it
  // to reject: every field is validated after the decode.
  const decoded = Buffer.from(raw, "base64url").toString("utf8");
  const separator = decoded.indexOf("|");
  if (separator < 0) throw ApiError.badRequest("Malformed cursor");

  const stamp = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);
  if (!id) throw ApiError.badRequest("Malformed cursor");
  if (stamp === "") return { startedAt: null, id };

  const startedAt = new Date(stamp);
  if (Number.isNaN(startedAt.getTime())) throw ApiError.badRequest("Malformed cursor");
  return { startedAt, id };
}

/**
 * The strictly-after half of (started_at DESC NULLS LAST, id DESC).
 *
 * The null branch is separate because a NULL sorts last under this ordering:
 * once the page has reached the undated tail there is nothing dated left to
 * return, and `started_at < NULL` would be NULL rather than false and quietly
 * end the listing early.
 *
 * `id` is text, so `<` uses the database collation — the same collation the
 * ORDER BY uses, since it is the same column, which is all a keyset needs.
 */
function keysetAfter(cursor: ShelfCursor | null): Prisma.Sql {
  if (!cursor) return Prisma.empty;
  if (cursor.startedAt === null) {
    return Prisma.sql`AND m."started_at" IS NULL AND m."id" < ${cursor.id}`;
  }
  return Prisma.sql`
      AND (
        m."started_at" IS NULL
        OR m."started_at" < ${cursor.startedAt}
        OR (m."started_at" = ${cursor.startedAt} AND m."id" < ${cursor.id})
      )`;
}

/* -------------------------------------------------------------------------
 * Per-page aggregates
 * ---------------------------------------------------------------------- */

type Speaker = { speaker: string; turns: number };

/**
 * Who was in the room, taken from the transcript rather than from the calendar:
 * the invitee list says who was asked, the diarisation says who actually spoke.
 * Sorted by turns, then by name so that two people with the same count do not
 * swap places between requests.
 */
async function speakersByTranscript(transcriptIds: string[]): Promise<Map<string, Speaker[]>> {
  const map = new Map<string, Speaker[]>();
  if (transcriptIds.length === 0) return map;

  const rows = await prisma.transcriptSegment.groupBy({
    by: ["transcriptId", "speaker"],
    where: { transcriptId: { in: transcriptIds } },
    _count: { _all: true },
  });

  for (const row of rows) {
    const entry = map.get(row.transcriptId) ?? [];
    entry.push({ speaker: row.speaker, turns: row._count._all });
    map.set(row.transcriptId, entry);
  }
  for (const entry of map.values()) {
    entry.sort((a, b) => b.turns - a.turns || a.speaker.localeCompare(b.speaker));
  }
  return map;
}

type ClaimCounts = Record<ClaimStatus, number> & { total: number };

const emptyClaimCounts = (): ClaimCounts => ({
  proposed: 0,
  approved: 0,
  rejected: 0,
  edited: 0,
  total: 0,
});

/** Same shape meetings.ts returns, so a card and a detail view agree. */
async function claimCounts(meetingIds: string[]): Promise<Map<string, ClaimCounts>> {
  const map = new Map<string, ClaimCounts>();
  const rows = await prisma.candidateClaim.groupBy({
    by: ["meetingId", "status"],
    where: { meetingId: { in: meetingIds } },
    _count: { _all: true },
  });

  for (const row of rows) {
    const entry = map.get(row.meetingId) ?? emptyClaimCounts();
    entry[row.status] = row._count._all;
    entry.total += row._count._all;
    map.set(row.meetingId, entry);
  }
  return map;
}

type ActionCounts = Record<ActionItemStatus, number> & { total: number };

const emptyActionCounts = (): ActionCounts => ({
  open: 0,
  in_progress: 0,
  done: 0,
  cancelled: 0,
  total: 0,
});

/**
 * A suggested item that nobody has accepted is a proposal, not work. Counting it
 * as an open action item would put a number on the card that says three people
 * owe you something when a model merely thought so — the same reason a
 * candidate claim is not in the brief until the review gate says so. Pending
 * suggestions are counted separately, below.
 */
const PENDING_SUGGESTION = {
  origin: ActionItemOrigin.ai_suggested,
  acceptedAt: null,
  dismissedAt: null,
} satisfies Prisma.ActionItemWhereInput;

async function actionCounts(meetingIds: string[]): Promise<Map<string, ActionCounts>> {
  const map = new Map<string, ActionCounts>();
  const rows = await prisma.actionItem.groupBy({
    by: ["meetingId", "status"],
    where: { meetingId: { in: meetingIds }, NOT: PENDING_SUGGESTION },
    _count: { _all: true },
  });

  for (const row of rows) {
    if (!row.meetingId) continue;
    const entry = map.get(row.meetingId) ?? emptyActionCounts();
    entry[row.status] = row._count._all;
    entry.total += row._count._all;
    map.set(row.meetingId, entry);
  }
  return map;
}

async function pendingSuggestionCounts(meetingIds: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const rows = await prisma.actionItem.groupBy({
    by: ["meetingId"],
    where: { meetingId: { in: meetingIds }, ...PENDING_SUGGESTION },
    _count: { _all: true },
  });

  for (const row of rows) {
    if (!row.meetingId) continue;
    map.set(row.meetingId, row._count._all);
  }
  return map;
}
