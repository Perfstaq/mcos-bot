import { Prisma } from "@prisma/client";
import { hasRole, type Actor } from "../authz.js";
import { prisma } from "../db.js";

/**
 * Cross-meeting search.
 *
 * TENANCY IS THIS FILE'S JOB. Everything here runs through `$queryRaw`, and the
 * client extension in db.ts cannot see inside raw SQL — it injects `tenant_id`
 * into queries it can parse, and a template string is not one of them. So this
 * is the one place in the codebase where a missing tenant filter is a
 * cross-tenant read with nothing standing behind it. Every statement below
 * carries `tenant_id = ${actor.tenantId}` itself, as a bound parameter, and any
 * statement added later must too.
 *
 * Raw SQL rather than Prisma's `search` mode because the GIN indexes are
 * *expression* indexes (see the full_text_search migration). Postgres uses one
 * only when the predicate repeats the indexed expression character for
 * character, and Prisma has no way to emit
 * `to_tsvector('english', coalesce("text", '') || ' ' || coalesce("speaker", ''))`.
 * Where an expression appears twice below — once in the WHERE, once in the
 * ranking — it is copied rather than aliased through a join for the same
 * reason: a joined tsquery becomes a join condition, and the planner stops
 * treating it as an index-scannable constant.
 *
 * `websearch_to_tsquery` rather than `plainto_tsquery` so that "quoted
 * phrases", `or` and a leading `-` work the way people already expect from a
 * search box, and so malformed input yields an empty tsquery rather than an
 * exception thrown at whoever typed a stray bracket.
 */

export const SEARCH_KINDS = ["meeting", "transcript", "note", "action_item", "claim"] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 50;
/** Past this length it is a pasted paragraph, not a search. */
export const MAX_QUERY_LENGTH = 200;

export type SearchHit = {
  kind: SearchKind;
  /** Primary key of the row that matched, not of its meeting. */
  id: string;
  meetingId: string | null;
  meetingTitle: string | null;
  /** Set when the hit resolves to a point in the recording. */
  segmentId: string | null;
  startMs: number | null;
  endMs: number | null;
  speaker: string | null;
  /** HTML-safe: escaped first, then `<mark>` around what matched. */
  snippet: string;
  rank: number;
  occurredAt: Date | null;
  /** The source meeting was purged; the text survived, the evidence did not. */
  evidenceRedacted: boolean;
};

/**
 * ts_rank_cd scores are only comparable inside one corpus — a title match and a
 * transcript match both score around 0.1 and do not mean the same thing. These
 * multipliers are the editorial call about which corpus wins when several
 * match: someone typing a meeting's name wants that meeting, not the eleven
 * times it was mentioned during a different call.
 */
const KIND_WEIGHT: Record<SearchKind, number> = {
  meeting: 4,
  claim: 2.5,
  action_item: 2,
  note: 1.5,
  transcript: 1,
};

/**
 * ts_headline wraps matches in these and toSnippet() swaps them for `<mark>`
 * *after* escaping. Emitting `<mark>` from Postgres directly would mean
 * shipping HTML assembled out of raw transcript text, which makes every meeting
 * a stored-XSS vector. Control characters rather than a printable sentinel so
 * that no amount of "[[" in someone's notes can forge a highlight; ts_headline
 * inserts them after tokenisation, so they cannot affect what matched.
 */
const HL_OPEN = String.fromCharCode(1);
const HL_CLOSE = String.fromCharCode(2);
const HEADLINE = `StartSel=${HL_OPEN}, StopSel=${HL_CLOSE}, MaxFragments=2, MaxWords=28, MinWords=8`;

