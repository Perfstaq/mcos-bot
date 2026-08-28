# Build contracts — auth & collaboration phase

Working agreement for parallel work on this branch. The schema, the auth config
and the dependencies are already landed and are **fixed**. Build against them.

## Files you must NOT touch

These are shared and owned by the integrator. Editing them causes conflicts.

- `apps/api/prisma/schema.prisma` and `apps/api/prisma/migrations/**`
- `apps/api/src/server.ts` (route registration)
- `apps/api/src/db.ts`, `src/env.ts`, `src/auth.ts`, `src/http.ts`, `src/queue.ts`
- `apps/web/src/App.tsx` (routes), `apps/web/src/components/Sidebar.tsx` (nav)
- `apps/web/src/styles.css`
- any `package.json`, `package-lock.json`
- existing tests under `apps/api/tests/**` (add new files; do not edit existing ones)

Need a schema change, a dependency, or a route registered? **Say so in your final
report.** Do not add it yourself.

## What already exists

- **Auth**: `apps/api/src/auth.ts` exports `auth` (Better Auth 1.7, Prisma
  adapter, email+password, Google + Microsoft OAuth with calendar scopes,
  `organization` and `admin` plugins). Base path `/api/auth`.
- **Tenancy**: `apps/api/src/db.ts` exports `prisma` (tenant-scoped via an
  AsyncLocalStorage-backed client extension) and `rawPrisma` (unscoped). Use
  `prisma`. Auth models are exempt from scoping — see `UNSCOPED`.
- **Context**: `apps/api/src/context.ts` — `runWithContext`, `requireContext`.
  `RequestContext` is `{ tenantId, tenantSlug, reviewer }`.
- **Errors**: `apps/api/src/http.ts` exports `ApiError` (`.badRequest`,
  `.notFound`, `.conflict`, `.unprocessable`) and `requireCtx(request)`.
- **Jobs**: `apps/api/src/queue.ts` — BullMQ queues. Add a new queue only by
  reporting it; do not edit `queue.ts`.
- **Schema**: models `User Session Account Verification Organization Member
  Invitation CalendarConnection CalendarEvent MeetingNote AgendaItem ActionItem
  MeetingCollaborator MeetingShare` plus the Milestone-1 models. Read
  `prisma/schema.prisma` before writing a query — field names are exact.
- **Search indexes**: GIN expression indexes exist on
  `to_tsvector('english', coalesce(text,'') || ' ' || coalesce(speaker,''))`
  over `transcript_segments`, `to_tsvector('english', coalesce(plain_text,''))`
  over `meeting_notes`, `to_tsvector('english', coalesce(title,''))` over
  `meetings`, and `lower(coalesce(title,'')) gin_trgm_ops` over `meetings`.
  **A query must use the identical expression or it will not hit the index.**

## House style — non-negotiable

Read `CONTRIBUTING.md`. In particular:

1. The **review gate** stays the only write path into `brief_versions` /
   `brief_claims`.
2. **Provenance is structural.** Anything lifted from a transcript keeps a
   segment reference (`ActionItem.sourceSegmentId` exists for exactly this).
3. **Append-only tables stay append-only.**
4. **Verify before you trust.** Webhooks, OAuth callbacks and share tokens are
   all untrusted input.
5. Comments explain **why**, not what. Match the surrounding density — this
   codebase comments decisions and trade-offs, not mechanics.
6. Plain TypeScript functions. No new abstraction layers, no frameworks.
7. ESM with `.js` import specifiers (`import { x } from "./y.js"`), NodeNext.

## Route file convention

Export a Fastify plugin. The integrator mounts it under `/api/v1`.

```ts
import type { FastifyInstance } from "fastify";
export async function <name>Routes(app: FastifyInstance): Promise<void> {
  app.get("/things", async (request) => { const ctx = requireCtx(request); /* ... */ });
}
```

## Round 2 — new models (already migrated, do not edit the schema)

- `UserPreference` — `userId` (unique), `autoRecordMode` (`none|all|external|owned`),
  `timezone`, `recordingMethod`. Personal default a new calendar connection
  inherits; a per-connection rule always wins.
- `ActionItem` gained `origin` (`manual|ai_suggested`), `dismissedAt`,
  `acceptedAt`, `groupName`.

**A suggested action item is a proposal, not a commitment.** It stays out of the
working lists until someone accepts it — the same shape as the claim review
gate, and for the same reason: a model may not add work to a person's plate on
its own. `origin: ai_suggested` with `acceptedAt: null` and `dismissedAt: null`
is the pending state.

## Verification

Before reporting done:

```bash
cd apps/api && npx tsc -p tsconfig.json --noEmit     # backend
cd apps/web && npx tsc -b --noEmit                   # frontend
```

Both must be clean **for the files you wrote**. If a pre-existing error is in
someone else's file, say so; do not fix it.

Your final message is a report, not prose. State: files created, what each does,
anything you need from the integrator (schema fields, deps, route registration),
and anything you could not verify.
