import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireActor } from "../authz.js";
import { ApiError } from "../http.js";
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MAX_QUERY_LENGTH,
  SEARCH_KINDS,
  search,
  type SearchHit,
  type SearchKind,
} from "../domain/search.js";
import { formatTimestamp } from "../domain/transcript.js";

const querySchema = z.object({
  q: z.string().max(MAX_QUERY_LENGTH, `Search is capped at ${MAX_QUERY_LENGTH} characters`).default(""),
  kind: z.string().optional(),
  meeting_id: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
});

export async function searchRoutes(app: FastifyInstance): Promise<void> {
  /**
   * One search box across everything a workspace has said.
   *
   * `requireActor` rather than `requireCtx`: the tenant has to come off the
   * actor here, because the queries in domain/search.ts are raw SQL and the
   * AsyncLocalStorage store the Prisma extension reads is invisible to them.
   * The actor is also what decides which meetings are visible, so a request
   * without one has no answer to give — not even an empty one.
   */
  app.get("/search", async (request) => {
    const actor = requireActor(request);
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) throw ApiError.badRequest("Invalid search", parsed.error.flatten().fieldErrors);

    const kinds = parseKinds(parsed.data.kind);
    const query = parsed.data.q.trim();
    const hits = await search({
      actor,
      query,
      kinds,
      meetingId: parsed.data.meeting_id,
      limit: parsed.data.limit,
    });

    return {
      query,
      kinds,
      total: hits.length,
      results: hits.map(serialize),
    };
  });
}

/**
 * Comma-separated rather than a repeated parameter: `?kind=note,transcript` is
 * what people type by hand, and an unknown kind is a 400 rather than a silent
 * empty result, because a typo that returns nothing looks exactly like a
 * workspace that contains nothing.
 */
function parseKinds(raw: string | undefined): SearchKind[] {
  if (!raw) return [...SEARCH_KINDS];

  const wanted = raw
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  const unknown = wanted.filter((k) => !SEARCH_KINDS.includes(k as SearchKind));
  if (unknown.length > 0) {
    throw ApiError.badRequest(`Unknown search kind: ${unknown.join(", ")}`, { allowed: SEARCH_KINDS });
  }
  return wanted.length > 0 ? (wanted as SearchKind[]) : [...SEARCH_KINDS];
}

/**
 * Provenance travels with the hit, for the same reason it travels with a review
 * card: a result you cannot jump to is a result you have to go and find again.
 * `location` is everything the playback view needs to open the recording at the
 * right second — segment, offset and who was speaking.
 */
function serialize(hit: SearchHit) {
  return {
    kind: hit.kind,
    id: hit.id,
    snippet: hit.snippet,
    score: Number(hit.rank.toFixed(6)),
    meeting: {
      id: hit.meetingId,
      title: hit.meetingTitle,
      occurred_at: hit.occurredAt?.toISOString() ?? null,
    },
    location: {
      segment_id: hit.segmentId,
      start_ms: hit.startMs,
      end_ms: hit.endMs,
      speaker: hit.speaker,
      timestamp_label: hit.startMs === null ? null : formatTimestamp(hit.startMs),
    },
    evidence_redacted: hit.evidenceRedacted,
  };
}
