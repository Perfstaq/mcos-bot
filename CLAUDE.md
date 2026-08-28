# PerfStaq — agent context

## What this product is
Marketing Context Operating System. Meetings → LLM-extracted typed claims →
HUMAN REVIEW GATE (the only write path into memory) → versioned append-only
"Living Positioning Brief". The gate and provenance are the product. Never
weaken them for convenience.

## Invariants (violating any of these fails review)
1. GATE-ONLY WRITES: nothing reaches brief/memory tables except through an
   approve/edit-approve action recorded in review_decisions. No auto-approve
   paths, no seed scripts that bypass the gate (except fixtures explicitly
   marked as such and never run in production).
2. EVIDENCE OR DROP: a claim without transcript_segment linkage + verbatim
   quote is invalid and must be dropped and counted, never persisted.
3. APPEND-ONLY MEMORY: brief_versions rows are never updated or deleted.
   New state = new version. Rejected claims are never deleted, only status-marked.
4. PROVENANCE EVERYWHERE: every claim carries source segment ids, speaker,
   timestamps, meeting id, tenant id.
5. TENANT ISOLATION: every query filters by tenant_id. No cross-tenant reads.
6. ADDITIVE MIGRATIONS ONLY: no destructive schema changes; no renames of
   existing columns in this milestone.

## Conventions
- TypeScript strict. Plain functions over abstractions. No new frameworks,
  no LangChain/agent libraries. BullMQ for jobs. Prisma for DB.
- Structured LLM output via tool/function-calling schema only — never parse
  free-text JSON from the model.
- Conventional commits (feat:, fix:, test:, chore:).
- Every PR: tests pass locally, lint clean, no drive-by refactors, no
  dependency additions without justification in the PR body.
- UI: existing dark theme tokens (#111114 bg, #FF7A1A accent used sparingly,
  Montserrat ExtraBold headings). Match the existing meetings screens.

## Commands
- dev: npm run dev            (api only: npm run dev:api · worker: npm run dev:worker · web: npm run dev:web)
- test: npm test              (ALWAYS from repo root — vitest with --root breaks Prisma test setup)
- lint: npm run typecheck     (no separate linter is configured; typecheck is the gate)
- db migrate: npm run db:migrate
- seed: npm run db:seed:demo

## Current reality (orchestrator-verified, 26 Aug 2026 — trust this over stale docs)
- npm workspaces (apps/api, apps/web). API tests: apps/api/tests (vitest). No repo-root tests/ dir.
- Review gate and brief versioning are PARTIALLY BUILT: routes/review.ts, routes/brief.ts,
  pages/ReviewQueue.tsx, pages/Brief.tsx, review_decisions + brief_versions +
  brief_version_claims tables all exist. Audit reality against your spec section, close
  gaps, keep what already conforms. Do not rebuild working code.
- Extraction runs via jobs/extract.ts calling integrations/openai.ts (OpenAI models,
  configured by env). Do NOT switch LLM provider in this milestone; keep model ids in
  env/config, never hardcoded in call sites.
- Webhook fixtures already exist at apps/api/tests/fixtures/. Demo tenant seed exists
  (npm run db:seed:demo → demo@freshworks.example).

## What NOT to do
- Do not touch webhook verification, Recall client, or R2 streaming code
  unless the task spec says so.
- Do not add auth providers, calendar sync, chat/Ask features, strategy
  screens, or any Phase-2 surface. Out of scope = out of branch.
- Do not "improve" working code you pass by. Note it in the PR body instead.
