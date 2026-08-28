-- ARCHITECTURE.md §12.25 / §12.38 — a durable, retryable surface for
-- `plan_infeasible`, which 03 §7 requires and which previously vanished.
--
-- Strictly ADDITIVE (CLAUDE.md invariant 6): one new enum, one new table, its
-- indexes and one FK. No existing table is altered, no column renamed, nothing
-- dropped. Safe to apply to a populated database — `render_attempts` starts
-- empty and nothing reads it until the routes below do.
--
-- Keyed on the plan id `POST /content/plans` pre-allocates, so a built attempt
-- and its `render_plans` row share an id. There is deliberately no FK between
-- them: the plan may never exist, and a nullable link would reintroduce the
-- "rows that are not plans" confusion §12.25 rejected.

-- CreateEnum
CREATE TYPE "render_attempt_status" AS ENUM ('queued', 'built', 'infeasible', 'failed');

-- CreateTable
CREATE TABLE "render_attempts" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "content_brief_id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "footage_asset_id" TEXT NOT NULL,
    "status" "render_attempt_status" NOT NULL DEFAULT 'queued',
    "failure_code" TEXT,
    "failure_message" TEXT,
    "failure_detail" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "render_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "render_attempts_tenant_id_created_at_idx" ON "render_attempts"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "render_attempts_tenant_id_status_idx" ON "render_attempts"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "render_attempts_tenant_id_content_brief_id_idx" ON "render_attempts"("tenant_id", "content_brief_id");

-- AddForeignKey
ALTER TABLE "render_attempts" ADD CONSTRAINT "render_attempts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

