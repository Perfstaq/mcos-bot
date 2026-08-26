-- Additive only: one nullable column, one index, one FK.
--
-- Records which call a reviewer had just finished when they merged. Nullable,
-- so every brief_versions row that already exists stays valid, and ON DELETE
-- SET NULL, so purging a meeting can never delete a published version — brief
-- versions are append-only (invariant 3).

ALTER TABLE "brief_versions" ADD COLUMN "source_meeting_id" TEXT;

CREATE INDEX "brief_versions_tenant_id_source_meeting_id_idx"
  ON "brief_versions"("tenant_id", "source_meeting_id");

ALTER TABLE "brief_versions"
  ADD CONSTRAINT "brief_versions_source_meeting_id_fkey"
  FOREIGN KEY ("source_meeting_id") REFERENCES "meetings"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
