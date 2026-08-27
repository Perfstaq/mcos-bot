import type { FastifyInstance } from "fastify";
import type { BriefClaim } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db.js";
import { ApiError, requireCtx } from "../http.js";
import {
  ConflictingLineageError,
  diffVersions,
  groupByType,
  mergeApprovedClaims,
  MergeContentionError,
  NothingToMergeError,
} from "../domain/brief.js";
import { CLAIM_TYPE_LABEL } from "../domain/claims.js";
import { formatTimestamp } from "../domain/transcript.js";

const mergeSchema = z
  .object({
    /** The call the reviewer had just finished. Optional: see the route. */
    meeting_id: z.string().uuid().optional(),
    note: z.string().trim().max(500).optional(),
  })
  .default({});

/** A brief version's own provenance: which call the reviewer merged from. */
type SourceMeeting = { id: string; title: string | null; date: string | null } | null;

export async function briefRoutes(app: FastifyInstance): Promise<void> {
  /** The merge. Approved claims become a new, immutable version of the brief. */
  app.post("/brief/versions", async (request, reply) => {
    const ctx = requireCtx(request);
    const parsed = mergeSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw ApiError.badRequest("Invalid body", parsed.error.flatten());

    // `meeting_id` names the call the reviewer just worked through, and is
    // optional because the merge is not scoped to it: a version is everything
    // approved and unmerged, whichever call it came from. Naming a meeting
    // records where the reviewer was standing, nothing more — and it is checked
    // against this tenant, so it cannot be used to point a version at a call
    // from another workspace.
    if (parsed.data.meeting_id) {
      const meeting = await prisma.meeting.findUnique({
        where: { id: parsed.data.meeting_id },
        select: { id: true },
      });
      if (!meeting) throw ApiError.notFound(`Meeting ${parsed.data.meeting_id} not found`);
    }

    try {
      const result = await mergeApprovedClaims({
        tenantId: ctx.tenantId,
        reviewer: ctx.reviewer,
        note: parsed.data.note ?? null,
        sourceMeetingId: parsed.data.meeting_id ?? null,
      });
      return reply.status(201).send({
        version: {
          version: result.version,
          added: result.added,
          removed: result.removed,
          edited: result.edited,
          total: result.total,
          source_meeting: await loadSourceMeeting(result.sourceMeetingId),
        },
      });
    } catch (error) {
      // "Nothing changed" is its own answer, not a generic conflict: it is what
      // a reviewer gets for pressing merge twice, and the UI says so rather
      // than showing them an error.
      if (error instanceof NothingToMergeError) {
        throw new ApiError(409, "no_changes", error.message);
      }
      if (error instanceof MergeContentionError) {
        throw new ApiError(409, "merge_contention", error.message);
      }
      if (error instanceof ConflictingLineageError) throw ApiError.conflict(error.message);
      throw error;
    }
  });

  app.get("/brief/versions", async (request) => {
    requireCtx(request);
    const versions = await prisma.briefVersion.findMany({
      orderBy: { version: "desc" },
      include: { sourceMeeting: { select: { id: true, title: true, startedAt: true, createdAt: true } } },
    });
    return {
      versions: versions.map((v) => ({
        version: v.version,
        created_at: v.createdAt.toISOString(),
        created_by: v.createdBy,
        note: v.note,
        // Flat counts are what the existing web client reads; `counts` is the
        // grouped shape the version rail renders. Same numbers, both kept.
        added: v.addedCount,
        removed: v.removedCount,
        edited: v.editedCount,
        counts: { added: v.addedCount, removed: v.removedCount, edited: v.editedCount },
        total: v.totalCount,
        source_meeting: serializeSourceMeeting(v.sourceMeeting),
      })),
    };
  });

  /**
   * The stage-5 read interface.
   *
   * Generation reads approved memory and nothing else — no candidate claims,
   * no raw transcripts, no unreviewed extractions are reachable from here.
   * Stage 5 is designed, not built; this is the shape it would consume.
   */
  app.get("/brief/current", async (request) => {
    requireCtx(request);
    const current = await prisma.briefVersion.findFirst({
      orderBy: { version: "desc" },
      include: { claims: true, sourceMeeting: SOURCE_MEETING_SELECT },
    });
    if (!current) {
      return { version: null, claims_by_type: [], total: 0, source_meeting: null };
    }
    return renderVersion(current);
  });

  app.get("/brief/versions/:n", async (request) => {
    requireCtx(request);
    const n = versionParam(request.params, "n");
    const version = await prisma.briefVersion.findFirst({
      where: { version: n },
      include: { claims: true, sourceMeeting: SOURCE_MEETING_SELECT },
    });
    if (!version) throw ApiError.notFound(`Brief version ${n} not found`);
    return renderVersion(version);
  });

  /**
   * What changed between two versions.
   *
   * `n` may be 0, meaning "against nothing" — the diff of the first version
   * against the empty brief, which is what the reviewer wants to see when they
   * land here straight from merging v1.
   */
  app.get("/brief/versions/:n/diff/:m", async (request) => {
    requireCtx(request);
    const n = versionParam(request.params, "n");
    const m = versionParam(request.params, "m");

    const [from, to] = await Promise.all([
      n === 0
        ? null
        : prisma.briefVersion.findFirst({ where: { version: n }, include: { claims: true } }),
      prisma.briefVersion.findFirst({ where: { version: m }, include: { claims: true } }),
    ]);

    if (n !== 0 && !from) throw ApiError.notFound(`Brief version ${n} not found`);
    if (!to) throw ApiError.notFound(`Brief version ${m} not found`);

    const diff = diffVersions(from?.claims ?? [], to.claims, n, m);
    const chips = await meetingChips([...diff.added, ...diff.removed, ...diff.edited.map((e) => e.after)]);

    return {
      from: n,
      to: m,
      added: diff.added.map((c) => serializeBriefClaim(c, chips)),
      removed: diff.removed.map((c) => serializeBriefClaim(c, chips)),
      edited: diff.edited.map((e) => ({
        claim_id: e.after.claimId,
        type: e.after.type,
        type_label: CLAIM_TYPE_LABEL[e.after.type],
        // `from`/`to` is the shape an edit reads as; `before`/`after` predates
        // it and is still what the shipped web client destructures. Both are
        // the same two strings, and renaming a live field to save four bytes
        // is not a trade worth making.
        from: e.before.text,
        to: e.after.text,
        before: e.before.text,
        after: e.after.text,
        source: chips.get(e.after.meetingId) ?? null,
      })),
      unchanged: diff.unchanged,
    };
  });
}

