# MCOS — Milestone 1 Implementation

**Marketing Context Operating System.** Meetings are one evidence source feeding a context
pipeline. The product is the pipeline: LLM extraction → human review gate → versioned,
append-only context memory ("Living Positioning Brief").

Milestone 1 builds stages 1–4 of the six-stage ring. Stages 5 (generation reads approved
memory) and 6 (performance results re-enter as evidence) are **interface-only** here.

---

## 0. Assumptions & open questions

### Where the live docs overrode the brief

| Brief said | Live docs (Aug 2026) say | What we build |
|---|---|---|
| Configure `recording_config.transcript.provider` with `recallai_async` at bot creation | `recallai_async` **cannot** be set at bot creation. It is a *post-recording* job: `POST /api/v1/recording/{id}/create_transcript/`. Setting a provider in Create Bot means you chose the *real-time* flow. | Create bot with **no** transcript provider. On `recording.done`, POST `create_transcript` with `recallai_async`. Wait for `transcript.done`. |
| Verify the **Svix** signature | Recall moved to the Standard Webhooks HMAC scheme with `webhook-id` / `webhook-timestamp` / `webhook-signature` headers and a **workspace verification secret**. `svix-*` headers are legacy (accounts created before 2025-12-15). | `verifyRecallSignature()` accepts both header sets and both secrets. Same HMAC-SHA256 math. No `svix` dependency. |
| `Authorization: Token {key}` | The `Token` prefix is documented as optional. | Send `Token {key}` — accepted, and matches the brief. |
| Poll bot status | Documented anti-pattern. | Webhooks only. No polling anywhere. |

### Decisions taken (not asked)

1. **Audio + transcript only. No video.** `recording_config.audio_mixed_mp3` is enabled;
   `video_mixed_mp4` is omitted entirely. Halves storage and Recall cost, and Milestone 1
   has no playback UI to justify video. Flip `RECALL_CAPTURE_VIDEO=true` to add it.
2. **No auth.** Tenancy is real (row-level, every table, enforced in the Prisma client);
   *identity* is not. Tenant comes from `X-Tenant-Slug` (default `freshworks-demo`),
   reviewer from `X-Reviewer-Email` (default `demo@freshworks.example`). The review gate's
   audit log records whatever identity it is handed. Swapping in real auth means changing
   one function, `resolveContext()`. Listed under **Later**.
3. **One deployable service, two entrypoints.** `apps/api` builds once and runs as either
   `node dist/server.js` (Fastify) or `node dist/worker.js` (BullMQ). Same image, same code,
   different command. The Fastify server also serves the built frontend, so production is
   one container + N worker containers.
4. **Extraction runs on OpenAI, not Anthropic — an explicit override of the fixed stack.**
   The brief fixed Anthropic; the swap was directed after the first build and confirmed once
   the conflict was raised. Recorded here so it reads as a decision, not drift.
   `OPENAI_MODEL` defaults to `gpt-5.6-terra` — the balanced tier of the three (sol is the
   flagship, luna the cheap one) — and `OPENAI_REASONING_EFFORT` to `low`, because extraction
   is judgement-heavy but mechanical once the schema is fixed. Both are one-line env changes.

   The structural guarantee the brief asked for survives, and is arguably stronger. "Use
   tool use to force structured output; do not parse free-text JSON" becomes OpenAI
   **Structured Outputs with `strict: true`**, which constrains decoding to the schema
   rather than asking the model to comply with it.
5. **Brief versions are materialised, not derived.** Version N copies every `BriefClaim` from
   N-1 and appends the delta. `GET /brief/versions/:n` is one query; diffing is a set
   comparison. Append-only holds: no row in `brief_versions` or `brief_claims` is ever
   updated or deleted.
6. **Deduplication of claims is deterministic**, not LLM-based: normalise text (lowercase,
   strip punctuation/whitespace), hash with type, unique-constrain on `(tenant_id, dedupe_key)`.
   Cross-chunk duplicates collapse on insert. No second model call.

### Open questions for the human

1. **Which `RECALL_REGION`?** API keys, webhook secrets, bots and recordings are all
   region-scoped and non-portable. **Recall has no India region** — the four are
   `us-east-1`, `us-west-2`, `eu-central-1`, `ap-northeast-1`. With compute in Mumbai,
   `ap-northeast-1` (Tokyo) is the lowest-latency option and `us-east-1` the cheapest to
   operate; the choice is a data-residency call, not a technical one, because meeting media
   transits Recall's region either way.
