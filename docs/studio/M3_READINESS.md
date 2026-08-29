# M3 Readiness — the Content Studio, audited against the code

**Audited 29 Aug 2026** against `90ad45b` (studio-main, squash-merged to main as `aeeda6d`).
Production at audit time is Milestone 1, `87165c3`.

Every claim below was checked against the code, the terraform, a live probe of
`bot.perfstaq.com`, or a measurement taken on this machine. Where the spec docs and the
code disagree, the code is recorded as the truth and the disagreement is listed as a
finding. Claims taken from `M2_CLOSEOUT.md` were re-verified, not copied; two of them
turned out to be understated and are corrected here.

**Method and its limits.** Nothing in this document was observed running in production,
because the Content Studio is not in production and — see §3 — could not complete a
render there if it were. Production statements are limited to what an unauthenticated
HTTP probe can establish. Everything else is either static verification against the
merged tree or a local measurement on named hardware (Apple M4, 10 cores, 16 GB, macOS
26.6, Node v22.22.0, Remotion 4.0.518).

---

## 1. What is live

`401` from an unauthenticated probe means the route is registered and demanded auth;
`404` means it is not registered at all (`/api/v1/nonexistent-route-xyz` returns `404`,
which is the control).

| Capability | State | Evidence |
|---|---|---|
| **Meeting ingestion** | **working in prod** | `POST /api/v1/webhooks/recall` → `401` (signature rejected, route live). [`routes/webhooks.ts:22`](../../apps/api/src/routes/webhooks.ts:22). `POST /api/v1/meetings` → `401`. |
| **Extraction** | **working in prod** (not directly observable) | Shipped in `87165c3`; runs on the `worker` service, which terraform does deploy ([`ecs.tf:251`](../../infra/terraform/ecs.tf:251), [`worker.ts:61`](../../apps/api/src/worker.ts:61)). No unauthenticated surface exposes it, so this is inference from deployment topology, not observation. |
| **Review gate** | **working in prod** | `GET /api/v1/review-queue` → `401`, `GET /api/v1/review-decisions` → `401`. [`routes/review.ts:41,168`](../../apps/api/src/routes/review.ts:41). |
| **Brief versioning** | **working in prod** | `GET /api/v1/brief/current` → `401`, `GET /api/v1/brief/versions` → `401`. [`routes/brief.ts:81,112`](../../apps/api/src/routes/brief.ts:81). |
| **ContentBrief generation** | **working locally only** | `GET /api/v1/content/briefs` → **`404` in production**. The route exists in the merged tree at [`routes/content.ts:38`](../../apps/api/src/routes/content.ts:38) and is covered by `content-routes.test.ts`; it is simply not deployed. |
| **Plan build** | **working locally only, and unreachable from the UI** | `POST /content/plans` exists ([`content.ts:164`](../../apps/api/src/routes/content.ts:164)) and `plan.build` runs on the deployable `worker` ([`worker.ts:103`](../../apps/api/src/worker.ts:103)). **Nothing in `apps/web` calls it** — the only Studio calls are generate/approve/list/retry ([`ContentReviewQueue.tsx`](../../apps/web/src/pages/ContentReviewQueue.tsx), [`PlanBuilds.tsx:65,97`](../../apps/web/src/components/PlanBuilds.tsx:65)). |
| **Render** | **not wired** | Fails on the first of three independent conditions — see §3. |
| **QC** | **not wired** | `render.qc` is handled only by [`worker-media.ts:29`](../../apps/api/src/worker-media.ts:29). Terraform defines three task definitions — api, worker, migrate ([`ecs.tf:197,251,311`](../../infra/terraform/ecs.tf:197)) — and two services. **Nothing runs `worker-media.js`**, and `Dockerfile.media` is never built or pushed by any script or workflow. Jobs enqueue and are never consumed. |
| **Media analysis** (beat grid, word timings) | **not wired** | Same cause: `media.analyze` is a `worker-media` queue ([`worker-media.ts:24`](../../apps/api/src/worker-media.ts:24)). Without it there is no beat grid, and §2 records what the planner then does. |

**The two-worker split is the single largest deployment gap.** The code has always had
two workers; the infrastructure has only ever had one.

---

## 2. The honest gaps

### 2.1 Footage selection (03 §6) and the derived G1b exclusion

**Missing:** the whole segment-selection stage. `plan.build` passes `removesFootage: false`
as a literal ([`plan-build.ts:157`](../../apps/api/src/jobs/plan-build.ts:157)), commented
*"The selection stage of 03 §6 does not exist, and under the ruling it cannot exist without
a music bed."* `buildRenderPlan` defaults the same field to `false`
([`plan-builder.ts:202`](../../apps/api/src/domain/studio/plan-builder.ts:202)). No caller
anywhere sets it true except tests.

