/**
 * layout.ts — where text is allowed to be (02_MOTION_SYSTEM §2, §7; 01 §4, §7).
 *
 * ── The framing ruling this file implements (§11.1 R2, as corrected by §12.16)
 * v1 ships **`letterbox` framing only**, and `fill` plus MediaPipe face boxes
 * are deferred to v2 together — so `fill` is deliberately not buildable here.
 *
 * R2 originally justified descoping face detection by claiming captions live
 * in the black bars and "structurally cannot occlude a face". **That reason
 * was wrong and a rendered frame disproved it** (§12.16): a caption landed
 * across a subject's mouth in all three templates. The conclusion survives on
 * different grounds — a content region sized like the reference's (62.5% of
 * frame height, not the 31.6% a width-fit gives) leaves real room below the
 * chin, and locked-off interview footage needs only a static per-template
 * crop offset rather than a tracker.
 *
 * The anchors below are therefore derived from a MEASURED face floor, not
 * from an argument about which region text sits in.
 *
 * **No luminance analysis.** 02 §2.2 wanted a scrim "when over a busy region
 * (detect via mean luminance of the text bounding box)"; R2 descopes it.
 * Drop-shadow is always on (the reference achieves legibility with a 2px
 * shadow alone, 01 §4) and the scrim is a static per-template policy.
 *
 * ── Position names ──────────────────────────────────────────────────────────
 * 02 §2.2 names four rotation positions; §12.20 retires `upper_third` because
 * the corrected geometry has no room for it. See the note on `CaptionPosition`.
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

/**
 * The content region: where footage is drawn (ARCHITECTURE §12.16).
 *
 * **This replaces "scale 16:9 to width".** `01 §7` said the reference is
 * "16:9 podcast footage scaled to fit width"; §12.4 measured the content
 * region at 720×800 (≈0.9:1) and §12.16 established why that difference
 * matters rather than being trivia. Fitting 16:9 to width puts 607px of video
 * in a 1920 frame — 31.6% of frame height, against the reference's 62.5% —
 * so our subject was half the size of the reference's, and the "bars" were
 * 68% of the frame. The reference gets its 0.9:1 region by zooming ~2× and
 * cropping the SIDES, which is why its subject's head fills the frame.
 *
 * That cramped band is the root cause of the caption-across-the-mouth this
 * ruling came from: with only 31.6% of the frame carrying video, every
 * caption position sat either in a vast black bar or on the subject's face,
 * with nothing in between.
 */
export const CONTENT_REGION_RATIO = 0.625;

export function contentRegion(
  height: number = FRAME.height,
  regionRatio: number = CONTENT_REGION_RATIO,
): { top: number; bottom: number; height: number } {
  const regionHeight = height * regionRatio;
  const top = (height - regionHeight) / 2;
  return { top, bottom: top + regionHeight, height: regionHeight };
}

/**
 * @deprecated Superseded by `contentRegion` (§12.16). Retained only so the
 * arithmetic of the old assumption stays inspectable next to the correction:
 * this is the 16:9-fit band that produced a 31.6% video region.
 */
export function letterboxVideoBand(width: number = FRAME.width, height: number = FRAME.height): { top: number; bottom: number } {
  const videoHeight = width * (9 / 16);
  const top = (height - videoHeight) / 2;
  return { top, bottom: top + videoHeight };
}

/**
 * §12.20 retires `upper_third`. Under the corrected content region the top
 * bar spans y ∈ [0, 0.1875] and G9's 12% margin leaves 130px of usable
 * height; a two-line chunk at emphasis size is 229px. It does not fit, and no
 * amount of anchor tuning makes it fit. `01 §4` measures the reference's own
 * karaoke layer at exactly three positions ("center-low, lower-left,
 * center"), so three is both what fits and what the reference does. §12.5
 * preserved 02 §2.2's four names under the OLD geometry; the geometry changed.
 *
 * The retirement originally cited §12.16, which rules on the content region
 * and not on this; §12.20 is the ruling that actually retires the position,
 * and it also records that `02 §2.2`'s four-position list and §12.5's
 * resolution of it are stale on this point.
 */
export type CaptionPosition = "center_low" | "lower_left" | "lower_right" | "center";

