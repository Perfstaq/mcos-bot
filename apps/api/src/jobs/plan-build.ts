import crypto from "node:crypto";
import { MediaAnalysisStatus, Prisma } from "@prisma/client";
import type { RenderPlan } from "@mcos/render/plan";
import { prisma } from "../db.js";
import { requireApprovedContentBrief } from "../domain/content-gate.js";
import {
  buildApprovedRenderPlan,
  PlanInfeasibleError,
  resolveRenderTemplateId,
  type PlanBuilderWord,
} from "../domain/studio/plan-builder.js";
import { assertValidBeatGrid, assertValidWordsResult } from "../domain/studio/media-analysis-schema.js";
import { logger } from "../logger.js";
import type { PlanBuildJob } from "../queue.js";
import { withTenantContext } from "./context.js";

const log = logger.child({ job: "plan-build" });

/**
 * The `plan.build` job — the missing middle of the milestone (ARCHITECTURE
 * §12.12).
 *
 *   ContentBrief (approved via the gate) → **plan.build** → RenderPlan
 *   → render.submit → MP4 → render.qc
 *
 * Agent P created the queue and registered no processor; Agent M built the
 * planner as a pure library; Agent B built the route that enqueues and
 * correctly refused to fake a `RenderPlan` (append-only, `plan: Json` has no
 * default, so it cannot be created empty and filled in later). Three correct
 * boundaries left a hole where they met. This is that hole.
 *
 * The computation lives in `domain/studio/plan-builder.ts` — pure, DB-free,
 * and the owner of §12.13's grid ruling and ADR-8's G1a evaluation. This file
 * is the I/O and, more importantly, the TRANSACTION: see `materialize` below
 * for §12.12a.
 */
export async function runPlanBuild(job: PlanBuildJob): Promise<void> {
  await withTenantContext(job.tenantId, async () => {
    // 03 §3: "Idempotency: dedupe on (plan_id)". `planId` is pre-allocated by
    // the route, and `RenderPlan` is append-only — a second attempt cannot
    // rewrite the row, so the only correct behaviour on a retry that already
    // succeeded is to stop. Checking first also keeps a BullMQ retry after a
    // post-commit crash from failing loudly on a primary-key collision.
    const existing = await prisma.renderPlan.findUnique({ where: { id: job.planId } });
    if (existing) {
      log.info({ planId: job.planId }, "render plan already materialized — nothing to do");
      return;
    }

    const brief = await prisma.contentBrief.findUnique({ where: { id: job.contentBriefId } });
    if (!brief) throw new Error(`Unknown content brief ${job.contentBriefId}`);

    const templateRow = await prisma.motionTemplate.findUnique({ where: { id: job.templateId } });
    if (!templateRow) throw new Error(`Unknown motion template ${job.templateId}`);
    if (!templateRow.active) {
      throw new PlanInfeasibleError(
        "unknown_template",
        `motion template ${templateRow.name} is inactive and may not back a new plan.`,
        { templateId: job.templateId, name: templateRow.name },
      );
    }
    const renderTemplateId = resolveRenderTemplateId(templateRow);

    const footage = await prisma.mediaAsset.findUnique({
      where: { id: job.footageAssetId },
      include: { analysis: true },
    });
    if (!footage) throw new Error(`Unknown footage asset ${job.footageAssetId}`);

    const analysis = footage.analysis;
    if (!analysis || analysis.status !== MediaAnalysisStatus.succeeded) {
      throw new PlanInfeasibleError(
        "analysis_missing",
        `footage asset ${footage.id} has no succeeded MediaAnalysis (${analysis?.status ?? "none"}` +
          `${analysis?.error ? `: ${analysis.error}` : ""}). media.analyze must run before a plan can be built — ` +
          "the planner's legal cut points are word edges and its grid is the analyzer's beat track.",
        { assetId: footage.id, analysisStatus: analysis?.status ?? null },
      );
    }
    if (analysis.words === null || analysis.beats === null) {
      throw new PlanInfeasibleError(
        "analysis_incomplete",
        `footage asset ${footage.id}'s MediaAnalysis succeeded but is missing ` +
          `${analysis.words === null ? "words" : "beats"} — plan.build needs both.`,
        { assetId: footage.id },
      );
    }

    // Loud loaders, same discipline as media-analyze.ts: a malformed jsonb
    // payload becomes a named error here rather than an undefined deep inside
    // the DP.
    const words = assertValidWordsResult(analysis.words, `MediaAnalysis ${analysis.id} words`);
    const beats = assertValidBeatGrid(analysis.beats, `MediaAnalysis ${analysis.id} beats`);

    const flatWords: PlanBuilderWord[] = words.segments.flatMap((s) =>
      s.words.map((w) => ({ word: w.word, start: w.start, end: w.end, rms: w.rms ?? null })),
    );

    // ffprobe's container duration when we have it, the decoded duration
    // otherwise: faster-whisper reports what it DECODED, which trails the
    // container whenever the tail is silent (VAD drops it), and a plan that
    // stops short renders its last shot short.
    const durationSec = footage.durationMs != null ? footage.durationMs / 1000 : words.durationSec;

    const built = buildApprovedRenderPlan({
      templateId: renderTemplateId,
      words: flatWords,
      durationSec,
      beats,
      seed: planSeed(job),
      hookText: brief.hookText,
      emphasisWord: brief.emphasisWord,
      claimTexts: frozenClaimTexts(brief.claimSnapshots),
      handleText: handleTextFor(job.tenantId),
      footage: { assetId: footage.id, r2Key: footage.r2Key },
      // v1 is continuous playthrough (§12.13 row 1: source time IS output
      // time). The selection stage of 03 §6 does not exist, and under the
      // ruling it cannot exist without a music bed.
      removesFootage: false,
    });

    await materialize(job, built.plan);

    const measured = built.g1a.measured as { ratio?: number; withinCount?: number; totalCuts?: number };
    log.info(
      {
        planId: job.planId,
        contentBriefId: job.contentBriefId,
        template: renderTemplateId,
        cuts: built.plan.cuts.length - 1,
        g1aRatio: measured.ratio,
        g1aLocked: `${measured.withinCount}/${measured.totalCuts}`,
        lockPct: built.planner.lockPct,
        tempoBpm: built.plan.beatGrid.tempoBpm,
      },
      "render plan built and G1a passed",
    );
  });
}

