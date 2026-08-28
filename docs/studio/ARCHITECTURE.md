# Content Studio — Architecture Decision Document

> Architect output (one-shot, 2026-08-27), written before any Studio code. Source of the port:
> `/Users/sathvik/aix/founder-journey` (package `perfstaq`, branch `agency`, ~56.5k LOC, 786 tests).
> Every claim below carries a file:line citation. Where a spec doc in this folder is factually
> wrong about the codebase, §10 says so plainly — stop trusting those statements.
> All founder-journey paths are relative to `/Users/sathvik/aix/founder-journey`; all
> meeting-bot paths relative to `/Users/sathvik/aix/meeting-bot`.

---

## 1. Port ledger

Ruthless rule applied: the restraint thesis (01_REFERENCE_ANALYSIS §8 — hard cuts only, no
stickers, no SFX) makes most of the decoration layer LEAVE BEHIND. The audio and cutting
*infrastructure* underneath it is the real asset and ports nearly clean.

### 1.1 `remotion/src/` (the render engine)

| Module | Verdict | Why (one line) |
|---|---|---|
| `schema.ts` | **PORT AS-IS** | The EDL + word-edge invariant core (`EPSILON=0.05` at schema.ts:15, `wordEdges`/`snapToEdge` at :68-96, `computeKeptSpans` at :196-210) is exactly G10's "never mid-word" enforcement, already loud-validated. |
| `reel.ts` | **PORT WITH CHANGES** | Keep the layering (EDL → output-time spans/captions, reel.ts:61-132) and `CaptionWordSchema`; **delete** `ENTER_VALUES` (44 entrance effects, reel.ts:25-43), `OverlaySchema` gif/Giphy (:143-158), `BrollSchema` pexels (:167-177), `SfxSchema` (:101-106), `AccentSchema` — all banned by 01 §8. |
| `motion.ts` | **PORT WITH CHANGES** | Keep `effectiveMotion`/scale-floor concepts; replace the analytic ease-out in `motionScale` (motion.ts:32-37) with `SPRINGS.drift` per 02 §1; raise `MAX_GROW` 0.06 → the 0.05-0.08 band of 01 §5; drop `decayingScaleFloor` (only serves banned slide entrances, motion.ts:55-70) and `atmosphericWashAllowed` (washes are banned). |
| `duck.ts` | **PORT AS-IS** | Pure, unit-testable music-under-voice gain math (duck.ts:1-8) — exactly 03 §5's sidechain ducking. Audio infrastructure, not decoration. |
| `fonts.ts` + `fontdata.generated.ts` + `scripts/embed-fonts.mjs` | **PORT WITH CHANGES** | Embedded data-URL fonts exist because a pending font fetch can hang `delayRender` until timeout (fonts.ts:4-9) — deterministic on Lambda. Swap the font set for 02 §7's tokens (Anton/Playfair/Inter-class, OFL). I explicitly prefer this over 03 §4's `@remotion/google-fonts` suggestion. |
| `compositions/Reel.tsx` | **PORT WITH CHANGES** | Keep the shell — `<Sequence>` per span, `<OffthreadVideo>`, plan-as-props, imports only react+remotion+relative modules (Reel.tsx:1-30), which is already 03 §4's architecture. Strip every entrance/overlay/broll/evidence branch; the caption layer is a REWRITE per 02 §2 (three independent layers). |
| `sfx.ts` | **LEAVE BEHIND** | No SFX in v1 (01 §8). |
| `Root.tsx` | **PORT WITH CHANGES** | Re-register the pruned composition only. |
| `compositions/Graphics.tsx`, `graphics-layout.ts`, `compositions/scenes/*` (16 files incl. `surface.tsx`) | **LEAVE BEHIND** | The card/evidence system's headline-vs-graphic collision is admitted unsolved (PERFSTAQ-STATUS.md §6: "two systems competing for the same pixels"). Don't import an unsolved problem; templates are new, on M's primitives. |

### 1.2 `pipeline/` (43 files)

| Module | Verdict | Why |
|---|---|---|
| `ingest.ts` | **PORT WITH CHANGES** | Probe + rotation-correct + manifest is stage one of `media.analyze`; convert CLI (`process.argv`) to a job function. |
| `transcribe.ts` + `scripts/whisperx_run.py` | **PORT WITH CHANGES** | The proven venv-shell pattern (transcribe.ts:32-46) and the faster-whisper+Silero runner (whisperx_run.py:3-9, deliberately avoiding pyannote/torchcodec) become the sidecar's `words` stage. CLI → job. |
| `detect.ts` | **PORT WITH CHANGES** | Word-gap silence detection (detect.ts:129-138) IS 03 §6's "split on speech pauses (gaps >400ms)"; keep the segmenter + `mergeNonOverlapping`, drop CLI + the cuts.json human-gate loop (Studio's gate is the ContentBrief, not per-cut). |
| `audio.ts` | **PORT AS-IS** | Word onset/offset protection at cut boundaries — feeds G10 directly. |
| `proxy.ts` | **PORT AS-IS** | 4K 10-bit HEVC phone footage wedges compositors (proxy.ts header) — precisely what tenant uploads will be. Not in any spec doc; porting it anyway. **Disagreement flagged**: the docs forgot render-source normalization exists. |
| `face.ts` + `scripts/mediapipe_face_run.py` | **PORT AS-IS** | Median-aggregated per-span face boxes (reel.ts:50-58) drive 02 §2.2 scrim/safe-placement and 03 §1's face/luminance stage. |
| `music.ts` | **PORT WITH CHANGES** | Keep `findMusicBed` tier-1 library selection and `synthBed` (license-clean, and its BPM is *known by construction* — a free exact beat grid). Demote `detectBeats`/`buildBeatGrid` (music.ts:647-701) to last-rung fallback (§4). Drop IA-netlabel tier-2 and `suggestTrendingAudio`. |
| `music-library.ts`, `music-index.ts` | **PORT WITH CHANGES** | Bring-your-own licensed library (Epidemic/Artlist) is the only 03 §5-compliant source; re-home from local dir to per-tenant R2 prefix. |
| `tracks.ts` | **PORT WITH CHANGES** | Keep `deriveTargetTempo` (tracks.ts:485) + `bpmMatchScore` (:525) scoring math; **leave** all Internet Archive sourcing/download. |
| `music-sources.ts` | **LEAVE BEHIND** | Remote CC sourcing conflicts with licensed-only (03 §5). |
| `io.ts` | **PORT WITH CHANGES** | Zod-validated loud loaders pattern; re-target paths from `work/<clip>` to job temp dirs + R2. |
| `apply.ts` | **LEAVE BEHIND** | ffmpeg-concat rough cuts are superseded — Remotion renders from the plan; spans seek inside the source. |
| `env.ts` | **LEAVE BEHIND** | meeting-bot has `apps/api/src/env.ts`. |
| `analyze.ts` | **LEAVE BEHIND** (v1) | LLM shot-notes; 03's analyze stage is signal-based. Revisit for style transfer classification later. |
| `giphy.ts`, `pexels.ts`, `sfx.ts`, `sfx-fetch.ts`, `shoot.ts` | **LEAVE BEHIND** | The decoration layer. GIF stickers, stock B-roll cutaways and SFX are all explicitly banned by 01 §8 ("no B-roll cutaways", "no stickers"). |
| `compose.ts`, `enrich.ts`, `direct.ts`, `director.ts`, `visual-director.ts`, `visual-search.ts`, `evidence.ts` | **LEAVE BEHIND** | The creative-brain/enrichment chain exists to choose entrances, GIFs, B-roll and evidence scenes — the banned vocabulary. The Studio's "brain" is the ContentBrief + template, chosen upstream of render. |
| `story.ts`, `storyline.ts`, `variants.ts`, `suggest.ts`, `series.ts`, `persona.ts`, `strategy.ts`, `strategy-schema.ts`, `brief.ts`, `brand-research.ts`, `formats.ts`, `memory.ts` | **LEAVE BEHIND** | perfstaq's own strategy stack — it directly competes with the M1 Brief + review gate, which is the product (CLAUDE.md invariant 1). Bringing any of it in would create a second, ungated memory. |
| `keywords.ts` | **LEAVE BEHIND** | 02 §3's emphasis scorer is ~40 lines against claim text + RMS; RAKE adds nothing it needs. |
| `translate.ts` | **LEAVE BEHIND** | Multi-language captions are out of scope (00 §7). |
| `review.ts`, `serve.ts` | **LEAVE BEHIND** | Static review page + file server superseded by `apps/web`. |

**Where I disagree with the restraint reading**: restraint applies to *visible decoration*, not audio
plumbing. `duck.ts`, `synthBed`, the music library, and `proxy.ts` are infrastructure the spec docs
silently assume exists; they port. Everything a viewer could point at that the reference doesn't
have (entrances, GIFs, SFX, accents, evidence cards) stays behind — no exceptions in v1.

---

## 2. Target module layout

```
meeting-bot/
├── apps/api/src/
│   ├── routes/content.ts            # 05 §4 endpoints (briefs, plans, renders) — NEW file, review.ts untouched
│   ├── domain/content-gate.ts       # ContentBrief approve/reject/edit-approve (see §6)
│   ├── domain/studio/               # plan builder, footage selection, emphasis scoring, beat snap
│   ├── jobs/media-analyze.ts  plan-build.ts  render-submit.ts  render-qc.ts
│   ├── queue.ts                     # +4 queues, additive, same QUEUE-const pattern (queue.ts:15-23)
│   ├── integrations/studio-r2.ts    # studio key namespace built ON r2.ts exports; r2.ts not modified
│   └── worker-media.ts              # NEW entrypoint: consumes media.analyze + render.qc only
├── apps/web/src/pages/Studio.tsx    # upload / template pick / render status (dark theme tokens)
│   └── pages/ReviewQueue.tsx        # extended: ContentBrief card type (UI reuse — see §6)
├── packages/render/                 # NEW npm workspace — the Remotion bundle root
│   ├── remotion.config.ts
│   └── src/  plan.ts (zod RenderPlan contract)  motion/  captions/  fonts/  compositions/Reel.tsx
├── services/analyzer/               # NEW — Python sidecar (no Node imports)
│   ├── analyzer.py                  # CLI: --input --out --stages words,beats,scenes,motion,faces
│   └── requirements.txt             # faster-whisper, librosa, scenedetect[opencv], numpy (pinned)
├── Dockerfile.media                 # node + ffmpeg + python venv + packages/render
└── infra/terraform/                 # additive: ECR repo studio-media, service worker-media
```

Decisions and justification:

- **`packages/render` is a new workspace**, not code inside `apps/api`. Remotion needs its own
  webpack bundle root and a React dependency tree; `apps/api` is a server-only build shipped in the
  production image (infra/terraform/ecs.tf:2-7). Keeping remotion imports confined to one package is
  also the licensing containment boundary (ADR-5): only `packages/render` may import `remotion`;
  enforce with a typecheck-time lint (`no-restricted-imports`) in api/web.
- **No `apps/studio` HTTP service.** Auth, tenancy (db.ts:66-98), authz and rate limiting already
  live in `apps/api`; a second HTTP service would duplicate Better Auth wiring for zero isolation
  benefit. Studio routes are just more api routes.
- **Jobs follow the existing pattern exactly**: four new queue names in the `QUEUE` const with typed
  Queue instances and per-queue retry posture, exactly as `digestQueue` does (queue.ts:87-94).
- **Two worker entrypoints, three images total.** Today one image runs `api`/`worker`/`migrate`
  (ecs.tf:2-7, commands at :219/:270). That image stays byte-identical in behavior. A new
  `Dockerfile.media` image (Node + ffmpeg + Python venv) runs `worker-media.ts`, consuming only
  `media.analyze` and `render.qc` — the two queues needing ffmpeg/librosa/PySceneDetect.
  `plan.build` (pure TS) and `render.submit` (Lambda API calls) stay on the existing lean worker.
- **Rendering is Remotion Lambda** (03 §4), not the Fargate task: 1650 frames of 1080×1920 on
  Fargate CPU is a 10-30 minute render; Lambda parallelizes to ~1-2 min. Input footage reaches
  Lambda via `presignGet` R2 URLs (r2.ts:122); output comes back S3 → `streamUrlToR2` (r2.ts:67)
  into `renders/`. Local `@remotion/renderer` inside the media image is the dev/CI path so tests
  never need AWS.
- **R2 keys**: extend the namespace in `studio-r2.ts` (e.g. `tenants/<t>/studio/footage/<id>`,
  `.../renders/<id>.mp4`, `.../music/<id>`) using `putObject`/`presignGet`/`objectExists`/
  `deleteObjects` as exported (r2.ts:33-151). `r2.ts` itself is off-limits (§6).

---

## 3. Prisma schema (additive — invariant 6)

Conventions matched to `apps/api/prisma/schema.prisma`: uuid string ids, `tenantId String
@map("tenant_id")`, snake-case `@@map`, tenant relation `onDelete: Cascade`, `@@index([tenantId, …])`
(cf. Meeting at schema.prisma:85-151, Artifact at :261-281). Two deliberate deviations from
03_RENDER_PIPELINE §2's sketch, both forced by real code:

1. **`MediaAnalysis` gains `tenant_id`.** The spec sketch omits it, but the db.ts client extension
   injects `tenantId` into every query of every non-exempt model (db.ts:66-98); a model without the
   column would throw on first use, and invariant 5 requires it anyway.
2. **`MotionTemplate` is a global catalog** (no `tenant_id`) — templates ship with the product.
   It must therefore be added to the `UNSCOPED` set (db.ts:19-37), one additive line with a comment,
   like the Better Auth models. Per-tenant custom templates later = additive nullable `tenant_id`.

`RenderPlan` rows are immutable (G13 reproducibility): add `"RenderPlan"` to `APPEND_ONLY_MODELS`
(apps/api/src/domain/append-only.ts:28) — an additive set entry. `Render` is mutable (status
transitions). The `Tenant` model block gains back-relation array fields only (additive lines,
no columns — same shape as schema.prisma:41-60).

```prisma
// ---------------------------------------------------------------------------
// Content Studio — media, analysis, templates, plans, renders.
// ---------------------------------------------------------------------------

enum MediaAssetKind {
  footage
  reference
  render
  music

  @@map("media_asset_kind")
}

model MediaAsset {
  id       String @id @default(uuid())
  tenantId String @map("tenant_id")

  kind         MediaAssetKind
  r2Key        String         @unique @map("r2_key")
  contentType  String         @map("content_type")
  bytes        BigInt
  checksum     String?
  originalName String?        @map("original_name")

  durationMs Int?   @map("duration_ms")
  width      Int?
  height     Int?
  fps        Float?

  uploadedByUserId String? @map("uploaded_by_user_id")

  // Reference reels are purged after fingerprinting (04 §5) — same posture as
  // artifacts.purged_at: the row survives, the bytes do not.
  purgedAt  DateTime? @map("purged_at")
  createdAt DateTime  @default(now()) @map("created_at")

  tenant   Tenant         @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  analysis MediaAnalysis?
  plans    RenderPlan[]

  @@index([tenantId, kind, createdAt])
  @@map("media_assets")
}

enum MediaAnalysisStatus {
  running
  succeeded
  failed

  @@map("media_analysis_status")
}

model MediaAnalysis {
  id       String @id @default(uuid())
  tenantId String @map("tenant_id")

  assetId String @unique @map("asset_id")

  status MediaAnalysisStatus @default(running)
  error  String?

  // Signal payloads (03 §1); each null until its stage lands.
  words  Json? // word-level timings (faster-whisper), ms
  beats  Json? // { method, tempo_bpm, beat_times_ms[], grid_quality } — THE canonical grid (§4)
  scenes Json? // PySceneDetect shot list (reference assets only)
  motion Json? // per-window motion energy
  faces  Json? // per-span face boxes + luminance map

  tempoBpm   Float?  @map("tempo_bpm")
  beatMethod String? @map("beat_method") // 'beat_track' | 'onset_env' | 'constant_grid'

  // Pins the sidecar (and its librosa version) that produced this row —
  // same reasoning as extraction_runs.prompt_version.
  analyzerVersion String @map("analyzer_version")

  startedAt  DateTime  @default(now()) @map("started_at")
  finishedAt DateTime? @map("finished_at")

  tenant Tenant     @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  asset  MediaAsset @relation(fields: [assetId], references: [id], onDelete: Cascade)

  @@index([tenantId, status])
  @@map("media_analyses")
}

enum TemplateFraming {
  letterbox
  fill

  @@map("template_framing")
}

// Global catalog — NO tenant_id; must be listed in db.ts UNSCOPED. Rows are
// seeded by fixture (explicitly marked; templates are not memory, so the gate
// invariant does not apply to them).
model MotionTemplate {
  id        String @id @default(uuid())
  name      String
  archetype String

  framing TemplateFraming
  slots   Json // rhythm-slot spec: establish/accelerate/hold pattern
  fonts   Json // 02 §7 typography tokens
  grade   Json // 02 §6 grade parameters

  version Int     @default(1)
  active  Boolean @default(true)

  createdAt DateTime @default(now()) @map("created_at")

  plans RenderPlan[]

  @@unique([name, version])
  @@map("motion_templates")
}

// Immutable once written (APPEND_ONLY_MODELS): the reproducible artifact.
// plan embeds EVERYTHING the render consumes — cut list, caption chunks with
// word timings, emphasis flags, motion curves, grade, music asset id, beat
// grid, seed — so a re-render never recomputes analysis or re-runs an LLM.
model RenderPlan {
  id       String @id @default(uuid())
  tenantId String @map("tenant_id")

  // Plain column until Agent B's ContentBrief model lands, then a relation is
  // added in B's own additive migration (see §6).
  contentBriefId String @map("content_brief_id")
  templateId     String @map("template_id")
  footageAssetId String @map("footage_asset_id")

  plan        Json
  seed        Int
  planVersion String @map("plan_version") // schema version of the plan payload
  createdBy   String @map("created_by")

  createdAt DateTime @default(now()) @map("created_at")

  tenant   Tenant         @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  template MotionTemplate @relation(fields: [templateId], references: [id])
  footage  MediaAsset     @relation(fields: [footageAssetId], references: [id])
  renders  Render[]

  @@index([tenantId, contentBriefId])
  @@index([tenantId, createdAt])
  @@map("render_plans")
}

enum RenderStatus {
  queued
  rendering
  qc
  succeeded
  failed

  @@map("render_status")
}

model Render {
  id       String @id @default(uuid())
  tenantId String @map("tenant_id")

  planId String @map("plan_id")

  status         RenderStatus @default(queued)
  r2Key          String?      @unique @map("r2_key")
  durationMs     Int?         @map("duration_ms")
  bytes          BigInt?
  checksum       String? // G13: same plan+footage ⇒ same checksum
  qc             Json? // full gate-by-gate report from render.qc
  qcPassed       Boolean?     @map("qc_passed")
  lambdaRenderId String?      @map("lambda_render_id")

  // Mirrors meetings.failure_reason/failed_stage: failures are surfaced, never silent.
  error       String?
  failedStage String? @map("failed_stage") // analyze | plan | render | qc

  createdAt  DateTime  @default(now()) @map("created_at")
  finishedAt DateTime? @map("finished_at")

  tenant Tenant     @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  plan   RenderPlan @relation(fields: [planId], references: [id], onDelete: Cascade)

  @@index([tenantId, status])
  @@index([planId, createdAt])
  @@map("renders")
}
```

