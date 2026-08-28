# PerfStaq — Milestone 1 Completion: Multi-Agent Implementation Plan

> **How to use this file:** Place it at the repo root as `IMPLEMENTATION_M1.md`. Also ensure the repo has the `CLAUDE.md` defined in §2 (create it from this doc if missing). Run the Orchestrator prompt (§4) in Claude Code from the repo root. The orchestrator spawns worker agents in **git worktrees**, one per feature branch, so agents never collide on the same working directory.

---

## 0. Mission

Close the Milestone-1 ring on the live product at `bot.perfstaq.com`:

```
meeting → bot → transcript (WORKING, DO NOT BREAK)
       → extraction → review gate → versioned brief → e2e demo (THIS PLAN)
```

Five workstreams: **(A)** test fixtures & golden transcript, **(B)** extraction quality, **(C)** review gate, **(D)** brief versioning, **(E)** end-to-end demo hardening. Built in parallel where dependencies allow, each on its own branch, each raising its own PR with passing tests.

---

## 1. Current state — respect it

Working in production (verified 26 Aug 2026):
- Recall.ai bot dispatch, webhook ingestion, state machine (`bot_scheduled → in_call → recording → call_ended → fetching_media → transcript_ready`), timestamps per transition.
- Artifacts persisted to R2 (`recording audio`, `transcript json`), presigned open links.
- Meetings list UI + meeting detail with extraction stats panel (model, chunks, proposed, dropped, duplicates, persisted) and purge.
- Nav scaffolding: Meetings, Review queue, Brief (queue and brief are NOT yet functional).
- Extraction job runs but has produced 0 claims (previously blocked API key — now fixed; only trivial test transcripts ingested so far).

**Hard rule: no agent modifies the webhook handlers, Recall client, state machine, or R2 pipeline except where a spec below explicitly says so. These are load-bearing walls.**

---

## 2. `CLAUDE.md` — project context every agent inherits

Create/update the repo-root `CLAUDE.md` with exactly this content (agents read it automatically):

```markdown
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
- dev: [FILL: e.g. pnpm dev]
- test: [FILL: e.g. pnpm test]
- lint: [FILL: e.g. pnpm lint]
- db migrate: [FILL: e.g. pnpm prisma migrate dev]
(Orchestrator: fill these from package.json before spawning workers.)

## What NOT to do
- Do not touch webhook verification, Recall client, or R2 streaming code
  unless the task spec says so.
- Do not add auth providers, calendar sync, chat/Ask features, strategy
  screens, or any Phase-2 surface. Out of scope = out of branch.
- Do not "improve" working code you pass by. Note it in the PR body instead.
```

---

## 3. Git & agent workflow rules

1. **Base branch:** `main` (production). Integration branch for this milestone: `m1-ring` (create from `main`; all feature PRs target `m1-ring`; one final PR `m1-ring → main`).
2. **One worktree per agent** so parallel agents never share a working dir:
   ```bash
   git worktree add ../psq-a-fixtures   -b feat/m1-fixtures     m1-ring
   git worktree add ../psq-b-extraction -b feat/m1-extraction   m1-ring
   git worktree add ../psq-c-gate       -b feat/m1-review-gate  m1-ring
   git worktree add ../psq-d-brief      -b feat/m1-brief        m1-ring
   git worktree add ../psq-e-e2e        -b feat/m1-e2e          m1-ring
   ```
3. **Plan first, then code.** Every worker agent starts in plan mode: restate its spec, list files it will touch, list files it will NOT touch, list tests it will write. Only then implement. If the plan conflicts with an invariant, stop and report.
4. **TDD where the spec defines contracts:** write the failing test from the acceptance criteria first (API contract tests, gate tests, version-merge tests), then implement to green.
5. **PR discipline:** small, single-feature PRs into `m1-ring`. PR body must contain: scope, schema changes, how tested, screenshots/GIF for UI, invariant checklist (copy from CLAUDE.md, tick each), out-of-scope notes.
6. **Merge order (dependency-driven):** A → (B ∥ C) → D → E. C may start against fixture data from A without waiting for B.
7. **No agent merges its own PR.** The Reviewer agent (§4) reviews every PR against the invariants and the spec before merge.

---

## 4. Agent roster & orchestrator prompt

