-- CreateEnum
CREATE TYPE "content_brief_status" AS ENUM ('proposed', 'approved', 'rejected', 'superseded');

-- CreateEnum
CREATE TYPE "content_archetype" AS ENUM ('objection_killer', 'contrarian', 'pain_ladder', 'transformation', 'myth_bust', 'bts', 'listicle', 'client_story', 'category_ed', 'founder_pov');

-- CreateEnum
CREATE TYPE "evidence_tier" AS ENUM ('A', 'B', 'C');

-- CreateEnum
CREATE TYPE "content_channel" AS ENUM ('reels', 'shorts', 'tiktok', 'linkedin');

-- CreateEnum
CREATE TYPE "content_mix_slot" AS ENUM ('brand', 'activation');

-- CreateEnum
CREATE TYPE "expected_metric" AS ENUM ('sends_per_reach', 'saves', 'watch_time', 'profile_visits');

-- CreateEnum
CREATE TYPE "content_brief_action" AS ENUM ('approve', 'reject', 'edit_approve', 'undo');

-- CreateTable
CREATE TABLE "content_briefs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "brief_version_id" TEXT NOT NULL,
    "claim_ids" TEXT[],
    "claim_snapshots" JSONB NOT NULL,
    "framework_id" TEXT NOT NULL,
    "framework_evidence_tier" "evidence_tier" NOT NULL,
    "archetype" "content_archetype" NOT NULL,
    "hook_text" TEXT NOT NULL,
    "emphasis_word" TEXT NOT NULL,
    "beats" JSONB NOT NULL,
    "channel" "content_channel" NOT NULL,
    "content_mix_slot" "content_mix_slot" NOT NULL,
    "expected_metric" "expected_metric" NOT NULL,
    "status" "content_brief_status" NOT NULL DEFAULT 'proposed',
    "edited_from_id" TEXT,
    "generated_by_model" TEXT NOT NULL,
    "generation_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMP(3),

    CONSTRAINT "content_briefs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_brief_decisions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "content_brief_id" TEXT NOT NULL,
    "action" "content_brief_action" NOT NULL,
    "reviewer" TEXT NOT NULL,
    "note" TEXT,
    "result_brief_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_brief_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "content_briefs_tenant_id_status_channel_idx" ON "content_briefs"("tenant_id", "status", "channel");

-- CreateIndex
CREATE INDEX "content_briefs_tenant_id_brief_version_id_idx" ON "content_briefs"("tenant_id", "brief_version_id");

-- CreateIndex
CREATE INDEX "content_briefs_tenant_id_edited_from_id_idx" ON "content_briefs"("tenant_id", "edited_from_id");

-- CreateIndex
CREATE INDEX "content_brief_decisions_tenant_id_created_at_idx" ON "content_brief_decisions"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "content_brief_decisions_content_brief_id_created_at_idx" ON "content_brief_decisions"("content_brief_id", "created_at");

-- CreateIndex
CREATE INDEX "content_brief_decisions_result_brief_id_idx" ON "content_brief_decisions"("result_brief_id");

-- AddForeignKey
ALTER TABLE "render_plans" ADD CONSTRAINT "render_plans_content_brief_id_fkey" FOREIGN KEY ("content_brief_id") REFERENCES "content_briefs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_briefs" ADD CONSTRAINT "content_briefs_edited_from_id_fkey" FOREIGN KEY ("edited_from_id") REFERENCES "content_briefs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_briefs" ADD CONSTRAINT "content_briefs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_brief_decisions" ADD CONSTRAINT "content_brief_decisions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_brief_decisions" ADD CONSTRAINT "content_brief_decisions_content_brief_id_fkey" FOREIGN KEY ("content_brief_id") REFERENCES "content_briefs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
