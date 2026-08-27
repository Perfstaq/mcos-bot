import { ClaimType, ContentArchetype, ContentBrief, ContentChannel, Prisma } from "@prisma/client";
import { prisma } from "../../db.js";
import { ApiError } from "../../http.js";
import { env } from "../../env.js";
import {
  ARCHETYPE_EXPECTED_METRIC,
  Framework,
  FrameworkScore,
  scoreFrameworks,
} from "./frameworks.js";
import {
  BriefGenerationRefusal,
  BriefGenerationRequestItem,
  CandidateClaimForGeneration,
  ContentBriefRefused,
  MalformedBriefGenerationError,
  generateBriefsFromModel,
} from "../../integrations/content-brief-model.js";

/**
 * Generation orchestration: approved memory in, ContentBrief rows out.
 *
 * 05_BRIEF_INTEGRATION.md §2: "Reads approved claims only from the current
 * brief version. No raw transcripts, no internet." — the only read here is
 * `prisma.briefVersion` with its `claims` (BriefClaim rows, already frozen at
 * merge time; see domain/brief.ts). Framework AND archetype-feasibility are
 * decided deterministically by scoring claim-type signals
 * (domain/studio/frameworks.ts) before the model is ever called — "framework
 * selection is the engine's job" (05 §2) means a scoring function, not an LLM
 * guess, and it lets an archetype with zero supporting claim signal be
 * refused for a reason the code can name, without spending a model call on
 * it.
 *
 * Citation or refusal (00_MASTER §4.3): a brief the model produced with no
 * citations left after filtering against the real candidate pool is dropped
 * and counted as a refusal, never persisted. Rows created here are never
 * given an explicit `status:` — they land at the schema default (`proposed`),
 * the same posture as `jobs/extract.ts`'s claim creation. Nothing here writes
 * a status transition; only `domain/content-gate.ts` may do that.
 */

export type GenerateContentBriefsArgs = {
  tenantId: string;
  /** Omit to use the tenant's current (highest-numbered) brief version — the
   *  primary UI flow ("generate from the current brief"). `GET /brief/versions`
   *  and `GET /brief/current` (routes/brief.ts, off-limits to this agent) only
   *  ever expose the integer `version`, never the row's uuid `id`, so an
   *  explicit `brief_version_id` is an escape hatch for a caller that already
   *  has one (e.g. a stored ContentBrief), not the expected common case. */
  briefVersionId?: string;
  channel: ContentChannel;
  count: number;
};

export type GenerateContentBriefsResult = {
  briefVersion: number;
  briefs: ContentBrief[];
  refusals: BriefGenerationRefusal[];
};

type ArchetypeCandidate = {
  archetype: ContentArchetype;
  best: FrameworkScore;
};

/** The highest-scoring framework AMONG THOSE that actually name this
 *  archetype — `scoreFrameworks`'s `scored` array is already sorted
 *  descending across every framework, so filtering it to the ones that list
 *  this archetype preserves that order; the first entry is both the best fit
 *  for the archetype and (via its `matchedClaimTypes`) the feasibility
 *  signal. Every archetype owns at least one framework (content-frameworks
 *  test), so this is never empty. */
function bestFrameworkForArchetype(claimTypes: ClaimType[], archetype: ContentArchetype): FrameworkScore {
  const { scored } = scoreFrameworks({ claimTypes, archetype });
  const relevant = scored.filter((s) => s.framework.archetypes.includes(archetype));
  return relevant[0]!;
}

/**
 * Rough v1 brand/activation router (05 §1: "95/5 + 60/40 routing"). Neither
 * ratio is specified anywhere reachable by this agent — 95/5 and 60/40 are
 * two different, mutually inconsistent numbers named in the same sentence,
 * and no upstream signal decides the split per-brief. Rather than invent a
 * marketing-strategy position inside an architecture doc, `1` (every Nth
 * brief) is hoisted into its own const, named and commented as UNSPECIFIED,
 * so changing it later is a one-line edit and nobody mistakes today's ~20%
 * for a considered ratio. Product should replace this value, not this
 * function's shape.
 */
const CONTENT_MIX_EVERY_NTH_IS_ACTIVATION = 5; // UNSPECIFIED — placeholder pending product input (05 §1's "95/5 + 60/40" is two numbers, not one)

function contentMixSlotFor(existingCount: number): "brand" | "activation" {
  return existingCount % CONTENT_MIX_EVERY_NTH_IS_ACTIVATION === CONTENT_MIX_EVERY_NTH_IS_ACTIVATION - 1
    ? "activation"
    : "brand";
}