/**
 * ARCHITECTURE §12.12a — **the approval is re-checked at materialization, in
 * the same transaction as the `RenderPlan` create.**
 *
 * The hole the addendum names: `requireApprovedContentBrief` runs at ENQUEUE
 * (`routes/content.ts`), and undo's safety guard counts MATERIALIZED plans
 * (`content-gate.ts`) — so a queued-but-unbuilt plan is invisible to it, and
 * `approve → POST /content/plans → undo → job runs` would build a plan from a
 * brief that is no longer approved. That is an invariant-1 violation however
 * it happened, so enqueue-time validation is kept as a fast rejection and is
 * explicitly NOT the guarantee.
 *
 * **What actually makes it atomic, and why writing the call inside the
 * callback is not enough.** `requireApprovedContentBrief` reads through the
 * module-level `prisma` client, so calling it inside `$transaction` runs it on
 * a DIFFERENT connection — lexical position buys nothing on its own. The
 * `SELECT … FOR UPDATE` below is the mechanism:
 *
 *   - an undo that committed first ⇒ the locked read sees `proposed`, the
 *     helper throws, and no plan is written;
 *   - an undo that has not committed ⇒ its `contentBrief.update` blocks on this
 *     row lock until this transaction commits, so the brief IS approved at the
 *     instant of the insert.
 *
 * Either way the check and the write cannot be separated by a concurrent undo,
 * which is the property §12.12a asks for. The general lesson it states is
 * worth repeating here, where it is being applied: *a permission checked when
 * work is queued is not a permission held when work runs.*
 *
 * (The residual, which belongs to `content-gate.ts` and is deliberately not
 * fixed from here: undo counts plans BEFORE its own update blocks, so an undo
 * racing this transaction can still succeed *after* the plan commits, leaving
 * an approved-at-write-time plan attached to a re-`proposed` brief. Closing it
 * needs the same lock inside `undo()`, which is the gate module's to take —
 * that file is off-limits to this agent. Reported rather than reached into.)
 */
