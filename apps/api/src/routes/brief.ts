import type { FastifyInstance } from "fastify";
import type { BriefClaim } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db.js";
import { ApiError, requireCtx } from "../http.js";
import { diffVersions, groupByType, mergeApprovedClaims, NothingToMergeError } from "../domain/brief.js";
import { CLAIM_TYPE_LABEL } from "../domain/claims.js";
import { formatTimestamp } from "../domain/transcript.js";

const mergeSchema = z.object({ note: z.string().trim().max(500).optional() }).default({});

export async function briefRoutes(app: FastifyInstance): Promise<void> {
  /** The merge. Approved claims become a new, immutable version of the brief. */
  app.post("/brief/versions", async (request, reply) => {
    const ctx = requireCtx(request);
    const parsed = mergeSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw ApiError.badRequest("Invalid body", parsed.error.flatten());

    try {
      const result = await mergeApprovedClaims({
        tenantId: ctx.tenantId,
        reviewer: ctx.reviewer,
        note: parsed.data.note ?? null,
      });
      return reply.status(201).send({ version: result });
    } catch (error) {
      if (error instanceof NothingToMergeError) throw ApiError.conflict(error.message);
      throw error;
    }
  });

  app.get("/brief/versions", async (request) => {
    requireCtx(request);
    const versions = await prisma.briefVersion.findMany({ orderBy: { version: "desc" } });
    return {
      versions: versions.map((v) => ({
        version: v.version,
        created_at: v.createdAt.toISOString(),
        created_by: v.createdBy,
        note: v.note,
        added: v.addedCount,
        removed: v.removedCount,
        edited: v.editedCount,
        total: v.totalCount,
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
      include: { claims: true },
    });
    if (!current) {
      return { version: null, claims_by_type: [], total: 0 };
    }
    return renderVersion(current.version, current.createdAt, current.createdBy, current.note, current.claims);
  });

  app.get("/brief/versions/:n", async (request) => {
    requireCtx(request);
    const n = versionParam(request.params, "n");
    const version = await prisma.briefVersion.findFirst({
      where: { version: n },
      include: { claims: true },
    });
    if (!version) throw ApiError.notFound(`Brief version ${n} not found`);
    return renderVersion(version.version, version.createdAt, version.createdBy, version.note, version.claims);
  });

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
    return {
      from: n,
      to: m,
      added: diff.added.map(serializeBriefClaim),
      removed: diff.removed.map(serializeBriefClaim),
      edited: diff.edited.map((e) => ({
        claim_id: e.after.claimId,
        type: e.after.type,
        type_label: CLAIM_TYPE_LABEL[e.after.type],
        before: e.before.text,
        after: e.after.text,
      })),
      unchanged: diff.unchanged,
    };
  });
}

function renderVersion(
  version: number,
  createdAt: Date,
  createdBy: string,
  note: string | null,
  claims: BriefClaim[],
) {
  return {
    version,
    created_at: createdAt.toISOString(),
    created_by: createdBy,
    note,
    total: claims.length,
    claims_by_type: groupByType(claims).map((group) => ({
      type: group.type,
      label: CLAIM_TYPE_LABEL[group.type],
      claims: group.claims.map(serializeBriefClaim),
    })),
  };
}

function serializeBriefClaim(c: BriefClaim) {
  return {
    claim_id: c.claimId,
    type: c.type,
    type_label: CLAIM_TYPE_LABEL[c.type],
    text: c.text,
    confidence: c.confidence,
    introduced_in_version: c.introducedInVersion,
    meeting_id: c.meetingId,
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
