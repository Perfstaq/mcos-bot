import { Prisma, RenderAttemptStatus } from "@prisma/client";
import { prisma } from "../../db.js";
import { logger } from "../../logger.js";
import { PlanInfeasibleError } from "./plan-builder.js";

const log = logger.child({ module: "render-attempt" });

/**
 * render-attempt.ts — the ONLY writer of `render_attempts`
 * (ARCHITECTURE.md §12.25, §12.38).
 *
 * `03 §7` requires every failure state in this pipeline to be surfaced and
 * retryable. `plan_infeasible` was neither: a failed plan build wrote nothing
 * anywhere. `RenderPlan` is append-only and a failure is precisely the case
 * that creates no row; `Render.failedStage` enumerates `"plan"` but no Render
 * exists until after a plan; there was no plan-status table and no
 * `GET /content/plans/:id`. The reason lived in a log line and a BullMQ failure
 * payload — honest, and not a surface a user can see.
 *
 * This module is the surface. Every function here is keyed on the **plan id**
 * `POST /content/plans` pre-allocates and returns, which is what turns the
 * handle the route already handed back into something pollable, and what lets
 * a built attempt and its `RenderPlan` share one identity.
 *
 * **Single-writer, on purpose.** Same discipline `domain/content-gate.ts` holds
 * over `ContentBrief.status` and `domain/review-gate.ts` over claims: the
 * route and the job both go through here, so "exactly one attempt row per
 * plan id, and its status is always the truth" is a property of one file
 * rather than an agreement between three call sites.
 *
 * **Why upsert everywhere.** The contract is *exactly one row per plan id*, and
 * `create`/`update` each break it in one direction — `create` on a BullMQ retry
 * collides, `update` on a job whose enqueue-time row never landed silently
 * writes nothing and restores the vanishing failure this table exists to
 * prevent. Upsert is the operation that states the invariant instead of
 * assuming it.
 */

/** What a failure that is NOT a named `plan_infeasible` is recorded as. A user
 *  can act on "footage too short"; they cannot act on "the database went away",
 *  and an operator needs to tell the two apart without reading a stack. */
export const PLAN_BUILD_ERROR_CODE = "plan_build_error";

export type RenderAttemptIdentity = {
  planId: string;
  tenantId: string;
  contentBriefId: string;
  templateId: string;
  footageAssetId: string;
};

/**
 * Open (or re-open) an attempt at `queued`.
 *
 * Called by `POST /content/plans` **before** the job is enqueued, and by the
 * retry route. Before-not-after matters: a job that dies between enqueue and
 * its first line must still leave the user something to read, and ordering it
 * this way makes the worst case "a queued row for a job that never ran" rather
 * than "no row at all" — visibly stuck beats invisibly gone.
 *
 * Re-opening clears the previous failure. A retry that still showed last
 * attempt's reason while claiming to be queued would be two truths on one row.
 */
export async function openRenderAttempt(id: RenderAttemptIdentity): Promise<void> {
  const queued = {
    status: RenderAttemptStatus.queued,
    failureCode: null,
    failureMessage: null,
    failureDetail: Prisma.DbNull,
  };
  await prisma.renderAttempt.upsert({
    where: { id: id.planId },
    create: {
      id: id.planId,
      tenantId: id.tenantId,
      contentBriefId: id.contentBriefId,
      templateId: id.templateId,
      footageAssetId: id.footageAssetId,
      ...queued,
    },
    update: queued,
  });
}

/**
 * The plan materialized. Clears any failure recorded by an earlier attempt at
 * the same id — a BullMQ retry that eventually succeeds must not leave a row
 * that is `built` and still carrying last attempt's reason.
 */
export async function markRenderAttemptBuilt(id: RenderAttemptIdentity): Promise<void> {
  const built = {
    status: RenderAttemptStatus.built,
    failureCode: null,
    failureMessage: null,
    failureDetail: Prisma.DbNull,
  };
  await prisma.renderAttempt.upsert({
    where: { id: id.planId },
    create: {
      id: id.planId,
      tenantId: id.tenantId,
      contentBriefId: id.contentBriefId,
      templateId: id.templateId,
      footageAssetId: id.footageAssetId,
      ...built,
    },
    update: built,
  });
}

/**
 * Record why this build failed.
 *
 * A named `PlanInfeasibleError` becomes `infeasible` and keeps its own code,
 * message and measured numbers — `03 §7` asks for `plan_infeasible(reason)`,
 * and ADR-8's whole posture (reject a plan before it costs a render) is only
 * auditable if the number it was rejected on survives the rejection. Anything
 * else becomes `failed` under `plan_build_error`.
 *
 * **This never throws.** A failure to record a failure must not mask the
 * original error — the same rule `failExtraction` / `failMediaAnalyze` /
 * `failPlanBuild` already follow. The caller rethrows the real error.
 */
export async function recordRenderAttemptFailure(
  id: RenderAttemptIdentity,
  error: Error,
): Promise<void> {
  const infeasible = error instanceof PlanInfeasibleError ? error : null;
  const failure = {
    status: infeasible ? RenderAttemptStatus.infeasible : RenderAttemptStatus.failed,
    failureCode: infeasible ? infeasible.code : PLAN_BUILD_ERROR_CODE,
    failureMessage: infeasible ? infeasible.message : error.message,
    failureDetail:
      infeasible?.measured === undefined
        ? Prisma.DbNull
        : (infeasible.measured as Prisma.InputJsonValue),
  };

  try {
    await prisma.renderAttempt.upsert({
      where: { id: id.planId },
      create: {
        id: id.planId,
        tenantId: id.tenantId,
        contentBriefId: id.contentBriefId,
        templateId: id.templateId,
        footageAssetId: id.footageAssetId,
        ...failure,
      },
      update: failure,
    });
  } catch (writeError) {
    // Swallowed deliberately — see the doc comment. The original error is the
    // one that matters and the caller is about to rethrow it.
    //
    // But NOT silently. This catch is the one place where the whole point of
    // §12.25 can quietly fail: if it fires, a failure has vanished again,
    // which is the exact condition this table exists to make impossible. An
    // empty catch here would be indistinguishable from the bug.
    log.error(
      {
        planId: id.planId,
        tenantId: id.tenantId,
        failureCode: failure.failureCode,
        originalError: error.message,
        err: (writeError as Error).message,
      },
      "could not record the plan-build failure — the reason has no durable surface for this attempt",
    );
  }
}

/** The statuses a retry is meaningful from. `built` is excluded because
 *  `RenderPlan` is append-only — the plan already exists and re-running the job
 *  is a no-op by design (`plan.build` returns early on a materialized id).
 *  `queued` is excluded because it is already in flight. */
export function isRetryableAttemptStatus(status: RenderAttemptStatus): boolean {
  return status === RenderAttemptStatus.infeasible || status === RenderAttemptStatus.failed;
}