2. **Was the Recall account created before 2025-12-15?** If yes, dashboard webhooks need the
   per-endpoint `RECALL_SVIX_WEBHOOK_SECRET`. If no, using that secret *breaks* verification
   and you must use only the workspace verification secret. The app supports both; set the
   one that applies.
3. **Static ngrok URL** is required for local webhook development. Recall rejects request
   bodies containing `localhost` or IPs with a 403 from CloudFront.

### Later (cut from Milestone 1 — deliberately)

Calendar OAuth · recording playback, chapters, highlights, comments · meeting notes · search ·
ask-a-meeting · sharing & permissions UI · templates · workspace management · generic summaries
and action items · real auth and RBAC · a second evidence source (the interface exists, only
`meeting_transcript` is implemented) · vector search · generation (stage 5) · performance
feedback loop (stage 6).

---

## 1. Repo layout

```
meeting-bot/
├── docker-compose.yml          postgres 16 + redis 7
├── .env.example                every secret, enumerated
├── package.json                npm workspaces
├── apps/
│   ├── api/                    ONE deployable: Fastify server + BullMQ workers
│   │   ├── prisma/schema.prisma
│   │   ├── src/
│   │   │   ├── server.ts       entrypoint: HTTP
│   │   │   ├── worker.ts       entrypoint: jobs
│   │   │   ├── env.ts          zod-validated config, fails fast
│   │   │   ├── db.ts           Prisma + row-level tenancy extension
│   │   │   ├── queue.ts        BullMQ queues + connection
│   │   │   ├── context.ts      AsyncLocalStorage tenant/reviewer context
│   │   │   ├── domain/
│   │   │   │   ├── state.ts        meeting state machine
│   │   │   │   ├── claims.ts       normalise + dedupe keys
│   │   │   │   └── brief.ts        merge, version, diff
│   │   │   ├── integrations/
│   │   │   │   ├── recall.ts       client, retry, signature verification
│   │   │   │   ├── r2.ts           S3 client, streaming upload, presign
│   │   │   │   └── anthropic.ts    propose_claims tool, chunking
│   │   │   ├── routes/             meetings, webhooks, review, brief
│   │   │   ├── jobs/               webhook, ingest-recording, ingest-transcript, extract
│   │   │   └── seed.ts
│   │   └── tests/
│   │       ├── fixtures/        recorded Recall webhook payload shapes
│   │       └── *.test.ts
│   └── web/                    React + Vite. Three screens.
└── perfstaq-logos/             brand assets (given)
```

---

## 2. Data model (Prisma / Postgres 16)

Every table carries `tenant_id`. A Prisma client extension injects it into every `where`
and `create` from `AsyncLocalStorage` — a query that escapes its tenant is not expressible
through the app's client.

| Table | Purpose | Append-only? |
|---|---|---|
| `tenants` | tenant root | — |
| `meetings` | one per call; carries the status machine | no (status mutates) |
| `state_transitions` | every status change, timestamped | **yes** |
| `evidence_sources` | pluggable: `meeting_transcript` \| `performance_metric` \| `document` | **yes** |
| `transcripts` | one per meeting, links to an evidence source | no |
| `transcript_segments` | speaker, start_ms, end_ms, text — the citable unit | **yes** |
| `artifacts` | r2_key, kind, bytes, checksum; immutable once written | **yes** (purge sets `purged_at`) |
| `candidate_claims` | typed proposals; `proposed \| approved \| rejected \| edited` | no (status mutates) |
| `claim_segments` | claim → transcript segment linkage (the provenance FK) | **yes** |
| `extraction_runs` | model, prompt version, counts, timing | **yes** |
| `review_decisions` | **the audit log.** who, when, action, previous/edited text | **yes** |
| `brief_versions` | version N of the Living Positioning Brief | **yes** |
| `brief_claims` | which claims compose version N, text frozen at merge | **yes** |
| `webhook_events` | raw payload + dedupe key + processed_at, for replay/debug | **yes** |

**Provenance is structural, not advisory.** `candidate_claims.evidence_source_id` is a
required FK and `claim_segments` must be non-empty — a claim with no evidence linkage cannot
be written. The extractor's proposals are rejected at the boundary if segment ids don't
resolve.

**Deletion / PDPL shape.** `DELETE /meetings/:id` purges R2 objects and deletes transcript,
segments, artifacts and candidate claims. `brief_claims` already merged **survive** — the
positioning memory does not silently lose its content — but are marked `evidence_redacted`,
and the UI renders them with the quote replaced by "evidence redacted". The audit log is
never deleted.

---

## 3. Meeting state machine

