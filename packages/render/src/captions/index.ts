/**
 * captions/ — the three independently-timed layers (02_MOTION_SYSTEM §2,
 * 01_REFERENCE_ANALYSIS §4):
 *
 *   1. the persistent hook banner   (buildBanner)
 *   2. karaoke word captions        (buildCaptionTrack)
 *   3. the handle / brand bug       (handleCornerForShot, layout.ts)
 *
 * "Three separate composition layers with independent timing" (01 §4) — the
 * banner is derived from the ContentBrief's hook, the karaoke layer from
 * word timings, the handle from tenant config. None of them shares a clock.
 */
export {
  CHUNK_GAP_MS,
  MAX_WORDS_PER_CHUNK,
  buildBanner,
  buildCaptionTrack,
  chunkWords,
  type BannerPlan,
  type CaptionChunkPlan,
  type CaptionTrackInput,
  type CaptionWordPlan,
} from "./chunk.js";
export {
  EMPHASIS_THRESHOLD,
  EMPHASIS_WEIGHTS,
  buildEmphasisContext,
  claimTokenSet,
  isContrastWord,
  isNumberOrProperNoun,
  isStopword,
  normalizeToken,
  pickEmphasis,
  rmsStats,
  scoreWord,
  type EmphasisContext,
  type ScoredWord,
} from "./emphasis.js";
export {
  CAPTION_POSITIONS,
  DROP_SHADOW,
  FONT_ROLES,
  FRAME,
  HANDLE_OPACITY,
  SAFE_MARGIN_RATIO,
  TYPE_SCALE,
  anchorFor,
  fontSizePx,
  handleAnchor,
  handleCornerForShot,
  letterboxVideoBand,
  positionForShot,
  textBoxBounds,
  withinSafeMargins,
  type Anchor,
  type CaptionPosition,
  type HandleCorner,
  type ScrimPolicy,
} from "./layout.js";
