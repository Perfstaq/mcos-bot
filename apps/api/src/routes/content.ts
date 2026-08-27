import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { ContentBriefStatus, ContentChannel, MediaAssetKind } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db.js";
import { ApiError, requireCtx } from "../http.js";
import {
  recordContentBriefDecision,
  requireApprovedContentBrief,
  type ContentGateAction,
} from "../domain/content-gate.js";
import { generateContentBriefs } from "../domain/studio/generate-content-brief.js";
import { frameworkById } from "../domain/studio/frameworks.js";
import { HOOK_TEXT_MAX } from "../integrations/content-brief-model.js";
import { planBuildQueue, renderSubmitQueue } from "../queue.js";

/**
 * The 05_BRIEF_INTEGRATION.md §4 surface, mounted under `/api/v1/content`
 * (server.ts already prefixes every route file with `/api/v1`; no existing
 * route touches `/content`).
 *
 * Every write to a content_brief's status is a thin shell around
 * `domain/content-gate.ts`, the same discipline `routes/review.ts` follows
 * for `domain/review-gate.ts` — keeping the routes dumb is what makes the
 * gate's exclusivity checkable (tests/content-gate.test.ts).
 */
export async function contentRoutes(app: FastifyInstance): Promise<void> {
  const generateSchema = z.object({
    // Optional: omitted means "the tenant's current brief version" — see
    // GenerateContentBriefsArgs's doc comment for why this is the expected
    // common case, not id-required.
    brief_version_id: z.string().uuid().optional(),
    channel: z.nativeEnum(ContentChannel),
    count: z.coerce.number().int().min(1).max(10),
  });

  app.post("/content/briefs", async (request) => {
    const ctx = requireCtx(request);
    const parsed = generateSchema.safeParse(request.body);
    if (!parsed.success) throw ApiError.badRequest("Invalid body", parsed.error.flatten());

    const result = await generateContentBriefs({
      tenantId: ctx.tenantId,
      briefVersionId: parsed.data.brief_version_id,
      channel: parsed.data.channel,
      count: parsed.data.count,
    });

    return {
      brief_version: result.briefVersion,
      briefs: result.briefs.map(serializeContentBrief),
      refusals: result.refusals,
      generated_count: result.briefs.length,
      refused_count: result.refusals.length,
    };
  });

  const queueSchema = z.object({
    status: z.nativeEnum(ContentBriefStatus).default(ContentBriefStatus.proposed),
    channel: z.nativeEnum(ContentChannel).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  });

  /** The content-brief queue, parallel to GET /review-queue (ARCHITECTURE.md
   *  §11.3: a parallel section reusing components, not a card-type drop-in —
   *  this is that section's own response shape, not review-queue's). */
  app.get("/content/briefs", async (request) => {
    requireCtx(request);
    const parsed = queueSchema.safeParse(request.query);
    if (!parsed.success) throw ApiError.badRequest("Invalid query", parsed.error.flatten());
    const { status, channel, limit } = parsed.data;

    const briefs = await prisma.contentBrief.findMany({
      where: { status, ...(channel ? { channel } : {}) },
      orderBy: [{ createdAt: "desc" }],
      take: limit,
    });

    return { briefs: briefs.map(serializeContentBrief), total: briefs.length };
  });

  const noteSchema = z.object({ note: z.string().trim().max(1000).optional() }).default({});
  const editSchema = z.object({
    // Same one-line banner cap generation enforces (HOOK_TEXT_MAX's doc
    // comment) — an edit must not be able to reintroduce the G9 violation
    // the coercion layer exists to keep out.
    hook_text: z.string().trim().min(3).max(HOOK_TEXT_MAX).optional(),
    emphasis_word: z.string().trim().min(1).max(80).optional(),
    beats: z.array(z.record(z.unknown())).optional(),
    framework_id: z.string().optional(),
    note: z.string().trim().max(1000).optional(),
  });

  async function decide(request: Parameters<typeof requireCtx>[0], id: string, action: ContentGateAction) {
    const ctx = requireCtx(request);
    const parsed = noteSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw ApiError.badRequest("Invalid body", parsed.error.flatten());
    return recordContentBriefDecision({ contentBriefId: id, reviewer: ctx.reviewer, action, note: parsed.data.note });
  }

  app.post("/content/briefs/:id/approve", async (request) => {
    const { id } = request.params as { id: string };
    return decide(request, id, "approve");
  });

  app.post("/content/briefs/:id/reject", async (request) => {
    const { id } = request.params as { id: string };
    return decide(request, id, "reject");
  });

  /** Undo — not in 05 §4's list explicitly, but ADR-6 / ARCHITECTURE.md §11.3
   *  require the same keyboard discipline as the review gate ("a/e/r + u"),
   *  which needs an endpoint to call. */
  app.post("/content/briefs/:id/undo", async (request) => {
    const { id } = request.params as { id: string };
    return decide(request, id, "undo");
  });

  /** Edit-then-approve — one action, one PATCH, same as PATCH /claims/:id. */
  app.patch("/content/briefs/:id", async (request) => {
    const ctx = requireCtx(request);
    const { id } = request.params as { id: string };
    const parsed = editSchema.safeParse(request.body);
    if (!parsed.success) throw ApiError.badRequest("Invalid edit", parsed.error.flatten());
    const { hook_text, emphasis_word, beats, framework_id, note } = parsed.data;

    if (framework_id && !frameworkById(framework_id)) {
      throw ApiError.unprocessable(`Unknown framework_id "${framework_id}"`);
    }

    return recordContentBriefDecision({
      contentBriefId: id,
      reviewer: ctx.reviewer,
      action: "edit_approve",
      note,
      edits: { hookText: hook_text, emphasisWord: emphasis_word, beats, frameworkId: framework_id },
    });
  });

  const planSchema = z.object({
    content_brief_id: z.string().uuid(),
    template_id: z.string().uuid(),
    footage_asset_id: z.string().uuid(),
  });

  /**
   * "Only `status='approved'` briefs can enter `plan.build` — enforce at the
   * service layer" (05 §3 / ARCHITECTURE.md §6, ADR-6). The enforcement call
   * (`requireApprovedContentBrief`) lives in `domain/content-gate.ts`, not
   * here — this route is the thin shell that calls it, same posture as every
   * other route in this file.
   *
   * `RenderPlan` is append-only (G13) and its `plan` column has no default,
   * so it cannot be created empty and filled in later — the actual
   * beat-snapped plan is computed by whichever job processor consumes
   * `plan.build` (domain/studio's plan builder, motion primitives, footage
   * selection — all explicitly out of this agent's scope; see the PR body).
   * This route validates, enforces approved-only, and enqueues; it returns a
   * queued handle with the pre-allocated plan id, not a materialized
   * RenderPlan — a deviation from 05 §4's literal "→ RenderPlan" return type,
   * forced by the append-only constraint.
   */
  app.post("/content/plans", async (request) => {
    const ctx = requireCtx(request);
    const parsed = planSchema.safeParse(request.body);
    if (!parsed.success) throw ApiError.badRequest("Invalid body", parsed.error.flatten());
    const { content_brief_id, template_id, footage_asset_id } = parsed.data;

    await requireApprovedContentBrief(content_brief_id);

    const template = await prisma.motionTemplate.findUnique({ where: { id: template_id } });
    if (!template || !template.active) throw ApiError.notFound(`Template ${template_id} not found`);

    const footage = await prisma.mediaAsset.findUnique({ where: { id: footage_asset_id } });
    if (!footage || footage.kind !== MediaAssetKind.footage) {
      throw ApiError.notFound(`Footage asset ${footage_asset_id} not found`);
    }

    const planId = crypto.randomUUID();
    await planBuildQueue.add("build", {
      tenantId: ctx.tenantId,
      planId,
      contentBriefId: content_brief_id,
      templateId: template_id,
      footageAssetId: footage_asset_id,
    });

    return {
      id: planId,
      status: "queued",
      content_brief_id,
      template_id,
      footage_asset_id,
    };
  });

  const renderSchema = z.object({ plan_id: z.string().uuid() });

  app.post("/content/renders", async (request) => {
    const ctx = requireCtx(request);
    const parsed = renderSchema.safeParse(request.body);
    if (!parsed.success) throw ApiError.badRequest("Invalid body", parsed.error.flatten());

    const plan = await prisma.renderPlan.findUnique({ where: { id: parsed.data.plan_id } });
    if (!plan) throw ApiError.notFound(`Render plan ${parsed.data.plan_id} not found`);

    const render = await prisma.render.create({ data: { tenantId: ctx.tenantId, planId: plan.id } });
    await renderSubmitQueue.add("submit", { tenantId: ctx.tenantId, renderId: render.id });

    return serializeRender(render);
  });

  app.get("/content/renders/:id", async (request) => {
    requireCtx(request);
    const { id } = request.params as { id: string };
    const render = await prisma.render.findUnique({ where: { id } });
    if (!render) throw ApiError.notFound(`Render ${id} not found`);
    return serializeRender(render);
  });
}