```
draft → bot_scheduled → bot_joined → recording → call_ended
      → media_processing → transcript_ready → extracting → in_review → merged
                                                                     ↘ failed (from any)
```

Transitions are **rank-guarded**: each state has an ordinal, and a transition to a lower or
equal rank is ignored. This is what makes out-of-order webhook delivery safe — a late
`bot.in_call_recording` arriving after `recording.done` does not rewind the meeting.
`failed` is reachable from anywhere and is terminal until an explicit retry.

| Recall event | → status |
|---|---|
| (API) `POST /meetings` | `bot_scheduled` |
| `bot.joining_call`, `bot.in_waiting_room` | `bot_scheduled` |
| `bot.in_call_not_recording` | `bot_joined` |
| `bot.in_call_recording` | `recording` |
| `bot.call_ended`, `bot.done` | `call_ended` |
| `bot.fatal` | `failed` |
| `recording.done` | `media_processing` |
| `recording.failed`, `transcript.failed` | `failed` |
| `transcript.done` → after ingest | `transcript_ready` |
| extraction job start | `extracting` |
| claims persisted | `in_review` |
| `POST /brief/versions` | `merged` |

---

## 4. Pipeline

```
POST /meetings
   └─ Recall POST /api/v1/bot/  { meeting_url, join_at, bot_name,
                                  recording_config: { audio_mixed_mp3: {} },
                                  chat.on_bot_join }
        └─ meeting.recall_bot_id, status=bot_scheduled

POST /webhooks/recall   (verify HMAC → insert webhook_event → enqueue → 200. Always <50ms.)
   ├─ bot.*              → state transition
   ├─ recording.done     → job:ingest-recording
   │      ├─ GET /recording/{id}/ → media_shortcuts.audio_mixed.data.download_url
   │      ├─ stream → R2  {tenant}/meetings/{meeting}/recording.mp3   (multipart >100MB)
   │      └─ POST /recording/{id}/create_transcript/
   │             { provider: { recallai_async: { language_code: "auto" } },
   │               diarization: { use_separate_streams_when_available: true } }
   └─ transcript.done    → job:ingest-transcript
          ├─ GET /transcript/{id}/ → data.download_url → download JSON
          ├─ stream raw → R2  {tenant}/meetings/{meeting}/transcript.json
          ├─ parse → evidence_source + transcript + transcript_segments
          └─ status=transcript_ready → job:extract
                 ├─ chunk by speaker turns (~8k tokens, 2-turn overlap)
                 ├─ OpenAI responses.create, json_schema propose_claims, strict:true
                 ├─ resolve segment ids, drop unlinked claims
                 ├─ dedupe on (tenant, type+normalised text)
                 └─ status=in_review
```

**Recall's media retention is ~7 days** (`recording_config.retention` defaults to
`{type: "timed", hours: 168}`). Artifacts are therefore downloaded **in the completion
handler**, never lazily. R2 is the system of record for media from the moment it lands.
Downloads stream through `Upload` from `@aws-sdk/lib-storage` — no whole file is ever
buffered in memory.

**Every Recall request** goes through `fetchWithRetry`, which honours `Retry-After` on 429,
waits 10s on 503, 30s on 507, and adds jitter. Non-negotiable per Recall's own docs.

---

## 5. Extraction

One OpenAI Responses call per chunk, with Structured Outputs pinned to a strict JSON
schema named `propose_claims`. `strict: true` is a decoding constraint, so there is no
free-text JSON anywhere in this path and no "the model wrapped it in a code fence"
failure mode.

```ts
claim_type = "positioning_statement" | "icp_fact" | "pain_point" | "objection"
           | "messaging_decision" | "competitor_mention" | "proof_point"

claim = {
  type: claim_type,
  text: string,               // the claim, in the tenant's voice
  confidence: number,         // 0..1
  evidence: {
    transcript_segment_ids: string[],   // must be non-empty and must resolve
    verbatim_quote: string,             // must appear in those segments
    speaker: string,
    timestamp_ms: number
  }
}
```

Strict mode supports only a subset of JSON Schema — every object needs
`additionalProperties: false` and every property in `required`, and validation keywords
(`minimum`, `minItems`, …) are not part of it. Ranges and the non-empty-citation rule are
therefore enforced in code, which is where they belonged anyway: the model cannot be
trusted to police its own evidence.

Two non-schema outcomes are surfaced as errors rather than silently becoming zero claims,
because a chunk that failed must not look like a chunk that had nothing in it:
a **refusal** (`content.type === "refusal"`) and an **incomplete** response (output
truncated against `max_output_tokens`).