---

## 4. The beat-lock decision (G1 — the milestone's gate)

**Decision: real beat tracking (librosa `beat.beat_track`) in the Python sidecar is REQUIRED.
The ported constant-tempo `buildBeatGrid` is not sufficient and is demoted to the last fallback
rung.** Three independent reasons, any one of which decides it:

1. **The measurer and the planner must share one grid.** G1 is defined as "% of cuts within 150ms
   of a *librosa* beat" (07 §1) and `scripts/qc-render.ts` runs librosa. If the planner snaps to a
   grid from the hand-rolled estimator (`analyzeOnsets` → mode-of-IOI-bins, music.ts:658-663,
   :610-644) while QC measures against librosa's DP beat tracker, the two estimators' systematic
   disagreement is charged against the gate even with perfect snapping. Two beat backends is an
   architecture bug regardless of either one's quality.
2. **Drift math at 112 BPM over 55s.** Beat period 0.534s; ~103 beats in 55s. A tempo estimate
   off by fraction ε accumulates ε·t of drift: at t=55s, staying under 150ms requires
   ε < 0.15/55 ≈ **0.27% (±0.3 BPM at 112)**. `estimateTempo` quantizes to 0.1 BPM
   (music.ts:643) — inside budget *only if* the mode-of-binned-IOIs estimate is that accurate on
   real mixed music, which is unproven; its onsets are 20ms-hop energy peaks on an 11kHz mono
   decode (music.ts:689-691). librosa's beat tracker follows the onset envelope dynamically and
   absorbs both estimate error and real tempo variance.
3. **Phase.** `detectBeats` anchors the grid at `onsets[0]` — the first detected onset of the track
   (music.ts:696), which is routinely a pickup note, not beat one. A constant phase error up to
   ±267ms fails G1 outright before drift even starts. The founder-journey usage never cared:
   `detectBeats` only feeds `bpmMatchScore` track *selection* (tracks.ts:525), where phase is
   irrelevant. The spec's G1 is the inverse problem and phase is everything.

### 4.1 Measured re-analysis: the gate is inside methodology noise — pin the harness

The reference reel was independently re-measured (2026-08-27) with the exact method 04 §2 names —
librosa 0.11 `beat_track` (22050Hz mono, ffmpeg-demuxed WAV) + PySceneDetect
`ContentDetector(threshold=27)`. Raw data + script: `reference_measured.json` /
`measure_reference.py` (session scratchpad; Agent D commits them as the calibration fixture).
Results:

- **Confirms 01 is genuinely measured**: tempo 112.3 (claimed 112.3), 97 beats (claimed 97),
  duration 54.87s, median cut-to-beat 80ms (claimed 86ms), and the shot-duration list is identical
  to the doc's for the first 28 shots.
- **But the headline gate number does not survive re-measurement**: 29 shots detected vs the doc's
  30 (one threshold-sensitive tail cut: the doc splits its final 5.65s into 1.63+4.02; the detector
  sees one shot), giving **beat_lock_ratio 0.821 (23/28) vs the claimed 0.862 (25/29)**. The five
  misses are 151, 163, 183, 201, 249ms — one of them a single millisecond over the window.
  **The exemplar the ≥85% gate was derived from fails its own gate under a plausible measurement
  configuration.** The pass/fail margin is methodology noise, not signal.

Three consequences, ruled 27 Aug 2026 (full reasoning in ADR-8):

1. **G1 splits into two hard gates with different owners.** The questions "did we cut on the
   beat?" and "did the renderer do what the plan said?" have different failure modes, different
   owners (planner vs renderer), and different noise characteristics — one number cannot gate both.
   - **G1a — musical intent (planner's gate, normative).** Plan cut times vs the plan-embedded
     librosa grid: **≥85% within 150ms** required, ≈100% expected because cuts are snapped
     deliberately; scoring near the threshold means the planner is broken. Evaluated at
     `plan.build` — a plan that fails G1a is rejected before a single frame renders, which is
     also far cheaper than discovering it post-render.
   - **G1b — render fidelity (renderer's gate).** Scene-detect the output and require **≥90% of
     the PLAN's cut times to have a detected cut within ±2 frames (66ms at 30fps)**. Matching
     against *known* cut times is robust to detector sensitivity in a way blind re-discovery is
     not — blind re-discovery is exactly the noise that scored the reference 0.862 or 0.821
     depending on threshold. The pixel-derived beat-lock ratio is written to `qc.json` as
     **informational**, alongside the reference's calibrated 0.821 baseline — never gated on.
   Pixel re-detection without a plan remains necessary only for *reference* fingerprinting (04),
   where its acceptance stays calibration-relative: ≥ reference-under-the-pinned-harness − 2pts,
   i.e. ≥0.80 today.
2. **The QC harness pins its methodology, normative for both gates**, committed as config,
   not convention: librosa version pinned in `requirements.txt` (0.11.x), `beat_track` on
   ffmpeg-demuxed mono 22050Hz WAV (librosa/soundfile cannot open MP4 — demux first), default
   hop 512, `units="time"`; `ContentDetector(threshold=27)` for pixel paths; the t=0 boundary is
   not a cut; distances compared as integer milliseconds, pass at ≤150 inclusive (G1a) / ≤66ms
   (G1b). Changing any of these is a `planVersion`/`analyzerVersion` bump, never a silent edit.
3. **The reference re-measurement is the calibration baseline**, committed as a fixture
   (`reference_measured.json` + script): the informational pixel ratio is always reported next to
   the 0.821 baseline so a reviewer reads it against what the human exemplar actually scores under
   the same harness, and the fingerprint threshold moves only when the pinned harness re-measures
   the reference — never independently.

This evidence also *strengthens* the librosa decision rather than reopening it: a human editor
cutting by feel lands median 80ms from the beat and still only manages 82-86%. Clearing 85%
reliably means our cuts must be tighter than the human exemplar's, which only construction-time
snapping to real tracked beat times delivers — an extrapolated constant grid spends the entire
error budget (§4 reason 2) before the first cut is placed. And the misses clustering at 151-249ms
is exactly the scale of estimator disagreement, confirming reason 1 (one grid for planner and QC).

**Canonical grid = `MediaAnalysis.beats`, embedded into `RenderPlan.plan`.** QC scores G1a as plan
cut times vs the plan's embedded grid at `plan.build` (§4.1 — single source of truth,
detector-noise-free, and required anyway for G13 reproducibility); G1b then verifies the render
executed the plan, and the pixel-derived ratio is informational only. To prevent a degraded grid from gaming the gate, QC adds a **grid-quality check**:
mean onset-strength at beat times ÷ mean at inter-beat midpoints must exceed a threshold calibrated
on the reference (which measures 86% lock at 112.3 BPM, 01 §3).

**The snap algorithm gets a second degree of freedom the docs miss.** Cuts are constrained to word
edges (G10, ported `snapToEdge`, ±50ms — schema.ts:85-96); beats every 534ms. The joint constraint
can be infeasible on dense speech. But the music bed's *start offset is ours to choose*: first fix
the speech-legal cut list from the rhythm plan, then solve for the bed's global phase φ minimizing
total cut-to-beat distance (a 1-D circular optimization), then micro-shift residual cuts within
their word-edge slack. Cuts placed inside speech pauses (any point in a ≥400ms gap is legal)
satisfy both constraints almost freely. And when the bed is `synthBed`, the grid is exact **by
construction** — the strongest guarantee available.

**Fallback ladder** (recorded in `beat_method`):
1. `beat_track` — librosa on the chosen licensed/synth bed. The production path.
2. `onset_env` — speech-only footage, no bed (02 §5): grid from librosa onset-strength peaks,
   cuts snapped to speech-pause boundaries; QC measures against this stored grid.
3. `constant_grid` — ported `buildBeatGrid`, dev machines without the sidecar only. QC marks the
   render `degraded`; a `constant_grid` plan can never pass G1a for merge evidence.

**What must be MEASURED before Agent M builds the planner** (P's first-week spike, §8):
- **M-1 estimator honesty**: librosa `beat_track` vs ported `detectBeats` on ≥10 licensed-library
  tracks + the reference audio: Δtempo and median per-beat offset at t=55s. Validates reasons 2-3
  with numbers.
- **M-2 reference reproduction** (04 §6): **already done** — see §4.1. The extractor reports tempo
  112.3, beat_lock_ratio 0.821 under the pinned harness. `measure_reference.py` is the working
  seed of `scripts/qc-render.ts`'s measurement stage (P adapts it; D commits
  `reference_measured.json` as the calibration fixture). 04 §6's "≥0.80" line survives; its
  "if it doesn't reproduce those numbers the extractor is wrong" now has the numbers pinned.
- **M-3 joint feasibility**: on ≥3 real talking-head clips, simulate the planner (word edges +
  phase-optimized grid, a ~100-line script over MediaAnalysis output): report achievable lock %.
  Target ≥90% (margin over the 85% gate). **If M-3 fails, the milestone's core promise is at
  risk and the human must see the number before M builds anything.**
- **M-4 fallback ceiling**: |beat_track − constant grid| at t=55s across the library, p95 — tells
  us honestly whether rung 3 is ever more than a dev convenience.

### 4.2 M-3 came back MARGINAL — the planner algorithm is therefore mandated (orchestrator ruling)

Agent P measured M-3 on 6 real talking-head clips using a *perfect* phase-optimized grid, which
isolates the geometric question from any grid-estimation error. Result: at the reference's
112.3bpm, mean lock across seeds 86.9–92.2% (grand mean ~89.7%) — but **per-clip minimums of
78.9–87.8%, i.e. some clip on some rhythm draw falls under the 85% G1a gate**, and one real clip
failed outright at 82.05%. Tempo sensitivity is steep and real: 90bpm → 84.5% mean (fails on
average), 130bpm → 93.5% (clears comfortably).

M-1/M-4 give the accompanying verdict on the fallback: the ported estimator's median tempo error
is 14bpm against a budget of ~0.3bpm, p95 drift at t≈55s is 556ms against a 150ms gate, and it
converges on exactly 187.5bpm on dense tracks because of a 150ms minimum-onset-gap floor.
`constant_grid` is a dev convenience and never a production rung. ADR-2 stands, now with numbers.

**The ruling.** What P simulated is the algorithm 02_MOTION_SYSTEM §5 specifies — *draw a rhythm
curve, then snap each planned cut to the nearest beat* — and that algorithm is structurally
marginal, because it commits to cut POSITIONS before it knows where legal word edges are and
therefore wastes cuts on positions no word boundary can serve. **02_MOTION_SYSTEM §5 step 3 is
superseded for Agent M**, which must instead treat cut placement as a joint optimization over
candidate cut points:

- **Candidates** are word boundaries from the WhisperX/faster-whisper output, each carrying a
  pause-quality score (a >400ms gap is a better cut than a mid-sentence word edge).
- **Cost** per candidate combines distance to the nearest beat (hard-reject beyond 150ms),
  deviation from the rhythm curve's target duration for that slot, and pause quality.
- **Solve** with a DP/Viterbi over candidates subject to the [0.6s, 5.0s] shot constraint,
  maximizing beat-locked cuts while keeping the rhythm plausible. This never places a cut where a
  word edge and a beat fail to coincide; the rhythm curve bends to accommodate instead.
- **Phase** (where the licensed bed starts) stays an optimization variable, as does **tempo**:
  search 2–3 candidate beds within the mood-appropriate band and keep the best-scoring plan.

  But tempo alone does **not** rescue this, and P's full sweep is why (seed=42, 6 clips, perfect
  phase-optimized grid):

  | Tempo | Mean lock% | Min (worst clip) |
  |---|---|---|
  | 90 bpm | 84.5% | 74.4% |
  | 100 bpm | 85.3% | 76.3% |
  | 112.3 bpm (reference) | 89.4% | 82.1% |
  | 120 bpm | 92.0% | **79.0%** |
  | 130 bpm | 93.5% | 86.7% |

  The mean rises monotonically with tempo; **the minimum does not** — 120bpm posts a better mean
  than 112.3 but a *worse* worst case. Only 130bpm lifts the minimum clear of the gate, and 130bpm
  is a driving tempo that is musically wrong for a reflective or authoritative piece. So biasing
  tempo upward is a useful secondary lever, not the fix: **the DP is load-bearing**, because what
  fails the gate is a specific clip's word-edge geometry, not the average clip's.
- **Honest failure**: if the best plan still cannot clear G1a, emit `plan_infeasible` with the
  measured lock % (03 §7) rather than rendering something that will fail QC. G1a is evaluated at
  `plan.build` precisely so this costs a plan, not a render.

Consequence for ADR-8: G1a's "expected ≈100%" was optimistic. Expect high-but-not-perfect, and
treat a plan that clears 85% only barely as a signal to re-search tempo/phase, not as a pass.

M iterates against P's committed M-3 fixture and must demonstrate improvement by re-running that
same simulation — a number in a PR body is not runnable evidence. **M's acceptance bar is the
naive baseline at the reference tempo: mean 89.4%, worst clip 82.1%. Beating the mean is easy and
not the point; the deliverable is lifting the WORST CLIP above 85% at a musically appropriate
tempo.** Report both figures, at 112.3bpm, via `npx tsx scripts/measurements/m3-report.ts`.

---

## 5. Python sidecar strategy

**Decision: one new container image (`Dockerfile.media`: Node + ffmpeg + Python venv), run as a
separate long-running ECS Fargate service (`worker-media`) consuming only `media.analyze` and
`render.qc`. The Node job shells to the venv via `execFileSync` — the exact pattern founder-journey
has run in production shape (pipeline/transcribe.ts:32-46).**

| Option | Verdict | Why |
|---|---|---|
| Same (existing) image | Rejected | torch+faster-whisper+librosa ≈ 1.8GB installed (founder-journey `.venv` measured 1.8GB); bloats every api deploy and couples api rollbacks to ML deps. |
| **Separate service, same repo, new image** | **Chosen** | BullMQ already routes by queue name; `worker-media.ts` is ~30 lines of worker wiring. No cold start (long-running); image pull cost paid once per deploy, not per job. Analysis sizing (2 vCPU / 8GB) decoupled from api sizing. One extra Fargate service ≈ $60-70/mo at 1 task — cheapest option that isn't a lie about ops complexity. |
| Lambda (container) | Rejected | 15-min hard cap vs the 15m analyze budget (03 §3) leaves zero headroom on long footage; 10-30s cold starts with torch; BullMQ→Lambda bridging is new machinery. |
| Managed API (Modal/Replicate) | Rejected for v1 | Ships client footage to a third party (data posture), new vendor dependency needing PR-body justification. Documented escape hatch if analyze throughput ever demands GPU. |

