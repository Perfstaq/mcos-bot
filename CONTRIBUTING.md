# Contributing to MCOS

Thanks for looking. This document covers how to get the project running, what a
good change looks like here, and the few rules that are not negotiable.

## Getting set up

**Prerequisites:** Node 20+, Docker, and — if you are touching the webhook path —
a static ngrok URL (Recall rejects request bodies containing `localhost` or IPs
with a 403 from CloudFront).

```bash
npm install
cp .env.example .env      # fill in what you need; see the table in the README
npm run db:up             # postgres :5433, redis :6380
npm run db:migrate
npm run db:seed:demo      # tenant "freshworks-demo" + a populated demo meeting
```

Three terminals:

```bash
npm run dev:api
```

```bash
npm run dev:worker
```

```bash
npm run dev:web
```

You do **not** need Recall, R2 or OpenAI credentials to work on most of the
codebase. The `--demo` seed populates the review queue and the brief directly,
so the review gate, the versioning and all three screens are exercisable with no
third-party account at all.

## Before you open a pull request

```bash
npm run typecheck
npm test
npm run build
```

All three must pass. CI runs the same three against a real Postgres and Redis.

## The rules that are not negotiable

These are architectural invariants, not style preferences. A change that breaks
one of them will be sent back regardless of how well it is written.

1. **The review gate is the only write path into context memory.** Nothing may
   write to `brief_versions` or `brief_claims` except a merge triggered by a
   human decision. No confidence threshold, no auto-approve, no "trusted source"
   bypass. If you find yourself adding a second write path, that is the bug.

2. **Provenance is structural.** A `candidate_claim` requires an
   `evidence_source_id` and at least one row in `claim_segments`. Extraction
   output that cannot be resolved to real transcript segments is dropped at the
   boundary and counted, never persisted.

3. **Append-only tables stay append-only.** `review_decisions`,
   `state_transitions`, `brief_versions`, `brief_claims` and `webhook_events` are
   never updated or deleted in normal operation. The deletion path redacts; it
   does not erase history.

4. **Webhooks are verified before anything else happens.** Signature check on the
   raw body, in every environment, with no development bypass. Unverified
   requests are logged and dropped — never enqueued, never stored as
   processable.

5. **Tenancy is enforced at the database client.** Do not reach around the Prisma
   extension in `apps/api/src/db.ts`. If you need `rawPrisma`, say why in a
   comment.

6. **No polling of the Recall API.** It is a documented anti-pattern. Bot state
   comes from webhooks.

## Style

- Match the surrounding code. Comment density, naming and idiom are consistent
  across the codebase on purpose.
- Comments explain *why*, not *what*. If a line needs a comment to say what it
  does, rewrite the line.
- Plain TypeScript functions over abstractions. No agentic frameworks.
- Tests for behaviour, not for coverage. A test that cannot fail is noise.

## Commits and pull requests

- [Conventional Commits](https://www.conventionalcommits.org): `feat:`, `fix:`,
  `docs:`, `refactor:`, `test:`, `chore:`.
- One concern per PR. If the description needs the word "also", split it.
- Say what you verified and how. "Tests pass" is not a verification claim; the
  output is.

## Reporting a security issue

Do **not** open a public issue. See [SECURITY.md](SECURITY.md).

## Licence

By contributing you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE).