const SOURCE_MEETING_SELECT = {
  select: { id: true, title: true, startedAt: true, createdAt: true },
} as const;

type MeetingRow = { id: string; title: string | null; startedAt: Date | null; createdAt: Date };

function serializeSourceMeeting(meeting: MeetingRow | null | undefined): SourceMeeting {
  if (!meeting) return null;
  return {
    id: meeting.id,
    title: meeting.title,
    date: (meeting.startedAt ?? meeting.createdAt).toISOString(),
  };
}

/** Resolve one merge's source meeting for the response the merge itself returns. */
async function loadSourceMeeting(meetingId: string | null): Promise<SourceMeeting> {
  if (!meetingId) return null;
  const meeting = await prisma.meeting.findUnique({ where: { id: meetingId }, ...SOURCE_MEETING_SELECT });
  return serializeSourceMeeting(meeting);
}

/**
 * The "meeting · date" chip under every claim in the document.
 *
 * Looked up in one query for the whole page rather than joined per row: a
 * version carries a few hundred claims drawn from a handful of calls, so the
 * join would fetch the same three meetings three hundred times.
 */
async function meetingChips(claims: BriefClaim[]): Promise<Map<string, NonNullable<SourceMeeting>>> {
  const ids = [...new Set(claims.map((c) => c.meetingId))];
  if (ids.length === 0) return new Map();

  const meetings = await prisma.meeting.findMany({ where: { id: { in: ids } }, ...SOURCE_MEETING_SELECT });
  return new Map(meetings.map((m) => [m.id, serializeSourceMeeting(m)!]));
}

async function renderVersion(version: {
  version: number;
  createdAt: Date;
  createdBy: string;
  note: string | null;
  claims: BriefClaim[];
  sourceMeeting: MeetingRow | null;
}) {
  const chips = await meetingChips(version.claims);
  return {
    version: version.version,
    created_at: version.createdAt.toISOString(),
    created_by: version.createdBy,
    note: version.note,
    source_meeting: serializeSourceMeeting(version.sourceMeeting),
    total: version.claims.length,
    claims_by_type: groupByType(version.claims).map((group) => ({
      type: group.type,
      label: CLAIM_TYPE_LABEL[group.type],
      claims: group.claims.map((c) => serializeBriefClaim(c, chips)),
    })),
  };
}

function serializeBriefClaim(c: BriefClaim, chips: Map<string, NonNullable<SourceMeeting>>) {
  const source = chips.get(c.meetingId);
  return {
    claim_id: c.claimId,
    type: c.type,
    type_label: CLAIM_TYPE_LABEL[c.type],
    text: c.text,
    confidence: c.confidence,
    introduced_in_version: c.introducedInVersion,
    meeting_id: c.meetingId,
    // The chip the document renders: which call said this, and when.
    source: source
      ? { meeting_id: source.id, meeting_title: source.title, meeting_date: source.date }
      : null,
    evidence: {
      verbatim_quote: c.verbatimQuote,
      speaker: c.speaker,
      timestamp_ms: c.timestampMs,
      timestamp_label: formatTimestamp(c.timestampMs),
      redacted: c.evidenceRedacted,
    },
  };
}

function versionParam(params: unknown, key: string): number {
  const raw = (params as Record<string, string>)[key];
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isInteger(n) || n < 0) throw ApiError.badRequest(`"${raw}" is not a version number`);
  return n;
}
