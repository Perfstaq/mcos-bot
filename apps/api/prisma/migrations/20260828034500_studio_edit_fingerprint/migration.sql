-- Agent F — the EditFingerprint's storage (04_STYLE_TRANSFER §3/§5).
--
-- Additive only (CLAUDE.md invariant 6 / 00_MASTER invariant 7): two nullable
-- columns on an existing table. No renames, no drops, no type changes, and
-- nothing to backfill — every existing media_analyses row is a footage
-- analysis, which legitimately has no fingerprint.
--
-- Why its own column rather than reusing `scenes`/`motion`: those are reserved
-- for per-signal payloads about FOOTAGE. This is one composite object
-- describing a REFERENCE reel's structure, whose per-field confidences only
-- mean anything together.
--
-- `fingerprint_version` pins the extractor build the way `analyzer_version`
-- pins the sidecar: a fingerprint measured by a different extractor is a
-- different measurement, and 04 §6's acceptance thresholds are calibrated
-- per-extractor against the committed reference baseline (ADR-8 §4.1(3)).
ALTER TABLE "media_analyses" ADD COLUMN "fingerprint" JSONB;
ALTER TABLE "media_analyses" ADD COLUMN "fingerprint_version" TEXT;