/**
 * The DEFAULT rotation — all three inside the bottom letterbox bar (§12.43).
 *
 * `center` is deliberately absent. It is the only in-video position and is now
 * **opt-in**: a template may list it in `captionPositions`, but doing so puts
 * text over the subject and needs a stated reason, because on this product's
 * common case — a founder talking to camera and gesturing while they do it —
 * "below the chin" is not the same as "clear of the subject". §12.16 reasoned
 * about the face and was silent about the hands; the hands were in the frame
 * the whole time.
 */
export const CAPTION_POSITIONS: readonly CaptionPosition[] = [
  "center_low",
  "lower_left",
  "lower_right",
] as const;

/** Positions that sit inside a letterbox bar rather than over the footage. */
export const BAR_CAPTION_POSITIONS: readonly CaptionPosition[] = [
  "center_low",
  "lower_left",
  "lower_right",
] as const;

export function isBarPosition(position: CaptionPosition): boolean {
  return BAR_CAPTION_POSITIONS.includes(position);
}

export type Anchor = {
  /** 0..1 of frame width — the text block's horizontal centre. */
  x: number;
  /** 0..1 of frame height — the text block's vertical centre. */
  y: number;
  /**
   * `right` exists because §12.43 pins the bar positions to ONE vertical line
   * (see `ANCHORS`), so all three of G6's distinct positions have to be
   * horizontal. Left and centre are only two.
   */
  align: "center" | "left" | "right";
};

/**
 * Anchors for the CORRECTED content region (§12.16), 1080×1920.
 *
 * Content region y ∈ [0.1875, 0.8125]; safe area y ∈ [0.12, 0.88].
 *
 * ── Where these numbers come from ───────────────────────────────────────────
 * Measured, not chosen. In the source footage the subject's chin sits at
 * ≈0.847 of source height; cover-cropped into the 0.625 content region that
 * lands at **y ≈ 0.717 of the frame**. So the caption band that cannot touch
 * a face is y > 0.73, bounded below by G9's 12% bottom margin at 0.88.
 *
 * The previous anchors (center 0.62, center_low 0.72) were derived against
 * the 16:9-fit band, where 0.62 was "the bottom sixth of the video, below a
 * seated subject's face". Under the corrected region 0.62 is the MOUTH — which
 * is what three rendered templates showed, and what falsified §11.1 R2's
 * claim that letterboxed captions structurally cannot occlude a face.
 *
 * The band is bounded on BOTH sides and is genuinely tight — 0.73 to 0.88,
 * about 288px, against a two-line block of ~200px. So vertical variance is
 * limited by geometry, and the positions get their separation mostly from
 * ALIGNMENT, which is what `01 §4`'s "center-low, lower-left, center" is:
 * lower-left is a horizontal move, not a vertical one.
 *
 *   center      → 0.785  (centred, over the chest, below the chin at 0.717)
 *   lower_left  → 0.800  (LEFT-aligned from the safe margin — the visible move)
 *   center_low  → 0.818  (centred, lowest; still clears G9's bottom at 2 lines)
 *
 * `lower_left` starts at x=0.12 rather than 0.3 so its box is the full safe
 * width. At 0.3 the box was 626px, which wrapped ordinary three-word chunks
 * to two and three lines and pushed them through the bottom margin; the fix
 * for a too-tall block is usually a wider box, not a higher anchor.
 *
 * ── §12.43: the bar positions have exactly one legal y ──────────────────────
 * The bottom bar runs from the content region's edge (0.8125 at the default
 * 0.625 region) to G9's bottom margin (0.88) — **129.6px**. A single line
 * containing the emphasis word is 0.101·W × 1.05 = **114.5px**. Requiring the
 * block to sit wholly inside the bar leaves the centre only
 *
 *   [0.8125·H + 57.2,  0.88·H − 57.2]  =  [1617.2, 1632.4]px  — 15px of range
 *
 * so there is one vertical position and the three rotation positions must
 * differ HORIZONTALLY. That is not a stylistic choice; it is what 129.6px of
 * bar permits, and it is why `lower_right` had to exist. It also means a
 * TWO-line chunk (up to 200px measured) cannot go in the bar at all — hence
 * the fit predicate in `chunk.ts`, which splits chunks until they can.
 */