**Cost today:** every reel is a **continuous playthrough**. The "cuts" change camera
framing and captions; they never remove a frame of footage. The reference reel this
product is modelled on removes footage constantly — that is what a jump cut *is*.

**Blocks:** G1b, which is not failed but *excluded by derivation* — `qc-render.ts:188-199`
marks it `not_applicable` with the reason `continuous_playback_no_discontinuities`
precisely because there are no discontinuities for a scene detector to find. Measured on
all three templates: `planCuts 26/28/30, detectedCuts 0`. **The gate is honest about being
unearned, and it will start scoring itself the moment a plan removes footage** — but today
one of the milestone's two headline gates has never returned a verdict.

Coupled to the music bed by §12.13: cutting in output time requires an audio bed that
survives the cut, and no licensed audio asset exists in the repo.

### 2.2 Style transfer: OCR signals at confidence 0, grade unmapped

**Missing (OCR):** three of the twelve fingerprint signals are typed `nullable` and
populated `null` — `wordsPerChunkMedian`, `styleClass`, `positionSequence`, plus the
`emphasis` object ([`fingerprint.ts:120-133`](../../apps/api/src/domain/studio/fingerprint.ts:120)).
`isUsable()` gates on `confidence > 0` ([`fingerprint.ts:48`](../../apps/api/src/domain/studio/fingerprint.ts:48)),
so they route to template defaults, which is what `04 §3` specifies. The behaviour is
correct; the capability is absent.

**Missing (grade):** not a confidence problem. The fingerprint measures **absolute finished
pixels**; a template's grade is **multipliers over an ungraded source**
([`style-transfer.ts:388-397`](../../apps/api/src/domain/studio/style-transfer.ts:388)).
`fieldSources["grade"] = "template_default"` unconditionally. Only the ordinal *warmth rank*
survives, at weight `0.25` in template selection ([`style-transfer.ts:172`](../../apps/api/src/domain/studio/style-transfer.ts:172)).

**Cost today:** "style transfer" transfers **rhythm**, and ranks templates by warmth. It does
not transfer caption style, caption position pattern, emphasis treatment or grade. A customer
who uploads a reference reel expecting their look to be matched gets their *pacing* matched
and the template's look.

**Blocks:** any claim that the product learns a brand's visual style from an example.

### 2.3 Remotion Lambda (ADR-7) — and it is worse than local-only

The closeout says Lambda is descoped and `render.submit` "fails by name rather than silently
falling back to local." True, and the failure is well built
([`render-submit.ts:76-130`](../../apps/api/src/jobs/render-submit.ts:76)). But **the local
path is not available in production either**:

1. `RENDER_BACKEND` is unset. It appears nowhere in `common_environment`
   ([`ecs.tf:157-181`](../../infra/terraform/ecs.tf:157)), nowhere in `required_secrets`
   ([`secrets.tf:91-100`](../../infra/terraform/secrets.tf:91)), and `optional_secrets`
   carries a validation whitelist that would **reject** it
   ([`variables.tf:389-406`](../../infra/terraform/variables.tf:389)). → `render_failed(backend_unconfigured)`.
2. Set it to `local` and the next failure is `local_renderer_missing`: the lean `Dockerfile`
   copies `packages/render/package.json` and `packages/render/dist` and **not**
   `packages/render/scripts/`, where `render-plan.mjs` lives.
3. Set it to `lambda` and the next failure is `lambda_unavailable`: all four
   `REMOTION_LAMBDA_*` variables are unset.

**Cost today:** rendering is a developer-workstation capability, not a product capability.
The ADR-5 licensing decision it depends on is still deferred.

### 2.4 The consent flag absent from retention (§12.36)

`RETENTION_DAYS` defaults to `30` and terraform never sets it, so **every tenant gets the
same 30-day reference-reel retention**. `env.ts:153` says so in as many words: *"no consent
flag exists yet to gate a shorter one."* A search for `consent` across
`apps/api/src` and `apps/api/prisma` returns OAuth re-consent and prose only — **no column,
no field, no enum** anywhere in the schema.

**Cost today:** the policy `04 §5` describes — *deleted after analysis, or retained ≤30 days
with tenant consent* — is implemented as its ceiling for everyone, consented or not.

