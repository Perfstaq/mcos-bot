-- Full-text search.
--
-- Expression indexes, not generated columns. A generated tsvector column is the
-- textbook approach, but Prisma has no syntax for GENERATED, so every
-- subsequent `migrate diff` proposes dropping the generated-ness — a schema that
-- fights its own migration tool is a schema that eventually loses.
--
-- An expression index gives the same query plan with nothing for Prisma to
-- disagree about: there is no column, only an index it cannot represent and
-- therefore leaves alone. Queries must use the *identical* expression to hit it.

CREATE INDEX IF NOT EXISTS "transcript_segments_search_idx"
  ON "transcript_segments"
  USING GIN (to_tsvector('english', coalesce("text", '') || ' ' || coalesce("speaker", '')));

CREATE INDEX IF NOT EXISTS "meeting_notes_search_idx"
  ON "meeting_notes"
  USING GIN (to_tsvector('english', coalesce("plain_text", '')));

CREATE INDEX IF NOT EXISTS "meetings_search_idx"
  ON "meetings"
  USING GIN (to_tsvector('english', coalesce("title", '')));

-- Trigram index for fuzzy title matching, so "positoning" still finds the
-- positioning review.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- On lower(title) rather than the bare column: a trigram index on a plain
-- column is structurally representable in Prisma, so the differ sees an index
-- it does not know about and proposes dropping it. Wrapping it in an expression
-- puts it in the same "cannot represent, will leave alone" bucket as the others
-- — and case-insensitive matching is what we wanted anyway.
CREATE INDEX IF NOT EXISTS "meetings_title_trgm_idx"
  ON "meetings" USING GIN (lower(coalesce("title", '')) gin_trgm_ops);
