/**
 * layout.ts — where text is allowed to be (02_MOTION_SYSTEM §2, §7; 01 §4, §7).
 *
 * ── The framing ruling this file implements (ARCHITECTURE §11.1 R2) ─────────
 * v1 ships **`letterbox` framing only**. That is what the reference does
 * (01 §7) and it is what descopes face detection: 16:9 source scaled to width
 * inside 9:16 leaves black bars top and bottom, and the bars are caption real
 * estate that structurally cannot occlude a face. `fill` framing and
 * MediaPipe face boxes are deferred to v2 and must be added together — so
 * `fill` is deliberately not buildable here.
 *
 * **No luminance analysis.** 02 §2.2 wanted a scrim "when over a busy region
 * (detect via mean luminance of the text bounding box)"; R2 descopes it.
 * Drop-shadow is always on (the reference achieves legibility with a 2px
 * shadow alone, 01 §4) and the scrim is a static per-template policy.
 *
 * ── Reconciling 02 §2.2's position names with letterbox ─────────────────────
 * 02 names four rotation positions — `center_low`, `lower_left`, `center`,
 * `upper_third` — and 01 §4 measures the reference's karaoke layer sitting
 * over the video. Resolved against a letterboxed 1080×1920 frame, three of
 * the four land inside the black bars and the fourth (`center`) sits in the
 * bottom sixth of the video band, below where a seated subject's face is in
 * podcast framing. That keeps 02's vocabulary, honours R2's "cannot occlude a
 * face", and satisfies G6 (≥3 distinct positions) without a face detector.
 */

export const FRAME = { width: 1080, height: 1920 } as const;

/** G9: nothing within 12% of a frame edge (platform UI overlap). */
export const SAFE_MARGIN_RATIO = 0.12;

/** 16:9 inside 9:16, scaled to width: the video band's vertical extent. */
export function letterboxVideoBand(width = FRAME.width, height = FRAME.height): { top: number; bottom: number } {
  const videoHeight = width * (9 / 16);
  const top = (height - videoHeight) / 2;
  return { top, bottom: top + videoHeight };
}

export type CaptionPosition = "center_low" | "lower_left" | "center" | "upper_third";

/** 02 §2.2's rotation list, in rotation order. */
export const CAPTION_POSITIONS: readonly CaptionPosition[] = [
  "center_low",
  "lower_left",
  "center",
  "upper_third",
] as const;

export type Anchor = {
  /** 0..1 of frame width — the text block's horizontal centre. */
  x: number;
  /** 0..1 of frame height — the text block's vertical centre. */
  y: number;
  align: "center" | "left";
};

/**
 * Letterbox geometry for 1080×1920: video band is y ∈ [0.3418, 0.6582];
 * safe area is y ∈ [0.12, 0.88], x ∈ [0.12, 0.88].
 *   upper_third → 0.26  (top bar, below the banner, above the video)
 *   center      → 0.62  (bottom sixth of the video band, below a seated face)
 *   center_low  → 0.72  (bottom bar)
 *   lower_left  → 0.80  (bottom bar, left-aligned)
 */
const ANCHORS: Record<CaptionPosition, Anchor> = {
  upper_third: { x: 0.5, y: 0.26, align: "center" },
  center: { x: 0.5, y: 0.62, align: "center" },
  center_low: { x: 0.5, y: 0.72, align: "center" },
  lower_left: { x: 0.3, y: 0.8, align: "left" },
};

export function anchorFor(position: CaptionPosition): Anchor {
  return ANCHORS[position];
}

/** True iff the anchor sits inside the 12% safe area (G9). */
export function withinSafeMargins(anchor: Anchor, marginRatio = SAFE_MARGIN_RATIO): boolean {
  const lo = marginRatio;
  const hi = 1 - marginRatio;
  return anchor.x >= lo && anchor.x <= hi && anchor.y >= lo && anchor.y <= hi;
}

/**
 * 02 §2.2: "Position rotates per shot … **Never the same position twice in a
 * row**." Deterministic in the shot index so a re-plan reproduces it (G13),
 * and it walks the list rather than sampling so G6's ≥3-distinct is
 * structural rather than probabilistic.
 */
export function positionForShot(shotIndex: number): CaptionPosition {
  return CAPTION_POSITIONS[shotIndex % CAPTION_POSITIONS.length]!;
}

/** 02 §7 — sizes proportional to frame width, never px constants. */
export const TYPE_SCALE = {
  banner: 0.062,
  karaoke: 0.075,
  emphasis: 0.101,
  handle: 0.028,
} as const;

export function fontSizePx(token: keyof typeof TYPE_SCALE, width = FRAME.width): number {
  return TYPE_SCALE[token] * width;
}

/** 02 §7's typography tokens. */
export const FONT_ROLES = {
  display_condensed: "banner",
  display_serif: "karaoke statement style",
  body_sans: "metadata, handles",
} as const;

/** 01 §4: "subtle drop shadow for legibility" — always on, never computed. */
export const DROP_SHADOW = { offsetPx: 2, blurPx: 6, color: "rgba(0,0,0,0.85)" } as const;

/** R2: a static per-template policy, not a per-frame luminance decision. */
export type ScrimPolicy = "never" | "always";

/**
 * 02 §2.3 — the handle/brand bug. "Alternates between two safe corners across
 * shots. Never static in one corner for the whole reel — static bugs read as
 * a watermark, alternating reads as design." 01 §4 measures the reference
 * alternating upper-right and mid-left.
 */
export type HandleCorner = "upper_right" | "mid_left";

export const HANDLE_OPACITY = 0.52; // 02 §2.3's 45–60% band

export function handleCornerForShot(shotIndex: number): HandleCorner {
  return shotIndex % 2 === 0 ? "upper_right" : "mid_left";
}

export function handleAnchor(corner: HandleCorner): Anchor {
  return corner === "upper_right" ? { x: 0.78, y: 0.2, align: "center" } : { x: 0.2, y: 0.5, align: "left" };
}
