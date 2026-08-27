# 07 — Quality Gates

Every render is measured. Numbers come from `01_REFERENCE_ANALYSIS.md`. The Reviewer agent runs these; CI runs the automatable ones.

## 1. Automated gates (block merge)

| # | Gate | Measure | Pass |
|---|---|---|---|
| G1 | **Beat lock** | % of cuts within 150ms of a librosa beat | **≥85%** |
| G2 | Cut density | cuts per minute | 25–40 |
| G3 | Shot length | median shot duration | 1.0–2.0s |
| G4 | Min shot | shortest shot | ≥0.6s |
| G5 | Caption density | max words visible simultaneously | ≤3 |
| G6 | Caption position variance | distinct positions used | ≥3 |
| G7 | Micro-motion | shots with scale delta >1% | 100% |
| G8 | Emphasis | emphasis words per chunk | ≤1 |
| G9 | Safe margins | any text within 12% of frame edge | 0 violations |
| G10 | Word integrity | cuts landing mid-word (vs WhisperX) | 0 |
| G11 | Loudness | integrated LUFS | -14 ±1 |
| G12 | Output spec | 1080×1920, 30fps, H.264+AAC | exact |
| G13 | Reproducibility | same plan+footage → identical checksum | pass |
| G14 | Provenance | render links to claim_ids + framework_id | non-empty |

**Implementation:** `scripts/qc-render.ts` takes an MP4 + its RenderPlan, runs PySceneDetect + librosa + ffprobe + plan introspection, emits `qc.json`. Wire into the `render.qc` queue and into CI.

## 2. Human/Reviewer gates (Opus)

Watch the render at full speed once, then answer:
- [ ] Does the first 2 seconds make you want to keep watching?
- [ ] Does any moment look **generated** rather than edited? (name the timestamp)
- [ ] Do the cuts feel intentional or metronomic?
- [ ] Is exactly one idea emphasized per caption chunk?
- [ ] Would an agency send this to a client without editing it?
- [ ] Anti-amateur checklist (02_MOTION_SYSTEM §8) — all clear?

**Any "no" → reject with the timestamp and the specific failure.** Vague feedback ("feels off") is not acceptable review output; name the metric or the moment.

## 3. The comparison test (Definition of Done)
Render the same content with (a) our pipeline and (b) a naive baseline (fixed-interval cuts, block captions, linear fades). Put them side by side. If a stranger can't immediately pick ours as the professional one, the motion system isn't done.

## 4. Regression
The M1 ring suite must stay green on every PR. Studio work must never touch webhook handlers, the Recall client, the review-gate write path, or brief versioning.