Chunking is by **speaker turn**, never mid-turn — a claim's evidence must not straddle a
chunk boundary invisibly. ~8k tokens per chunk with two turns of overlap. Segment ids are
presented to the model as short handles (`s0012`) to keep them cheap and unambiguous.

Validation at the boundary, before anything is written:
- unknown or unresolvable segment ids → claim dropped, counted in `extraction_runs`
- empty `transcript_segment_ids` → dropped
- `verbatim_quote` not found in the referenced segments → dropped
- duplicate `dedupe_key` → collapsed

**Nothing extraction produces is memory.** Everything lands in `candidate_claims` with
status `proposed`. The only write path into `brief_versions` is `POST /brief/versions`,
which reads only `approved`/`edited` claims. There is no code path that writes a brief
without a human decision, and the audit log proves it.

## 6. API — `/api/v1`

| Method | Path | Request | Response |
|---|---|---|---|
| POST | `/meetings` | `{ meeting_url, join_at?, title? }` | `201 { meeting }` — creates + dispatches bot |
| GET | `/meetings` | `?status=` | `200 { meetings: [{ ...meeting, claim_counts, artifacts }] }` |
| GET | `/meetings/:id` | | `200 { meeting, transitions, artifacts, transcript, claim_counts }` |
| POST | `/meetings/:id/retry` | | `202 { meeting }` — re-dispatch or re-run failed stage |
| DELETE | `/meetings/:id` | | `204` — purges R2 + rows, redacts merged evidence |
| GET | `/meetings/:id/artifacts/:kind/url` | | `200 { url, expires_at }` — presigned GET, 1h |
| POST | `/webhooks/recall` | Recall payload | `200 { received: true }` — verified, fast-ack |
| GET | `/review-queue` | `?status=proposed&type=&meeting_id=` | `200 { claims: [{ ...claim, evidence, meeting }] }` |
| POST | `/claims/:id/approve` | `{ note? }` | `200 { claim }` |
| POST | `/claims/:id/reject` | `{ note? }` | `200 { claim }` |
| PATCH | `/claims/:id` | `{ text, note? }` | `200 { claim }` — edit-then-approve, one action |
| POST | `/brief/versions` | `{ note? }` | `201 { version }` — merge approved → new version |
| GET | `/brief/versions` | | `200 { versions: [{ version, created_at, created_by, counts }] }` |
| GET | `/brief/versions/:n` | | `200 { version, claims_by_type }` |
| GET | `/brief/versions/:n/diff/:m` | | `200 { added, removed, edited }` |
| GET | `/brief/current` | | `200 { version, claims_by_type }` — **the stage-5 read interface** |
| GET | `/healthz` | | `200 { ok, db, redis }` |

`GET /brief/current` is deliberately the only shape a generation surface would need. Stage 5
consumes it; stage 5 is not built.

Errors are uniform: `{ error: { code, message, details? } }` with 400/404/409/422/500.

---

## 7. Frontend — a workspace, not a document site

Perfstaq brand: orange `#FF7A1A` (the middle reel, and the focus/selection signal — never
a large background), ink `#111114` / `#F2F2F0`, Geist SemiBold for type and Geist Mono for
metadata. Logo and fonts from `perfstaq-logos/`. Light and dark, both first-class.

**The shell is a persistent left rail.** It never scrolls with content and never changes
between screens, so the three stages of the ring stay visible as one pipeline rather than
three unrelated pages. Each screen is composed of panes that scroll independently — the
reviewer's position never moves because something else finished loading.

1. **Meetings** — two panes. List on the left with a compose row and status chips per the
   state machine; the right pane is one meeting's passage through the pipeline: claim
   counts, R2 artifacts with presigned open links, extraction statistics (proposed /
   dropped / duplicates / persisted), and the full state-transition timeline. Deliberately
   **no transcript reader**: reading a meeting back is a notes surface, and the only place
   transcript text belongs is next to a claim that cites it.

2. **Review Queue** — *built first; this screen is the product.* Three panes: claim types,
   the queue, and the claim. Provenance is a first-class block in the detail pane, never a
   disclosure — the quote, the speaker, the timestamp, and the cited turns in context are
   all on screen at the moment of decision. Approve / reject / edit-then-approve sit in a
   sticky action bar. Keyboard is the fast path: `a` `r` `e`, `j`/`k`, `⌘⏎` to save an edit
   and approve, `?` for the panel. A decided row holds for ~380ms before leaving, so a fast
   reviewer never loses their place.