type ContentBriefRow = Awaited<ReturnType<typeof prisma.contentBrief.findFirst>>;

/**
 * The WHY line, structurally: `claim_ids` + framework + `expected_metric`,
 * with source chips built from the frozen claim snapshots — exactly like
 * claim cards' evidence chips (05 §3 / ARCHITECTURE.md §11.3).
 */
function serializeContentBrief(brief: NonNullable<ContentBriefRow>) {
  const framework = frameworkById(brief.frameworkId);
  return {
    id: brief.id,
    status: brief.status,
    brief_version_id: brief.briefVersionId,
    archetype: brief.archetype,
    channel: brief.channel,
    content_mix_slot: brief.contentMixSlot,
    hook_text: brief.hookText,
    emphasis_word: brief.emphasisWord,
    beats: brief.beats,
    claim_ids: brief.claimIds,
    claim_snapshots: brief.claimSnapshots,
    framework: {
      id: brief.frameworkId,
      name: framework?.name ?? brief.frameworkId,
      evidence_tier: brief.frameworkEvidenceTier,
      when_to_use: framework?.whenToUse ?? null,
    },
    expected_metric: brief.expectedMetric,
    edited_from: brief.editedFromId,
    generated_by_model: brief.generatedByModel,
    generation_note: brief.generationNote,
    created_at: brief.createdAt.toISOString(),
    decided_at: brief.decidedAt?.toISOString() ?? null,
  };
}

type RenderRow = Awaited<ReturnType<typeof prisma.render.findFirstOrThrow>>;

function serializeRender(render: RenderRow) {
  return {
    id: render.id,
    status: render.status,
    plan_id: render.planId,
    r2_key: render.r2Key,
    duration_ms: render.durationMs,
    qc: render.qc,
    qc_passed: render.qcPassed,
    error: render.error,
    failed_stage: render.failedStage,
    created_at: render.createdAt.toISOString(),
    finished_at: render.finishedAt?.toISOString() ?? null,
  };
}
