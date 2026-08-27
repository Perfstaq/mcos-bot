# 04 — Style Transfer (reference reel → your footage)

Agent F owns this. **Starts only after templates (Agent T) merge** — the fingerprint must render *into* something.

## 1. Be honest about what's possible

You cannot extract an edit as a program. Video is flattened pixels; the decisions are gone. What you extract is a **structural fingerprint**, then map it onto your own primitives. The promise to the user is **"recreate in this style,"** never "clone this video." Say that in the UI.

## 2. What is extractable

> **v1 scope (ARCHITECTURE §11.2 R6, §12.31).** This table describes the ceiling, not what ships.
> **v1 transfers pace, cut rhythm, tempo and framing; typography, captions and grade come from the
> template.** The three OCR-dependent rows below (caption timing, position pattern, emphasis
> treatment) ship at confidence 0 and fall through to template defaults per §3 — there is no OCR
> tooling in the stack and adding it for medium-fidelity signals was judged a bad v1 trade. Grade is
> not mapped at all, and not for a confidence reason: the fingerprint measures absolute finished
> pixels while a template's grade is multipliers over an ungraded source, so assigning one to the
> other is arithmetic on incompatible units. Only warmth *order* is used, in template selection.

| Signal | Method | Fidelity |
|---|---|---|
| Cut points, shot rhythm | PySceneDetect ContentDetector(27) | High |
| Tempo, beat grid | librosa beat_track | High |
| Beat-lock ratio | cuts vs beats | High |
| Caption timing/cadence | per-frame OCR + tracking | Med-high |
| Caption position pattern | OCR bbox centroid per shot | High |
| Caption style (serif/sans, weight, color, karaoke vs block) | vision LLM classify → nearest known style | Classify |
| Emphasis treatment (colored word, scale) | OCR color/size delta | Medium |
| Zoom/push direction & magnitude | optical flow / phase correlation | Medium |
| Grade profile | histogram → LUT fit | Medium |
| Transition kinds | frame-delta classifier (8 classes) | Medium |
| Framing mode | letterbox detection (black bar rows) | High |
| Exact text animation curves | — | **Not recoverable** |

## 3. The EditFingerprint object

```ts
EditFingerprint {
  source_asset_id
  duration_ms, fps, framing: 'letterbox'|'fill'
  rhythm: { cuts_per_min, median_shot_ms, shot_durations_ms[],
            pattern: 'establish_accelerate_hold' | 'uniform' | 'accelerating' }
  audio:   { tempo_bpm, beat_times_ms[], beat_lock_ratio, beat_lock_median_ms }
  captions:{ layers: ('banner'|'karaoke'|'handle')[],
             words_per_chunk_median, style_class, position_sequence[],
             emphasis: { colored: bool, scale_ratio, accent_hex } }
  motion:  { micro_motion: bool, mean_scale_delta, punch_events_ms[] }
  grade:   { contrast, saturation, warmth, vignette }
  transitions: { kinds: string[], counts: {} }
  confidence: { per-field 0..1 }
}
```

Every low-confidence field falls back to the template default rather than guessing.

## 4. Fingerprint → RenderPlan mapping

1. **Pick nearest template** by vector distance over `(cuts_per_min, median_shot_ms, caption_style_class, framing, layer_set)`.
2. **Parameterize it** with the fingerprint's rhythm curve, caption cadence, position sequence, motion magnitude, and grade.
3. **Re-time to the user's footage** — the fingerprint's shot count rarely matches available footage. Scale the rhythm pattern proportionally; enforce min shot 0.6s.
4. **Re-derive the beat grid from the NEW audio** (the user's speech + the licensed bed). Never reuse the reference's beat times — snap to the new track.
5. Emit a normal `RenderPlan`. Everything downstream is unchanged.

## 5. Hard constraints

- **Never carry reference audio into output.** Tempo only.
- **Never copy the reference's text content.** Copy the *cadence* (words per chunk, timing pattern); the words come from the ContentBrief.
- Store only the fingerprint long-term; the reference video itself is deleted after analysis (or retained ≤30 days with tenant consent) — PDPL/GDPR posture and it keeps you out of "we're storing other people's content" territory.
- Fingerprint-derived observations that are *strategically* interesting (hook type, angle, format) are returned as typed **proposals that are never persisted**. ~~enter the Brain as proposed claims through the review gate~~ — **amended by ARCHITECTURE §12.30 R7**: they do NOT become `CandidateClaim` rows. That table requires `meetingId`, `evidenceSourceId`, `extractionRunId`, `verbatimQuote`, `speaker` and `timestampMs`, all NOT NULL — that column set *is* CLAUDE.md invariant 2 (evidence or drop) expressed in the schema, and a fingerprint has none of them: no meeting, no segment, and under §11.2 R6 no text was ever read. Persisting one would require fabricated provenance or relaxing the M1 gate's own table. If these observations are wanted in memory later they need their own table with their own honest provenance (asset id, frame ranges, method, confidence) routed through a gate of their own.

## 6. Acceptance test
Feed the reference reel from `01_REFERENCE_ANALYSIS.md` into the extractor. The fingerprint must report: cuts_per_min 30–36, median_shot_ms 1300–1600, tempo 110–115, beat_lock_ratio ≥0.80, layers = [banner, karaoke, handle], words_per_chunk_median 1–3, framing = letterbox. **If it doesn't reproduce those measured numbers, the extractor is wrong.**
