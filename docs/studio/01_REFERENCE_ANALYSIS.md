# 01 — Reference Reel Analysis (measured, not guessed)

Source: `08f77252a39a4dec9296f15ba4d17865.MP4` — a Raj Shamani podcast clip, "THE POWER OF OBSESSION". This is the quality bar. Every number below was measured with PySceneDetect, librosa, and OpenCV. **These numbers are the acceptance criteria.**

## 1. Container
| Property | Value |
|---|---|
| Resolution | 720×1280 (9:16) — *we render 1080×1920* |
| Frame rate | 23.976 fps — *we render 30fps* |
| Duration | 54.87s |
| Bitrate | ~14 Mbps |
| Audio | 44.1kHz stereo |

## 2. Cut rhythm — THE core finding

30 shots in 54.87s = **32.8 cuts/minute**. Median shot **1.44s**, mean 1.83s.

Full shot list (seconds): 2.79, 3.46, 1.00, 0.67, 1.54, 1.04, 1.21, 1.21, 1.21, 3.34, 0.83, 1.34, 0.79, 2.84, 0.71, 1.71, 1.17, 1.79, 0.71, 4.13, 0.75, 2.00, 1.00, 1.21, 2.42, 2.21, 4.55, 1.59, 1.63, 4.02

**Pattern: rhythmic breathing, not uniform pacing.** Long establishing shot (2.8–3.5s) → burst of rapid cuts (0.7–1.2s) → a long hold (3.3–4.5s) to let a point land → burst again. Note the run at 10.51→14.14s: three consecutive 1.21s shots — a deliberate triplet. Then 17.48→20.44: 0.83 / 1.34 / 0.79 — accelerating.

**Implementation rule:** never cut on a fixed interval. Generate a rhythm curve: `establish (2.5–3.5s) → accelerate (3–5 shots, 0.7–1.3s) → hold (3.5–4.5s)` and repeat, with hold shots placed on the script's payload beats.

## 3. Beat lock — the thing that separates pro from amateur

Audio tempo: **112.3 BPM**, 97 detected beats.

- Median distance from a cut to the nearest beat: **0.086s**
- **25 of 29 cuts (86%) land within 150ms of a beat**

This is not coincidence. The editor cut to the music. **This is the single highest-leverage thing to implement** and the one most template systems miss entirely.

**Implementation rule:** compute the beat grid with librosa, then snap every candidate cut to the nearest beat. Acceptance gate: ≥85% of cuts within 150ms.

## 4. Caption system — TWO independent layers

### Layer 1 — persistent title banner (top)
- Text: `THE POWER OF ` + `OBSESSION`
- Heavy condensed sans, all caps, ~centered, top ~9% of frame
- **Two-tone: white body + a single word in red (#E03030-ish)** — the emphasis word is colored, not the whole line
- Sits on the letterboxed black bar above the video, never over the subject's face
- Persistent for the entire clip — it's the hook, always visible for scroll-stoppers

### Layer 2 — karaoke word captions (over video)
- **Serif display face** (looks like Playfair/Bodoni-class), all caps, white, subtle drop shadow for legibility
- **1–3 words visible at a time** — "WORKING", "MORE THAN WORK", "SMALL". Not sentence blocks. Not 5+ word chunks.
- **Position varies by shot** — sampled at center-low, lower-left, center. It moves. Static bottom-center captions read as amateur.
- Word-level timing, synced to speech onset

### Layer 3 — handle watermark
- Instagram glyph + `@RAJSHAMANI`, small, semi-transparent, position alternates between upper-right and mid-left across shots (avoiding the subject)

**Implementation rule:** three separate composition layers with independent timing. The banner is derived from the ContentBrief's hook; the karaoke layer from WhisperX word timings; the handle from tenant config.

## 5. Motion — nothing is ever static

Sampled 223 frames: mean interframe difference 11.53, median 6.08, **21% of samples classified high-motion**.

The camera is locked off (podcast setup). The motion is **added in post**: continuous slow push-in on every shot, plus punch-ins on emphasis. Frames within a single shot show progressive scale change.

**Implementation rule:** every shot gets a Ken Burns push, scale 1.00 → 1.05–1.08 over the shot duration, with spring easing (not linear). On emphasis words, add a fast punch: scale +6% over ~8 frames with a stiff spring, then settle.

## 6. Grade
Warm-shadow, slightly crushed blacks, elevated contrast, saturated reds in the background signage. Skin tones warm. Not neutral — a deliberate look.

**Implementation rule:** apply a LUT or a CSS filter chain (contrast ~1.08, saturation ~1.06, warm tint) uniformly. Consistency reads as "graded."

## 7. Framing
Video is letterboxed inside 9:16 with black bars top and bottom — the source is 16:9 podcast footage, scaled to fit width, with the bars used as caption real estate. Smart: captions never occlude the face.

**Implementation rule:** support two framing modes — `letterbox` (16:9 source, bars carry the banner) and `fill` (9:16 native source, banner overlays with a scrim).

## 8. What this reel does NOT do (equally instructive)
- No transitions — every cut is a hard cut. No whip pans, no dissolves, no zoom transitions.
- No emoji, no stickers, no progress bars, no arrows.
- No background music bed competing with speech — the beat grid comes from the speech/room audio and a subtle bed.
- No B-roll cutaways — it's a single continuous interview, cut on itself (jump cuts).

**Restraint is part of the quality.** Do not add effects the reference doesn't have. Amateur output is usually over-decorated, not under-decorated.

## 9. Acceptance criteria derived from this file

| Metric | Target | Measured on reference |
|---|---|---|
| Cuts/minute | 25–40 | 32.8 |
| Median shot length | 1.2–1.8s | 1.44s |
| Cuts within 150ms of beat | ≥85% | 86% |
| Words visible per caption | 1–3 | 1–3 |
| Shots with micro-motion | 100% | 100% |
| Caption position variance | ≥3 distinct positions | 3 |
| Transition types used | hard cut only (v1) | hard cut only |