**Working correctly:** the sweep itself. `media.purge-references` is registered as a
repeatable BullMQ job at `0 4 * * *` ([`worker.ts:183-186`](../../apps/api/src/worker.ts:183),
[`queue.ts:199`](../../apps/api/src/queue.ts:199)) on the `worker` service, which *is*
deployed. §12.39's inversion — keeping forever exactly what should go first — is fixed and
covered by `media-purge.test.ts`.

### 2.5 `plan_infeasible`: the attempt row **does** reach the UI

**This one is closed.** Traced end to end:

`plan-build.ts:345` writes `failureKind: "plan_infeasible"` onto the attempt row →
`GET /content/plans` and `GET /content/plans/:id` serialise it
([`content.ts:226,257`](../../apps/api/src/routes/content.ts:226)) →
[`PlanBuilds.tsx:65`](../../apps/web/src/components/PlanBuilds.tsx:65) fetches
`/content/plans?limit=25` and `:97` posts the retry → the component is mounted at
[`ContentReviewQueue.tsx:248`](../../apps/web/src/pages/ContentReviewQueue.tsx:248),
which is routed at `/content` ([`App.tsx:84`](../../apps/web/src/App.tsx:84)).
The attempt row is opened *before* the enqueue (`content.ts:186-194`), so the handle is
pollable from the moment the caller has it.

**The caveat that matters:** the surface that *displays* a failed build is complete, and
the surface that *starts* a build does not exist (§1). Today a user can only reach
`PlanBuilds` in a state populated by an API client outside the product.

### 2.6 Also found — not on the original list

| Finding | Evidence | Consequence |
|---|---|---|
| **No footage upload path at all.** The only code creating a `MediaAsset` is two dev scripts. | `mediaAsset.create` appears at [`prove-plan-chain.ts:103,290`](../../scripts/studio/prove-plan-chain.ts:103) and [`w4-fixture-chain.ts:119`](../../scripts/studio/w4-fixture-chain.ts:119). No route, no UI. | A customer cannot get a video into the system. See §3. |
| **G13 (Reproducibility) has never been scored.** `pass: null`, note: *"no --prev-checksum given — recorded for a future comparison, not scored this run."* | `docs/studio/evidence/*/qc.json` | The determinism claim was unverified. **I verified it — see §4; it holds.** |
| **G14 (Provenance) is a placeholder that passes trivially.** Its own note: *"thin placeholder: only checks contentBriefId is non-empty."* | same | It passes for the **naive baseline** too (`comparison/README.md`). The gate does not check what it is named for. Its note is also stale — it says the ContentBrief model is "not yet built"; it is. |
| **The reference reel's tempo leaks into every tenant.** `tempoBpm: input.beats.tempoBpm ?? 112.3` | [`plan-builder.ts:261`](../../apps/api/src/domain/studio/plan-builder.ts:261) | With no media worker (§1), **there is never a beat grid in production**, so this fallback is not an edge case — it is the only path. Every tenant's reel would be cut to the reference's 112.3 bpm. |
| **The undo race is real and documented in the code that cannot fix it.** `undo()` counts `renderPlan` rows with no row lock; `plan.build` takes `SELECT … FOR UPDATE`. | [`content-gate.ts:322,332`](../../apps/api/src/domain/content-gate.ts:322) vs [`plan-build.ts:246`](../../apps/api/src/jobs/plan-build.ts:246) | approve → queue → undo → materialise leaves a plan attached to a re-`proposed` brief. Narrow, but it is a **gate-integrity** bug, which is the one class this product says it will not trade away. |
| **`render_attempts` has no retention.** No `delete`, no sweep, no TTL in `render-attempt.ts`. | grep | Unbounded growth. Low urgency at current volume. |
| **The deployed image tag lives in an untracked file.** `infra/terraform/production.auto.tfvars` is gitignored (`infra/terraform/.gitignore:8`). | `git check-ignore` | Nothing in the repo records what production runs, and no second machine can reproduce a deploy. |
| **There is no way to ask production what build it is running.** No version/build endpoint; `/healthz` returns `{ok,db,redis}` only. | [`observability.ts:476`](../../apps/api/src/observability.ts:476) | "image tag matches main's tip" is only checkable with AWS credentials. |
| **The e2e ring is not a required status check.** Required contexts are `Typecheck, test, build` and `Docker image builds`. | `repos/…/branches/main/protection` | The ring was red on every studio-main push and would not have blocked the merge. Fixed as a failure ([`package.json` `pretest:e2e`](../../package.json)); not fixed as a policy. |
| **The Lighthouse 84 figure has no artifact.** It appears once, in prose, in `M2_CLOSEOUT.md:143`. | grep across repo | Unverifiable as written. |

---

## 3. What a customer would hit first

