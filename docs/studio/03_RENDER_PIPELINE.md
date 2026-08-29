# 03 — Render Pipeline

Agent P owns this file. **First task: inventory the existing PerfStack repo** (Remotion, WhisperX, FFmpeg) and report what is reusable before writing new code.

## 1. Architecture

```
upload footage ──> R2 (raw/)
                     │
              [analyze job]  BullMQ
                     ├── ffprobe            → duration, fps, resolution
                     ├── WhisperX           → word-level timestamps + speaker
                     ├── librosa            → beat grid, tempo, onset envelope, RMS/word
                     ├── PySceneDetect      → existing cuts (if reference/long-form)
                     └── OpenCV             → per-shot motion energy, face box, luminance map
                     ▼
              MediaAnalysis (Postgres, jsonb)
                     │
              [plan job]  ← ContentBrief (from Strategy) + MotionTemplate
                     ├── rhythm plan → beat-snapped cut list
                     ├── caption chunks + emphasis scoring
                     └── shot assignment (which footage segment fills which slot)
                     ▼
                RenderPlan (typed JSON — this is the reproducible artifact)
                     │
              [render job] Remotion Lambda
                     ▼
              MP4 → R2 (renders/) → presigned URL → Studio UI
```

## 2. Data model (additive migrations)

```prisma
model MediaAsset      { id, tenant_id, r2_key, kind: 'footage'|'reference'|'render',
                        duration_ms, width, height, fps, created_at }
model MediaAnalysis   { id, asset_id, words Json, beats Json, scenes Json,
                        motion Json, faces Json, tempo Float, analyzed_at }
model MotionTemplate  { id, name, archetype, slots Json, fonts Json, grade Json,
                        framing: 'letterbox'|'fill', version, active }
model RenderPlan      { id, tenant_id, content_brief_id, template_id, footage_asset_id,
                        plan Json, seed, created_by }
model Render          { id, plan_id, status, r2_key, duration_ms, qc Json,
                        lambda_render_id, error, created_at }
```

`RenderPlan.plan` is the full deterministic spec: cut list, caption chunks with word timings, emphasis flags, motion curves per shot, grade, audio track id. **Given the same plan + footage, the render is byte-reproducible.** Re-renders never re-run the LLM.

## 3. Jobs (BullMQ queues)

| Queue | Concurrency | Timeout | Notes |
|---|---|---|---|
| `media.analyze` | 2 | 15m | GPU-optional; faster-whisper on CPU acceptable at this scale |
| `plan.build` | 4 | 60s | Pure computation, no LLM call — LLM already ran at ContentBrief stage |
| `render.submit` | 4 | 20m | Remotion Lambda; poll for completion |
| `render.qc` | 4 | 5m | Runs 07_QUALITY_GATES checks on the output |

Idempotency: dedupe on `(plan_id)`. Retries: 2 with backoff, then `render_failed` with the reason surfaced in the UI (never a silent failure).

## 4. Remotion setup

- **Render on Remotion Lambda** — do not build a render farm. 1080×1920, 30fps, H.264, CRF ~20, `x264-preset medium`, AAC 192k.
- Compositions are typed React components taking `RenderPlan` as props. **No component computes its own timing** — everything comes from the plan. This is what makes renders reproducible and testable.
- `<Sequence>` per shot, `<OffthreadVideo>` for footage, `<Audio>` for the licensed track.
- Fonts loaded via `@remotion/google-fonts` or self-hosted woff2 in `public/`.
- Concurrency: start at 8 lambdas/render; tune after measuring.

## 5. Audio rules

- Speech from the user's footage is the primary track — **never replaced, never cloned** (invariant 4).
- Music bed: licensed library only (Epidemic/Artlist), ducked to -18dB under speech via sidechain, full level in gaps.
- **Reference reel audio is never used in output** (invariant 5). Style transfer takes the *tempo*, not the track.
- Loudness normalize the final mix to -14 LUFS.

## 6. Footage selection

When the plan needs 14 shots and the user uploads one continuous clip, the planner segments it:
1. Split on speech pauses (from WhisperX gaps >400ms).
2. Score each segment: motion energy + face-present + audio RMS + no mid-word boundary.
3. Fill hold slots with the highest-scoring segments (the payload lines), fill accelerate slots with the rest, in order.
4. Never cut mid-word. Never produce a shot <0.6s.

## 7. Failure states (all surfaced in UI, all retryable)
`analyze_failed(reason)` · `plan_infeasible(reason)` — e.g. footage too short for template · `render_failed(reason)` · `qc_failed(metric, value)` — links to the specific gate that failed.