export async function generateContentBriefs(args: GenerateContentBriefsArgs): Promise<GenerateContentBriefsResult> {
  if (args.count < 1) throw ApiError.badRequest("count must be at least 1");

  const version = args.briefVersionId
    ? await prisma.briefVersion.findUnique({ where: { id: args.briefVersionId }, include: { claims: true } })
    : await prisma.briefVersion.findFirst({ orderBy: { version: "desc" }, include: { claims: true } });
  if (!version) {
    throw ApiError.notFound(
      args.briefVersionId ? `Brief version ${args.briefVersionId} not found` : "No brief version exists yet",
    );
  }

  const allArchetypes = Object.values(ContentArchetype);

  if (version.claims.length === 0) {
    return {
      briefVersion: version.version,
      briefs: [],
      refusals: allArchetypes.map((archetype) => ({
        archetype,
        reason: `Brief version ${version.version} has no approved claims to cite.`,
      })),
    };
  }

  const claimTypesAvailable = version.claims.map((c) => c.type);

  const candidates: ArchetypeCandidate[] = allArchetypes.map((archetype) => ({
    archetype,
    best: bestFrameworkForArchetype(claimTypesAvailable, archetype),
  }));
  candidates.sort((a, b) => b.best.score - a.best.score);

  const chosen: ArchetypeCandidate[] = [];
  const preRefusals: BriefGenerationRefusal[] = [];
  for (const candidate of candidates) {
    if (chosen.length >= args.count) break;
    if (candidate.best.matchedClaimTypes.length > 0) {
      chosen.push(candidate);
    } else {
      preRefusals.push({
        archetype: candidate.archetype,
        reason:
          `No approved claim in brief version ${version.version} matches ${candidate.archetype} — ` +
          `needs one of: ${candidate.best.framework.favoredClaimTypes.join(", ") || "(no signal defined)"}.`,
      });
    }
  }

  if (chosen.length === 0) {
    return { briefVersion: version.version, briefs: [], refusals: preRefusals };
  }

  const claimsByType = new Map<ClaimType, typeof version.claims>();
  for (const claim of version.claims) {
    const list = claimsByType.get(claim.type);
    if (list) list.push(claim);
    else claimsByType.set(claim.type, [claim]);
  }

  const MAX_CANDIDATES_PER_ARCHETYPE = 10;
  const requests: BriefGenerationRequestItem[] = chosen.map((c) => {
    const pool = c.best.matchedClaimTypes.flatMap((t) => claimsByType.get(t) ?? []);
    const candidates: CandidateClaimForGeneration[] = [...pool]
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, MAX_CANDIDATES_PER_ARCHETYPE)
      .map((claim) => ({ id: claim.claimId, type: claim.type, text: claim.text }));
    return { archetype: c.archetype, frameworkWhenToUse: c.best.framework.whenToUse, candidates };
  });

  let generation;
  try {
    generation = await generateBriefsFromModel({
      requests,
      model: env.CONTENT_BRIEF_MODEL,
      fallbackModel: env.CONTENT_BRIEF_FALLBACK,
    });
  } catch (error) {
    if (error instanceof ContentBriefRefused || error instanceof MalformedBriefGenerationError) {
      throw ApiError.unprocessable(`Content brief generation failed: ${error.message}`);
    }
    throw error;
  }

  const requestByArchetype = new Map(requests.map((r) => [r.archetype, r]));
  const frameworkByArchetype = new Map(chosen.map((c) => [c.archetype, c.best.framework]));

  const modelRefusals: BriefGenerationRefusal[] = [...generation.refusals];
  const toCreate: Array<{ archetype: ContentArchetype; framework: Framework; brief: (typeof generation.briefs)[number] }> = [];

  for (const brief of generation.briefs) {
    const request = requestByArchetype.get(brief.archetype);
    const framework = frameworkByArchetype.get(brief.archetype);
    if (!request || !framework) continue; // model echoed an archetype we never asked for

    const validIds = new Set(request.candidates.map((c) => c.id));
    const filteredClaimIds = brief.claimIds.filter((id) => validIds.has(id));

    if (filteredClaimIds.length === 0) {
      modelRefusals.push({
        archetype: brief.archetype,
        reason: "Model cited no claim id from the candidates it was given for this archetype.",
      });
      continue;
    }

    toCreate.push({ archetype: brief.archetype, framework, brief: { ...brief, claimIds: filteredClaimIds } });
  }

  let mixCounter = await prisma.contentBrief.count({ where: { tenantId: args.tenantId } });

  const created: ContentBrief[] = [];
  for (const item of toCreate) {
    const claimById = new Map(version.claims.map((c) => [c.claimId, c]));
    const claimSnapshots = item.brief.claimIds.map((id) => {
      const claim = claimById.get(id)!;
      return {
        claim_id: claim.claimId,
        type: claim.type,
        text: claim.text,
        verbatim_quote: claim.verbatimQuote,
        speaker: claim.speaker,
        timestamp_ms: claim.timestampMs,
      };
    });

    const beats = item.brief.beats.map((b) => ({
      role: b.role,
      script: b.script,
      target_ms: b.targetMs,
      fills_from: b.fillsFrom,
    }));

    // No `status:` here — the row lands at the schema default (`proposed`).
    // Only domain/content-gate.ts may write a status transition onto a
    // content_brief (tests/content-gate.test.ts enforces this statically).
    const row = await prisma.contentBrief.create({
      data: {
        tenantId: args.tenantId,
        briefVersionId: version.id,
        claimIds: item.brief.claimIds,
        claimSnapshots: claimSnapshots as unknown as Prisma.InputJsonValue,
        frameworkId: item.framework.id,
        frameworkEvidenceTier: item.framework.evidenceTier,
        archetype: item.archetype,
        hookText: item.brief.hookText,
        emphasisWord: item.brief.emphasisWord,
        beats: beats as unknown as Prisma.InputJsonValue,
        channel: args.channel,
        contentMixSlot: contentMixSlotFor(mixCounter),
        expectedMetric: ARCHETYPE_EXPECTED_METRIC[item.archetype],
        // The model that actually answered — the primary, or the fallback if
        // the primary's output was malformed and the retry used it instead
        // (06 §1: "never mix models within one brief"; generation.model is
        // recorded per-call, not assumed from the env default).
        generatedByModel: generation.model,
      },
    });
    mixCounter += 1;
    created.push(row);
  }

  return {
    briefVersion: version.version,
    briefs: created,
    refusals: [...preRefusals, ...modelRefusals],
  };
}