The scenario: **an agency uploads a client's footage, approves a brief, renders a reel.**
Walked against the merged tree and the deployed terraform, pessimistically, in order.

**Step 0 — they cannot start.** There is no footage upload path. Not a broken one; not a
partial one. The only code in the repository that creates a `MediaAsset` is
`scripts/studio/prove-plan-chain.ts:103` and `w4-fixture-chain.ts:119`, both of which
construct a row directly with a `r2Key` they invent and never move bytes for a user. No
route accepts a file, no presigned-upload endpoint exists, `apps/web` has no uploader.
**Everything below this line is unreachable today**, and is written as "what would happen
if a developer inserted the row by hand" — which is exactly how every render in this
milestone was produced.

**Step 1 — the beat grid never arrives.** `media.analyze` is consumed only by
`worker-media.ts`, which no ECS service runs. The job enqueues, sits in Redis, and the
`MediaAnalysis` row never reaches `succeeded`. Nothing tells the user; there is no UI for
media analysis at all.

**Step 2 — the plan is cut to the reference reel's tempo.** With no analysis, `plan.build`
takes `input.beats.tempoBpm ?? 112.3` (`plan-builder.ts:261`). 112.3 bpm is *the tempo of
the reference reel the team studied*. Except it will not get that far: `plan-builder.ts:224`
throws `plan_infeasible(analysis_incomplete)` on an empty `beatTimesMs` first. So the honest
outcome is a **named, retryable failure the user can see** in `PlanBuilds` — genuinely good
engineering — attached to a retry button that will fail identically forever, because the
missing piece is a Fargate service, not a transient fault.

**Step 3 — there is no button.** Suppose analysis worked. Nothing in the web app calls
`POST /content/plans`. The user can generate briefs, approve them through the gate, and
watch a list of plan builds they have no way to start.

**Step 4 — the render fails three times over.** `render_failed(backend_unconfigured)`,
because `RENDER_BACKEND` is unset in ECS. Set it to `local` and the renderer entrypoint is
not in the image. Set it to `lambda` and four variables are unset. §2.3.

**Step 5 — QC never runs.** `render.qc` is also a `worker-media` queue. Even a successful
render would carry no gate report, so the 13 gates that define "good" in this product do
not execute in production at all.

**Step 6 — if it all worked, the reel would still not be a reel.** No footage is removed
(§2.1), so the output is a 60-second continuous playthrough with moving captions and a
gentle push/pull. Every "cut" is a caption and camera change over unbroken footage. The
thing an editor is hired to do — remove the boring parts — is the piece that is not built.

### The ranked list of what breaks

| # | Break | Severity |
|---|---|---|
| 1 | No upload path — the customer cannot begin | Blocking |
| 2 | No media-worker service — no beat grid, no word timings, no QC | Blocking |
| 3 | No UI trigger for plan build or render | Blocking |
| 4 | `RENDER_BACKEND` unset, local entrypoint absent from the image, Lambda unconfigured | Blocking |
| 5 | Footage is never removed, so the output is not a cut reel | Product-defining |
| 6 | Manual intervention required at every step: insert the asset row, POST the plan, POST the render, read the MP4 out of R2 by hand | Blocking |
| 7 | Emphasis lands on ASR mistakes (§4) | Visible quality |
| 8 | 112.3 bpm fallback would silently give every tenant the reference's tempo if analysis ever returns a partial grid | Silent wrongness |

**Everything from #1 to #4 is infrastructure and wiring, not algorithms.** The engine is
the part that works.

---

## 4. Quality reality

### The 13 hard gates, measured

From the committed artifacts at `docs/studio/evidence/*/qc.json`, rendered from `7070d6e`
against the locked-off fixture (59.605 s, sha256 `dd17a360…`). `G13`/`G14` are `hard: false`
and shown for completeness; `scoredGateCount` is **12** on every template — 13 hard gates
minus the one excluded.