export const BAR_CAPTION_Y = 0.846;
const ANCHORS: Record<CaptionPosition, Anchor> = {
  // ── The three bar positions (§12.43) ──────────────────────────────────────
  // y is IDENTICAL across all three, and that is forced, not chosen. Derived
  // in `BAR_CAPTION_Y` below.
  lower_left: { x: SAFE_MARGIN_RATIO, y: BAR_CAPTION_Y, align: "left" },
  center_low: { x: 0.5, y: BAR_CAPTION_Y, align: "center" },
  lower_right: { x: 1 - SAFE_MARGIN_RATIO, y: BAR_CAPTION_Y, align: "right" },

  // ── Opt-in, in-video (§12.43) ─────────────────────────────────────────────
  // Retained at its §12.16-derived value: centred, over the chest, below the
  // chin at 0.717. A template that lists it accepts text over the subject.
  center: { x: 0.5, y: 0.785, align: "center" },
};

/** The measured chin line under the corrected content region — the bound the
 *  caption anchors above are derived from, named so a test can assert it. */
export const FACE_FLOOR_RATIO = 0.717;

/**
 * The face floor expressed in the CONTENT REGION's own coordinates — 0..1 of
 * region height, which is what a CSS `transform-origin` on the region div
 * takes (ARCHITECTURE §12.19).
 *
 * This exists because the anchors above are derived from the chin at scale
 * 1.0, and the renderer does not compose at scale 1.0. It composes drift ×
 * punch, up to 1.18 × 1.06 ≈ 1.25. Scaling about the region's CENTRE leaves
 * the chin 416px below the origin, so the zoom pushes it down — 0.717 static
 * becomes 0.771 at worst case, against caption tops as high as 0.755. The
 * anchors were correct; the geometry they were derived under was not the
 * geometry that renders.
 *
 * Scaling about THIS line instead makes the chin the transform's fixed point,
 * so `FACE_FLOOR_RATIO` is the chin's position at every scale rather than only
 * at 1.0 — which is what lets the face-floor check below be a bound on one
 * measured constant instead of a bound that has to track `REFRAME_STEP`,
 * `MAX_GROW` and `punchScale` and be re-derived whenever any of them moves.
 *
 * Cover is preserved: for any scale ≥1 and any origin inside the element, the
 * scaled box contains the unscaled box, so the region never reveals an edge.
 */
export function faceFloorOriginY(
  faceFloorRatio: number = FACE_FLOOR_RATIO,
  regionRatio: number = CONTENT_REGION_RATIO,
): number {
  const regionTopRatio = (1 - regionRatio) / 2;
  return (faceFloorRatio - regionTopRatio) / regionRatio;
}

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
  // Mirror image of `left`: the box ENDS at its anchor and runs back to the
  // safe margin, so a right-aligned block's last glyph lands on the anchor
  // rather than its first.
  if (anchor.align === "right") {
    return { left: safeLeft, right: Math.min(safeRight, anchor.x * width) };
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
  return g9ViolationsForBlock(layer, anchor, fontSizePixels * LINE_HEIGHT * lines, width, height);
}

/**
 * G9 for a block whose height is already known in pixels.
 *
 * `g9Violations` above assumes every line is the same size, which is true of
 * the banner and the handle and NOT true of a karaoke chunk: 02 §7 gives the
 * emphasis word 0.101·W and its neighbours 0.075·W, so a wrapped chunk's
 * height is the sum of per-line maxima, not `size × lines`. Measuring it the
 * uniform way over-estimates by up to 35% on exactly the chunks most likely
 * to be near a margin — which surfaced as a G9 failure on a chunk that in
 * fact fits. An over-strict gate is a real cost: it teaches people to
 * disbelieve the gate.
 */
