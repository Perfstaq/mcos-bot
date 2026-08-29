-- CreateEnum
CREATE TYPE "media_asset_kind" AS ENUM ('footage', 'reference', 'render', 'music');

-- CreateEnum
CREATE TYPE "media_analysis_status" AS ENUM ('running', 'succeeded', 'failed');

-- CreateEnum
CREATE TYPE "template_framing" AS ENUM ('letterbox', 'fill');

-- CreateEnum
CREATE TYPE "render_status" AS ENUM ('queued', 'rendering', 'qc', 'succeeded', 'failed');

-- CreateTable
CREATE TABLE "media_assets" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "kind" "media_asset_kind" NOT NULL,
    "r2_key" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "bytes" BIGINT NOT NULL,
    "checksum" TEXT,
    "original_name" TEXT,
    "duration_ms" INTEGER,
    "width" INTEGER,
    "height" INTEGER,
    "fps" DOUBLE PRECISION,
    "uploaded_by_user_id" TEXT,
    "purged_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_analyses" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "status" "media_analysis_status" NOT NULL DEFAULT 'running',
    "error" TEXT,
    "words" JSONB,
    "beats" JSONB,
    "scenes" JSONB,
    "motion" JSONB,
    "faces" JSONB,
    "tempo_bpm" DOUBLE PRECISION,
    "beat_method" TEXT,
    "analyzer_version" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "media_analyses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "motion_templates" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "archetype" TEXT NOT NULL,
    "framing" "template_framing" NOT NULL,
    "slots" JSONB NOT NULL,
    "fonts" JSONB NOT NULL,
    "grade" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "motion_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "render_plans" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "content_brief_id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "footage_asset_id" TEXT NOT NULL,
    "plan" JSONB NOT NULL,
    "seed" INTEGER NOT NULL,
    "plan_version" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "render_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "renders" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "status" "render_status" NOT NULL DEFAULT 'queued',
    "r2_key" TEXT,
    "duration_ms" INTEGER,
    "bytes" BIGINT,
    "checksum" TEXT,
    "qc" JSONB,
    "qc_passed" BOOLEAN,
    "lambda_render_id" TEXT,
    "error" TEXT,
    "failed_stage" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "renders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "media_assets_r2_key_key" ON "media_assets"("r2_key");

-- CreateIndex
CREATE INDEX "media_assets_tenant_id_kind_created_at_idx" ON "media_assets"("tenant_id", "kind", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "media_analyses_asset_id_key" ON "media_analyses"("asset_id");

-- CreateIndex
CREATE INDEX "media_analyses_tenant_id_status_idx" ON "media_analyses"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "motion_templates_name_version_key" ON "motion_templates"("name", "version");

-- CreateIndex
CREATE INDEX "render_plans_tenant_id_content_brief_id_idx" ON "render_plans"("tenant_id", "content_brief_id");

-- CreateIndex
CREATE INDEX "render_plans_tenant_id_created_at_idx" ON "render_plans"("tenant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "renders_r2_key_key" ON "renders"("r2_key");

-- CreateIndex
CREATE INDEX "renders_tenant_id_status_idx" ON "renders"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "renders_plan_id_created_at_idx" ON "renders"("plan_id", "created_at");

-- AddForeignKey
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_analyses" ADD CONSTRAINT "media_analyses_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_analyses" ADD CONSTRAINT "media_analyses_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "media_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "render_plans" ADD CONSTRAINT "render_plans_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "render_plans" ADD CONSTRAINT "render_plans_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "motion_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "render_plans" ADD CONSTRAINT "render_plans_footage_asset_id_fkey" FOREIGN KEY ("footage_asset_id") REFERENCES "media_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "renders" ADD CONSTRAINT "renders_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "renders" ADD CONSTRAINT "renders_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "render_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;