3. **Brief** — two panes. Version history down the left with per-version `+ / ~ / −`
   deltas; the document on the right renders as an actual document — claim-type sections,
   numbered assertions, citations set beneath in mono. Choosing a version to compare
   against switches the document into diff mode: added, edited (strikethrough → new), and
   removed, with an unchanged count.

**Responsive without losing the paradigm.** Under 1240px the type rail collapses into a
select in the queue header rather than squeezing the detail pane, which is where the
decision is actually made. Under 900px the rail becomes a top bar and the panes stack.

## 8. Testing

Webhook replay fixtures are mandatory. `tests/fixtures/` holds recorded Recall payload
shapes (`bot.*`, `recording.done`, `transcript.done`, `transcript.failed`) and a real-shaped
transcript download matching the documented
[JSON transcript download schema](https://docs.recall.ai/docs/download-schemas).

Covered end to end with mocked HTTP (`undici` MockAgent) and a real Postgres:
signature verification (valid / tampered / replayed / unsigned) → dedupe → state transition →
artifact upload to a mocked R2 → transcript parse → extraction with a mocked OpenAI
response → review queue → approve → brief version → diff.

Plus units: state machine rank guards, out-of-order webhook ordering, claim dedupe,
chunking boundaries, evidence validation rejection, brief diff.

## 9. Deploy — AWS Mumbai (`ap-south-1`)

One ECS Fargate service (`node dist/server.js`) + one worker service
(`node dist/worker.js`) from the same image, both in **`ap-south-1`**. RDS Postgres 16,
ElastiCache Redis. R2 for artifacts. `ALLOWED_ORIGINS` for CORS; the API serves the built
SPA, so there is usually only one origin.

**Three things about `ap-south-1` that will bite if nobody checks them first:**

1. **It is an opt-in region.** A new AWS account cannot see it until it is enabled in
   Account → AWS Regions. IAM propagation after enabling takes minutes, not seconds.
2. **Service and instance-type coverage is thinner than Mumbai (`ap-south-1`).** Verify
   Fargate, RDS Postgres 16 and ElastiCache instance classes are all available in
   `ap-south-1` before committing — availability differs by AZ within the region, so check
   per-AZ, not just per-region.
3. **The Recall region is a separate decision.** Recall has no India region, so meeting
   media is processed outside India regardless of where this service runs. If data
   residency is the reason for choosing Mumbai, that constraint is not satisfied by
   compute placement alone and needs to be raised explicitly.

**Cloudflare R2** has no Mumbai location. The closest control is a bucket **location
hint of `apac`**, set once at bucket creation and immutable afterwards — so it must be
right the first time:

```bash
npx wrangler r2 bucket create mcos-artifacts --location apac
```

R2's `jurisdiction` flag (which *does* enforce data locality) only supports `eu` and
`fedramp`; there is no APAC jurisdiction. A location hint is a placement preference, not a
residency guarantee.

## 10. Working order — status

| # | Step | State |
|---|---|---|
| 1 | Scaffold, docker-compose, Prisma schema, migrations | done |
| 2 | Recall client + `POST /meetings` + bot dispatch | done — **not yet run against a real meeting** |
| 3 | Webhook endpoint: verification, fast-ack, dedupe, BullMQ handoff | done |
| 4 | Completion handlers: transcript fetch + R2 artifact pipeline | done — R2 exercised against a mock, not a real bucket |
| 5 | Extraction job + `propose_claims` schema + chunking/dedupe | done — **verified against live OpenAI** |
| 6 | Review queue API + UI — the review gate | done |
| 7 | Brief versioning + merge + diff + UI | done |
| 8 | State machine hardening, failure/retry, seed + fixtures + tests | done — 62 tests passing |

### What has NOT been verified against live services

Every third party is mocked in the test suite, and the `.env` in this repo holds
placeholders. These need real credentials before anyone should call this production-ready:

- **Recall.ai** — a real bot dispatched to a real meeting, and a real signed webhook
  arriving through ngrok. The payload shapes in `tests/fixtures/` come from the documented
  schemas, not from captured traffic; re-record them against the first real call and re-run
  the suite.
- **Cloudflare R2** — a real bucket, real credentials, and one recording large enough
  (>100MB) to exercise the multipart path in `streamUrlToR2`.
- **OpenAI** — ✅ verified. One live `gpt-5.6-terra` run over the 14-segment demo
  transcript proposed 11 claims; every one cited a resolvable segment and every quote
  passed the evidence gate, so nothing was dropped (1,420 input / 1,080 output tokens).
  That is a *clean* transcript, though — the number worth watching is the drop rate on a
  real, noisy call, and `extraction_runs` records it per run.
