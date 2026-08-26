-- Additive only: three nullable columns on `meetings`, no defaults, no
-- backfill, no rewrite of existing rows.
--
-- `digest` is a cheap one-line title + 3-sentence summary generated once the
-- transcript lands (jobs/digest.ts). `digest_model` and
-- `digest_generated_at` are provenance only, the same reasoning as
-- extraction_runs.model / .prompt_version: a digest nobody can trace to a
-- prompt or a model id is a digest nobody can debug.

ALTER TABLE "meetings" ADD COLUMN "digest" TEXT;
ALTER TABLE "meetings" ADD COLUMN "digest_model" TEXT;
ALTER TABLE "meetings" ADD COLUMN "digest_generated_at" TIMESTAMP(3);
