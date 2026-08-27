# 02 — The Motion System

> This is what separates a ₹5,000 edit from a Canva template. Every rule here is mandatory. Agent M owns this file.

## 1. First principle: nothing is linear

**Ban `interpolate()` for any visible motion.** Every entrance, exit, scale, and position change uses Remotion's `spring()`. Linear tweens are the #1 tell of generated video.

```ts
// The house springs — use these, don't invent new ones per component
export const SPRINGS = {
  // text enters: overshoots then settles. The signature move.
  pop:     { damping: 12, mass: 0.5, stiffness: 200 },
  // frame punch on emphasis: fast, tight, minimal overshoot
  punch:   { damping: 20, mass: 0.3, stiffness: 400 },
  // slow continuous push: no overshoot, just ease
  drift:   { damping: 200, mass: 3,  stiffness: 40  },
  // exits: quicker than entrances, always
  out:     { damping: 18, mass: 0.4, stiffness: 260 },
} as const;
```

Rule: **exits are ~40% faster than entrances.** Symmetric timing looks robotic.

## 2. Caption engine — three layers, independent timing

### 2.1 Banner (persistent hook)
```ts
BannerSpec {
  text: string            // from ContentBrief.hook_text
  emphasis_word: string   // ONE word, rendered in accent color
  font: 'display_condensed'   // heavy, condensed, all-caps
  placement: 'letterbox_top' | 'overlay_top_with_scrim'
  enter: SPRINGS.pop      // animates in over first 12 frames, then static
}
```
Only one word is colored. Two coloured words halves the emphasis. The emphasis word is chosen by the rule in §3.

### 2.2 Karaoke word captions
Driven by **WhisperX word-level timestamps**. Hard rules:

- **1–3 words on screen at a time.** Never a sentence. Chunk by: break on punctuation, break at 3 words max, break at any gap >280ms between words.
- Each word enters on its own speech onset with `SPRINGS.pop`, starting at `scale: 0.82, opacity: 0`.
- **Active word is highlighted** — brand accent color while it's being spoken, then settles to white.
- **Position rotates per shot** through a safe-zone list: `center_low`, `lower_left`, `center`, `upper_third`. Never the same position twice in a row. Never within 12% of frame edges (platform UI overlap).
- Serif display face for statement content; condensed sans for punchy/listicle content. Set per template.
- Legibility: 2px dark drop shadow + optional 55%-opacity scrim behind text when over a busy region (detect via mean luminance of the text bounding box).

```ts
CaptionChunk { words: {text, start_ms, end_ms, is_emphasis}[], position, style }
```

### 2.3 Handle / brand bug
Small, 45–60% opacity, alternates between two safe corners across shots. Never static in one corner for the whole reel — static bugs read as a watermark, alternating reads as design.

## 3. Emphasis detection — pick the ONE word

For each caption chunk, score every word and take the max:

```
score(word) =
    2.0 * appears_in_claim_text(word)      // it's the payload of the approved claim
  + 1.5 * audio_energy_zscore(word)         // speaker stressed it (RMS over the word span)
  + 1.0 * is_number_or_proper_noun(word)
  + 0.8 * is_contrast_word(word)            // "but", "never", "actually", "instead"
  - 2.0 * is_stopword(word)
```

The winner gets: accent color + `scale 1.35` + a frame punch (§4.2) landing on its onset. **Maximum one emphasis per chunk.** If nothing scores above threshold, no emphasis — restraint over decoration.

## 4. Motion on footage

### 4.1 Continuous micro-motion (every shot, no exceptions)
```ts
scale: drift(1.00 → 1.05 + rand(0.00..0.03)) over shot duration
origin: alternate between subject-center and a slight offset per shot
```
Direction alternates: push-in on odd shots, pull-back on even. A reel where every shot pushes in feels monotonous.

### 4.2 Emphasis punch
On the emphasis word's onset: `scale +6% over 8 frames with SPRINGS.punch`, settle over 14 frames. Optionally 1-frame black flash on the hardest beat of the reel (use once per reel, maximum).

### 4.3 Cut behaviour
**Hard cuts only in v1.** No dissolves, no whips. The reference uses zero transitions and it looks premium. Add transition types only after v1 ships and only if a template demands it.

## 5. Beat-locked cutting — the algorithm

```
1. librosa.beat.beat_track(audio) → beat_times[], tempo
2. Generate a rhythm plan from the script beats:
     establish(2.5-3.5s) → accelerate(3-5 shots @ 0.7-1.3s) → hold(3.5-4.5s), repeat
3. For each planned cut time t: snap to argmin |beat_times - t|
   Reject the snap if it distorts the shot beyond [0.6s, 5.0s].
4. Assert: >=85% of final cuts are within 150ms of a beat. Fail the render if not.
```

When source audio is speech-only (no music bed), derive the grid from **onset strength envelope** instead of beat tracking, and snap cuts to speech-pause boundaries — never mid-word.

## 6. Grade
Uniform per reel: `contrast 1.08, saturate 1.06, warm shift +4`, slight vignette (0.12), optional film grain at 3% opacity. One look per template, applied globally. Do not grade per-shot.

## 7. Typography tokens
```ts
FONTS = {
  display_condensed: 'Anton / Bebas-class',   // banner
  display_serif:     'Playfair-class',        // karaoke statement style
  body_sans:         'Inter-class',           // metadata, handles
}
```
Sizes are proportional to frame width, never px constants: banner `0.062*W`, karaoke `0.075*W`, emphasis `0.101*W`, handle `0.028*W`.

## 8. The anti-amateur checklist (Reviewer enforces)
- [ ] No linear easing anywhere
- [ ] No fade-in/fade-out as the only entrance
- [ ] No static shots
- [ ] No captions in the same position for the whole reel
- [ ] No more than 3 words visible at once
- [ ] No emoji, stickers, arrows, or progress bars
- [ ] No more than one emphasis word per chunk
- [ ] No unlicensed audio
- [ ] Nothing within the platform-UI safe margins (12% edges)