### Orchestrator (you, Claude Code, in the main repo)
```
Read IMPLEMENTATION_M1.md and CLAUDE.md fully. Fill the Commands section of
CLAUDE.md from package.json. Create branch m1-ring from main. Create the five
worktrees per §3. Then spawn subagents as follows, giving each ONLY its spec
section plus CLAUDE.md:

- Agent A (fixtures)   → §5A in ../psq-a-fixtures
- Agent B (extraction) → §5B in ../psq-b-extraction  [start after A's PR merges]
- Agent C (gate)       → §5C in ../psq-c-gate        [start after A's PR merges]
- Agent D (brief)      → §5D in ../psq-d-brief       [start after C's PR merges]
- Agent E (e2e)        → §5E in ../psq-e-e2e         [start after B, C, D merge]
- Reviewer agent       → reviews each PR: invariants checklist, spec
  conformance, test quality, no scope creep. Requests changes or approves.

After each merge into m1-ring, run the full test suite in the main worktree.
If red, halt downstream agents and dispatch a fix task to the owning agent.
When E is merged and green, open PR m1-ring → main with the consolidated
changelog and the demo recording checklist from §7.
```

---

## 5. Feature specs

### §5A — Agent A: Fixtures, golden transcript & seed (branch `feat/m1-fixtures`)

**Goal:** realistic test data so B–E build against truth, not toy input.

Deliverables:
1. `tests/fixtures/transcripts/golden-freshworks.json` — a **golden transcript**: 30–40 min simulated Freshworks positioning workshop, 4 speakers (e.g., Priya Raman VP Mktg, Arjun CEO, Meera PMM, Dev Sales lead), 250–400 speaker-segmented turns with realistic `start_ms/end_ms`. Content MUST embed extractable material, with a companion answer key:
   - ≥5 positioning statements (incl. "mid-market IT teams underserved by legacy ITSM"),
   - ≥4 ICP facts (incl. "200–2,000 seats"), ≥4 pain points, ≥3 objections
     (incl. security-review doubt), ≥2 messaging decisions, ≥2 competitor
     mentions (Zendesk, ServiceNow), ≥2 proof points (incl. "live in 6 days at Acme"),
   - plus deliberate NOISE: small talk, scheduling chatter, a joke, an
     abandoned tangent — things that must NOT become claims.
2. `tests/fixtures/transcripts/golden-answer-key.json` — expected claims: `{type, text_gist, evidence_segment_ids[], must_extract: true|false}` including 5+ explicit `must_extract:false` noise entries.
3. A second short transcript `golden-discovery.json` (~15 min client-discovery call) for multi-meeting brief tests, with its own mini answer key.
4. `tests/fixtures/webhooks/` — recorded-shape Recall webhook payload fixtures for each lifecycle event (redact secrets), for replay tests.
5. `scripts/seed-dev.ts` — creates tenant `freshworks-demo`, ingests both golden transcripts as completed meetings (state `transcript_ready`) WITHOUT running extraction and WITHOUT touching brief tables. Guard: refuses to run if `NODE_ENV=production`.
6. Test helper `tests/helpers/llm-mock.ts` — deterministic mock of the extraction model returning canned tool-call outputs, so C and D test without live API calls.

Acceptance criteria:
- `pnpm seed:dev` (or repo equivalent) produces two `transcript_ready` meetings with segments queryable.
- Fixtures load in <1s; answer key ids resolve to real segment ids in the golden transcript.
- No production code paths modified.

---

### §5B — Agent B: Extraction quality loop (branch `feat/m1-extraction`)

**Goal:** golden transcript in → high-quality typed claims out, measurably.

Scope (may touch extraction job + prompt + schema only):
1. **Structured output enforcement:** extraction must use a tool/function schema `propose_claims` with the claim union type: `positioning_statement | icp_fact | pain_point | objection | messaging_decision | competitor_mention | proof_point`, each `{type, text, confidence: high|medium|low, evidence: {segment_ids[], verbatim_quote, speaker}}`. Malformed tool output → job retries once, then marks meeting `extraction_failed` with reason. Never parse free-text JSON.
2. **Evidence gate (server-side):** claims whose `segment_ids` don't exist in the transcript, or whose `verbatim_quote` is not a fuzzy-substring (normalized, ≥0.85 similarity) of the cited segments → DROP, increment `dropped` counter with reason `failed_evidence_gate`. (The stats panel already displays this — wire the real numbers.)
3. **Chunking:** split by speaker turns at ~8k tokens with 1-turn overlap; dedupe near-identical claims across chunks (normalized text similarity ≥0.9 keeps highest-confidence copy; increment `duplicates`).
4. **Failure visibility:** add meeting states `extracting → extracted | extraction_failed(reason)`; surface reason string in the meeting detail UI (one line, no redesign).
5. **Eval harness:** `pnpm eval:extraction` runs extraction on the golden transcript against the answer key and prints: recall of `must_extract:true` items, false-positive count (claims matching `must_extract:false` noise), type-accuracy, evidence-accuracy (cited segments ⊇ expected). Writes `eval-results.json`.
6. **Prompt iteration:** iterate the extraction prompt until eval hits: **recall ≥0.8, noise false-positives = 0, type accuracy ≥0.85, evidence accuracy ≥0.9** on the golden transcript. Commit the prompt as a versioned file `src/extraction/prompts/extract-v{n}.ts` — never inline strings; record eval scores in the file header comment.