Details: Python is invoked per-job as a CLI (`analyzer.py --stages …` writing JSON to a temp dir,
zod-validated on the Node side via the ported io.ts loaders) — no long-lived Python process, no
Python↔Redis client, no HTTP inside the task. `requirements.txt` pins exact versions;
`MediaAnalysis.analyzerVersion` records them (QC and planner grids must come from the same librosa).
faster-whisper runs CPU int8 (03 §3 says CPU acceptable at this scale; whisperx_run.py already
avoids the pyannote/torchcodec swamp). Terraform: additive resources only — new ECR repo, task
definition, service, log group; existing `api`/`worker`/`migrate` definitions untouched.

---

## 6. Boundary with the M1 ring

**Files Studio agents must never modify** (07 §4 + project CLAUDE.md, made exact):

| Area | Off-limits files |
|---|---|
| Webhooks | `apps/api/src/routes/webhooks.ts`, `apps/api/src/domain/webhook.ts`, `apps/api/src/jobs/webhook.ts` |
| Recall client | `apps/api/src/integrations/recall.ts` |
| R2 streaming | `apps/api/src/integrations/r2.ts` (consume its exports from new `studio-r2.ts`; never edit) |
| Review-gate write path | `apps/api/src/domain/review-gate.ts`, `apps/api/src/routes/review.ts` (new endpoints go in `routes/content.ts`) |
| Brief versioning | `apps/api/src/domain/brief.ts`, `apps/api/src/routes/brief.ts` |
| M1 ingestion jobs | `apps/api/src/jobs/ingest-recording.ts`, `ingest-transcript.ts`, `extract.ts` |
| Schema | every existing model block in `apps/api/prisma/schema.prisma` (Tenant gains back-relation lines only) |

Permitted single-line touches, called out so they aren't smuggled: `db.ts` UNSCOPED gains
`"MotionTemplate"`; `append-only.ts` APPEND_ONLY_MODELS gains `"RenderPlan"` and
`"ContentBriefDecision"`; `queue.ts` gains the four studio queues; `worker.ts` registration if
needed. Nothing else in those files.

**How ContentBrief reuses the gate without touching its write path.** A fact the spec doc gets
wrong: 05 §3 says ContentBriefs use "the same `review_decisions` table". **They cannot, additively**
— `review_decisions.claim_id` is a required FK to `candidate_claims`
(schema.prisma:438, relation at :453); a ContentBrief id cannot live there without loosening the FK,
which is a destructive change to the M1 audit log. What "reuse the gate" really means, and what we
build:

- **Reuse the surface**: the same ReviewQueue UI, same A/E/R keyboard, a new card type showing
  hook / archetype / beats / WHY-line with claim source chips. `ReviewQueue.tsx` is extended
  (UI, not write path).
- **Mirror the mechanism, own table**: Agent B adds `ContentBrief` (status:
  proposed/approved/rejected/superseded, `claim_ids`, `framework_id`, `generated_by_model`, …) and
  an append-only `ContentBriefDecision` table mirroring ReviewDecision's shape, written in the same
  transaction as the status flip by **`domain/content-gate.ts`** — a deliberate clone of
  `recordDecision`'s one-transaction discipline (review-gate.ts:87-107).
- **Yes, ContentBrief needs the analogous guard.** The existing source-scan test walks `src/` and
  fails any `candidateClaim.<write>` carrying `status:` outside the gate module
  (review-gate.test.ts:637-660, balanced-paren scanner at :677-690). Agent B must ship
  `tests/content-gate.test.ts` doing the identical scan for `contentBrief.` writes with
  `domain/content-gate.ts` as the only allowed writer — including the "gate really contains the
  write" positive assertion (:658-659). Without it, invariant "only approved briefs enter
  `plan.build`" (05 §3) is a convention, not a property.
- Enforcement at the seam: `plan.build` loads the brief through a service function that throws
  unless `status === 'approved'` — service layer, not route layer, per 05 §3.

---

## 7. ADRs

### ADR-1 — Port target layout: `packages/render` workspace + api-resident jobs + `services/analyzer`
- **Context**: Remotion needs a bundle root; meeting-bot is a 2-workspace npm monorepo with one
  HTTP service and jobs in `apps/api/src/jobs` (queue.ts:15-23); production is one Node image on
  Fargate (ecs.tf:2-7).