| Gate | Hard | Statement (measured / verdict) | Staccato (measured / verdict) | Editorial (measured / verdict) | Target |
|---|---|---|---|---|---|
| **G1a** Beat lock — musical intent | yes | 100% (26/26), gq 2.4342 · PASS | 100% (28/28), gq 2.4342 · PASS | 100% (30/30), gq 2.4342 · PASS | ≥85% within 150ms of the embedded grid, AND (for beat_track grids) grid_quality present and ≥ 80% of the reference's 2.2003 (guards a degraded/absent grid gaming the gate) |
| **G1b** Beat lock — render fidelity | yes | planCuts 26, detected 0 · **excluded** | planCuts 28, detected 0 · **excluded** | planCuts 30, detected 0 · **excluded** | ≥90% of the plan's cut times have a detected cut within ±2 frames (66ms) — scored only for plans that remove footage |
| **G2** Cut density | yes | 26.1 · PASS | 28.2 · PASS | 30.2 · PASS | 25-40 cuts/minute |
| **G3** Shot length (median) | yes | 1.68 · PASS | 1.62 · PASS | 1.38 · PASS | 1.0-2.0s |
| **G4** Min shot length | yes | 0.65 · PASS | 0.8 · PASS | 0.81 · PASS | ≥0.6s |
| **G5** Caption density | yes | 3 · PASS | 3 · PASS | 3 · PASS | ≤3 words visible simultaneously |
| **G6** Caption position variance | yes | 3 · PASS | 3 · PASS | 3 · PASS | ≥3 distinct positions |
| **G7** Micro-motion | yes | 27/27 moving, Δ 0.0504–0.078 · PASS | 29/29 moving, Δ 0.051–0.0788 · PASS | 31/31 moving, Δ 0.0507–0.0784 · PASS | 100% of shots have scale delta >1% |
| **G8** Emphasis | yes | 89 chunks, 0 bad · PASS | 62 chunks, 0 bad · PASS | 89 chunks, 0 bad · PASS | ≤1 emphasis word per chunk (schema-enforced) and it must index a real word |
| **G9** Safe margins | yes | 0 violations · PASS | 0 violations · PASS | 0 violations · PASS | 0 text blocks within 12% of the left/right/bottom edge; banner top exempt to 8% (ARCHITECTURE §12.7); 0 karaoke blocks whose top is above the face floor at 0.717 (ARCHITECTURE §12.19) |
| **G10** Word integrity | yes | 0/27 cuts bad · PASS | 0/29 cuts bad · PASS | 0/31 cuts bad · PASS | 0 cuts landing mid-word (source in/out points) |
| **G11** Loudness | yes | -13.9 · PASS | -13.9 · PASS | -14 · PASS | -14 ±1 LUFS integrated |
| **G12** Output spec | yes | 1080x1920 30fps h264+aac · PASS | 1080x1920 30fps h264+aac · PASS | 1080x1920 30fps h264+aac · PASS | 1080x1920, 30fps, h264+aac |
| **G13** Reproducibility | no | feb7f65b6464… · **not scored** | 75a24509fb24… · **not scored** | 4b7aa6411ebb… · **not scored** | same plan+footage ⇒ identical checksum |
| **G14** Provenance | no | briefId present · PASS | briefId present · PASS | briefId present · PASS | render links to claim_ids + framework_id |

### What is excluded, and why

- **G1b — excluded by derivation, on all three templates.** Not failed, not passed:
  `notApplicable.code = continuous_playback_no_discontinuities`. The plan is a continuous
  playthrough, so there is no discontinuity for PySceneDetect to find (`planCuts 26/28/30`,
  `detectedCuts 0`). It resumes scoring automatically for any plan that removes footage.
  The derivation is sound and the exclusion is honestly labelled — but the consequence is
  that **one of the two headline gates has never returned a verdict**, and cannot until
  §2.1 is built.
- **G13 — `hard: false`, and never scored** until this audit. `pass: null`, note: *"no
  --prev-checksum given."*
- **G14 — `hard: false`, and a placeholder.** It checks that `contentBriefId` is non-empty.
  It therefore **passes for the naive baseline too** (`comparison/README.md`), which is a
  gate that cannot discriminate. Its note claims the ContentBrief model is "not yet built";
  it has been built since Agent B's workstream landed, so the note is stale and the gate is
  still thin.

### G13, scored for the first time

I re-rendered `statement_serif` from the committed `plan.json` and the same fixture, on a
different day and out of a different worktree:

```
measured  sha256:feb7f65b6464b6a6147a1990d568f00a0e086f192af0c69d7d5b7fc2771b169a
manifest  sha256:feb7f65b6464b6a6147a1990d568f00a0e086f192af0c69d7d5b7fc2771b169a
```

**Byte-identical.** The reproducibility claim holds; it had simply never been checked.
(A second run at `--concurrency=1` produced a different checksum, but it also skipped
`render-plan.mjs`'s two-pass `loudnorm`, so it changed two variables at once and is
evidence about neither.)

### Where the output still looks generated rather than edited

From the W4.3 comparison frames — PerfStaq on the left, naive baseline on the right.

**t = 0.880 s** (`frames/statement_serif-00880ms.png`). The caption is the single word
**"WONDERING"**, alone, mid-sentence. No human editor keys a lone auxiliary fragment. This
is structural, not incidental: measured across the committed plans, **41 of 89 caption
chunks (46%) in `statement_serif` and `editorial_sans` are one word long**. G5 bounds
captions at ≤3 words and nothing sets a floor.

