<p align="left">
  <img src="perfstaq-logos/perfstaq-logo/lockup/perfstaq-horizontal-on-light.svg" alt="Perfstaq" height="34">
</p>

# MCOS — Marketing Context Operating System

[![CI](https://github.com/Perfstaq/mcos-bot/actions/workflows/ci.yml/badge.svg)](https://github.com/Perfstaq/mcos-bot/actions/workflows/ci.yml)
[![CodeQL](https://github.com/Perfstaq/mcos-bot/actions/workflows/codeql.yml/badge.svg)](https://github.com/Perfstaq/mcos-bot/actions/workflows/codeql.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](package.json)

**Milestone 1: ingestion → review gate → versioned brief.**

Meetings are one evidence source feeding a context pipeline. The product is the pipeline:
LLM extraction proposes typed claims, a human decides on every one of them, and approved
claims become an append-only, versioned **Living Positioning Brief**.

The review gate is the only write path into memory. Nothing is auto-approved, ever.

> Design decisions, assumptions, open questions and the six-stage ring: **[IMPLEMENTATION.md](IMPLEMENTATION.md)**.

---

## What runs

| Piece | What it is |
|---|---|
| `apps/api` | One deployable. `dist/server.js` is the Fastify API (and serves the built SPA); `dist/worker.js` is the BullMQ workers. Same image, different command. |
| `apps/web` | React + Vite. A persistent-rail workspace with three screens — Meetings, Review Queue, Brief — each composed of independently scrolling panes. |
| Postgres 16 | Prisma. Append-only versioning in plain tables. |
| Redis | BullMQ: webhook processing, artifact download, extraction. |
| Cloudflare R2 | Recording audio + raw transcript JSON. |
| OpenAI | Extraction, via Structured Outputs with a strict schema. |

---

## Local setup

**Prerequisites:** Node 20+, Docker, and a static ngrok URL (Recall rejects request bodies
containing `localhost` or IPs with a 403).

```bash
git clone <this repo> && cd meeting-bot
cp .env.example .env      # fill in the secrets — see the table below
npm install
npm run db:up             # postgres on 5433, redis on 6380
npm run db:migrate
npm run db:seed:demo      # tenant "freshworks-demo" + a populated demo meeting
```

Then, in three terminals:

```bash
npm run dev:api
```

```bash
npm run dev:worker
```

```bash
npm run dev:web
```

Open http://localhost:5173. The `--demo` seed gives you eleven claims waiting in the
review queue, so the review gate and brief versioning work before a bot has ever joined
a call.

### Webhook tunnel

```bash
ngrok http --domain=your-static-subdomain.ngrok-free.app 8787
```

Set `APP_BASE_URL` to that URL, then register
`https://your-static-subdomain.ngrok-free.app/api/v1/webhooks/recall` in the Recall
dashboard for your region and subscribe it to `bot.*`, `recording.done`,
`recording.failed`, `transcript.done`, `transcript.failed`.

---

## Configuration

Everything comes from the environment. `.env.example` is the full list; these are the ones
that need a decision rather than a paste.

| Variable | Notes |
|---|---|
| `RECALL_REGION` | `us-east-1` \| `us-west-2` \| `eu-central-1` \| `ap-northeast-1`. API keys, secrets, bots and recordings are region-scoped and **not** portable. |
| `RECALL_WEBHOOK_SECRET` | The **workspace verification secret** (`whsec_…`). Used to verify every webhook. |
| `RECALL_SVIX_WEBHOOK_SECRET` | Only for Recall accounts created **before 2025-12-15**, which use a per-endpoint secret for dashboard webhooks. On newer accounts, setting this **breaks** verification — leave it empty. |
| `APP_BASE_URL` | Publicly reachable and stable. Never `localhost`. |
| `RECALL_CAPTURE_VIDEO` | `false` by default — audio + transcript only, which is all Milestone 1 needs. |
| `OPENAI_MODEL` | `gpt-5.6-terra` by default — the balanced tier. `gpt-5.6-sol` if extraction recall matters more than cost, `gpt-5.6-luna` to cut cost on clean transcripts. |
| `OPENAI_REASONING_EFFORT` | `low` by default. Extraction is mechanical once the schema is fixed; raise it if claim typing is sloppy. |

---

## Commands

```bash
npm run setup       # install + db up + migrate + seed, in one go
npm test            # 62 tests: unit + full pipeline against a real Postgres
npm run typecheck   # both workspaces
npm run build       # api (tsc) + web (vite)
npm run db:studio   # Prisma Studio
```

Tests use a separate `mcos_test` database and **Redis database 15**, both created
automatically — so a `npm run dev:worker` left running in another terminal cannot consume
the jobs the suite just enqueued. Recall,
R2 and OpenAI are all mocked; webhook fixtures are signed with the real HMAC and
verified by the real verifier, so the signature path is exercised rather than bypassed.

---

## How the pipeline actually runs

```
POST /api/v1/meetings
  └─ Recall POST /bot/  (audio_mixed_mp3; no transcript provider — see below)

POST /api/v1/webhooks/recall     verify HMAC → persist raw → enqueue → 200. Always.
  ├─ bot.*             → state transition (rank-guarded, so late webhooks can't rewind)
  ├─ recording.done    → stream audio → R2, then POST /recording/{id}/create_transcript/
  └─ transcript.done   → download transcript → R2 + parse into citable segments
                          └─ extraction → typed claims, status `proposed`
                               └─ REVIEW QUEUE ← a human decides here
                                    └─ POST /brief/versions → brief vN
```

Two things worth knowing, both of which contradict a reasonable first guess:

1. **`recallai_async` cannot be configured at bot creation.** Setting a transcript
   provider in Create Bot selects the *real-time* flow. Post-meeting transcription is a
   separate call made after `recording.done`. Milestone 1 uses the async flow, so the bot
   is created with no transcript provider at all.
2. **Recall retains media for about seven days.** Artifacts are pulled into R2 in the
   completion handler, never lazily. R2 is the system of record from the moment media lands.

The bot's status is never polled — that is a documented anti-pattern. Webhooks only.

---

## API

`/api/v1`. Full request/response contracts are in
[IMPLEMENTATION.md § 6](IMPLEMENTATION.md#6-api--apiv1).

```
POST   /meetings                          GET  /meetings            GET /meetings/:id
POST   /meetings/:id/retry                DELETE /meetings/:id
GET    /meetings/:id/artifacts/:kind/url  (presigned R2 GET, 1h)
POST   /webhooks/recall                   (Svix-style HMAC, fast-ack)
GET    /review-queue                      GET  /review-decisions    (the audit log)
POST   /claims/:id/approve | /reject      PATCH /claims/:id         (edit-then-approve)
POST   /brief/versions                    GET  /brief/versions      GET /brief/versions/:n
GET    /brief/versions/:n/diff/:m         GET  /brief/current       ← the stage-5 read interface
```

Milestone 1 has no authentication. Tenancy **is** enforced — every table carries
`tenant_id` and a Prisma client extension injects it into every query, so a cross-tenant
read is not expressible through the app's client. Identity is supplied by header
(`X-Tenant-Slug`, `X-Reviewer-Email`) and falls back to the seeded demo tenant. Replacing
`resolveContext()` in `apps/api/src/http.ts` is the entire auth story.

---

## Deploy

```bash
docker build -t mcos .
docker run -p 8787:8787 --env-file .env mcos                       # API + SPA
docker run --env-file .env mcos node apps/api/dist/worker.js       # workers
```

One ECS Fargate service for the API and one for the workers, from the same image, in
**`ap-south-2` (AWS Hyderabad)**. RDS Postgres 16, ElastiCache Redis, R2 for artifacts.
Run `npx prisma migrate deploy` as a release task.

`ap-south-2` is an **opt-in region** — enable it in Account → AWS Regions first, and
verify Fargate / RDS / ElastiCache instance classes are available in the specific AZs you
plan to use. Create the R2 bucket with `--location apac`; the hint is immutable after
creation. See [IMPLEMENTATION.md § 9](IMPLEMENTATION.md#9-deploy--aws-hyderabad-ap-south-2)
for the caveats, including why Recall's lack of an India region means compute placement
alone does not give you data residency.

---

## Deliberately not built

Calendar OAuth · recording playback, chapters, highlights, comments · meeting notes ·
search · ask-a-meeting AI · sharing and permissions UI · templates · workspace management ·
generic summaries and action items · agentic frameworks · a second evidence source.

The evidence interface is pluggable (`evidence_sources.kind`) and generation has a read
interface (`GET /brief/current`), but only `meeting_transcript` is implemented and
generation is not built. That is the milestone boundary, not an oversight —
see **Later** in [IMPLEMENTATION.md](IMPLEMENTATION.md#later-cut-from-milestone-1--deliberately).

---

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) first — particularly the six
architectural invariants. They are not style preferences, and a change that
breaks one will be sent back regardless of how well it is written.

Everything runs locally with **no third-party credentials**: `npm run db:seed:demo`
populates the review queue and the brief directly, so all three screens and the
whole review-gate path are exercisable without a Recall, R2 or OpenAI account.

- Bugs and proposals: [issues](https://github.com/Perfstaq/mcos-bot/issues)
- Questions and ideas: [discussions](https://github.com/Perfstaq/mcos-bot/discussions)
- Security: **do not open an issue** — see [SECURITY.md](SECURITY.md)
- Conduct: [Contributor Covenant 2.1](CODE_OF_CONDUCT.md)

## Licence

[Apache License 2.0](LICENSE). © 2026 Perfstaq.

The **Perfstaq name and marks** — including everything under `perfstaq-logos/` —
are trademarks and are *not* covered by that licence (Apache-2.0 § 6). Fork
freely; swap the brand assets for your own. See [NOTICE](NOTICE).

Geist and Geist Mono are used under the SIL Open Font License 1.1.