- **Decision**: render contract + compositions in a new `packages/render` workspace (no DB, no
  network — preserving Reel.tsx's proven purity, Reel.tsx:1-30); orchestration in `apps/api`;
  Python in `services/analyzer` baked into a second image.
- **Consequences**: `remotion` imports confined to one package (licensing + swap containment);
  api image unchanged; one more workspace in the root `package.json`.
- **Rejected**: `apps/studio` service (duplicates auth/tenancy for nothing); Remotion inside
  `apps/api` (React+webpack in a server build, license spread); porting founder-journey's
  ports-and-adapters + raw `pg` layer (incompatible with Prisma/meeting-bot conventions —
  only files above the data layer port).

### ADR-2 — Beat grid: librosa in the sidecar is the source of truth; plan embeds the grid
- **Context**: §4. G1 measured with librosa; constant grid has unbounded phase error and a 0.27%
  tempo-accuracy budget; planner/QC estimator split would corrupt the gate.
- **Decision**: `beat_track` → `MediaAnalysis.beats` → embedded in `RenderPlan.plan`; QC measures
  against the embedded grid + grid-quality check; ladder `beat_track → onset_env → constant_grid
  (dev-only, marked degraded)`; bed phase is an optimization variable.
- **Consequences**: librosa becomes a hard production dependency (it is currently installed
  nowhere on this machine — verified); G1 becomes self-consistent and reproducible.
- **Rejected**: ported `buildBeatGrid` as primary (music.ts:647-655 — extrapolated constant tempo,
  first-onset anchor); JS beat-tracking libraries (unproven against the librosa-defined gate);
  aubio/madmom sidecars (heavier or unmaintained; librosa is the gate's own ruler).

### ADR-3 — Python sidecar: second image + second Fargate service, Node shells to venv per job
- **Context**: §5. faster-whisper + librosa + PySceneDetect + torch ≈ 1.8GB; meeting-bot ships one
  lean Node image; BullMQ is the job fabric.
- **Decision**: `worker-media` service from `Dockerfile.media`; per-job `execFileSync` CLI calls
  (ported transcribe.ts pattern); pinned `requirements.txt` recorded as `analyzerVersion`.
- **Consequences**: second deploy artifact + ECR repo (~$60-70/mo idle); api rollbacks decoupled
  from ML deps; analyze concurrency scales by service count.
- **Rejected**: same image (bloat/coupling), Lambda (15-min cap, cold start, bridge machinery),
  managed API (client footage leaves our account).

### ADR-4 — Transitions/restraint: hard cuts only; ENTER_VALUES does not port
- **Context**: reel.ts:25-43 defines 44 entrance effects plus GIF stickers (Giphy), B-roll
  (Pexels), 8 SFX kinds; 01 §8 measures the reference at zero transitions and bans all of it.
- **Decision**: none of the decoration vocabulary ports (ledger §1). The plan schema has no
  `enter` field at all in v1 — absence in the contract, not a lint rule, is the enforcement.
  Audio infrastructure (duck, synthBed, music library, proxy) explicitly ports (my one
  disagreement with a maximal reading of restraint).
- **Consequences**: T's templates cannot reach for an effect that doesn't exist; adding any
  transition later is a schema change that shows up in review. Big deletion surface in the
  Reel.tsx port.
- **Rejected**: porting effects "disabled by default" (dead code invites resurrection and
  contradicts "build the capability, not a label" — PERFSTAQ-STATUS §8.1).

### ADR-5 — Remotion licensing: flagged risk, containment now, decision deferred to the human
- **Context**: Remotion requires a paid company license for commercial/automated use — Automators
  tier listed at $0.01/render + $100/mo min (open-source-video-tools.md:35); Revideo and Motion
  Canvas are MIT escape hatches (:36-37). PerfStaq Studio is exactly the automated commercial case.
- **Decision**: **DEFERRED by the human, 27 Aug 2026 — revisit before commercial launch.** Build
  on Remotion now under its development/evaluation terms; the commercial licence decision happens
  before GA, not now. The containment requirement stands and is what preserves the option: all
  timing/motion/caption math lives in pure TS modules in `packages/render/src` (framework-free,
  like ported motion.ts/duck.ts); compositions are thin plan-consumers; `remotion` imports allowed
  only inside `packages/render`. A forced Revideo swap then touches one directory, not the
  pipeline.
- **Consequences**: no licence spend or migration cost now; the obligation accrues with every week
  of build on Remotion, and a swap gets more expensive over time (each new template/composition
  deepens the Remotion-specific layer). A dated revisit gate belongs in the GA checklist; if the
  decision then is "don't pay", expect ~2-3 weeks of composition-layer rework, bounded by the
  purity rule.
- **Rejected**: switching to Revideo now (discards the highest-value ported asset and the master
  doc's explicit decision); ignoring the license (it's a per-render commercial term, not a
  theoretical risk).

### ADR-6 — ContentBrief approval: own decision table + own gate module + own source-scan guard
- **Context**: §6. `review_decisions.claim_id` FK makes "same table" impossible additively;
  the review-gate's guarantee is enforced by a static scan (review-gate.test.ts:637-660).
- **Decision**: `ContentBriefDecision` (append-only) + `domain/content-gate.ts` (one-transaction
  status+audit) + mirrored source-scan test; ReviewQueue UI extended with the brief card type;
  approved-only enforcement in the service in front of `plan.build`.
- **Consequences**: 05 §3's "same audit log" becomes "same audit *discipline*"; the M1 log's FK
  integrity is preserved; the guard makes the property machine-checked from day one.
- **Rejected**: loosening the FK (destructive, invariant 6); polymorphic decision rows
  (subject_type/subject_id — destroys FK integrity for both); reusing CandidateClaim rows to
  represent briefs (wrong shape, pollutes claim analytics and the merge path).

### ADR-7 — Render execution: Remotion Lambda for product renders; local renderer for dev/CI
- **Context**: 03 §4 mandates Lambda; Fargate CPU renders a 55s reel in 10-30 min vs ~1-2 min
  parallelized; footage lives in R2, Lambda in AWS.
- **Decision**: `render.submit` deploys the `packages/render` site bundle once per version, feeds
  presigned R2 URLs in (r2.ts:122), copies output S3 → R2 via `streamUrlToR2` (r2.ts:67); embedded
  data-URL fonts (fonts.ts pattern) keep the bundle deterministic offline. Dev/CI render via
  `@remotion/renderer` inside the media image — tests never need AWS.
- **Consequences**: first real AWS-Lambda dependency in the stack (Terraform additive); QC runs on
  the returned MP4 identically in both paths.
- **Rejected**: Fargate render farm (03 §4 forbids; slow), rendering inside api/worker (starves
  the queue fabric).

### ADR-8 — G1 splits into G1a (musical intent) + G1b (render fidelity); pinned harness; calibrated baseline
- **Context**: Independent re-measurement of the reference (§4.1, `reference_measured.json`) with
  the spec's own method (librosa 0.11 + ContentDetector(27)) reproduces 01's tempo/beats/shot list
  exactly — but yields beat_lock 0.821 vs the claimed 0.862, on a single threshold-sensitive tail
  cut, with one miss 1ms over the 150ms window. The exemplar fails its own ≥85% gate under a
  plausible configuration; the margin is measurement noise. Underneath that noise sit two distinct
  questions a single pixel-measured ratio was conflating: "did we cut on the beat?" (planner) and
  "did the renderer do what the plan said?" (renderer) — different failure modes, different
  owners, different noise characteristics.
- **Decision** (ruled 27 Aug 2026): (a) **G1a — musical intent, normative hard gate**: plan cut
  times vs plan-embedded librosa grid, ≥85% within 150ms, expected ≈100% because cuts are snapped
  deliberately; evaluated at `plan.build`, so a failing plan is rejected before any render spend.
  (b) **G1b — render fidelity, hard gate**: scene-detect the output and require ≥90% of the
  plan's cut times to have a detected cut within ±2 frames (66ms at 30fps); matching against
  known cut times is robust to detector sensitivity where blind re-discovery is not. The
  pixel-derived beat-lock ratio goes into `qc.json` as informational, reported alongside the
  calibrated 0.821 reference baseline — never gated on. Reference-fingerprint acceptance (04 §6)
  stays calibration-relative: ≥ (reference under the pinned harness − 2pts) = ≥0.80 today.
  (c) The harness config — librosa version, demux-to-WAV, hop, detector threshold, t=0 not a cut,
  integer-ms comparison, ≤150ms (G1a) / ±2 frames (G1b) — is pinned in committed config and
  normative for both gates; changes bump `analyzerVersion`/`planVersion`. Reference measurement +
  script committed as fixtures.
- **Consequences**: planner failures and renderer failures are separately attributable to their
  owning agents (M vs T/P) with no shared number to argue over; G1a rejection is pre-render and
  cheap; detector tuning can no longer game or fail a gate (G1b never asks the detector to find
  cuts it wasn't told about); the gate stops depending on whether a 5.65s tail reads as one shot
  or two; a reviewer arguing with a number can re-run one script.
- **Rejected**: one pixel-measured ratio gating both questions (conflates two failure modes with
  different owners; the exemplar itself oscillates across the threshold — a gate the exemplar
  can't reliably pass indicts the harness, not the render); hardcoded 0.85 measured by pixel
  re-detection (same reason); loosening to ≥0.80 everywhere (throws away the margin exactly where
  we control the outcome); widening the window to 160ms (moves the noise boundary instead of
  removing it).

---

## 8. Revised build order & agent scoping

**P → M → T → B (B parallel with M/T), F after T merges — the order HOLDS.** The port changes
what "P first" means and shrinks M's greenfield. Corrections the orchestrator must apply to agent
prompts:

| Agent | First task (revised) | Notes |
|---|---|---|
| **P** | Not "inventory PerfStack" — **this document is that inventory; delete that task.** Instead: (1) scaffold `packages/render` + `services/analyzer` + `Dockerfile.media`; (2) additive Prisma migration from §3; (3) four queues + `worker-media.ts`; (4) sidecar `words/beats` stages working end-to-end; (5) **run measurements M-1…M-4 (§4) and report the numbers before M starts the planner.** Also owns `scripts/qc-render.ts` (07 §1) — QC must exist before there is anything to gate. |
| **M** | Port `schema.ts`/`motion.ts`/`duck.ts` into `packages/render/src` (prune per ledger), then SPRINGS + caption engine + emphasis scorer + the beat-snap planner **using P's M-3 data**. M consumes a real `MediaAnalysis` fixture, not synthetic timings. |
| **T** | Port the Reel.tsx shell (strip decoration branches per ADR-4), then template #1 on M's primitives. First template escalates a model rung per 06 §1 — it sets the pattern. |
| **B** | ContentBrief model + `content-gate.ts` + `ContentBriefDecision` + the mirrored source-scan guard (§6) + review-card UI + `routes/content.ts`. Adds the `RenderPlan.contentBriefId` relation in its own additive migration. Fully parallel with M/T once P's migration lands. |
| **F** | Unchanged: after T. Its acceptance test is 04 §6 against the reference — which P's M-2 measurement will already have exercised, so F starts with a working extractor harness. |
| **D** | Golden fixtures: the reference clip's `MediaAnalysis` JSON, a 60-90s talking-head footage fixture with known pauses, 2-3 licensed-library test tracks (or synthBed output) with known BPM. |
| **Reviewer** | Gains the grid-quality check (§4) on top of 07's gates; a `constant_grid` render is auto-rejected as merge evidence. |

**Context discipline correction (06 §4)**: each agent's packet must now include
`ARCHITECTURE.md` (this file) alongside 00/01/CLAUDE.md + its own doc — the ledger and boundary
list are load-bearing for every agent, and 06's packet predates this file's existence.

**Doc assumptions now false** — see §10; the orchestrator should paste that table into any agent
prompt that cites the affected sections.

---

## 9. Risk register (ranked — #1 most likely to sink the milestone)

1. **G1×G10 joint infeasibility on real speech** — beat-lock ≥85% AND zero mid-word cuts may not
   coexist on dense, pause-poor speech even with phase optimization. *Mitigation*: M-3 measured in
   P's first week, before the planner exists; rhythm plans biased to cut in pauses; synthBed's
   by-construction grid as the guaranteed-feasible bed. *Signal*: M-3 < 85% ⇒ halt and surface.
2. **Remotion commercial license** (ADR-5) — decision DEFERRED by the human (27 Aug 2026) to
   before commercial launch; build proceeds under development/evaluation terms. The exposure is
   not static: **the obligation accrues with every week of build on Remotion, and a swap gets more
   expensive over time** as templates and compositions deepen the Remotion-specific layer.
   *Mitigation*: the containment boundary (remotion imports only in `packages/render`, pure-TS
   timing/motion math) is mandatory precisely because it is what keeps the deferred option
   affordable; put a dated revisit gate in the GA checklist.
3. **QC/planner measurement mismatch** — *downgraded off the blocking path by ADR-8*: the
   evidence (reference beat-lock 0.862→0.821 under a plausible config, §4.1) is resolved by the
   G1a/G1b split — G1a is detector-free, and G1b only matches *known* plan cut times (±2 frames),
   never asking the detector to find cuts it wasn't told about, so Ken-Burns-vs-ContentDetector
   sensitivity no longer gates a render. Residual (non-blocking): detector noise still colors the
   informational pixel ratio and reference fingerprinting (Agent F) — calibrate on renders of
   known plans (D's fixtures) and read the informational figure against the 0.821 baseline.
4. **Sidecar ops drag** — second image doubles deploy surface; torch image builds are slow;
   librosa/numpy pinning drift breaks grid reproducibility. *Mitigation*: pinned requirements,
   `analyzerVersion` on every row, media image built only when `services/analyzer` or
   `Dockerfile.media` change.
5. **Port contamination** — agents "helpfully" porting banned modules (Giphy, ENTER_VALUES, SFX)
   because the code is right there and works. *Mitigation*: ledger is normative; plan schema has no
   fields for the banned vocabulary (ADR-4); lint forbids `remotion` outside `packages/render`.
6. **Lambda↔R2 plumbing** — presigned-URL expiry mid-render, egress cost, output copy-back
   failures. *Mitigation*: long-expiry presigns scoped per render, retry posture copied from
   queue.ts:45-50, `failedStage` on Render rows.
7. **Style-transfer caption OCR fidelity** (04 §2 med-high at best) — F's fingerprints may be too
   noisy to map. *Mitigation*: per-field confidence with template-default fallback is already
   spec'd (04 §3); F is last in the build order, so the miss is contained to capability B of the
   mission, not the render pipeline.
8. **M1 regression via shared surfaces** — queue.ts/worker/db.ts one-liners are the only shared
   touches; the 344-test api suite + the off-limits list (§6) fence the rest. Lowest likelihood,
   highest severity — every Studio PR runs the M1 suite (07 §4).

---

## 10. Doc corrections — statements to stop trusting

| Doc | Says | Reality |
|---|---|---|
| 00_MASTER §3 | "PerfStack pipeline (prior work): Remotion, WhisperX, FFmpeg" — a utils pile | It is a ~56.5k LOC *product* (own Postgres+pgvector data layer, 16-port hexagonal core, strategy brain, 786 tests). Agents port the specific files in §1's ledger; nothing imports the repo wholesale. Its data layer (raw `pg`, checksum-guarded SQL migrations) is incompatible with Prisma and does not port. |
| 03 §1 / 02 §2.2 | "WhisperX word-level timestamps" | The actual runner is faster-whisper + Silero VAD via `scripts/whisperx_run.py` (whisperx_run.py:3-9), deliberately avoiding pyannote/torchcodec breakage. Keep that runner; treat "WhisperX" in the docs as "word-level ASR". |
| 02 §5 / 03 §1 / 07 G1 | librosa assumed available | librosa (and PySceneDetect) are installed **nowhere** on this machine — the founder-journey venv has faster-whisper+torch only. The sidecar (§5) must introduce both; they are new production dependencies, not existing capability. |
| 05 §3 | ContentBriefs use "the same `review_decisions` table" | Impossible additively: `review_decisions.claim_id` FKs `candidate_claims` (schema.prisma:438). Same UI surface and same discipline, **new** `ContentBriefDecision` table + `content-gate.ts` + mirrored guard (§6, ADR-6). |
| 03 §2 | `MediaAnalysis` sketch has no tenant_id | Every non-exempt model must carry it — the db.ts tenancy extension injects it into all queries (db.ts:66-98). §3's blocks are the corrected shapes. |
| 03 §4 | "Fonts via `@remotion/google-fonts` or self-hosted woff2 in public/" | Ported embedded data-URL fonts (fonts.ts:4-9) are strictly better: no `delayRender` hang risk, offline-deterministic on Lambda. |
| 00 §3 / implicit | The engine's cutting is beat-aware and reusable for G1 | Cutting is silence/filler-based (detect.ts:129-155); `detectBeats` exists only to *select music* by BPM match (tracks.ts:525). The G1 direction — cuts snapped to a beat grid — exists nowhere in the source and is new work on a new (librosa) foundation (§4). |
| 01 §3 / §9, 07 G1 | Reference achieves 86% beat-lock; gate is a plain "≥85% within 150ms" | Methodology-sensitive: re-measurement with the spec's own tools yields **82.1%** (29 shots, not 30) — the exemplar straddles its own gate. 86% is not a reproducible constant; G1 is only well-defined under the pinned harness + plan-based measurement of §4.1/ADR-8. Trust 01's tempo/shot-list numbers (they reproduce exactly); do not trust the headline ratio as a stable target. |
| 06 §4 packet list | Agent packet = 00 + 01 + own doc + CLAUDE.md | Add ARCHITECTURE.md (this file) to every packet — ledger and off-limits list are load-bearing. |
| `/Users/sathvik/aix/PRODUCT_STATUS.md` | (root status doc) | 5 weeks stale, understates the source repo ~20×. Ignore entirely; `founder-journey/docs/PERFSTAQ-STATUS.md` is the definitive self-audit. |

---

## 11. Orchestrator rulings — spec reality audit (27 Aug 2026)

A second audit of `02`, `04`, `05` and `07` against the real code found six blocking gaps beyond
§10's. The pattern behind most of them: **the specs name analyzer outputs and catalogue objects
that no stage produces and no agent owns** — they assumed a richer pipeline than the one being
built. These rulings are binding; where they contradict a spec doc, they win.

### 11.1 Agent M — the three data seams

**R1 — RMS-per-word: BUILD IT.** `02 §3`'s emphasis scorer weights `audio_energy_zscore(word)`
at 1.5, and `03 §1` promised "RMS/word" from librosa, but no stage produces it (`analyzer.py:34`
implements `words` and `beats` only). Do not drop the term — audio stress is genuinely how a
speaker marks emphasis, and "one word per phrase gets emphasis treatment" is in the mission
statement. **Owner: Agent P** (sidecar owner): add RMS over each word's span to the `words` stage
output, extend the zod schema, bump `analyzerVersion`. ~20 lines of librosa.

**R2 — luminance, motion and faces: DESCOPED for v1, by shipping exactly what the reference
does.** These three stages are unimplemented and unowned. Rather than assign them, remove the
need:
- **Scrim/luminance — descoped.** `02 §2.2` makes the scrim optional; the reference achieves
  legibility with a 2px drop shadow alone (`01 §4`). Ship drop-shadow always, scrim as a static
  per-template policy. No luminance analysis in v1.
- **Motion energy — descoped.** `03 §6` scores footage segments partly on motion energy, but the
  reference is a locked-off podcast where motion energy is near-constant, and our target footage
  is the same genre. Score segments on pause quality + word-RMS (R1) + duration fit.
- **Faces — descoped, with framing.** **v1 ships `letterbox` framing only.** This is what the
  reference does (`01 §7`), and it dissolves the problem: captions live in the black bars and
  structurally cannot occlude a face, so no face detection is needed. `fill` framing and
  MediaPipe face boxes are deferred to v2 and must be added together.

**R3 — claim text reaches the plan by denormalization.** `02 §3`'s `appears_in_claim_text` needs
claim text, ContentBrief carries only `claim_ids`, and `05 §1`'s "neither side knows the other's
internals" forbids M reaching into claim tables. **Ruling: ContentBrief stores the claim texts
alongside the ids, frozen at generation time.** This mirrors `BriefClaim`'s existing freeze
rationale (`schema.prisma:497-498`) and is required for reproducibility (invariant 6): a later
edit to a claim must not retroactively change what an already-approved brief emphasised.

### 11.2 Agent B — catalogue and provider

**R4 — the framework catalogue is a versioned TS const, not a table.** `05 §1` makes
`framework_id` MANDATORY; nothing named "framework" exists in the schema or source. It is product
knowledge that changes with our thinking, not tenant data — a table would mean a migration every
time an editorial judgement changes. Ship a versioned const (id, name, evidence tier, when-to-use,
the claim signals that favour it), validated at write time, starting with the tier-A frameworks
`05 §2` already names. **`framework_evidence_tier` is denormalized onto the brief**, frozen, for
the same reason as R3.

**R5 — OpenAI structured outputs. CLAUDE.md wins.** `05 §2` says "Anthropic tool-calling schema"
and `06 §1` lists `claude-*` runtime models; CLAUDE.md says "Do NOT switch LLM provider in this
milestone" and the only client is OpenAI. **CLAUDE.md is binding: ContentBrief generation uses the
Responses API with strict Structured Outputs**, the proven house pattern (`openai.ts:175-177`),
model id in a new env var. `06 §1`'s runtime-model block is superseded. Two consequences the audit
surfaced, both real: strict mode's schema subset excludes validation keywords (`openai.ts:74-83`),
so `05 §3`'s "empty `claim_ids` ⇒ dropped" must be enforced in a coercion layer exactly like
`coerceClaims`; and no vision-capable client is wired, which gates F's style classification (see
R6).

**R6 — no OCR in v1; low-confidence fields fall back to template defaults.** `04 §2` rates three
signals Med-high to High on per-frame OCR, but no OCR tooling exists on the machine, in any venv,
or in the port source. `04 §3` already specifies the correct behaviour: *"Every low-confidence
field falls back to the template default rather than guessing."* Apply it from day one — caption
timing, position pattern and emphasis treatment ship at confidence 0. What survives is genuinely
high fidelity and is what "recreate in this style" actually promises: rhythm (PySceneDetect),
tempo and beat grid (librosa), framing (black-bar detection, trivial in cv2), grade (histogram
fit), zoom (optical flow). Adding tesseract to a production image for medium-fidelity signals is a
bad v1 trade. Revisit in v2 alongside `fill` framing.

### 11.3 Corrections (buildable, but the doc misleads)

- **Springs must be duration-rescaled, or G7 fails.** `02 §1`'s `drift` config
  (`damping 200, mass 3, stiffness 40`) is heavily overdamped: at natural speed a 0.6s shot
  traverses ~11% of its range → ~0.57% scale delta → **fails G7's "scale delta >1% on 100% of
  shots"**, and the reference's accelerate bursts are 0.7–1.2s. Remotion's `durationInFrames`
  rescaling is the mechanism and `02` never mentions it, though the port source uses it on every
  spring call. **M's contract: `durationInFrames = shot frames` for drift, stated frame counts for
  pop/punch.** Restate "exits ~40% faster" as a duration rule, not a config rule.
- **G13 is unscoreable as written.** "Same plan+footage → identical checksum" cannot hold across
  render paths — Lambda and the local renderer use different encoder builds, and on Lambda byte
  output depends on chunk concurrency. **Amend to: paired re-render on the identical pinned path ⇒
  identical checksum; otherwise record the checksum.** P's harness already implements this honest
  version. Determinism preconditions (seeded plan, no `Date.now`/`Math.random` in compositions,
  embedded fonts, pinned Remotion version) move into M/T's contract.
- **`04 §6`'s rhythm bands sit on their own floors.** Under the pinned harness the reference gives
  30.6 cuts/min against a 30–36 band and a 1.34s median against a 1300–1600ms band — both within
  one merged shot of failing. Same disease ADR-8 diagnosed. **Make them calibration-relative to
  `reference_measured.json`, and pin the cuts-vs-shots convention** (N shots ⇒ N−1 cuts; t=0 is not
  a cut) in the fingerprint schema. Tempo 110–115 and beat-lock ≥0.80 survive as written.
- **G3 band contradiction:** `07` says median shot 1.0–2.0s, `01 §9` says 1.2–1.8s. **`07`'s wider
  band is the gate**; `01`'s is descriptive of the reference.
- **"Build no new approval UI" understates the cost.** `ReviewQueue.tsx` is claim-typed end to end
  — response shape, filters, decide/undo/bulk endpoints, counts, and an audit rail that per ADR-6
  will never contain ContentBrief decisions. Reusable: visual components, card styling, the
  key-handling pattern (which is lowercase `a/e/r` + `u` + `Shift+A`, not "A/E/R"). **Budget B for
  a parallel queue section sharing components, not a card-type drop-in.**
- **ContentBrief edit semantics mirror M1 lineage.** `05 §1`'s status enum has `edited`;
  ADR-6 has `superseded`. M1 deliberately migrated away from in-place editing to successor-row
  lineage. **Follow M1: successor row + `superseded`, with a `resultBriefId` analog of
  `review_decisions.result_claim_id`.**
- **Render provenance is derived, not denormalized.** `05 §5` says store `claim_ids +
  framework_id + expected_metric` on each `Render`; the landed migration has no such columns and
  ARCHITECTURE §3 has none. **G14 is scored by traversal** (Render → plan → contentBriefId →
  ContentBrief), which P's `gateG14` already assumes. Amend `05 §5`.
- **The scratchpad `qcvenv` is off-harness.** It carries librosa 1.0.0; the pinned harness is
  0.11.0 (`requirements.txt:20`, and `st-p/services/analyzer/.venv` is correct). The two produce
  bit-identical `beat_track` output on the reference (P verified), so no published number is
  wrong — but **qcvenv is for exploratory measurement only; never produce a normative gate number
  with it.**

---

## 12. Corrections from Agent M's first real render (27 Aug 2026)

Agent M built the planner, rendered a real MP4 end-to-end, and in doing so falsified four things
— including one of my own rulings. Recorded here because each was invisible until something ran.

### 12.1 §4.2's "phase is a search variable" was DANGEROUSLY under-qualified (my error)

§4.2 lists bed **phase** as an optimization variable. That is true **only of the licensed music
bed's start offset**, which we choose. It is NOT true of a grid derived from the footage's own
audio: that grid is a physical property of a recording that already exists and cannot be slid.

M's planner swept phase regardless and the result was a silent, total failure — **the demo scored
100% in the planner and 29.2% in QC**, perfectly locked to a grid that does not exist. Nothing
errored. Every intermediate artifact looked correct.

**Ruling: the bed carries a `phaseLocked` flag (M implemented this). A grid derived from source
audio is phase-locked and its offset must never be searched.** Treat any future "optimize X"
instruction in these docs with the same suspicion: ask whether X is something we choose or
something we measured.

### 12.2 §4.2's legality model was wrong — and the baseline it was measured against was invalid

§4.2 mandated a DP over "candidate word-edge cut points" but inherited P's simulation's legality
model, which merged abutting words into speech runs and so permitted cuts only at real silences.
**Under that model the problem is not marginal, it is infeasible** — M's DP finds no legal shot
list on 5 of 6 clips, because real silences in speech are further apart than the 5.0s maximum shot.

Worse, P's 82.05% baseline was never a valid cut list. Its `nearestLegal()` gives up after 2s and
returns the illegal target unchanged, so those cut lists contain **1–4 mid-word cuts (G10 must be
0) and 7–16 sub-0.6s shots (G4)** per clip. The number we treated as "the bar to beat" was
measured on output that fails two other hard gates.

**Ruling: candidates are word EDGES, not silences.** G10 and the ported `wordEdges()` both define
illegal as *strictly inside a word*, so a boundary between two abutting words is legal — that is
the jump cut the reference is built from. `01 §8` says the reference is "cut on itself (jump
cuts)" and `01 §2` measures 30 shots in 54.87s; a podcast contains nowhere near 30 real silences
in 55 seconds, so the reference itself proves the stricter reading wrong.

Result under the corrected model: **100% lock on all six clips, at every seed (1/7/42/99) and
every tempo (90–130bpm)** — the tempo sensitivity in §4.2's table disappears entirely — with
G2/G3/G4 all inside band, so the lock rate is not bought by cutting less.

### 12.3 G1b is unreachable for any plan that does not REMOVE footage

`ADR-8`'s G1b matches plan cut times against pixel-detected cuts. A scene detector finds content
*discontinuities*; a plan that plays footage continuously and only changes framing has none to
find. M's render scores **2/29** on G1b for this reason, and correctly did not chase it — inflating
framing changes until a detector trips is gaming the gate, not passing it.

**Real jump cuts require footage removal — the selection stage of `03 §6`, which does not exist
yet.** G1b therefore cannot pass until that lands, and it is P/T's boundary, not M's. State this
in 07 rather than letting each agent rediscover it by rendering. G1a (29/29 = 100% against a real
librosa grid: tempo 112.347bpm, 97 beats, reproducing `01 §3` exactly) is the gate that means
something today — note the human editor who cut the reference scores 82.1% on that same grid.

### 12.4 `01 §7` is wrong about the reference's framing

`01 §7` says the reference is "16:9 podcast footage scaled to fit width". Measured: the content
region is **720×800 (≈0.9:1)**, not the 405px height a 16:9 fit would give. The operative point
survives — bars exist and carry the captions — but M had to build a 16:9 proxy to exercise
letterbox at all. Anyone reasoning from that sentence about aspect ratios will be wrong.

### 12.5 Caption positions — ruling on the 02 §2.2 vs §11.1 R2 conflict

`02 §2.2` names four rotating positions (`center_low`, `lower_left`, `center`, `upper_third`);
`§11.1 R2` says captions live in the letterbox bars, which is what makes face detection
unnecessary. These genuinely conflict. **M's resolution stands: keep 02's four names, resolve three
into the bars, and place `center` in the video band's bottom sixth** — below a seated subject's
face, which needs no detector. Documented in `layout.ts`. If a future template needs a caption
higher in the video band, it must first justify how it avoids the face without face detection.

### 12.6 G7/G9 are now closeable

M added `ShotMotionSchema` per cut and `anchor` per caption, so micro-motion and safe margins are
decidable from the plan without pixels. Wiring them into `qc-render.ts` is P/T's boundary.

### 12.7 G9 vs the banner — ruling (the reference violates the gate as written)

The demo plan pins the banner at `y: 0.09`, wholly inside G9's 12% top margin. This is a genuine
conflict, not an oversight: `01 §4` measures the reference's banner at ~9% and `02 §2.1` puts it
in the top letterbox bar, while `07 §1` G9 demands zero text within 12% of ANY edge. Agent M
resolved it silently in the reference's favour, and the G9 test asserts horizontal bounds only,
so nothing caught it.

**Ruling: G9's 12% bound applies strictly to the LEFT, RIGHT and BOTTOM edges. The top edge is
exempt for the persistent banner only, which may sit as high as 8%.** Reasoning: G9 exists to
avoid platform UI, and on Reels/Shorts/TikTok that UI is concentrated at the bottom (caption,
CTA) and the right (action rail) — the top is comparatively clear. The banner is the
scroll-stopper hook (`01 §4`: "persistent for the entire clip"), it sits in the letterbox bar
where it occludes nothing, and pushing it to 14% would bury the hook to satisfy a margin
protecting against UI that isn't there. Every other text layer — karaoke, handle, anything a
template adds — stays bound on all four edges.

**Required with this ruling:** the G9 test must assert VERTICAL box extents too (it currently
checks horizontal only, which is exactly why the violation shipped), with the banner exemption
written as an explicit named carve-out rather than an absent assertion. An exemption that nothing
tests is indistinguishable from a bug.

### 12.8 The planner soft-penalises a missed beat; §4.2 said hard-reject

§4.2 specifies "hard-reject beyond 150ms". M implemented a large soft penalty instead: a hard
reject makes the problem infeasible wherever no locked path exists, returning `plan_infeasible` on
clips a slightly-bent rhythm would serve. The penalty is derived at runtime (`missWeightFloor`) to
exceed the worst rhythm cost any in-bounds shot can incur, so a miss is never the cheaper option —
the ordering §4.2 wanted, without the cliff. 100% lock on all six M-3 clips is therefore an
outcome of the optimisation, not an artefact of arithmetic.

### 12.9 Accent colour means EMPHASIS only — ruling on the 02 §2.2 / §3 collision

`02 §2.2` says the *active* (currently spoken) karaoke word is accent-coloured; `02 §3` says the
*emphasis* word is accent-coloured. Same hue, two meanings — and on a one-word chunk the active
word is accent for its entire life on screen, so a deliberately UN-emphasised stopword becomes
indistinguishable from the payload of an approved claim. Caught by looking at a rendered frame
(the word "IT" in accent orange), not by any test.

Worth recording how the diagnosis went, because it generalises: the visible symptom was a
stopword rendered as if emphasised, and the obvious suspect was the emphasis scorer bypassing its
threshold on a single-candidate chunk. That was wrong. The scorer had correctly scored "it" at
−0.77 against a 1.0 bar and recorded `isEmphasis: false`; the plan was right and the renderer was
wrong. **A frame is evidence about the renderer, not about the thing the renderer drew from** —
check the plan before blaming the planner.

**Ruling: accent colour is reserved for emphasis. The active word is carried by opacity.** Agent
M's resolution stands, on its grounds: `01 §4` measures the reference's karaoke layer as plain
white with only the *banner* two-tone; `01 §8` forbids adding effects the reference does not have;
and `02 §2.1`'s own argument — "two coloured words halves the emphasis" — applies with more force
to two coloured words that mean different things. `02 §2.2`'s active-word colouring is superseded.

### 12.10 Render evidence lives in-repo with a manifest — ruling

Render artifacts have been living in `/Users/sathvik/aix/studio-renders/`, outside the repo. That
has now produced the same failure twice in one day: frames written three minutes before a fix were
forwarded to the user as evidence of the fixed behaviour, and the demo MP4 went stale against
`c0dc1a6` while still sitting there looking authoritative. Evidence that cannot be checked against
the code it claims to demonstrate is worse than no evidence, because it is trusted.

**Ruling:** commit `demo-plan.json`, `qc.json`, and 2–3 PNG frames (~500KB each) under
`docs/studio/evidence/`, written by a regeneration script that also emits a manifest recording the
MP4's sha256 and the commit it was rendered from. The 22MB MP4 itself stays out of git. Staleness
then becomes a detectable manifest-vs-HEAD mismatch rather than a silent lie, and a PR reviewer
can tell at a glance whether the pictures describe the code in front of them.

**Owner: Agent T**, as part of the template work — T renders three templates and will produce the
next generation of evidence anyway.

### 12.11 Two open follow-ups from M's review (not blocking, do not lose)

- **Banner wrap is unbounded (Minor A).** The G9 carve-out is asserted at one line only. A hook
  long enough to wrap at `0.062·W` puts ink at ~6.3%, breaching the 8% exemption, and nothing caps
  hook length — `buildBanner` accepts any text and the composition wraps. **Fix when Agent B's
  ContentBrief lands:** cap `hook_text` length in the schema, or assert wrap count at plan-build
  from measured text width. Owner: B, with T asserting it in the template.
- **`missWeightFloor` bounds single-shot degradation, not the real exchange (Minor B).** Swapping
  an unlocked cut for a locked one changes TWO adjacent shots, since they share the boundary.
  Reachable worst case with today's constants gives a combined penalty ≈7.2 against a floor of
  4.56. Practically inert — it needs a ~3.9s stretch with no locked candidate, which a beat every
  ~0.5s makes essentially impossible, and the measured-`lockPct` gate backstops it. One-line
  hardening with no downside, since paths with no locked alternative all pay `miss` equally:
  double the floor, or restate the comment to claim only the single-shot bound honestly.

### 12.12 `jobs/plan-build.ts` does not exist — the critical-path gap nobody owns

The Definition of Done (00_MASTER §6) requires "a ContentBrief generated from a real approved
Brief version renders to MP4 end-to-end". That chain is:

```
ContentBrief (B, approved via the gate) → plan.build → RenderPlan (M's planner) → render.submit → MP4 → render.qc
```

**The middle link is missing.** Agent P created the `plan.build` queue but deliberately registered
no processor (its job body was out of P's scope). Agent M built the planner as a pure library.
Agent B built the route that enqueues the job and correctly refused to fake a `RenderPlan` — it is
append-only with no default on `plan: Json`, so it cannot be created empty and filled in later —
returning a queued handle with a pre-allocated id instead. Every agent behaved correctly at its
own boundary, and the seam between them fell through: `apps/api/src/jobs/plan-build.ts` does not
exist and nothing registers a `plan.build` processor.

This is the classic multi-agent failure mode, and worth naming as such: three correct boundaries
can still leave a hole where they meet. It was caught by Agent B reporting what it could not
build, rather than stubbing it — which is why "report what you found wrong or infeasible" is in
every agent brief.

**The work:** a processor that loads an approved ContentBrief (rejecting anything not
`status='approved'` — B's `requireApprovedContentBrief` already enforces this at the route), loads
the footage's `MediaAnalysis` (words + RMS + beat grid), calls M's `planBeatLockedCuts`, builds
captions and emphasis, evaluates **G1a before persisting** (ADR-8: a plan failing the gate is
rejected at plan-build so it never costs a render), and writes the `RenderPlan` once, complete.
`render.submit` needs the same treatment.

**Owner: assigned after Agent B merges**, since the processor consumes B's ContentBrief shape.
Not T — T is already carrying three templates, the evidence harness and possibly footage
selection.

#### 12.12a Addendum — the approval must be re-checked at materialization, not just at enqueue

Review of Agent B surfaced a timing hole that the missing processor would otherwise inherit.
`requireApprovedContentBrief` runs at **enqueue** (`routes/content.ts:165`), and undo's safety
guard counts **materialized** RenderPlans (`content-gate.ts:309,321`) — so a queued-but-unbuilt
plan is invisible to it. That admits this sequence:

```
approve brief → POST /content/plans (job queued) → undo the approval → job runs → plan built from a now-'proposed' brief
```

No code is wrong today, because no processor exists to run the job. But it means the gate is
enforced against a snapshot of approval that can go stale between enqueue and execution — and a
plan built from an un-approved brief is an invariant-1 violation regardless of how it happened.

**Requirement on the §12.12 work item:** the processor must re-call `requireApprovedContentBrief`
**at materialization, inside the same transaction as the `RenderPlan` create**, so the approval
check and the write cannot be separated by a concurrent undo. Enqueue-time validation stays as a
fast rejection, not as the guarantee. Also fix `content-gate.ts:370`'s doc comment, which claims
the helper is "never called by a route directly" while a route calls it.

The general lesson, worth carrying: **a permission checked when work is queued is not a permission
held when work runs.** Any gate enforced across an async boundary needs re-checking on the far
side, in the transaction that does the write.

### 12.13 The cutting grid must live in OUTPUT time — ruling on footage selection

Agent T declined to build the `03 §6` selection stage and asked for a ruling instead of silently
answering it. Correct call, and the question is the sharpest in the milestone.

**The problem.** Removing footage makes output time ≠ source time. Our beat grid is derived from
the *footage's own audio* but consumed in *output* coordinates. Cut a span out and the grid no
longer describes what the viewer hears — the plan would be locked to a grid that does not exist in
the artifact. That is exactly §12.1's failure, one level up: a quantity we measured being treated
as one we can move.

**Ruling: the grid that cuts are locked to must be defined in output time. In practice that means
the licensed music bed's grid.** Exactly two configurations are valid:

| Plan | Grid source | Valid? |
|---|---|---|
| Continuous playthrough, no removal | footage's own audio | **Yes** — source time *is* output time; this is what ships today |
| Footage removal (real jump cuts) | the music bed | **Yes** — the bed plays over the finished edit, so its grid is output-time by construction |
| Footage removal | footage's own audio | **NO** — the invalid quadrant. Reject at plan-build. |

**Why the bed and not T's clever alternative.** T proposed remapping the retained spans' beats and
embedding that, choosing spans that start on beat-locked word edges so relative phase survives.
It can be made to work, but it constrains span selection to preserve a property that a bed gives
for free, and it keeps us deriving a musical grid from speech. Three things settle it:

1. **"Cuts land on musical beats" means musical.** Speech onsets were always a stand-in for a bed
   we hadn't added. `01 §3` measured the reference at 112.3bpm because the reference *has* a bed
   (`01 §8`: "the beat grid comes from the speech/room audio and a subtle bed").
2. **A bed's grid is output-time by construction.** It is laid over the finished edit; removal
   cannot invalidate it.
3. **A bed's phase is genuinely ours** — we choose where the track starts. Apply §12.1's test —
   is this a quantity we choose or one we measured? — and the bed passes where source audio fails.

**Consequence, stated plainly: footage selection and the music bed are coupled. There is no
"remove footage but keep the speech-derived grid" configuration.** A reel that actually cuts needs
music, which is true of essentially every reel anyway. `02 §5`'s speech-only fallback survives only
for the no-removal case, where it is already correct.

This also unblocks G1b: real jump cuts create the content discontinuities a detector can find, and
the grid they lock to is one that survives into the artifact. **G1a and G1b become jointly
satisfiable only under this convention** — which is why T was right that G1b was blocked on more
than the selection stage.

**Owner:** the same work item as §12.12 (`jobs/plan-build.ts`), since both turn on how a plan is
materialised. Assign together, after B merges.

### 12.14 Correction: `camera.ts`'s REFRAME_STEP comment is falsified by measurement

It claims alternating base framing "restores the discontinuity", implying G1b becomes passable.
§12.3 records the actual render at 2/29 with the reframe in place. Correct the comment or the next
agent will trust it.

### 12.15 Every generated brief picked the tier-C fallback — a scoring-weight finding from live output

First live generation against the demo tenant's approved brief produced three ContentBriefs
(contrarian, myth_bust, listicle), each citing 3/2/5 claims, all `proposed`, none auto-approved —
invariant 1 and 3 both hold in practice, not just in tests. `listicle` generating at all confirms
the empty-`favoredClaimTypes` bug is really fixed.

**But all three attributed to `hook_taxonomies`, evidence tier C.** `05 §2` and §11.2 R4 intend
tier-A frameworks (double jeopardy, ESOV, 60/40) to lead when the signals support them; here the
tier-C fallback won three out of three. The cause is the weighting: claim-type match scores ×10,
archetype affinity ×5, and tier only breaks ties at 3/2/1 — so a framework whose favored claim
types happen to match the tenant's claim mix wins regardless of tier, and `hook_taxonomies` is
deliberately broad because it is the "no other framework fits" fallback.

This is not a correctness bug — the scoring is deterministic and the model still cannot choose the
framework, which is the property that mattered. It is a **quality** problem: the card's "Why this
brief" line exists to justify the angle, and a line that always reads *Short-form Hook Taxonomies
(C)* justifies nothing. It would also quietly bias the whole product toward its least-evidenced
framework.

**Not fixed now** — it needs a real product view on how much evidence tier should outrank signal
match, which is Sathvik's call, not an agent's. Recorded so it is not mistaken for working as
intended. Candidate fixes when ruled: multiply by tier rather than adding it; exclude the fallback
from scoring unless every other framework scores zero; or widen the tier-A frameworks'
`favoredClaimTypes`, which are currently narrow enough to lose to a catch-all.

### 12.16 §11.1 R2's guarantee was wrong, and finding 2 explains why — framing ruling

Agent T rendered three templates and found the `center` caption sitting **on the subject's mouth**
in all three, on real footage. That falsifies the guarantee I gave in §11.1 R2 — that letterbox
captions "structurally cannot occlude a face", which is what justified descoping face detection.
The guarantee assumed a fixed frame; `camera.ts`'s `REFRAME_STEP` zooms odd shots 18%, moving the
face below the line §12.5 placed the caption on. My ruling, my error.

**T's second finding is the root cause, and it dissolves the first.** The reference's content
region is 720×800 — 62.5% of frame height (§12.4). Ours letterboxes 16:9 at full width:
1080/(16/9) = 607px of 1920 = **31.6% video, 68% black bars**. We have been benchmarking against a
frame we do not produce, and the cramped video band is why there is no room below a face for a
caption.

The reference does not letterbox 16:9 at full width. To get 720×800 from 16:9 source it **zooms in
roughly 2× and crops the sides** — which is why the subject's head fills the frame. That is
ordinary reel practice and we simply did not do it.

**Ruling: v1 crops source footage to a ~0.9:1 content region (≈62.5% of frame height), full
width — it does not letterboxed-fit 16:9.** Consequences:

1. **The caption problem largely dissolves.** A 62.5% video band leaves real estate below a seated
   subject's face, which is what §12.5's `center` placement assumed all along.
2. **Still no face detection.** The crop offset is static per template (centred by default,
   overridable), which is sufficient for the locked-off interview footage this milestone targets —
   the subject does not move. §11.1 R2's *conclusion* survives; only its stated reason was wrong.
3. **The reframe must not undo it.** `REFRAME_STEP` may not push the face below the caption line —
   reduce the step, or anchor the zoom toward the top of the content region so the face stays put.
   Framing and caption placement are one decision, not two, exactly as T said.
4. **The `mid_left` handle (y=0.5) moves out of the video band** into a bar, for the same reason.

**Re-verify by rendering and looking**, not by re-reading the plan: this ruling exists because two
plausible-sounding rules composed into a caption across someone's mouth, and only a frame showed it.

### 12.17 Credit where the discipline worked

T saw the word "NOT" rendered in accent orange and suspected a repeat of §12.9's stopword bug.
Instead of reporting it, it checked the plan and the scorer first and found `"not"` is in
`CONTRAST_WORDS` (+0.8, the same class as "never"), correctly emphasised per `02 §3`. §12.9's
lesson — a frame is evidence about the renderer, not about what the renderer drew from — applied
correctly by the next agent to hit it. Also worth recording: T's evidence harness caught four bugs
in itself before shipping, including a frame labelled "caption rotation" that contained no caption
(it sampled 200ms into 160ms chunks), and it fixed a containment-test flag by moving the renderer
invocation behind the boundary rather than exempting the file.

### 12.18 The visual gate is now blocked on FOOTAGE, not on code

Agent T's re-render against §12.16 was a large, visible improvement — the subject fills the frame,
the banner sits clean in the bar, and "does the first 2 seconds make you want to keep watching?"
flipped from qualified to **yes**. But `07 §2`'s final question is still answered **no**, for one
residual defect: on shots whose source framing is tighter than the measured average, the chin
drops to ~0.79 and the caption at 0.785 touches the jaw.

**T's diagnosis is right and it is not a code defect.** §12.16's static-crop premise says a fixed
crop is "sufficient for locked-off interview footage". The reference reel is not that — it is cut
from multiple camera setups (a wide with the subject lower-left, a medium, and tight close-ups).
One static crop and one caption line cannot serve all three. The premise may well hold; we simply
have no footage that tests it.

I surveyed what is available. `founder-journey/inbox/` has a dozen clips, all handheld
multi-person B-roll from an office event — a moving camera and no stable face position, which is
further from the premise than the reference is. The reference itself is additionally a 720p proxy,
so cropping 1.67× into it leaves ~648×720 upscaled to 1080×1200 and the softness is visible.

**What is needed, and only Sathvik can supply it:** one genuinely locked-off talking-head clip —
a single fixed camera, seated subject, 60–90s, 1080p or better, no burned-in graphics. Exactly
what a PerfStaq customer uploads when a founder records themselves. A phone on a stand produces
it in two minutes.

**Until that exists:** the templates are code-complete and pass 12 of 13 automated gates; the
human gates in `07 §2` and the `07 §3` comparison test cannot be honestly cleared, and no agent
should claim otherwise. This is also the fixture Agent D owes per §8, and it gates the
Definition of Done's side-by-side comparison.

### 12.19 Correction to §12.18 — a zoom term is hiding inside the "footage" explanation

Review of T's framing round found the fixture attribution is *mostly* right but **incomplete**, and
the remainder is a real code defect that would survive onto the clean fixture:

The caption anchors are derived from the chin at **scale 1.0**, but the renderer composes up to
**1.18 × 1.06 ≈ 1.25** about the region centre (`Reel.tsx:250`). The chin sits 416px below that
origin, so it is *not* the near-fixed point `camera.ts:81-83` claims — that is true of the eyes,
and the chin is precisely the line the caption band is derived from. Chin at 0.717 static becomes
0.739 at odd-shot base 1.10, 0.756 at 1.18, and **0.771 with punch**, against caption tops of
0.755 (one-line emphasis) and 0.733 (two-line).

Measured against T's own committed plans: drift alone clears on average footage (0 overlaps, which
is why the renders looked clean), but **drift + punch overlaps the derived face floor on 2/1/3
emphasis chunks per template**, by 2–25px for up to 14 frames.

So **§12.16 item 3 is not satisfied — the reframe step was reduced, not neutralised, and the punch
multiplies it.** The visible jaw contact T reported is still dominated by footage variance
(tighter source framing contributes ~0.05+ against the zoom's ~0.01–0.05), so §12.18's fixture
request stands unchanged. But the zoom term persists on ideal footage, and if left in place the
incoming locked-off clip would be judged against wrong geometry — the fixture would be blamed for
a bug, or worse, absolve one.

**Required:** derive the face floor at worst-case composed scale (chin ≈ 0.771), or re-anchor the
odd-shot zoom origin to the chin line so it cannot displace it, or suppress the punch on shots
whose visible chunk anchors at `center`. Plus a plan-scorable face-floor check over block **tops**
— today the floor is asserted only on `anchor.y`, so a three-line chunk at `center` (top 0.711,
above the 0.717 chin) passes G9 silently. Enforce it everywhere, not at one position.

### 12.20 `upper_third` is retired — recorded as its own ruling

T retired the `upper_third` caption position and cited §12.16, which does not rule on it. The
retirement is nonetheless correct and is recorded here properly: after the content-region crop the
top bar leaves ~130px of usable height while a real mixed-size two-line chunk is ~200px, so it fits
at no anchor. `01 §4` measures the reference at exactly three positions, so three is both what fits
and what the reference does. **`02 §2.2`'s four-position list and §12.5's resolution of it are now
stale on this point** — the positions are `center_low`, `lower_left`, `center`.

### 12.21 Two honest-labelling notes

- **G11's −14 LUFS is not a capability.** All three templates hit it exactly because the fixture's
  audio is already at −14 and passes through untouched; **no loudness stage exists anywhere in the
  pipeline**. The number is true and demonstrates nothing about arbitrary footage. Do not read the
  green gate as a shipped normaliser; `03 §5` still owes one.
- **The font NOTICE reads OFL §3 backwards.** It claims shipping an un-renamed *subset* of Playfair
  Display is "the permitted case"; a subset is a Modified Version and may not carry the Reserved
  Font Name without permission. Universally tolerated in practice, but the note asserts the
  opposite of the licence. Folded into ADR-5's pre-GA licensing checklist alongside Remotion.

### 12.22 The zoom fix, and what testing an inherited claim turned up

§12.19 is closed. Of the three sanctioned options the fix agent chose **anchoring the odd-shot
zoom origin on the chin line**, and its reasoning is worth keeping because it generalises:

- Re-deriving anchors at the worst-case composed chin (0.771) *collapses the layout* — every
  two-line block would need its centre in a 9px window to clear both that floor and G9's bottom
  bound, destroying the vertical separation the position rotation exists for. Worse, it re-couples
  the anchors to `REFRAME_STEP`, `MAX_GROW` and `punchScale`, so **any later change to any of the
  three silently re-opens the bug**.
- Suppressing the punch removes one term of three; base reframe alone already puts the chin at
  0.739 against a two-line top of 0.733, passing today only because no committed plan happens to
  place a two-line chunk at `center` on an odd shot.
- Anchoring the origin makes the chin the transform's **exact fixed point**, so `FACE_FLOOR_RATIO`
  is where the chin is at *every* scale. That satisfies §12.16 item 3 as written — neutralised,
  not merely reduced — and leaves the floor a single measured constant.

Measured against the branch's own plans, overlaps went **2/1/1 → 0/0/0 by construction rather than
by tuning**, and the frames show it: the chunk the measurement flagged had "TO NOT" sitting on the
jaw before, and clears it with neck and collar visible after.

**And the inherited claim turned out to be false.** Enforcing the three-line limit at every
position instead of only `center_low` showed the old "fits nowhere" title was never measured:
`center_low` fails G9's bottom bound, `center` fails only the face floor, and **`lower_left` clears
both — by 17.0px and 5.8px. A three-line chunk genuinely fits there.** The agent asserted that as
found rather than tuning an anchor to preserve the headline. Since nothing in the chunker prevents
three lines (G5 bounds words, not lines), **which position the rotation happens to pick decides
whether a three-line chunk is safe** — that needs a product view, not an agent's guess.

### 12.23 Three smaller corrections

- **`ShotCamera.originY` was documented as "0..1 of the frame"; it is 0..1 of the content region**
  (`Reel.tsx` applies it to the region div). Harmless only while the value was 0.5. Fixed, and
  every template is now pinned to `CONTENT_REGION_RATIO` so a template shipping its own region
  cannot move the origin out from under itself.
- **The evidence harness cannot run outside `st-p` unaided**: `qc-render` needs
  `ANALYZER_PYTHON` pointing at the analyzer venv, which only that worktree has. The first run
  rendered a full MP4 and threw the work away at the QC step. The harness correctly refused to
  write evidence for a crashed QC, but a per-worktree venv or a checked prerequisite would save a
  render's worth of disk. Worth fixing before the next agent renders.
- **`SPRINGS.punch` is underdamped** (ζ = 0.913), but the composed `attack − settle` peaks at
  1.0599 — just under the 1.06 §12.19 assumed. The worst case stands; no correction needed.

### 12.24 The chain runs — and §12.12a's instruction was insufficient as written

Agent I built `plan.build` and `render.submit` and proved the Definition-of-Done chain by running
the real surfaces rather than reasoning about them: gate approve over HTTP → `POST /content/plans`
→ real Redis → real worker → real row. **Plan `0f6c3ed0`, 26 cuts, median 1.49s, 62 caption
chunks, G1a PASS at 100% (26/26)** against the committed analyzer grid (112.347bpm, 97 beats), and
a 32.6MB MP4 followed in 137s. All three guards are **mutation-tested** — removing the approval
re-check fails 3 tests, disabling the §12.13 guard and the G1a rejection fails 4.

**Correction to §12.12a, which I got technically wrong.** I ruled "re-check
`requireApprovedContentBrief` inside the same transaction as the `RenderPlan` create". That is the
right *shape* and an insufficient *instruction*: `requireApprovedContentBrief` reads through the
module-level Prisma client, so calling it lexically inside `$transaction` still runs **on a
different connection** and buys nothing. What actually makes it atomic is a `SELECT … FOR UPDATE`
on the brief row, taken *before* the check. Agent I found this by building it; the guard is
correct in the code and the doc was wrong.

The general form is worth keeping: **"inside the transaction" is a claim about the connection, not
about where the call sits in the source.** An ORM that hands you a module-level client will let you
write code that looks transactional and isn't.

### 12.25 `plan_infeasible` has nowhere durable to live — ruling

`03 §7` requires every failure state to be surfaced and retryable, but a failed plan build
currently vanishes: there is no plan-status row, `RenderPlan` is append-only and a failed build
creates no row at all, `Render.failedStage` enumerates `"plan"` but no `Render` exists yet, and
there is no `GET /content/plans/:id`. A user who posts a plan request and hits `plan_infeasible`
sees nothing, forever.

**Ruling: add a lightweight attempt row, and keep `RenderPlan` pure.** A `plan_build_attempts`
table keyed on the pre-allocated plan id, carrying tenant, `contentBriefId`, status
(`queued|built|infeasible|failed`), a reason string, and timestamps. `POST /content/plans` writes
it at enqueue; the processor updates it; `GET /content/plans/:id` reads it. On success the
`RenderPlan` row is created with that same id and the attempt marked `built`.

Why not the alternatives: giving `RenderPlan` a status column would mean rows that are not plans,
which is exactly what append-only purity buys us (a row exists ⇔ a complete, reproducible plan
exists); and materialising a `Render` to hold the failure inverts the pipeline's own ordering.
**Owner: the same agent as the follow-ups below.**

### 12.26 Five more findings from Agent I

- **`Reel`'s `footageSrc` is a trap.** A leading-slash path is a *server-root URL*, not a
  filesystem path; only an http(s) URL or a bare `staticFile()` name work. Undocumented, and it
  cost a render to discover.
- **The bare-plan bug typechecked, unit-tested green, and rendered nothing.** `render.submit`
  passed a bare plan where the composition wants `{ plan, footageSrc }`. Found only by rendering —
  the fourth defect this milestone invisible to every static check.
- **`motion_templates` had no seed at all**, so a fresh database 404s on `POST /content/plans`.
  Closed with a marked fixture, but the table-versus-TS-catalogue duplication is a real smell:
  §11.2 R4 put the *framework* catalogue in a const for good reasons that apply here too.
- **A residual race survives in `content-gate`'s undo guard**: it counts plans *before* its update
  takes the row lock. The sequential case holds (409, verified), but a concurrent undo racing a
  committing plan can still win. The fix is the same `FOR UPDATE` discipline inside `undo()` —
  that module's to make, not Agent I's, since it was out of bounds.
- **ADR-7's Lambda path is not implementable inside any single agent's boundary**: `@remotion/lambda`
  is uninstalled and ADR-5 confines Remotion to `packages/render`. Implemented as a named hard
  failure rather than a silent local fallback, which is the right call — but it means the product
  render path is still unbuilt, and that needs an owner before GA.

### 12.27 The calibration script never implemented the rule it calibrated

Agent F found that `measure_reference.py` — the script I wrote at the start of this milestone, whose
0.821 figure has been the calibration baseline in ADR-8, §4.1, §12.19 and every agent brief since —
**does not implement the comparison ADR-8 §4.1(c) pins.** The pin is *integer milliseconds, ≤150
inclusive*; the script compares float seconds. On this input the two agree by luck. Against the
millisecond-quantised grid the sidecar actually emits, the float rule scores **0.786, not 0.821** —
one cut sits within a millisecond of the boundary.

A 3.5-point error in the number every later measurement was calibrated against, in a script that
looked right and produced a plausible answer, surviving four agents and six review rounds. It was
caught only because F implemented the pinned rule from the specification text rather than copying
the script. **Where a doc and an implementation disagree, the doc is not automatically wrong — but
neither is the code, and only re-deriving from the spec settles it.**

F's extractor implements the pinned rule and commits the fixture properly at
`apps/api/tests/fixtures/studio/reference/reference_measured.json`. It had been living in a session
scratchpad, which is why `04 §6`'s bands kept being read as absolute rather than calibration-relative.

### 12.28 Corrections to my own §12.16 numbers, and three to `01`

- **The content region is 720×756 (0.952:1, 59.1% of height), not 720×800 (0.9:1, 62.5%).** My
  §12.16 figures came from a black-row walk that stops at the *banner* — white-on-black text is
  mostly black per row — so they include the 33-row banner band. The ruling's shape is right and
  the crop is still correct in kind; the cited constants are ~3% off.
- **`01 §4`'s handle claim is not supported.** It says the handle alternates upper-right and
  mid-left; it is static mid-left in every sampled frame. More usefully: **the handle is not
  detectable without OCR** — probed at its true position it scores 0.44 occupancy while picture
  frames on the far wall score 0.47. F reports `undetermined` rather than `absent`, so the template
  default supplies it per `04 §3`. Tuning the threshold until the handle appeared would have fired
  on the wall too.
- **`01 §5`'s "100% of shots have micro-motion" measures 26/29.** Two shortfalls are 0.90% and
  0.98% against a 1% threshold — inside the method's own error — and the third is the merged tail
  shot from §4.1.
- **`01 §1`'s 23.976 fps is the nominal rate; decoders report 24.423** (nb_frames/duration). Both
  are real; recorded as `fps` and `fpsNominal`.

### 12.29 The reference colours whole caption chunks — which weakens one of §12.9's grounds

F observed the reference's karaoke emphasis is **whole-chunk colour** (a fully yellow
"UNCOMFORTABLE"), not `01 §4`'s "white with per-word emphasis". §12.9 cited `01 §4`'s plain-white
karaoke as one of three grounds for reserving accent colour to emphasis.

**The ruling stands, on its other two grounds.** The defect §12.9 fixed was that one hue meant two
different things — active and emphasised — so an un-emphasised stopword rendered identically to an
approved claim's payload. That is a real defect regardless of what the reference does, and
`02 §2.1`'s "two coloured words halves the emphasis" argues harder when the two colours differ in
meaning. But the *provenance* of ground (a) is now known to be wrong, and it raises a genuine
design question I am NOT ruling on: if the reference has no per-word emphasis at all, our per-word
emphasis is an addition, and `01 §8` says not to add what the reference lacks. Characterising it
properly needs OCR (§11.2 R6 defers that), so this is recorded for a v2 decision, not settled now.

### 12.30 Two rulings Agent F asked for

**R7 — fingerprint observations do NOT become `CandidateClaim` rows.** `04 §5` wants strategically
interesting fingerprint observations entering memory as proposed claims through the review gate.
But `CandidateClaim` requires `meetingId`, `evidenceSourceId`, `extractionRunId`, `verbatimQuote`,
`speaker` and `timestampMs`, all NOT NULL — that column set *is* CLAUDE.md invariant 2, evidence-or-
drop, expressed in the schema. A fingerprint has none of them: no meeting, no segment, and under R6
no text was ever read. Persisting one would require either fabricated provenance or relaxing the M1
gate's own table, and both are worse than not having the feature.

**F's approach is correct and is the ruling:** `proposeFingerprintObservations` returns typed
proposed rows and writes nothing, with a test asserting the module contains no Prisma import and no
write call. If these observations are wanted in memory later they need their own table with their
own honest provenance — asset id, frame ranges, method, confidence — routed through a gate of their
own. **Do not smuggle them into the claim table.** `04 §5` is amended accordingly.

**R8 — F's one out-of-area edit is accepted.** F added an optional `rhythm?: RhythmOptions` to
`BuildTemplatePlanInput` (Agent T's `scripts/studio/build-template-plan.ts`, +16 lines, defaulted to
`template.rhythm`, every existing caller unaffected). Without it the re-timed rhythm curve was
computed and discarded, and "style transfer" would reduce to picking a template — the deliverable
would be hollow. Additive, defaulted, and flagged rather than assumed. **Agent I's `plan-build.ts`
wants the same field**; the contract is `mapFingerprintToTemplate` → `{ templateId, retimed.rhythm }`
plus `assertStyleTransferConstraints(plan, fingerprint)`.

### 12.31 Two findings worth keeping for their reasoning

- **Grade is not mappable, and not for a confidence reason.** The fingerprint measures absolute
  finished pixels; a template's grade is multipliers over an ungraded source. Assigning one to the
  other is arithmetic on incompatible units — a category error, not a precision problem. F uses
  only warmth *order*, in selection. This is the right shape of answer for any
  "extract X and apply it" feature: ask what the units are before asking how accurate they are.
- **`04 §4`'s five-term match vector has two live terms.** `caption_style_class` needs OCR;
  `framing` and `layer_set` are constant across all three templates. F weights them 0 and returns
  `inertTerms` rather than letting constants contribute noise, and makes framing a *filter* instead
  — a `fill` fingerprint raises `plan_infeasible`. Independent confirmation that the matcher works:
  on unrelated footage it picked `statement_serif` at distance 0.191 against 0.403 and 0.420, and
  F's code never reads the "reference archetype" label in `templates/index.ts`.

### 12.32 `motion_templates` is an FK anchor — ruling

The reviewer escalated the table-versus-const duplication. The code already treats the row as a
pointer: `name` resolves into the TS catalogue and `resolveRenderTemplateId` is the single bridge.
That is §11.2 R4's reasoning (product knowledge belongs in a versioned const, not a table that
needs a migration every time an editorial judgement changes) stopping halfway.

**Ruling: the table is an FK anchor and nothing more.** It exists so `RenderPlan.templateId` has
referential integrity and so a plan's template identity is stable across deploys — both real
reasons to keep a row. Its *behavioural* columns (`slots`, `fonts`, `grade`, `framing`) are
duplicates of the catalogue and will drift; **no code may read them.** Invariant 6 forbids dropping
columns this milestone, so they are marked deprecated and unread now, with a post-milestone task to
drop them. The catalogue is the definition; the row is a handle.

Minor within it: the seeder's `update: { active: true }` silently reactivates a deliberately
deactivated template on reseed. Reseeding should not resurrect.

### 12.33 Open follow-ups after the plan-build merge

Recorded so none of these is lost between agents. None blocks the milestone; two need owners.

- **The undo race in `content-gate.ts:323,335` (Important).** `undo()` counts plans *before*
  `guardedUpdate` takes the row lock, and the guard is on `status` only — plan-build doesn't change
  status, so an undo that blocked on the materialisation lock proceeds with a stale zero count.
  **Invariant 1 is not at risk**: the plan was approved-at-write-time, and review could construct no
  interleaving producing a plan from an unapproved brief. What breaks is content-gate's own "no undo
  once a plan exists" promise, leaving a committed plan attached to a re-`proposed` brief in a
  milliseconds-wide window. Fix: the same `SELECT … FOR UPDATE` on the brief row at the top of
  `undo()`, before the counts. Agent I reported it rather than reaching into an out-of-bounds file,
  which was correct.
- **`plan_infeasible` still has no durable surface** — ruled in §12.25 (an attempt row keyed on the
  pre-allocated plan id); Agent I's failure logging is honest interim behaviour and was not faulted.
- **`plan-builder.ts:248` hardcodes `112.3` as a tempo fallback** — the *reference's* tempo, leaking
  into arbitrary tenants' plans whenever a beat grid is missing. Derive it, or name it a constant
  with provenance so it cannot be mistaken for a measured value. This is the same class of error as
  §12.27: a plausible number nobody re-derived.
- **Minors:** `content-gate.ts:384-385`'s doc comment still says `requireApprovedContentBrief` is
  "never called by a route directly" while `routes/content.ts:169` calls it (§12.12a asked for this;
  the boundary blocked it — bundle with the undo fix). `prove-plan-chain.ts:8`'s header claims the
  proof covers "the worker registration"; it constructs its own Worker around the same processor,
  so registration is exercised only by the suite. §12.13 has one test at the production call site
  and three against the guard function directly — adequate but thin.

### 12.34 Correction to §12.27 — the baseline was never wrong; the bug was latent

I wrote §12.27 as "a 3.5-point error in the number every later measurement was calibrated against."
That overstated it, and the reviewer settled it by re-deriving the figure from the reel itself under
all three rules:

| Rule | Score |
|---|---|
| float grid + float ≤0.150 — `measure_reference.py` as written | **23/28 = 0.821** |
| wire-format quantised grid + float ≤0.150 — the unpinned rule on real data | 22/28 = 0.786 |
| quantised grid + integer-ms ≤150 inclusive — ADR-8 §4.1(c) as pinned | **23/28 = 0.821** |

**0.821 is correct and always was.** The script's comparison rule was wrong, but on float inputs it
coincided with the pinned rule, so the published baseline never carried the error. The bug was
*latent*, and it was still genuinely load-bearing: F's extractor reads the sidecar's
millisecond-quantised grid, so had it copied the script's float comparison it would have reported
**0.786 and failed the ≥0.80 acceptance floor** — the feature would have looked broken because the
measurement was. Deltas of exactly 150 and 151 ms straddle the boundary, and the reel has a cut
within 1 ms of the window edge.

The lesson survives intact and is arguably sharper: **a latent bug in a measurement tool is
invisible precisely while its inputs happen to agree.** It surfaced only when a different consumer
fed it differently-shaped data. Do not conclude from "the number matches" that the rule is right.

### 12.35 Follow-ups after the style-transfer merge

- **`04 §5`'s deletion/retention posture is not implemented anywhere (Important, unowned).**
  `MediaAsset.purgedAt` exists and its comment already declares the policy, but **no code sets it**
  for reference reels after fingerprinting, and there is no ≤30-day sweep and no consent flag on any
  branch. F's storage design makes it implementable — the fingerprint survives on its own row, so
  the source video is genuinely disposable — but the purge is unbuilt milestone work with a
  privacy posture attached to it. Needs an owner: a purge step at the end of `runMediaAnalyze` for
  `kind=reference`, or a scheduled sweep.
- **`warmthRank` is described as a weak tiebreak but decided the selection.** Weight 0.25
  (`style-transfer.ts:161-176`) against rhythm-only distances of staccato 0.170 vs statement 0.191 —
  the warmth term is what put statement ahead. Defensible here (the 0.021 gap is inside
  one-merged-shot noise ≈0.036), but a 0–0.25 term can override a real rhythm winner, and rhythm is
  what `01 §2/§3` identify as the core signal. **Ruling: lower it to ~0.05**, or promote it honestly
  to a third live term alongside the `inertTerms` disclosure. It must not be able to outvote rhythm.
- **`assertOutputTimeGrid` checks bed *presence*, not grid *provenance*** — a plan that removes
  footage, carries a bed, but embeds a footage-derived grid would pass. The plan schema has no
  grid-source field, so this was the strongest check expressible when F wrote it. Now that Agent I's
  plan-build is merged, add grid-source provenance to `beatGrid` (additive) or re-assert at
  materialisation, where the grid's source row is known.
- **Stale comments:** `stages/fingerprint.py:734` cites banner persistence 0.906 against the
  fixture's 0.896; `style-transfer.ts:543-548` and its test still say the observations question
  "needs a human ruling" — §12.30 R7 has since ruled exactly F's way, so cite the ruling.

### 12.36 The reference-reel purge — closing §12.35's named gap

§12.35 flagged this and left it unowned: `MediaAsset.purgedAt` exists, its comment already
declares the policy, M1's ingest paths already set the column on `Artifact` — and nothing purged a
`reference` asset. `media.purge-references` (`jobs/media-purge.ts`, `queue.ts`, `worker.ts`) is that
job: a daily BullMQ sweep that deletes the R2 object for a `reference` `MediaAsset` once it is older
than `RETENTION_DAYS` and its fingerprint extraction succeeded, and sets `purgedAt`. It never touches
`MediaAnalysis`.

**The retention window: 30 days, uniformly, and why that is not quite what `04 §5` says.** The spec's
literal words are "deleted after analysis (or retained ≤30 days with tenant consent)" — i.e. the
default is immediate deletion, and 30 days is a consented exception. §12.35 already recorded the
fact that makes that unbuildable as written: **no consent flag exists on any branch.** Building one —
a schema column, a tenant-facing toggle, a UI affordance to set it — is its own feature with its own
review surface, not a resolvable part of "the smallest job in the closeout." Choosing between
"implement consent" and "implement the purge" for this workstream, the purge is the one with the
actual privacy exposure attached to it (indefinite retention, today, in production if this shipped
unfixed) — consent tiering is a refinement of a working purge, not a precondition for one existing at
all.

**Ruling: `RETENTION_DAYS` (env, default 30) applies uniformly to every reference reel**, consented or
not. This is the spec's own stated *ceiling* promoted to the *default floor of protection*: no tenant
ever retains a reference longer than 30 days, which is strictly tighter than the current bug
(unbounded retention) and never looser than what §5 already permits a consented tenant. It is
deliberately a stopgap, not a final design — the honest gap it leaves is that a tenant who never
consented still gets 30 days rather than near-zero. Once a consent flag exists, the natural
tightening is: unconsented defaults to a short window (or immediate purge, matching §5's literal
floor), consented can opt into the full 30. Nothing here forecloses that — `RETENTION_DAYS` is
already the single knob that change would tune, and `isEligibleForPurge` is already the one function
that would grow a consent check.

**What survives and why.** `MediaAnalysis.fingerprint` — the `EditFingerprint` — is never deleted,
never read, never modified by this job. That asymmetry is Agent F's own design landing exactly as
intended: the fingerprint lives on its own row, with its own provenance (`fingerprintVersion`,
`analyzerVersion`), precisely so the source video is disposable and the structural description of it
is not. `MediaAsset.r2Key` is left in place too (same posture as `Artifact.purgedAt` in
`routes/meetings.ts` — the historical key stays legible even though the object behind it is gone);
only the bytes at that key and the row's null `purgedAt` change.

**The footage/render exclusion is structural, not conditional.** `sweepPurgeReferences`'s only query
pins `kind: reference` — there is no parameter, override, or code path that could widen it, and
`isEligibleForPurge` (the pure selection predicate, tested directly and hostilely) checks `kind`
again on every call regardless of what the caller already filtered. A future edit that wanted to
purge footage or renders would have to touch both the query literal and the predicate's own
rejection — it cannot happen by loosening one filter.

**Tenant isolation and idempotency, same mechanism as `calendar-sync.ts`'s sweep.** Enumerating
candidates crosses tenants by definition, so it is the one read in the job that uses `rawPrisma`;
every actual purge (`purgeReferenceAsset`) then runs inside `withTenantContext(tenantId, …)` and
re-reads the row through the tenant-scoped `prisma` client before touching it — a foreign `assetId`
resolves to `null` there, structurally, the same guarantee every other tenant-scoped write in this
codebase gets from `db.ts`, not a property this job had to invent. Delete-then-mark ordering (delete
the R2 object, then set `purgedAt`) makes a crash mid-purge safe to retry: `DeleteObjectCommand` on an
already-gone key is not an error, and a row's `purgedAt` only ever gets set on a completed pass, so a
retried sweep re-selects it and finishes rather than double-purging or silently skipping it. A
per-asset failure is caught and counted, not thrown — one broken delete must not block every other
tenant's eligible purge for the day, and a row that failed simply stays eligible for tomorrow's sweep,
which is a simpler and tighter retry loop than any explicit backoff bookkeeping this job could add.
### 12.37 G1b is `not_applicable`, derived per-plan — resolving §12.3

§12.3 diagnosed G1b correctly and then left it failing. Every template and every render reported a
hard red on it, and §12.18's honest summary — "code-complete and pass 12 of 13 automated gates" —
was carrying that red permanently. Two options were open: ship a licensed music bed so `03 §6`'s
footage-removal stage could exist (§12.13 rules the two are inseparable), or mark the gate. **I
surveyed the repo: there is no audio asset anywhere and no `data/music-library`.** Removal
therefore cannot exist, so G1b cannot pass under any plan we are able to build. It is marked.

**Ruling: G1b returns a not-applicable verdict — `pass: null` plus a machine-readable
`notApplicable: { code, see }` — for any plan that does not remove footage. The QC report is
green-with-exclusion, never green-by-omission.**

Three properties make this an exclusion rather than a disabled gate, and each is asserted by a test
that fails if it is removed:

1. **Derived from the plan, never hardcoded.** The predicate is `planRemovesFootage(plan)` in
   `packages/render/src/plan.ts`: a plan removes footage exactly when some shot's source span does
   not continue where the last one ended. Nothing checks a flag, a template id or a milestone
   number. The day the selection stage ships with a bed, its plans remove footage and G1b starts
   scoring again with **no code change and no migration** — which is the whole difference between
   deferring a measurement and abandoning one. A test asserts both directions on two fixtures that
   differ only in their source spans.
2. **Visibly excluded, never silently dropped.** `QcReport` grows `excludedGates` and
   `scoredGateCount` as first-class fields, and the console prints `PASS (12 hard gates scored · 1
   excluded (n/a))` with a `–` mark distinct from `·`. A green report beside an unscored gate is the
   exact shape of the lies §12.21 and §12.10 record; the exclusion is lifted to the top of the
   report so no reader has to reconstruct it by scanning for nulls.
3. **Distinguished from "could not measure".** `computable: false` already meant a real contract gap
   (G10 without `--words`). "Does not apply to this artifact" is a different claim and now says so
   in its own field. `rollUpQc` checks `computable` **and** `notApplicable` independently, so a
   future gate that sets one and forgets the other cannot silently rejoin the pass set — there is a
   test that flips `computable` back to true and still expects exclusion.

**Verified against the real artifacts, not fixtures.** Re-scoring the three committed evidence
plans (`docs/studio/evidence/*/plan.json`) with their own recorded detected-cut counts:
`statement_serif`, `staccato_condensed` and `editorial_sans` each go `removesFootage=false` ⇒ G1b
n/a ⇒ `overallPass false → true`, **12 gates scored, 1 excluded**. That is §12.18's "12 of 13"
arriving at an honest verdict instead of a permanent red. The committed `qc.json` files and
`manifest.json` still record the old shape; they are dated by `renderedFromCommit` per §12.10, so
they are stale rather than wrong, and will pick up `excludedGates` at the next regeneration. That
needs a real render, which needs the analyzer venv §12.23 notes is missing outside `st-p`.

**What would reverse this.** Any of: a licensed bed landing and `03 §6` shipping, at which point
plans remove footage and the exclusion evaporates on its own — no reversal needed, which is the
design. A decision that framing changes SHOULD be detectable discontinuities, which would make G1b
measurable on continuous plans; §12.3 already refused that as gaming the gate, and reversing it
means arguing with §12.3, not with this. Or evidence that some continuous plan does produce real
detected cuts — the exclusion's `measured.detectedCuts` is recorded precisely so that would show up
rather than being assumed away.

**G1a is untouched**, and remains the gate that means something today (§12.3): 29/29 against a real
librosa grid, where the human editor who cut the reference scores 0.821.

**Noted, not fixed:** `assertOutputTimeGrid` in `apps/api/src/domain/studio/style-transfer.ts:483`
carries its own copy of this predicate, written before there was a shared home for it. The two now
agree by construction of having been written from the same ruling, which is exactly the arrangement
§12.32 warns drifts. Collapsing it onto `planRemovesFootage` is a one-line change in a file this
workstream had no other reason to open — left as a follow-up rather than taken as a drive-by.

### 12.38 `render_attempts` — building the surface §12.25 ruled

§12.25 ruled the shape and nobody built it, so `plan_infeasible` stayed invisible through two more
merges (§12.33 records it still open). Built now, as ruled: a lightweight, deliberately **mutable**
attempt row keyed on the plan id `POST /content/plans` already pre-allocates, so the handle the
route was already handing back became the thing you poll. Migration is strictly additive — one
enum, one table, its indexes, one FK; no existing table is altered (invariant 6).

**`RenderPlan` stays pure.** It is read by the new routes and never written or annotated. A row
exists ⇔ a complete, reproducible plan exists, which is what §12.25 refused to trade for a status
column, and what lets `qc-render.ts` score G1a against the grid embedded in the exact row a render
was built from. The two rows share an id and carry no FK between them: the plan may never exist, and
a nullable link would reintroduce exactly the "rows that are not plans" confusion the ruling
rejected.

**What the ruling did not settle, and how it was settled.**

- **The failure codes are read, not guessed.** `PlanInfeasibleCode` in `plan-builder.ts` enumerates
  eight: `analysis_missing`, `analysis_incomplete`, `banner_wrap`, `footage_too_short`,
  `g1a_below_gate`, `invalid_grid_configuration`, `no_locked_cut_path`, `unknown_template`. The
  brief that assigned this work also named `template_slot_unfillable`; **no such code exists** and
  nothing can emit it. Anything that is not a `PlanInfeasibleError` — an unresolvable footage id, a
  dead connection — is recorded as `failed` under `plan_build_error`, kept distinct from
  `infeasible` because a user can act on "footage too short" and cannot act on "we broke".
- **The job records its own failure, not just the worker's handler.** §12.25 says "the processor
  updates it". Implemented as `runPlanBuild` recording on its way out, with `failPlanBuild`
  re-asserting on permanent failure. Two reasons, both concrete: a `plan_infeasible` is a *verdict*
  that will fail identically on every retry, so making the user wait out two BullMQ backoffs before
  the reason appears is a worse surface than no retries; and `failPlanBuild` only runs if the
  worker's `failed` handler is wired, while `prove-plan-chain.ts` builds its own Worker — the seam
  §12.33 already called thin. Recording inside the job makes the row a property of the **job**
  rather than of the worker that happened to run it. Both paths upsert the same key, so the count
  stays 1.
- **Upsert, never create-or-update.** The contract is *exactly one row per plan id*; `create`
  collides on a retry and `update` silently writes nothing when the enqueue-time row is missing,
  restoring the vanishing failure the table exists to prevent. Upsert states the invariant instead
  of assuming it. `domain/studio/render-attempt.ts` is the single writer, same posture
  `content-gate.ts` holds over `ContentBrief.status`.
- **Retry re-checks the approval; it does not replay.** `POST /content/plans/:id/retry` re-queues
  the *same* plan id with the failure cleared, after calling `requireApprovedContentBrief` — a retry
  is a fresh request to build from a brief that may have been undone, rejected or superseded since.
  §12.12a's lesson applies with more force to work queued twice. `plan.build`'s `FOR UPDATE`
  re-check at materialization is still the guarantee; this is the fast rejection.
- **A pre-migration plan is not a 404.** `GET /content/plans/:id` falls back to the `RenderPlan` row
  when no attempt exists and reports `built`. That is reading the plan's existence, not inventing a
  status — append-only purity is precisely what makes it unambiguous.
- **A cross-tenant request records in the tenant that ASKED.** Every value on such a row was
  supplied by the caller and nothing is read across the boundary; the owning tenant gets nothing.
  Asserted in both directions rather than left to inference.

**Driven end to end, not just unit-tested** (`scripts/studio/prove-plan-chain.ts`, runs 2c/2d — real
HTTP route → real Redis → real registered processor → real row → real HTTP read). A footage asset
with a failed `MediaAnalysis`: `GET /content/plans/:id` returns `queued` *before the worker runs*,
then `infeasible` / `analysis_missing` / `retryable: true` with the job's own sentence, **1 attempt
row and 0 plan rows**. Re-analysis then `POST …/retry` returns to `queued` on the same id and
completes `built` with the plan materialized — still **1 attempt row, not 2**. The script asserts
both and fails the chain if either regresses.

**A defect only looking caught.** The UI surface first went into `.pane.rail-types`, which
typechecked and rendered correctly — and `styles.css` hides that rail entirely below 1240px. A
failure surface that disappears on a narrow window is a silent failure with extra steps. Moved to a
strip in normal flow under the screen header, verified in a browser at 1100px and 820px, with the
reason legible, the code beside it, and Retry confirmed issuing `POST /content/plans/:id/retry`.
This is the fifth defect this milestone invisible to every static check (§12.26's count), and it
cost one screenshot to find.

**What would reverse this.** A decision that plan status belongs on `RenderPlan` after all — which
means arguing with §12.25's purity grounds, not with this. A move to synchronous plan building,
which would make the attempt row redundant (there would be an HTTP response to fail into) — plausible
given `plan.build` is 60s of pure computation with no LLM call, and it would simplify this away
entirely. Or `Render` being materialized before its plan, which would give the failure an existing
home; §12.25 rejected that as inverting the pipeline's ordering, and that reasoning still holds.

**Left open, deliberately:** the attempt row is never garbage-collected. Rows are small and one per
build request, so this is not urgent, but it is unbounded — the retention workstream's sweep is the
natural owner and this table should be on its list.

### 12.39 Correction to §12.36 — the purge kept forever exactly what it should delete first

Review of the closeout caught an inversion in W1's eligibility rule, and an overclaim in §12.36.

`isEligibleForPurge` required a **succeeded analysis carrying a fingerprint**. The intent was
sound — do not delete a video before we have extracted from it — but the effect was the opposite
of the posture: a reference whose analysis permanently failed (corrupt upload, unreadable codec)
satisfied that condition *never*, and so was **kept indefinitely**. §12.36's sentence "no tenant
ever retains a reference longer than 30 days" was false for precisely the class with the weakest
claim to being retained: `04 §5` applies **most** to a video that yielded nothing, because there is
no retained artifact justifying holding it.

The fingerprint guard only ever protected *young* assets from being purged mid-extraction, and
analysis runs on upload — so a reference still unanalysed at the retention horizon is not pending,
it is failed. **Age alone now decides past the horizon.** The two tests that asserted the old
behaviour were inverted rather than deleted, so the corrected posture is pinned.

**A second defect fell out with it.** The age cutoff was applied only in memory, over a
`take: limit` window ordered oldest-first — so rows that were never eligible accumulated at the
head, and once more than `limit` of them existed the sweep would scan a full page, purge nothing,
and report success forever. Pushing the cutoff into the query fixes it, and note the shape of the
fix: **the query predicate and the in-memory predicate now select the same set**, so a row in the
window is by construction a row to purge. Starvation is not guarded against; it is unrepresentable.

**And a note on the test I did not write.** I wrote a starvation regression test, then mutated the
query filter away to confirm it failed without the fix. It passed either way — the eligible row
sorts first regardless of `limit`, so it demonstrated nothing. I removed it and left the reasoning
in the test file instead. A test that passes with and without the fix is worse than no test: it is
false assurance, which is the failure mode this milestone found five separate times. **Mutate a new
test before trusting it.**

### 12.40 W4.1 on real locked-off footage — what held, and what did not

First render against genuinely locked-off talking-head footage (`talking-head-v1.mp4`, sha256
`7dbc78be…`, staged outside git per §12.10; a 1080×1920 proxy `dd17a360…` is the working source —
the content region is 1080px wide and the master is 2160, so the downscale is lossless *for this
pipeline*, the inverse of §12.18's upscaling complaint).

**What held.** §12.22's chin-anchored face floor **works on footage never used to tune it** — no
caption touches the jaw. G1a is 100% on all three templates (32/29/23 cuts). The gate was exercised
for real over HTTP, producing a `ContentBriefDecision` row.

**Correction to my own pre-flight claim.** I reported that "nothing in the codebase applies rotation
metadata", from a grep. Too strong: cv2, ffmpeg and Chromium **all auto-apply the display matrix** —
cv2 reports 2160×3840, ffmpeg stills come out portrait, and a proxy built with `scale=1080:-2` is
portrait. The real exposure is narrower and still worth fixing: **only ffprobe's raw stream
`width`/`height` is pre-rotation**, so the first upload path populating `MediaAsset` from those
fields records every portrait phone video as landscape. A grep proves what code says, not what
libraries do.

**No analyzer defect.** The apparent disagreements were different quantities: "136 onsets" vs 137
beats is §11.3's N⇒N−1 convention; the duration gap is container vs audio stream (both real, and
`plan-build.ts:141` already prefers the container and says why); and my staged pause list was a
**waveform silence** measurement — reproduced exactly with `silencedetect -35dB` — while the
analyzer emits word timings and never emitted a pause list. Comparing them was my error.

**Chasing the one mismatch found something real.** faster-whisper **runs word ends into silence** —
`"temple"` spans 16.34→17.76 (1.42s) at RMS 0.025; four such words total 4.18s. Since §12.2 made
word edges the legal cut candidates, those spans are **uncuttable**, and a caption sits on screen
1.4s after speech stopped. It never starves the DP (largest candidate gap 1.84s against a 5.0s
maximum). Fix when owned: trim word ends against an RMS floor — the signal is already in the payload.

### 12.41 Ruling — `editorial_sans` fails G2 by seed draw; fix the template, not the gate

It produced **23.1 cuts/min against G2's 25–40 band**, and a seed sweep shows it is not the
fixture's fault: **3 of 8 seeds fail on this footage, 1 of 8 on the reference.** Its curve centres
around 26–27 against a floor of 25 — about 5% margin — so passing has been a coin toss, and it has
shipped with roughly a one-in-eight chance of an ungateable plan.

The agent declined to retune, correctly naming the risk that tuning numbers until a gate goes green
is §12.3's failure in costume. **The distinction: §12.3 was moving a gate's threshold to accommodate
an algorithm that could not meet it. This is moving a template's design centre to respect a band
fixed first.** The 25–40 band is the product contract for "a reel" (`01 §9`, `07 §1`) and predates
the template.

**Ruling: retune `editorial_sans`'s rhythm curve to centre with real margin inside the band** —
target ~29–30 cuts/min so the full seed spread sits inside 25–40 — and add a seed-sweep test that
fails if any seed in a fixed set lands outside. A template satisfying its own gate on 5 of 8 seeds
is not slow, it is broken. **Do not touch G2.**

### 12.42 Ruling — ADR-8's pre-render rejection is implemented for G1a only

ADR-8 says a plan failing its gate is rejected at `plan.build` "so it never costs a render". That is
wired for **G1a alone**, yet G2–G10 are all plan-decidable — §12.6 deliberately made G7 and G9 so —
and all hard. §12.41 is the proof: a plan that could not pass G2 was materialised and would have
burned a full render before anything noticed.

**Ruling: `buildApprovedRenderPlan` evaluates every plan-decidable hard gate before persisting**,
emitting `plan_infeasible` with the failing gate and its measured value. G11/G12/G13 need the
rendered file and stay post-render. This is what ADR-8 meant; only its implementation was partial.

### 12.43 §12.16 was right about the face and silent about the hands

Two captions land on the subject's **hands** (7.47s, 30.0s). §12.16 reasoned that a 62.5% content
region leaves room below the face. It does — and this subject gestures into that room continuously.
The premise was correct about the one occupant it considered and said nothing about any other,
which is the same shape as the bug it was written to fix.

**Ruling: captions default to the letterbox bars.** `02 §2.2`'s in-video `center` becomes opt-in,
available to a template only with a documented reason — restoring §11.1 R2's actual logic, that the
bars are *structurally* safe, which is why face detection was descoped, and which §12.5 partially
undid. G6's ≥3 distinct positions come from horizontal variation within the bars, where the
reference's own `lower_left`/`center_low` distinction already lives. A gesturing talking head is the
**common** case for this product, not an edge case.

From the same pass, both ours: a chunk at **1.20s** straddles the video/bar boundary, one line on
the shirt and one on black — a block must sit wholly inside one region. And **5 of 35 emphasis words
are stopwords** (`is`, `you`, `one`, `the`): G8 is mechanically clean while being editorially wrong,
so the scorer needs a floor a stopword cannot clear on audio energy alone.

### 12.44 The fixture's content caps the comparison — for the Reviewer

`talking-head-v1.mp4` is an unedited take: retakes ("temple is a… temple is an…"), a name that
changes mid-clip, and a flubbed ending at 57.8–59.3s that the pipeline renders faithfully because
faithful rendering is what it does. **`07 §3` asks whether a stranger can immediately pick our
render as the professional one. That question is about the motion system, not the script.** Judge
cut placement, caption behaviour, motion and grade; do not mark the PerfStaq render down for saying
what the speaker said. A better take raises both sides equally and changes nothing about which one
looks edited.

### 12.46 The comparison test passes — and the baseline was built to resist being flattered

`07 §3` is answered: **PerfStaq PASS ×3, naive baseline FAIL ×3**, same footage, same ContentBrief,
12 hard gates scored on both sides. The baseline fails G2, G3, G5, G6, G7, G9 and G10. A stranger
picks the real arm from a single still — one side has a two-word caption on black with the subject
pushed in; the other has fourteen words across three lines running over the subject's hands, static
and ungraded.

**The part worth recording is how the baseline was built.** The instruction was that it must be
honestly bad, because an agent optimising for a flattering comparison will unconsciously soften the
control. It did the opposite, twice, in ways nobody asked for:

- Baseline shots **declare** a camera with `fromScale === toScale` rather than omitting `motion` —
  because omitting it makes `gateG7` report `computable: false`, and an *excluded* gate would
  flatter the baseline by dropping the one gate measuring exactly what it lacks.
- Baseline block captions carry their **real words**, which needed an additive `captionMode` field,
  because `gateG5` measures `words.length` — a whole sentence collapsed into one `CaptionWord`
  would report 1 and **pass**.

Typography was held identical so the comparison could not be won on fonts, and the baseline was
given a *smaller, more readable* caption size than the real arm. It also declined to retune the cut
interval after discovering the finding below, on the grounds that **tuning the control arm to lose
is the same error as softening it**. That is the right instinct stated better than I stated it.

Also proven rather than asserted: re-rendering all three real arms from the W4.1 plans, in a
different directory and a later session, reproduced the **W4.1 checksums byte for byte** — §11.3's
amended G13 satisfied in fact, not merely recorded.

### 12.47 Ruling — G1a is a floor, not a discriminator, and needs a regression tripwire beside it

The baseline's **beat-blind** 2.5s cuts scored **87% on G1a and cleared the 85% gate**. The reason
is arithmetic: the fixture's grid is 143.6 BPM (median gap 418ms) and 2.5s is 5.98 beats, so a fixed
interval lands near a beat by coincidence. Neighbouring intervals collapse — 2.25s scores 65%,
2.75s scores 52% — so this is a lucky number, not a capability.

**An 85% floor is therefore reachable without consulting the grid at all.** That does not make the
gate wrong: 85% was calibrated against the reference's own measured 82–86% (§4.1), i.e. against what
a human editor achieves, and its job is to reject plans that never locked to the beat. But it cannot
distinguish deliberate snapping from coincidence, and our planner scores **100% by construction**.

**Ruling: keep 85% as the hard floor — it is the reference-calibrated contract and must not move
(§12.3) — and add a separate regression tripwire asserting that plans produced by our own planner
score ≥95%.** A drop from 100% to 87% means the snapping broke, and today's floor would not notice.
A floor and a regression alarm are different instruments; we had only one.

### 12.48 Two gaps in the emphasis path, one of which produced the milestone's last honest "no"

**G8 cannot see a reel with no emphasis at all.** "At most one emphasis per chunk, indexing a real
word" is satisfied by *zero*, so the baseline marks none and scores clean on all three templates.
The mission statement says one word per phrase **gets** emphasis treatment; the gate only bounds the
maximum. **Ruling: G8 also requires emphasis to be present at a minimum rate**, so a reel that
emphasises nothing fails rather than passes silently.

**The emphasis scorer ignores ASR confidence.** At 30.0s the emphasised word is "SHAIL" — a
mis-transcription of "shared", carrying confidence 0.571 against a 0.970 median — and elsewhere
"what" is selected at confidence **0.0423**, the least-confident token in the file. §11.1 R1 added
per-word `rms` to the payload for this scorer; `score` sits in the same payload, unused. **Ruling:
penalise low-confidence tokens in `pickEmphasis`.** Per §12.44 we do not mark the render down for
what the speaker said — but *choosing* to enlarge and colour the one word the recogniser was least
sure of is ours, and it is the last honest "no" in `07 §2`.

### 12.49 The same shape a third time, in the harness that was checking for it

The baseline's G9 predicted a six-line 510px block where the renderer drew three, because the
composition computed its font size from a constant while the plan carried the template's display
size. Same family as §12.45's uppercase bug: **every check agreed with every other check and all
were wrong together**, because they shared an assumption instead of sharing a source. Fixed by
putting the size on the plan.

Three occurrences now (§12.34 latent calibration, §12.45 uppercase measurement, this). The pattern
is stable enough to name: **when a value is derived independently on both sides of a boundary, the
checks agree with each other and disagree with reality.** Put the value in the artifact that crosses
the boundary, and measure the artifact.

Minor, environmental: this machine's ffmpeg has no `drawtext` (no libfreetype), so the grid halves
carry a colour band instead of text labels.