**t = 7.470 s** (`…-07470ms.png`). The caption reads **"WHO DO"** — the middle of "…people
who do…". A two-word fragment with no meaning of its own, held for the length of a shot.

**t = 30.000 s** (`…-30000ms.png`). The worst of the three. The emphasis word — large,
accent orange, the single most prominent element on screen — is **"SHAIL"**. The baseline
arm's full-sentence caption shows why: the ASR heard *"A FEW MONTHS AGO, DEPENDER SHAIL AND
INTERESTING IDEA HE IS RESEARCHING."* **"Shail" is a mis-transcription**, and
`isNumberOrProperNoun` awarded it +1.0 for being capitalised mid-sentence
(`emphasis.ts:171`). This is §12.48's finding with a timestamp on it.

The fix is blocked by a data seam, not by the scorer: the analyzer **does** capture ASR
confidence — `services/analyzer/stages/words.py:126` writes `score = w.probability`, and
**"Shail" carries a confidence of 0.571** in the fixture, against a median of
0.9701 across the 159 words (14% sit below 0.6) — but `ScoredWord`
(`emphasis.ts:32-38`) has fields `word`, `startMs`, `endMs`, `rms` and **no confidence
field at all**. The signal is measured, persisted in the words file, and dropped before it
reaches the code that needs it.

**Emphasis is applied far too often.** Measured on the committed plans:

| Template | chunks | with an emphasis word | 1-word chunks |
|---|---|---|---|
| statement_serif | 89 | 38 (**43%**) | 41 (46%) |
| staccato_condensed | 62 | 30 (**48%**) | 9 (15%) |
| editorial_sans | 89 | 38 (**43%**) | 41 (46%) |

Something applied to nearly half of all captions is not emphasis. G8 bounds emphasis at
**≤1 per chunk** and never bounds the **rate across the reel**, so 43% is mechanically
clean. §12.48 already rules that G8 must require emphasis to be *present*; this is the same
gate failing at the other end, and it is not currently on any list.

**Two further "generated" tells, structural rather than per-frame:**

- **Nothing is ever cut away from.** At t = 30.0 s the subject is looking down at his desk.
  An editor cuts. The system holds the shot, because it cannot remove footage (§2.1).
- **Hands leave the frame.** The ~0.9:1 crop (§12.16) clips the speaker's gesturing hands at
  the left edge at 0.88 s and 30.0 s. §12.43 records that the framing ruling "was right about
  the face and silent about the hands"; the frames show the cost.

### What the comparison genuinely proves

**PerfStaq PASS ×3, naive baseline FAIL ×3**, same footage, same approved ContentBrief, same
typography. The baseline fails 7 of 12 scored gates on every template — G2 23.2 cuts/min,
G3 2.5 s median, G5 14 words on screen, G6 1 position, G7 24/24 static shots, G10 42 mid-word
cuts, G9 3–11 margin violations. That result is real and the baseline was deliberately built
not to flatter us. It establishes that **the motion system beats a naive one**. It does not
establish that the output passes for hand-edited, and §4 above is the honest list of why not.

---

## 5. Scale and cost

**Measured, not estimated** — on Apple M4, 10 cores, 16 GB, macOS 26.6, Node v22.22.0,
Remotion 4.0.518. Input: the committed `statement_serif` plan (27 cuts, 89 caption chunks)
over the 59.605 s / 85,125,521-byte fixture. Peak memory is the summed RSS of the whole
process tree (node + npx + `remotion` + `chrome-headless-shell` + `esbuild`), sampled every
2 s.

| Run | Wall clock | Peak tree RSS | Output |
|---|---|---|---|
| Full path (`render-plan.mjs`, default concurrency, incl. two-pass `loudnorm`) | **195.3 s** | **3,059 MB** | 68,783,255 B |
| Remotion `--concurrency=1`, no `loudnorm` | **198.0 s** | **2,643 MB** | 69,721,682 B |

**Render time per reel, end to end: 195 s for a 59.7 s reel — 3.27× realtime.** The
`loudnorm` stage reported `-16.2 → -14 LUFS`, i.e. it did real work on this fixture.

**The first surprising result: CPU parallelism buys nothing.** Dropping Remotion from
10-way to 1-way concurrency changed wall clock by **1.4%** (195.3 s → 198.0 s). This render
is not CPU-parallelism-bound — it is bound by decoding an 85 MB source and by the encoder.
**Adding vCPUs to the worker task will not make renders faster.** Nobody should buy a bigger
Fargate task expecting a speed-up.

