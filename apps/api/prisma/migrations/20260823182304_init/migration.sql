-- CreateEnum
CREATE TYPE "meeting_status" AS ENUM ('draft', 'bot_scheduled', 'bot_joined', 'recording', 'call_ended', 'media_processing', 'transcript_ready', 'extracting', 'in_review', 'merged', 'failed');

-- CreateEnum
CREATE TYPE "evidence_kind" AS ENUM ('meeting_transcript', 'performance_metric', 'document');

-- CreateEnum
CREATE TYPE "artifact_kind" AS ENUM ('recording_audio', 'recording_video', 'transcript_json');

-- CreateEnum
CREATE TYPE "extraction_status" AS ENUM ('running', 'succeeded', 'failed');

-- CreateEnum
CREATE TYPE "claim_type" AS ENUM ('positioning_statement', 'icp_fact', 'pain_point', 'objection', 'messaging_decision', 'competitor_mention', 'proof_point');

-- CreateEnum
CREATE TYPE "claim_status" AS ENUM ('proposed', 'approved', 'rejected', 'edited');

-- CreateEnum
CREATE TYPE "review_action" AS ENUM ('approve', 'reject', 'edit_approve');

-- CreateTable
CREATE TABLE "tenants" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meetings" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "title" TEXT,
    "meeting_url" TEXT NOT NULL,
    "join_at" TIMESTAMP(3),
    "status" "meeting_status" NOT NULL DEFAULT 'draft',
    "failure_reason" TEXT,
    "failed_stage" TEXT,
    "recall_bot_id" TEXT,
    "recall_recording_id" TEXT,
    "recall_transcript_id" TEXT,
    "platform" TEXT,
    "started_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meetings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "state_transitions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "meeting_id" TEXT NOT NULL,
    "from_status" "meeting_status",
    "to_status" "meeting_status" NOT NULL,
    "reason" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "state_transitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evidence_sources" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "kind" "evidence_kind" NOT NULL,
    "meeting_id" TEXT,
    "external_id" TEXT,
    "captured_at" TIMESTAMP(3) NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evidence_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transcripts" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "meeting_id" TEXT NOT NULL,
    "evidence_source_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "language_code" TEXT,
    "recall_transcript_id" TEXT,
    "segment_count" INTEGER NOT NULL,
    "word_count" INTEGER NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transcripts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transcript_segments" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "transcript_id" TEXT NOT NULL,
    "idx" INTEGER NOT NULL,
    "speaker" TEXT NOT NULL,
    "speaker_id" INTEGER,
    "start_ms" INTEGER NOT NULL,
    "end_ms" INTEGER NOT NULL,
    "text" TEXT NOT NULL,

    CONSTRAINT "transcript_segments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "artifacts" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "meeting_id" TEXT NOT NULL,
    "kind" "artifact_kind" NOT NULL,
    "r2_key" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "bytes" BIGINT NOT NULL,
    "checksum" TEXT,
    "source_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "purged_at" TIMESTAMP(3),

    CONSTRAINT "artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "extraction_runs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "meeting_id" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "prompt_version" TEXT NOT NULL,
    "status" "extraction_status" NOT NULL DEFAULT 'running',
    "chunk_count" INTEGER NOT NULL DEFAULT 0,
    "proposed_count" INTEGER NOT NULL DEFAULT 0,
    "dropped_count" INTEGER NOT NULL DEFAULT 0,
    "duplicate_count" INTEGER NOT NULL DEFAULT 0,
    "persisted_count" INTEGER NOT NULL DEFAULT 0,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "extraction_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidate_claims" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "meeting_id" TEXT NOT NULL,
    "evidence_source_id" TEXT NOT NULL,
    "extraction_run_id" TEXT NOT NULL,
    "type" "claim_type" NOT NULL,
    "text" TEXT NOT NULL,
    "edited_text" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL,
    "status" "claim_status" NOT NULL DEFAULT 'proposed',
    "verbatim_quote" TEXT NOT NULL,
    "speaker" TEXT NOT NULL,
    "timestamp_ms" INTEGER NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMP(3),
    "merged_at" TIMESTAMP(3),

    CONSTRAINT "candidate_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "claim_segments" (
    "claim_id" TEXT NOT NULL,
    "segment_id" TEXT NOT NULL,

    CONSTRAINT "claim_segments_pkey" PRIMARY KEY ("claim_id","segment_id")
);

-- CreateTable
CREATE TABLE "review_decisions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "claim_id" TEXT NOT NULL,
    "action" "review_action" NOT NULL,
    "reviewer" TEXT NOT NULL,
    "previous_text" TEXT,
    "edited_text" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brief_versions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT NOT NULL,
    "note" TEXT,
    "added_count" INTEGER NOT NULL DEFAULT 0,
    "removed_count" INTEGER NOT NULL DEFAULT 0,
    "edited_count" INTEGER NOT NULL DEFAULT 0,
    "total_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "brief_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brief_claims" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "brief_version_id" TEXT NOT NULL,
    "claim_id" TEXT NOT NULL,
    "meeting_id" TEXT NOT NULL,
    "type" "claim_type" NOT NULL,
    "text" TEXT NOT NULL,
    "verbatim_quote" TEXT NOT NULL,
    "speaker" TEXT NOT NULL,
    "timestamp_ms" INTEGER NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "evidence_redacted" BOOLEAN NOT NULL DEFAULT false,
    "introduced_in_version" INTEGER NOT NULL,

    CONSTRAINT "brief_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT,
    "event_type" TEXT NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "bot_id" TEXT,
    "recording_id" TEXT,
    "transcript_id" TEXT,
    "payload" JSONB NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "meetings_recall_bot_id_key" ON "meetings"("recall_bot_id");