Explicitly out of scope: meeting-type classification profiles, summaries, any UI beyond the failure-reason line.

Acceptance criteria: eval thresholds met and reproducible via mock-recorded snapshot; live-model eval run documented in PR body with scores; webhook replay tests still green.

---

### §5C — Agent C: Review gate — API + UI (branch `feat/m1-review-gate`)

**Goal:** the product. Approve/reject/edit with a bulletproof write path.

**API (contract-test these first):**
- `GET /api/v1/meetings/:id/claims?status=proposed` → claims with full provenance (quote, speaker, segment refs, confidence, type).
- `POST /api/v1/claims/:id/approve` → status `approved`, writes `review_decisions{claim_id, actor, action:'approve', at}`.
- `POST /api/v1/claims/:id/reject` → status `rejected` (row retained), decision logged.
- `PATCH /api/v1/claims/:id` body `{text}` → creates NEW claim row `{status:'approved', edited_from: original_id, same evidence}`, marks original `superseded`, logs `action:'edit_approve'` with before/after text.
- `POST /api/v1/meetings/:id/bulk-approve` body `{claim_ids[]}` → only claims with `confidence='high'` allowed; others rejected from the batch with per-id errors.
- **Gate enforcement:** DB/service layer must make it impossible to set claim status `approved` outside these endpoints (single service function, no other callsites; unit test asserts no other write path exists by grepping for direct status writes in CI).
- All endpoints tenant-scoped; 404 cross-tenant.