**The second: memory already exceeds the deployed task.** The worker task is **1 vCPU /
2048 MiB** (`variables.tf:172-182`, `ecs.tf:255`). Both measurements — 2,643 MB at the most
conservative setting, 3,059 MB on the normal path — are **above 2,048 MiB**.

### What breaks first at 10 concurrent renders

**Nothing, because nothing breaks at 10 — it breaks at one.** In order:

1. **`render_failed(backend_unconfigured)`, at zero concurrency.** `RENDER_BACKEND` is unset
   in ECS. This is the actual first failure and it precedes every scaling question (§2.3).
2. **OOM on the first render, if a backend were configured `local`.** 2,643–3,059 MB against
   a 2,048 MiB task. The task is killed and restarted; the job retries twice
   (`studioJobOptions`, `attempts: 2`) and dies the same way. The container also would not
   have the renderer entrypoint in the first place.
3. **Four concurrent local encodes on one task, by design-for-a-different-design.**
   `render.submit` concurrency is **4**, and `queue.ts:151` annotates that row *"worker.ts;
   Remotion Lambda API calls"* — the number was sized for issuing API calls, not for running
   four Chrome instances. With a local backend it means 4 × ~3 GB on a 2 GB task.
4. **Autoscaling cannot rescue it.** The worker scales on
   `ECSServiceAverageCPUUtilization` at a 65% target, ceiling 6 (`ecs.tf:493-508`). A
   memory-bound OOM does not raise average CPU, so the policy will not scale out; it will
   watch tasks die.
5. **Then the connection pool.** Each in-flight `plan.build` needs **two** Postgres
   connections, not one — `requireApprovedContentBrief` reads through the module-level
   client while the transaction holds the row lock (`plan-build.ts:234-239`). The code says
   8 connections at concurrency 4 is "comfortable"; **`connection_limit` is set nowhere** in
   `DATABASE_URL` or terraform, so the pool is whatever Prisma infers from the runtime's CPU
   count inside Fargate. That has never been measured. At 10 concurrent it is 20 connections
   against an unpinned pool on a `db.t4g.medium`, and the file's own comment warns this
   "would deadlock rather than merely queue."

### Cost per render

| Component | Measured | Notes |
|---|---|---|
| **LLM** | **not measurable** | `ExtractionRun` persists `input_tokens`/`output_tokens` (`schema.prisma:322`); **`ContentBrief` has no such columns**, and `generate-content-brief.ts` discards the `usage` object it receives. The only token figures in the repo are `{input: 2000, output: 2160}` from `eval-results.golden.json`, whose `mode` is `"mock"`. No real generation cost has ever been recorded. |
| **Compute** | **no production render has ever run** | Extrapolating 195 s of 10-core M4 to a 1-vCPU Fargate task would be invention, and the concurrency result above says the usual scaling intuition is wrong here anyway. What is measurable: the workload does not fit the deployed task. |
| **Storage** | **68.8 MB per 60 s reel output; 85.1 MB per source clip** | R2. `media.purge-references` deletes **only** `kind: reference` (`media-purge.ts:41,100,164`). `footage`, `render` and `music` assets have **no expiry anywhere** — no sweep, no lifecycle policy in the repo. Every reel a customer renders is kept forever by default. |

**The honest summary of §5:** the only end-to-end cost number that exists is one measured on
a laptop. Production has no render telemetry because production has no renders.

---

## 6. M3 candidate list

Ranked by **"would a paying customer notice its absence in week one?"** — not by effort, and
not by how interesting the work is. Effort is a rough engineering-days estimate.

### Tier 1 — the customer cannot use the product without these

| # | Item | Effort | Unblocks | Noticed in week 1? |
|---|---|---|---|---|
| 1 | **Footage upload path** — presigned R2 upload route, `MediaAsset` row, an uploader in `apps/web`. Include rotation from the display matrix, not raw stream dimensions (§12.40), or every portrait phone video lands sideways on day one. | 3–5 d | Everything | **Yes — they cannot start** |
| 2 | **Deploy the media worker.** `Dockerfile.media` exists and is correct; it has no ECR repo, no task definition, no service, and no build in `ship.sh` or CI. | 2–3 d | Beat grids, word timings, QC, all of §1's "not wired" | **Yes — nothing analyses or scores** |
| 3 | **Wire a render backend.** Decide ADR-5's licensing question, then either stand up Remotion Lambda and set the four variables, or ship the local entrypoint in the image and size the task for 3+ GB. `RENDER_BACKEND` must be set either way. | 3–8 d (Lambda) / 1–2 d (local) | Any render at all | **Yes — the product's output** |
| 4 | **Studio UI: start a build, start a render, fetch the result.** The read and retry surfaces exist; the write surfaces do not. | 3–4 d | Using the product without an API client | **Yes** |