function toSnippet(headline: string | null): string {
  return (headline ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll(HL_OPEN, "<mark>")
    .replaceAll(HL_CLOSE, "</mark>");
}

/**
 * The rule from meetingAccess() in authz.ts, restated as SQL against a
 * `meetings m`.
 *
 * Duplicating it is deliberate. Deciding access per row in TypeScript means
 * reading every candidate row first, so a private meeting has already left the
 * database by the time we decide it should not have. If the visibility rules in
 * authz.ts change, this changes with them.
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

type Scope = {
  tenantId: string;
  query: string;
  limit: number;
  visible: Prisma.Sql;
  byMeeting: Prisma.Sql;
};

/** Uniform projection, so every corpus maps through one function. */
type RawHit = {
  id: string;
  meeting_id: string | null;
  meeting_title: string | null;
  segment_id: string | null;
  start_ms: number | null;
  end_ms: number | null;
  speaker: string | null;
  snippet: string | null;
  rank: number;
  occurred_at: Date | null;
  evidence_redacted: boolean | null;
};

export async function search(args: {
  actor: Actor;
  query: string;
  kinds?: readonly SearchKind[];
  meetingId?: string;
  limit?: number;
}): Promise<SearchHit[]> {
  const query = args.query.trim().slice(0, MAX_QUERY_LENGTH);
  // An empty search box is not a request for the whole workspace.
  if (query.length === 0) return [];

  const scope: Scope = {
    tenantId: args.actor.tenantId,
    query,
    limit: Math.min(Math.max(Math.trunc(args.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT),
    visible: visibleToActor(args.actor),
    byMeeting: args.meetingId ? Prisma.sql`AND m."id" = ${args.meetingId}` : Prisma.empty,
  };

  const kinds = args.kinds?.length ? args.kinds : SEARCH_KINDS;
  const batches = await Promise.all(kinds.map((kind) => RUNNERS[kind](scope)));

  // Each corpus is capped at `limit` and already ordered, so the global top
  // `limit` is guaranteed to sit inside the union: merging in memory is exact
  // here rather than an approximation, and it costs one round trip, not two.
  return batches
    .flat()
    .sort((a, b) => b.rank - a.rank || (a.startMs ?? 0) - (b.startMs ?? 0) || a.id.localeCompare(b.id))
    .slice(0, scope.limit);
}

/**
 * Titles, with a fuzzy tail.
 *
 * The trigram index is what makes "positoning review" still find the
 * positioning review. ts_rank_cd is 0 for a row that matched only fuzzily, so
 * the deliberately tiny word_similarity term never reorders real matches — it
 * only sorts the misspelling tail among itself. word_similarity rather than
 * similarity because it scores the query against the best-matching run of words
 * inside the title rather than against the whole string; otherwise a two-word
 * query never clears the threshold against a nine-word title.
 */
async function searchMeetings(scope: Scope): Promise<SearchHit[]> {
  const rows = await prisma.$queryRaw<RawHit[]>(Prisma.sql`
    SELECT
      m."id",
      m."id"                                    AS meeting_id,
      m."title"                                 AS meeting_title,
      NULL::text                                AS segment_id,
      NULL::int                                 AS start_ms,
      NULL::int                                 AS end_ms,
      NULL::text                                AS speaker,
      ts_headline('english', coalesce(m."title", ''),
                  websearch_to_tsquery('english', ${scope.query}), ${HEADLINE})  AS snippet,
      ts_rank_cd(to_tsvector('english', coalesce(m."title", '')),
                 websearch_to_tsquery('english', ${scope.query}))
        + word_similarity(lower(${scope.query}), lower(coalesce(m."title", ''))) * 0.01
                                                AS rank,
      coalesce(m."started_at", m."created_at")   AS occurred_at,
      FALSE                                     AS evidence_redacted
    FROM "meetings" m
    WHERE m."tenant_id" = ${scope.tenantId}
      AND m."deleted_at" IS NULL
      AND ${scope.visible}
      ${scope.byMeeting}
      AND (
        to_tsvector('english', coalesce(m."title", ''))
          @@ websearch_to_tsquery('english', ${scope.query})
        OR lower(${scope.query}) <% lower(coalesce(m."title", ''))
      )
    ORDER BY rank DESC
    LIMIT ${scope.limit}
  `);
  return toHits("meeting", rows);
}

/**
 * The transcript. Speaker is folded into the indexed expression, so "priya on
 * pricing" finds her turns — but the headline is taken over the text alone,
 * because a snippet with the speaker's name glued to the front reads like a
 * transcription error. Speaker travels as its own field instead.
 */
async function searchTranscripts(scope: Scope): Promise<SearchHit[]> {
  const rows = await prisma.$queryRaw<RawHit[]>(Prisma.sql`
    SELECT
      s."id",
      t."meeting_id"                            AS meeting_id,
      m."title"                                 AS meeting_title,
      s."id"                                    AS segment_id,
      s."start_ms"                              AS start_ms,
      s."end_ms"                                AS end_ms,
      s."speaker"                               AS speaker,
      ts_headline('english', s."text",
                  websearch_to_tsquery('english', ${scope.query}), ${HEADLINE})  AS snippet,
      ts_rank_cd(
        to_tsvector('english', coalesce(s."text", '') || ' ' || coalesce(s."speaker", '')),
        websearch_to_tsquery('english', ${scope.query})
      )                                         AS rank,
      coalesce(m."started_at", m."created_at")   AS occurred_at,
      FALSE                                     AS evidence_redacted
    FROM "transcript_segments" s
    JOIN "transcripts" t ON t."id" = s."transcript_id"
    JOIN "meetings" m ON m."id" = t."meeting_id"
    WHERE s."tenant_id" = ${scope.tenantId}
      AND m."deleted_at" IS NULL
      AND ${scope.visible}
      ${scope.byMeeting}
      AND to_tsvector('english', coalesce(s."text", '') || ' ' || coalesce(s."speaker", ''))
          @@ websearch_to_tsquery('english', ${scope.query})
    ORDER BY rank DESC, s."start_ms" ASC
    LIMIT ${scope.limit}
  `);
  return toHits("transcript", rows);
}

/**
 * Collaborative notes. `plain_text` is a projection of the Yjs document that
 * exists for exactly this query — the CRDT state itself is opaque bytes and
 * cannot be indexed.
 */
async function searchNotes(scope: Scope): Promise<SearchHit[]> {
  const rows = await prisma.$queryRaw<RawHit[]>(Prisma.sql`
    SELECT
      n."id",
      n."meeting_id"                            AS meeting_id,
      m."title"                                 AS meeting_title,
      NULL::text                                AS segment_id,
      NULL::int                                 AS start_ms,
      NULL::int                                 AS end_ms,
      NULL::text                                AS speaker,
      ts_headline('english', n."plain_text",
                  websearch_to_tsquery('english', ${scope.query}), ${HEADLINE})  AS snippet,
      ts_rank_cd(to_tsvector('english', coalesce(n."plain_text", '')),
                 websearch_to_tsquery('english', ${scope.query}))                AS rank,
      coalesce(m."started_at", m."created_at")   AS occurred_at,
      FALSE                                     AS evidence_redacted
    FROM "meeting_notes" n
    JOIN "meetings" m ON m."id" = n."meeting_id"
    WHERE n."tenant_id" = ${scope.tenantId}
      AND m."deleted_at" IS NULL
      AND ${scope.visible}
      ${scope.byMeeting}
      AND to_tsvector('english', coalesce(n."plain_text", ''))
          @@ websearch_to_tsquery('english', ${scope.query})
    ORDER BY rank DESC
    LIMIT ${scope.limit}
  `);
  return toHits("note", rows);
}

/**
 * Action items. No GIN index stands behind this one: the table holds tens of
 * rows per meeting, so a scan inside a single tenant costs less than the index
 * would. Saying so out loud beats letting a later reader assume the
 * full_text_search migration covers it.
 *
 * `source_segment_id` is joined rather than ignored — an item lifted from the
 * transcript keeps its citation, so the hit can open the recording at the
 * moment it was agreed instead of only naming the meeting.
 */
async function searchActionItems(scope: Scope): Promise<SearchHit[]> {
  const rows = await prisma.$queryRaw<RawHit[]>(Prisma.sql`
    SELECT
      ai."id",
      ai."meeting_id"                           AS meeting_id,
      m."title"                                 AS meeting_title,
      ai."source_segment_id"                    AS segment_id,
      seg."start_ms"                            AS start_ms,
      seg."end_ms"                              AS end_ms,
      seg."speaker"                             AS speaker,
      ts_headline('english',
                  coalesce(ai."title", '') || ' ' || coalesce(ai."description", ''),
                  websearch_to_tsquery('english', ${scope.query}), ${HEADLINE})  AS snippet,
      ts_rank_cd(
        to_tsvector('english', coalesce(ai."title", '') || ' ' || coalesce(ai."description", '')),
        websearch_to_tsquery('english', ${scope.query})
      )                                         AS rank,
      coalesce(m."started_at", ai."created_at")  AS occurred_at,
      FALSE                                     AS evidence_redacted
    FROM "action_items" ai
    LEFT JOIN "meetings" m ON m."id" = ai."meeting_id"
    LEFT JOIN "transcript_segments" seg ON seg."id" = ai."source_segment_id"
    WHERE ai."tenant_id" = ${scope.tenantId}
      -- A standalone item has no meeting to inherit visibility from, so it is
      -- workspace-wide by construction.
      AND (ai."meeting_id" IS NULL OR (m."deleted_at" IS NULL AND ${scope.visible}))
      ${scope.byMeeting}
      AND to_tsvector('english', coalesce(ai."title", '') || ' ' || coalesce(ai."description", ''))
          @@ websearch_to_tsquery('english', ${scope.query})
    ORDER BY rank DESC
    LIMIT ${scope.limit}
  `);
  return toHits("action_item", rows);
}

/**
 * Approved claims, from the current brief version only.
 *
 * Every version materialises the claims it carries forward, so searching all of
 * brief_claims would return one sentence once per version — five merges, five
 * identical hits. The newest version is the workspace's current memory and the
 * only one worth searching.
 *
 * No visibility predicate here, deliberately: a claim in the brief is workspace
 * memory, not meeting content. It got there through the review gate, and GET
 * /brief/current already shows it to every member — filtering it back out by
 * the visibility of the meeting it came from would hide approved memory from
 * the people who approved it. Deleted meetings are not excluded either. The
 * claim outlives its evidence by design, and `evidence_redacted` is what tells
 * the client not to offer a jump into a recording that no longer exists.
 */
async function searchBriefClaims(scope: Scope): Promise<SearchHit[]> {
  const rows = await prisma.$queryRaw<RawHit[]>(Prisma.sql`
    SELECT
      bc."id",
      bc."meeting_id"                           AS meeting_id,
      m."title"                                 AS meeting_title,
      NULL::text                                AS segment_id,
      bc."timestamp_ms"                         AS start_ms,
      NULL::int                                 AS end_ms,
      bc."speaker"                              AS speaker,
      ts_headline('english', bc."text",
                  websearch_to_tsquery('english', ${scope.query}), ${HEADLINE})  AS snippet,
      ts_rank_cd(
        to_tsvector('english', coalesce(bc."text", '') || ' ' || coalesce(bc."verbatim_quote", '')),
        websearch_to_tsquery('english', ${scope.query})
      )                                         AS rank,
      coalesce(m."started_at", m."created_at")   AS occurred_at,
      bc."evidence_redacted"                    AS evidence_redacted
    FROM "brief_claims" bc
    JOIN "meetings" m ON m."id" = bc."meeting_id"
    WHERE bc."tenant_id" = ${scope.tenantId}
      AND bc."brief_version_id" = (
        SELECT bv."id" FROM "brief_versions" bv
        WHERE bv."tenant_id" = ${scope.tenantId}
        ORDER BY bv."version" DESC
        LIMIT 1
      )
      ${scope.byMeeting}
      AND to_tsvector('english', coalesce(bc."text", '') || ' ' || coalesce(bc."verbatim_quote", ''))
          @@ websearch_to_tsquery('english', ${scope.query})
    ORDER BY rank DESC
    LIMIT ${scope.limit}
  `);
  return toHits("claim", rows);
}

const RUNNERS: Record<SearchKind, (scope: Scope) => Promise<SearchHit[]>> = {
  meeting: searchMeetings,
  transcript: searchTranscripts,
  note: searchNotes,
  action_item: searchActionItems,
  claim: searchBriefClaims,
};

function toHits(kind: SearchKind, rows: RawHit[]): SearchHit[] {
  const weight = KIND_WEIGHT[kind];
  return rows.map((row) => ({
    kind,
    id: row.id,
    meetingId: row.meeting_id,
    meetingTitle: row.meeting_title,
    segmentId: row.segment_id,
    startMs: row.start_ms,
    endMs: row.end_ms,
    speaker: row.speaker,
    snippet: toSnippet(row.snippet),
    rank: Number(row.rank) * weight,
    occurredAt: row.occurred_at,
    evidenceRedacted: row.evidence_redacted ?? false,
  }));
}