-- CreateIndex
CREATE UNIQUE INDEX "meetings_recall_recording_id_key" ON "meetings"("recall_recording_id");

-- CreateIndex
CREATE UNIQUE INDEX "meetings_recall_transcript_id_key" ON "meetings"("recall_transcript_id");

-- CreateIndex
CREATE INDEX "meetings_tenant_id_status_idx" ON "meetings"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "meetings_tenant_id_created_at_idx" ON "meetings"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "state_transitions_meeting_id_occurred_at_idx" ON "state_transitions"("meeting_id", "occurred_at");

-- CreateIndex
CREATE INDEX "evidence_sources_tenant_id_kind_idx" ON "evidence_sources"("tenant_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "evidence_sources_tenant_id_kind_external_id_key" ON "evidence_sources"("tenant_id", "kind", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "transcripts_meeting_id_key" ON "transcripts"("meeting_id");

-- CreateIndex
CREATE UNIQUE INDEX "transcripts_evidence_source_id_key" ON "transcripts"("evidence_source_id");

-- CreateIndex
CREATE INDEX "transcript_segments_transcript_id_start_ms_idx" ON "transcript_segments"("transcript_id", "start_ms");

-- CreateIndex
CREATE UNIQUE INDEX "transcript_segments_transcript_id_idx_key" ON "transcript_segments"("transcript_id", "idx");

-- CreateIndex
CREATE UNIQUE INDEX "artifacts_r2_key_key" ON "artifacts"("r2_key");

-- CreateIndex
CREATE UNIQUE INDEX "artifacts_meeting_id_kind_key" ON "artifacts"("meeting_id", "kind");

-- CreateIndex
CREATE INDEX "extraction_runs_meeting_id_started_at_idx" ON "extraction_runs"("meeting_id", "started_at");

-- CreateIndex
CREATE INDEX "candidate_claims_tenant_id_status_type_idx" ON "candidate_claims"("tenant_id", "status", "type");

-- CreateIndex
CREATE INDEX "candidate_claims_meeting_id_status_idx" ON "candidate_claims"("meeting_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "candidate_claims_tenant_id_dedupe_key_key" ON "candidate_claims"("tenant_id", "dedupe_key");

-- CreateIndex
CREATE INDEX "claim_segments_segment_id_idx" ON "claim_segments"("segment_id");

-- CreateIndex
CREATE INDEX "review_decisions_tenant_id_created_at_idx" ON "review_decisions"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "review_decisions_claim_id_created_at_idx" ON "review_decisions"("claim_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "brief_versions_tenant_id_version_key" ON "brief_versions"("tenant_id", "version");

-- CreateIndex
CREATE INDEX "brief_claims_tenant_id_type_idx" ON "brief_claims"("tenant_id", "type");

-- CreateIndex
CREATE UNIQUE INDEX "brief_claims_brief_version_id_claim_id_key" ON "brief_claims"("brief_version_id", "claim_id");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_dedupe_key_key" ON "webhook_events"("dedupe_key");

-- CreateIndex
CREATE INDEX "webhook_events_event_type_received_at_idx" ON "webhook_events"("event_type", "received_at");

-- CreateIndex
CREATE INDEX "webhook_events_bot_id_idx" ON "webhook_events"("bot_id");

-- AddForeignKey
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "state_transitions" ADD CONSTRAINT "state_transitions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "state_transitions" ADD CONSTRAINT "state_transitions_meeting_id_fkey" FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_sources" ADD CONSTRAINT "evidence_sources_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_sources" ADD CONSTRAINT "evidence_sources_meeting_id_fkey" FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_meeting_id_fkey" FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_evidence_source_id_fkey" FOREIGN KEY ("evidence_source_id") REFERENCES "evidence_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcript_segments" ADD CONSTRAINT "transcript_segments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcript_segments" ADD CONSTRAINT "transcript_segments_transcript_id_fkey" FOREIGN KEY ("transcript_id") REFERENCES "transcripts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_meeting_id_fkey" FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extraction_runs" ADD CONSTRAINT "extraction_runs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extraction_runs" ADD CONSTRAINT "extraction_runs_meeting_id_fkey" FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_claims" ADD CONSTRAINT "candidate_claims_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_claims" ADD CONSTRAINT "candidate_claims_meeting_id_fkey" FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_claims" ADD CONSTRAINT "candidate_claims_evidence_source_id_fkey" FOREIGN KEY ("evidence_source_id") REFERENCES "evidence_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_claims" ADD CONSTRAINT "candidate_claims_extraction_run_id_fkey" FOREIGN KEY ("extraction_run_id") REFERENCES "extraction_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_segments" ADD CONSTRAINT "claim_segments_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "candidate_claims"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_segments" ADD CONSTRAINT "claim_segments_segment_id_fkey" FOREIGN KEY ("segment_id") REFERENCES "transcript_segments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_decisions" ADD CONSTRAINT "review_decisions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_decisions" ADD CONSTRAINT "review_decisions_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "candidate_claims"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brief_versions" ADD CONSTRAINT "brief_versions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brief_claims" ADD CONSTRAINT "brief_claims_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brief_claims" ADD CONSTRAINT "brief_claims_brief_version_id_fkey" FOREIGN KEY ("brief_version_id") REFERENCES "brief_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brief_claims" ADD CONSTRAINT "brief_claims_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "candidate_claims"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brief_claims" ADD CONSTRAINT "brief_claims_meeting_id_fkey" FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