### Tier 2 — they will use it, and then be disappointed

| # | Item | Effort | Unblocks | Noticed in week 1? |
|---|---|---|---|---|
| 5 | **Footage selection + music bed** (`03 §6`, coupled by §12.13). Real jump cuts; releases G1b from exclusion. | 8–12 d | The thing "editing" means | **Yes — the reel is uncut** |
| 6 | **ASR confidence into the emphasis scorer** (§12.48). Add the field to `ScoredWord`, thread it from the words file, floor it. 14% of the fixture's words sit below 0.6. | 1–2 d | Not putting mis-transcriptions in accent orange | **Yes — it is the biggest thing on screen** |
| 7 | **Bound the emphasis *rate*, and require emphasis to exist** (§12.48 + this audit). 43–48% of chunks currently carry emphasis. | 1–2 d | Emphasis meaning something | **Yes** |
| 8 | **Caption chunk floor.** 46% one-word captions is what produces "WONDERING" and "WHO DO". | 2–3 d | Captions reading as language | **Yes** |
| 9 | **Remove the `?? 112.3` tempo fallback** (§12.33) — fail `plan_infeasible` instead. With #2 unbuilt it is the *only* path today, not an edge case. | 0.5 d | Not cutting every tenant to the reference's tempo | Only if #2 ships without it |

### Tier 3 — correctness and trust; invisible until they are not

| # | Item | Effort | Unblocks | Noticed in week 1? |
|---|---|---|---|---|
| 10 | **Close the undo race** — take the same `FOR UPDATE` row lock inside `content-gate.ts`'s `undo()` (§12.33). | 1 d | Gate integrity, which is this product's core claim | No — until it happens once |
| 11 | **Make G14 a real provenance gate**; make G13 score against a stored previous checksum. Both are `hard: false` placeholders today, and G14 passes for the naive baseline. | 2–3 d | The gates that verify the promises | No |
| 12 | **Retention consent flag** (§12.36) — a column, a UI control, and a per-tenant `RETENTION_DAYS`. | 2–3 d | Honouring `04 §5` rather than its ceiling | No — unless asked in a security review |
| 13 | **Lifecycle for `footage` / `render` / `music` in R2** (§5). Nothing expires today. | 1–2 d | Storage cost, and a defensible data-retention story | No |
| 14 | **A ≥95% G1a regression tripwire** (§12.47) — 87% by coincidence from beat-blind cuts means the 85% floor cannot tell deliberate from lucky. | 1 d | Knowing if the planner regresses | No |
| 15 | **Trim word ends against an RMS floor** (§12.40). | 2–3 d | Cuttable spans; captions leaving on time | Marginally |
| 16 | **`render_attempts` GC** (§12.38) and `motion_templates`' deprecated columns (§12.32). | 1 d | Table hygiene | No |

### Tier 4 — operational debt this ship surfaced

| # | Item | Effort | Noticed in week 1? |
|---|---|---|---|
| 17 | **Track `production.auto.tfvars`** (or move `image_tag` somewhere versioned). Nothing in the repo records what production runs. | 0.5 d | No — until a second person deploys |
| 18 | **A build-identity endpoint.** `/healthz` cannot answer "which commit is this?"; verifying a deploy needs AWS credentials. | 0.5 d | No |
| 19 | **Make `E2E ring` a required status check.** It was red on every studio-main push and would not have blocked the merge. | 0.1 d | No |
| 20 | **Fix the evidence manifest's regeneration command.** It documents `render-evidence.ts --footage …`, which uses the *script's* second plan builder; §12.45 records the committed plans as coming through the real chain (`--plan`). Following the manifest would silently swap builders — the §12.34/§12.45/§12.49 shape again, in the harness. | 0.5 d | No |
| 21 | **Split the web bundle.** 1,344.70 kB single chunk (CI build log); the M1 Lighthouse-84 carry-over, which has no artifact in the repo to check against. | 2 d | Marginally — first paint |

### The one-line answer

**Nothing in Tier 1 is an algorithm.** M2 built a motion system that measurably beats a
naive baseline on 12 of 12 scored gates across three templates, and reproduces byte for
byte. What it does not have is a way for a customer to put a video in, a machine to analyse
it on, a renderer to render it with, or a button to press. That is the whole of M3's
critical path.
