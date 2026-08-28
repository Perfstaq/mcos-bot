-- Additive only: one nullable column on `meetings`.
--
-- Completes the provenance triple jobs/digest.ts already writes two thirds
-- of (digest_model, digest_generated_at) — the same reasoning as
-- extraction_runs.prompt_version: a digest nobody can trace to the harness
-- that produced it is a digest nobody can debug.

ALTER TABLE "meetings" ADD COLUMN "digest_prompt_version" TEXT;
