-- Additive only: tag each candidate claim with the model that proposed it.
-- Nullable, no default, no backfill — rows from before this column existed
-- simply have no model recorded, which is the truth.
ALTER TABLE "candidate_claims" ADD COLUMN "extracted_by_model" TEXT;