export function g9ViolationsForBlock(
  layer: TextLayer,
  anchor: Anchor,
  blockHeightPx: number,
  width: number = FRAME.width,
  height: number = FRAME.height,
): string[] {
  const problems: string[] = [];
  const { left, right } = textBoxBounds(anchor, width);
  const centre = anchor.y * height;
  const top = centre - blockHeightPx / 2;
  const bottom = centre + blockHeightPx / 2;
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
 * Whether a karaoke block clears the face, measured on its TOP EDGE
 * (ARCHITECTURE §12.19). Empty array means clear.
 *
 * `g9ViolationsForBlock` bounds a karaoke top at 12% — the frame edge — and
 * says nothing about the chin at 71.7%, so the two bounds leave a hole between
 * them that a tall block falls straight through. A three-line chunk at
 * `center` puts its top at 0.711, eleven pixels ABOVE the chin, while sitting
 * comfortably inside every margin G9 knows about: it passes, silently, with
 * text across a face. That is the same failure §12.16 exists to fix, one layer
 * up, and it stayed invisible because the floor was only ever asserted on
 * `anchor.y` — the block's CENTRE — which is by construction the half of the
 * block that is furthest from the face.
 *
 * Kept separate from `g9Violations` rather than folded into it because they
 * bound different things: G9 is about platform chrome at the frame edges, this
 * is about the subject. A caller that wants both asks for both.
 *
 * Only the karaoke layer is scored. The banner and the handle live in the top
 * bar by construction (§12.16 item 4), where "below the chin" is not a bound
 * anyone wants — it would demand the hook banner sit on the subject's chest.
 */
export function faceFloorViolationsForBlock(
  anchor: Anchor,
  blockHeightPx: number,
  height: number = FRAME.height,
  faceFloorRatio: number = FACE_FLOOR_RATIO,
): string[] {
  const top = anchor.y * height - blockHeightPx / 2;
  const floor = faceFloorRatio * height;
  const eps = 1e-6;
  if (top < floor - eps) {
    return [`top ${(top / height).toFixed(4)} above the face floor ${faceFloorRatio}`];
  }
  return [];
}

/**
 * §12.43 — a text block must sit wholly inside ONE region: the footage band,
 * the top bar, or the bottom bar. Empty array means contained.
 *
 * This is its own bound because the existing two miss it from both sides. G9
 * bounds the block against the FRAME edges and is happy at 0.88; the face
 * floor bounds it against the CHIN and is happy anywhere below 0.717. A block
 * centred between them can still lie half on the subject's chest and half on
 * black — which is exactly what shipped at 1.20s, one line on the shirt and
 * the next on the bar, looking like a layout accident because it was one.
 *
 * Scored on the same wrapped height G9 uses, so the two cannot disagree about
 * how tall the block is.
 */
export function regionContainmentViolations(
  anchor: Anchor,
  blockHeightPx: number,
  height: number = FRAME.height,
  regionRatio: number = CONTENT_REGION_RATIO,
): string[] {
  const region = contentRegion(height, regionRatio);
  const top = anchor.y * height - blockHeightPx / 2;
  const bottom = anchor.y * height + blockHeightPx / 2;
  const eps = 1e-6;

  const wholly =
    (bottom <= region.top + eps) || // entirely in the top bar
    (top >= region.bottom - eps) || // entirely in the bottom bar
    (top >= region.top - eps && bottom <= region.bottom + eps); // entirely in the footage

  if (wholly) return [];
  return [
    `block ${(top / height).toFixed(4)}..${(bottom / height).toFixed(4)} straddles a region edge ` +
      `(content region ${(region.top / height).toFixed(4)}..${(region.bottom / height).toFixed(4)})`,
  ];
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
/**
 * §12.16 item 3: the handle moved OUT of the content region.
 *
 * It used to alternate `upper_right` (y=0.2) and `mid_left` (y=0.5), copying
 * 01 §4's description of the reference. Under the corrected content region
 * y=0.5 is the dead centre of the video — the subject's face — and a render
 * showed the handle sitting on his hair. `mid_left` was renamed rather than
 * repointed: a constant whose name says "mid" while it resolves to the top
 * bar is the same kind of lie §12.14 recorded in camera.ts, and the enum is
 * young enough that honesty costs one schema line.
 *
 * Both corners now live in the top bar, alternating sides. The bottom bar is
 * not available: `center_low` and `lower_left` captions already occupy it,
 * and a handle that intermittently collides with a caption is worse than one
 * that alternates within a bar it owns.
 */
export type HandleCorner = "upper_right" | "upper_left";

export const HANDLE_OPACITY = 0.52; // 02 §2.3's 45–60% band

export function handleCornerForShot(shotIndex: number): HandleCorner {
  return shotIndex % 2 === 0 ? "upper_right" : "upper_left";
}

export function handleAnchor(corner: HandleCorner): Anchor {
  return corner === "upper_right"
    ? { x: 0.78, y: 0.155, align: "center" }
    : { x: 0.14, y: 0.155, align: "left" };
}
