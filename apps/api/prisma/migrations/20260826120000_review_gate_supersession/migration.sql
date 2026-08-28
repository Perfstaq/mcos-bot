-- Review gate: edit-approve writes a new claim and supersedes the old one,
-- and undo is a compensating decision rather than a deleted row.
--
-- Additive only. No column is dropped or renamed, no enum value is removed,
-- and every new column is nullable so existing rows stay valid untouched.

-- A claim replaced by an edit-approved successor.
ALTER TYPE "claim_status" ADD VALUE IF NOT EXISTS 'superseded';

-- A decision that compensates an earlier one. The earlier row is never deleted.
ALTER TYPE "review_action" ADD VALUE IF NOT EXISTS 'undo';

-- The original of an edit lineage. Always the root, never the immediate
-- predecessor, so the brief has one stable identity per claim.
ALTER TABLE "candidate_claims" ADD COLUMN "edited_from_id" TEXT;

ALTER TABLE "candidate_claims"
  ADD CONSTRAINT "candidate_claims_edited_from_id_fkey"
  FOREIGN KEY ("edited_from_id") REFERENCES "candidate_claims"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "candidate_claims_tenant_id_edited_from_id_idx"
  ON "candidate_claims"("tenant_id", "edited_from_id");

-- The claim row a decision produced or compensated. Not a foreign key on
-- purpose: the audit log must outlive the rows it describes.
ALTER TABLE "review_decisions" ADD COLUMN "result_claim_id" TEXT;

CREATE INDEX "review_decisions_result_claim_id_idx"
  ON "review_decisions"("result_claim_id");