**UI (Review queue page, matching existing dark theme):**
- Claim cards grouped by type; type badge, confidence chip, claim text prominent; provenance block ALWAYS visible: mono verbatim quote, orange left border, speaker · timestamp · meeting.
- Actions: Keep (accent), Edit, Toss. Keyboard `A`/`E`/`R`, `Esc` exits edit. Card animates out; next card focuses. Undo toast 5s (undo calls the inverse endpoint before commit-window closes — implement as delayed commit client-side; server actions remain immediate+logged if simpler, in which case undo issues a compensating decision, also logged).
- Edit mode: original text struck-through above editable field; save = edit-approve.
- Header: `n of m` progress + bulk panel "Keep all {k} high-confidence" listing excluded flagged items.
- Right rail: session audit feed from `review_decisions` (live).
- Completion state: "X kept · Y edited · Z tossed → **Merge into Brief**" button (button calls D's endpoint; behind a feature flag until D merges — render disabled with tooltip "brief merge lands next").
- Empty state: "Nothing waiting. PerfStaq will ping you after your next call."

Tests: contract tests for all endpoints incl. gate-bypass attempts (direct status write via any other route must be impossible), cross-tenant 404s, edit-lineage integrity (original superseded, new claim carries evidence), bulk-approve confidence filter. UI: component tests for keyboard flow + provenance always-rendered.

Acceptance: with A's fixtures + mocked claims, a human can review 14 claims end-to-end in <60s using only the keyboard; every action produces a `review_decisions` row; zero write paths bypass the gate.

---

### §5D — Agent D: Brief versioning & diff (branch `feat/m1-brief`)

**Goal:** append-only memory with visible compounding.

**Schema (additive):** `brief_versions{id, tenant_id, version_no, created_at, created_by, source_meeting_id, note}`, `brief_version_claims{version_id, claim_id}` (join snapshot). Version N contents = all currently-approved claims at merge time; deltas derived by set-diff N vs N-1 (added / removed / edited via `edited_from` lineage).

**API:**
- `POST /api/v1/brief/versions` body `{meeting_id}` → snapshots approved claims into new version; idempotent per meeting (re-merge of same meeting with no new decisions → 409 `no_changes`).
- `GET /api/v1/brief/versions` → list with `{version_no, date, source_meeting, counts:{added,removed,edited}}`.
- `GET /api/v1/brief/versions/:n` → claims grouped by type with provenance chips.
- `GET /api/v1/brief/versions/:n/diff/:m` → `{added[], removed[], edited[{from,to}]}`.
- Append-only enforced: no UPDATE/DELETE on version tables (DB constraint or service-layer guard + test).

**UI (Brief page):**
- Document view grouped: Positioning · ICP · Pain points · Objections · Messaging decisions · Competitors · Proof points. Each claim row: text + source chip (meeting · date), hover reveals verbatim quote.
- Header: version dropdown (`v4 · Aug 26`), **Diff toggle** (default ON immediately after a merge): added rows accent-tinted `+ NEW`, removed struck `− GONE`, edited shown from→to.
- Right rail: version history `v1…vN` with `merged from {meeting} · +a −r ~e`; clicking a version renders the brief as of then.
- Empty state: "The brief builds itself from your first approved call."
- Wire C's "Merge into Brief" button; success → navigate to Brief with diff ON.

Tests: merge snapshot correctness across the two golden meetings (v1 from workshop approvals, v2 after discovery-call approvals; diff counts match decisions made), idempotency 409, append-only guard, as-of rendering, edit lineage shows as `edited` not `added+removed`.

Acceptance: reviewing meeting 2 and merging produces v2 whose diff against v1 exactly reflects the review session; no mutation of v1 possible.

---

### §5E — Agent E: End-to-end hardening & demo (branch `feat/m1-e2e`)

**Goal:** the ring runs clean, twice, on camera.

1. **E2E test (Playwright):** seed → open meeting 1 → review all claims via keyboard (mocked LLM path) → merge v1 → seed meeting 2 → review → merge v2 → assert diff view shows expected added/removed/edited. Runs headless in CI.
2. **Live-path smoke script** `scripts/smoke-live.md`: step-by-step manual runbook for a REAL Google Meet call end-to-end (bot join → transcript → real extraction → review → merge), with expected states and failure triage per stage.
3. **Meeting one-liner:** cheap LLM call at `transcript_ready` producing a 1-line title + 3-sentence digest stored on the meeting; meetings list shows the title instead of raw URL; digest shown atop the review queue. (Small, high demo value; reuse extraction job infra; failure = non-blocking, falls back to URL.)
4. **Polish pass (bounded):** loading/empty/failed states across the three screens per the wireframe spec; retry action on `extraction_failed`; no console errors; Lighthouse pass ≥85 perf on the three pages.
5. **Demo capture checklist** committed as `docs/demo-runbook.md`: the 90-second script (meetings → gate with keyboard → edit moment → merge → diff → version rail), what to say per click, reset instructions (`pnpm seed:demo` restoring the exact pre-demo state).

Acceptance: E2E green in CI; a full demo reset-and-run completes in <5 minutes; screen recording of the complete ring attached to the PR.

---

## 6. Testing strategy (all agents)

- **Unit:** pure logic (chunking, dedupe, evidence gate, diff computation).
- **Contract:** every API endpoint request/response + auth/tenant + failure shapes.
- **Webhook replay:** existing fixtures from A must stay green in every PR — this is the don't-break-production alarm.
- **Eval (B only):** golden-transcript scores are part of the PR, not a vibe.
- **E2E (E):** the ring, headless, with mocked LLM for determinism.
- **CI gate:** lint + typecheck + unit + contract + replay on every PR; E2E on `m1-ring`.
- LLM calls in tests are ALWAYS mocked (A's helper) except the explicitly-marked live eval run.

## 7. Definition of done (milestone)

- [ ] All five PRs merged to `m1-ring`; `m1-ring → main` merged; deployed.
- [ ] Extraction eval ≥ thresholds on golden transcript (scores in repo).
- [ ] Gate invariant test proves no non-gate write path to approved status.
- [ ] Two-meeting ring produces v1 → v2 with correct diff, on production.
- [ ] Demo recording exists; `docs/demo-runbook.md` reset works.
- [ ] Zero regressions in webhook replay suite.

## 8. Out of scope — do not build (any agent)

Meeting-type classification profiles · Ask-the-Brain · claim Map · Strategy screen/plays · Content Studio · psychology profile · WhatsApp/Slack pings · calendar sync · auth changes · multi-workspace UI · performance-data ingestion. Note ideas in PR bodies under "Later"; never in code.

---

## 9. Model routing policy — Claude Fable / Opus / Sonnet / Haiku

Two separate concerns. Don't mix them up: **(I)** which model runs each *Claude Code agent* during this build, and **(II)** which model the *product itself* calls at runtime. Different economics, different rules.

### 9-I. Claude Code agents (the build)

Principle: spend the strongest model where judgment is scarce (architecture, review, prompt quality), spend cheaper models where the spec is already precise (well-scoped implementation). This plan front-loads precision into the specs exactly so workers don't need the top model.

| Agent | Model | Why |
|---|---|---|
| **Orchestrator** | **Fable** (`claude-fable-5`) | Coordinates everything: worktrees, dependency order, halting on red suites, dispatching fixes. Mistakes here cascade into every branch. |
| **Reviewer** | **Fable**; fallback **Opus** | Reviews PRs against invariants — the last line of defense for the gate. Never below Opus. |
| **Agent B (extraction quality)** | **Fable**; fallback **Opus** | Prompt engineering against eval thresholds is judgment-heavy; the extraction prompt IS product quality. Cheaping out here costs more in iteration loops than it saves in tokens. |
| **Agent C (review gate)** | **Opus** (`claude-opus-4-8`) | Security-adjacent (write-path enforcement, tenant isolation) but the contract is fully specified in §5C. Opus executes precise specs excellently. |
| **Agent D (brief versioning)** | **Opus** | Set-diff logic + append-only guards; well-specified, moderate complexity. |
| **Agent A (fixtures)** | **Sonnet** (`claude-sonnet-4-6`) | Content generation against an explicit checklist. The golden transcript needs realism, not architecture. If the answer-key linkage comes out sloppy, redo once on Opus. |
| **Agent E (e2e + polish)** | **Sonnet**; escalate flaky-test debugging to **Opus** | Playwright flows and UI states from an existing wireframe spec — mechanical with taste, not judgment. |

**Fallback ladder (usage limits):** Fable → Opus → Sonnet, in that order, and **never skip a rung**. Rules when a downshift happens:

1. **Announce it.** The orchestrator notes in the PR body: "built partially on {model} due to limits." Silent downgrades make quality drift untraceable.
2. **Downshift mid-task only at a commit boundary.** Finish the current red→green cycle, commit, then switch. Never swap models mid-file.
3. **Never downshift the Reviewer below Opus.** If only Sonnet is available, PRs queue unreviewed until Opus capacity returns. A Sonnet-reviewed gate is a gate you haven't reviewed.
4. **Upshift-sensitive work waits.** If Fable is exhausted and Agent B hasn't hit eval thresholds after 3 Opus iterations, pause B rather than burning cycles — resume on Fable. Thresholds are the contract; the model serves them.
5. **Weekly-limit tactics:** batch Fable work (orchestration decisions, B's prompt iterations, final reviews) into planned sessions; run A/E Sonnet work during Fable cooldowns. Don't idle Fable capacity on tasks Sonnet handles.

### 9-II. Product runtime models (the API your code calls)

All model ids live in env/config — **never hardcode strings in call sites**:

```
EXTRACTION_MODEL=claude-opus-4-8        # quality-critical, low volume
EXTRACTION_FALLBACK=claude-sonnet-4-6
DIGEST_MODEL=claude-haiku-4-5-20251001  # cheap, high volume
DIGEST_FALLBACK=claude-sonnet-4-6
EVAL_MODEL=<always pinned = EXTRACTION_MODEL>
```

| Runtime job | Model | Rationale |
|---|---|---|
| **Claim extraction** | **Opus**, fallback Sonnet | The product's output quality ceiling. Volume is low (per-meeting), so cost is trivial relative to value. Do NOT use Fable here yet: it's the newest tier, so validate cost/latency on your eval harness before promoting — if Fable beats Opus on the golden-transcript eval by ≥5 points on recall or evidence accuracy, promote it deliberately, as a config change with the eval diff in the commit. |
| **Meeting one-liner + digest** (§5E) | **Haiku**, fallback Sonnet | High-frequency, low-stakes summarization. Failure is non-blocking by spec. |
| **Future (not this milestone):** Ask-the-Brain, Strategy plays, Studio generation | Sonnet default; Opus for strategy-play synthesis | Decide with evals when built; noted here so nobody hardcodes ahead of the decision. |

**Runtime fallback semantics (implement in the LLM client wrapper, once, used by all jobs):**
- On 429/overloaded/model-unavailable: retry ×2 with backoff on the primary, then one attempt on the fallback model, then fail the job with the model chain recorded in the failure reason.
- **Tag every extraction with the model that produced it** (`claims.extracted_by_model`, additive column) — when quality questions arise later, you need to know which model wrote which claims.
- Eval runs (§5B) always pin the primary extraction model. An eval that silently ran on the fallback is not an eval.

**Consistency rule:** a single meeting's extraction never mixes models across chunks. If fallback triggers mid-meeting, restart that meeting's extraction wholly on the fallback model.
