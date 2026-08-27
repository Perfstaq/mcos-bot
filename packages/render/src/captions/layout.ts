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

/**
 * ARCHITECTURE §12.7 — the one carve-out, and it is deliberately narrow.
 *
 * G9's 12% bound stays strict on the LEFT, RIGHT and BOTTOM edges. The TOP
 * edge is exempt **for the persistent banner only**, which may reach 8%.
 * Platform UI on Reels/Shorts/TikTok sits at the bottom (caption, CTA) and
 * the right (action rail); the top is comparatively clear, the banner lives
 * in the letterbox bar where it occludes nothing, and pushing it to 14% would
 * bury the hook to satisfy a margin protecting against UI that is not there.
 * Every other layer stays bound on all four edges.
 */
export const BANNER_TOP_MARGIN_RATIO = 0.08;

/** Which G9 rule a text layer is held to. */
export type TextLayer = "banner" | "karaoke" | "handle";

/** 16:9 inside 9:16, scaled to width: the video band's vertical extent. */
export function letterboxVideoBand(width: number = FRAME.width, height: number = FRAME.height): { top: number; bottom: number } {
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
 * The horizontal extent of a text box placed at `anchor`, in pixels.
 *
 * G9 is about where the TEXT lands, not where its anchor sits, and those come
 * apart the moment a box is wider than the distance from its anchor to the
 * frame edge. Rendering caught it: a left-aligned handle anchored at x=0.2
 * inside a centred 0.76·W box starts at −194px and loses its first character
 * off-frame. Centring a fixed-width box is only correct for a centred anchor.
 *
 * So a left-aligned box starts AT its anchor and runs to the safe margin; a
 * centred box is centred and clamped to whichever margin it reaches first.
 * Returning the geometry (rather than doing it inline in the composition) is
 * what lets G9 be asserted without rasterising a frame.
 */
export function textBoxBounds(
  anchor: Anchor,
  width: number = FRAME.width,
  marginRatio: number = SAFE_MARGIN_RATIO,
): { left: number; right: number } {
  const safeLeft = marginRatio * width;
  const safeRight = (1 - marginRatio) * width;
  if (anchor.align === "left") {
    return { left: Math.max(safeLeft, anchor.x * width), right: safeRight };
  }
  const centre = anchor.x * width;
  const halfWidth = Math.min(centre - safeLeft, safeRight - centre);
  return { left: centre - halfWidth, right: centre + halfWidth };
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

/** The line-height every text layer renders at; used to turn a font size
 *  into the block height G9 actually has to bound. */
export const LINE_HEIGHT = 1.05;

/**
 * The vertical extent of a text block centred on `anchor.y`.
 *
 * G9 bounds where the TEXT lands, and a block's top and bottom are its anchor
 * ± half its height — which is why an anchor at 9% and a 67px banner puts ink
 * at 7.2%, inside a margin the anchor alone looked clear of. The horizontal
 * half of this was already learned the hard way (see `textBoxBounds`); this is
 * the same lesson on the other axis.
 */
export function textBoxVerticalExtent(
  anchor: Anchor,
  fontSizePixels: number,
  lines = 1,
  height: number = FRAME.height,
): { top: number; bottom: number } {
  const blockHeight = fontSizePixels * LINE_HEIGHT * lines;
  const centre = anchor.y * height;
  return { top: centre - blockHeight / 2, bottom: centre + blockHeight / 2 };
}

/**
 * Every way a text block breaks G9, named. Empty array means compliant.
 * Encodes §12.7's asymmetry directly, so the exemption is a value the tests
 * can point at rather than an assertion someone forgot to write.
 */
export function g9Violations(
  layer: TextLayer,
  anchor: Anchor,
  fontSizePixels: number,
  lines = 1,
  width: number = FRAME.width,
  height: number = FRAME.height,
): string[] {
  const problems: string[] = [];
  const { left, right } = textBoxBounds(anchor, width);
  const { top, bottom } = textBoxVerticalExtent(anchor, fontSizePixels, lines, height);
  const eps = 1e-6;

  if (left < SAFE_MARGIN_RATIO * width - eps) problems.push(`left ${(left / width).toFixed(4)} < ${SAFE_MARGIN_RATIO}`);
  if (right > (1 - SAFE_MARGIN_RATIO) * width + eps)
    problems.push(`right ${(right / width).toFixed(4)} > ${1 - SAFE_MARGIN_RATIO}`);
  if (bottom > (1 - SAFE_MARGIN_RATIO) * height + eps)
    problems.push(`bottom ${(bottom / height).toFixed(4)} > ${1 - SAFE_MARGIN_RATIO}`);

  // The ONLY asymmetry (§12.7): banner tops may reach 8%, everything else 12%.
  const topLimit = layer === "banner" ? BANNER_TOP_MARGIN_RATIO : SAFE_MARGIN_RATIO;
  if (top < topLimit * height - eps) problems.push(`top ${(top / height).toFixed(4)} < ${topLimit}`);

  return problems;
}

/**
 * The banner's anchor, defined once so the composition and the plan builder
 * cannot drift apart. y=0.10 rather than 01 §4's measured ~0.09 because the
 * ruling bounds the block's TOP at 8%, and a 0.062·W banner centred at 0.09
 * puts its top at 7.2%.
 */
export const BANNER_ANCHOR: Anchor = { x: 0.5, y: 0.1, align: "center" };

/** 02 §7 — sizes proportional to frame width, never px constants. */
export const TYPE_SCALE = {
  banner: 0.062,
  karaoke: 0.075,
  emphasis: 0.101,
  handle: 0.028,
} as const;

export function fontSizePx(token: keyof typeof TYPE_SCALE, width: number = FRAME.width): number {
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

// ---------------------------------------------------------------------------
// Karaoke word appearance — where 02 §2.2 and 01 §8 collide.
//
// 02 §2.2 asks for the ACTIVE word (the one being spoken) to be "brand accent
// color while it's being spoken, then settles to white". 02 §3 gives the ONE
// emphasis word "accent color + scale 1.35". Rendered literally, those two
// rules use the same colour, so on any given frame an accent word means
// either "this is the payload of the approved claim" or merely "the speaker
// is currently saying this" — and on a 1–2 word chunk the active word is
// accent for essentially the whole time it is on screen.
//
// That is the exact failure 02 §2.1 names in the banner's case: "Two coloured
// words halves the emphasis." It also adds an effect the measured reference
// does not have — 01 §4 records the karaoke layer as plain WHITE, with only
// the banner two-tone — and 01 §8 is explicit that "Restraint is part of the
// quality. Do not add effects the reference doesn't have."
//
// Resolution: accent is reserved for emphasis. The active word is still
// highlighted, by weight and opacity rather than hue — already-spoken words
// recede, which is the karaoke read — so word-level sync survives and the one
// accent word in a chunk keeps meaning exactly one thing.
// ---------------------------------------------------------------------------

export type WordVisualState = "pending" | "active" | "spoken";

export type WordAppearance = {
  /** "accent" is reserved for the single emphasis word (G8). */
  colorRole: "accent" | "primary";
  opacity: number;
  sizeToken: "karaoke" | "emphasis";
};

export const SPOKEN_OPACITY = 0.72;

export function captionWordAppearance(state: WordVisualState, isEmphasis: boolean): WordAppearance {
  return {
    colorRole: isEmphasis ? "accent" : "primary",
    opacity: state === "spoken" && !isEmphasis ? SPOKEN_OPACITY : 1,
    sizeToken: isEmphasis ? "emphasis" : "karaoke",
  };
}

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