async function materialize(job: PlanBuildJob, plan: RenderPlan): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // The lock comes FIRST, before the check, or the check races the undo it
    // exists to exclude. Tenant-scoped explicitly: `$queryRaw` bypasses db.ts's
    // client extension, so invariant 5 is this query's own responsibility.
    const locked = await tx.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`SELECT id FROM content_briefs WHERE id = ${job.contentBriefId} AND tenant_id = ${job.tenantId} FOR UPDATE`,
    );
    if (!locked.length) {
      throw new Error(`Content brief ${job.contentBriefId} not found in tenant ${job.tenantId}`);
    }

    await requireApprovedContentBrief(job.contentBriefId);

    await tx.renderPlan.create({
      data: {
        id: job.planId,
        tenantId: job.tenantId,
        contentBriefId: job.contentBriefId,
        templateId: job.templateId,
        footageAssetId: job.footageAssetId,
        plan: plan as unknown as Prisma.InputJsonValue,
        seed: plan.seed,
        planVersion: plan.planVersion,
        createdBy: "job:plan.build",
      },
    });
  });
}

/**
 * The plan's seed, derived from the triple invariant 6 names as a render's
 * identity: `{ContentBrief, template_id, footage_ref, seed}`.
 *
 * Deriving rather than drawing means re-planning the same three inputs
 * reproduces the same plan byte-for-byte, which is a strictly stronger
 * property than the invariant asks for and costs nothing. `Math.random()`
 * would make every re-plan a different reel from identical inputs.
 */
function planSeed(job: PlanBuildJob): number {
  const digest = crypto
    .createHash("sha256")
    .update(`${job.contentBriefId}:${job.templateId}:${job.footageAssetId}`)
    .digest();
  // Positive int32 — `RenderPlan.seed` is an Int column and mulberry32 wants a
  // 32-bit value.
  return digest.readUInt32BE(0) & 0x7fffffff;
}

/**
 * The ContentBrief's FROZEN claim texts (ARCHITECTURE §11.1 R3).
 *
 * The emphasis scorer reads claim text from the snapshot Agent B took at
 * generation time and never reaches into claim tables (05 §1: "neither side
 * knows the other's internals"). Freezing is what stops a later edit to an
 * underlying claim retroactively changing what an already-approved brief
 * emphasises — the plan a human approved must stay the plan that renders.
 */
function frozenClaimTexts(snapshots: Prisma.JsonValue): string[] {
  if (!Array.isArray(snapshots)) return [];
  return snapshots
    .map((s) => (s && typeof s === "object" && !Array.isArray(s) ? (s as Record<string, unknown>)["text"] : null))
    .filter((t): t is string => typeof t === "string" && t.trim().length > 0);
}

/**
 * 02 §2.3's handle / brand bug. There is no per-tenant handle column yet
 * (adding one is a schema change on a model outside this agent's boundary), so
 * the plan carries the product handle rather than inventing a tenant field.
 * Recorded here rather than hidden inline so the follow-up is findable.
 */
function handleTextFor(_tenantId: string): string {
  return "@PERFSTAQ";
}

/**
 * Only a permanent BullMQ failure calls this (see worker.ts), and it never
 * throws itself — a failure to record a failure must not mask the original
 * error. Mirrors `failExtraction` / `failMediaAnalyze`.
 *
 * **Known gap, reported rather than papered over:** 03 §7 requires
 * `plan_infeasible(reason)` to be surfaced in the UI, and there is nowhere
 * durable to put it. `RenderPlan` is append-only and its row is precisely what
 * a failed build does NOT create; `Render.failedStage` already enumerates
 * `"plan"` but no `Render` exists until `POST /content/renders`, which comes
 * after a plan; and there is no plan-status table and no
 * `GET /content/plans/:id`. So the reason is structured into the job's failure
 * (BullMQ retains failed jobs for 7 days) and logged with the plan id, which
 * is honest but is not a UI surface. Closing it needs either a nullable
 * plan-attempt table or a status row the route creates at enqueue — an
 * additive migration, and a decision about which, that this agent flagged
 * rather than made.
 */
export async function failPlanBuild(job: PlanBuildJob, error: Error): Promise<void> {
  const infeasible = error instanceof PlanInfeasibleError ? error : null;
  log.error(
    {
      planId: job.planId,
      contentBriefId: job.contentBriefId,
      footageAssetId: job.footageAssetId,
      failureKind: infeasible ? "plan_infeasible" : "plan_build_error",
      reason: infeasible?.code ?? null,
      measured: infeasible?.measured ?? null,
      err: error.message,
    },
    infeasible ? "plan rejected at plan.build" : "plan.build failed",
  );
}
