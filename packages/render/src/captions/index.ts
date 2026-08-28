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
  splitChunksToFit,
  chunkWords,
  type BannerPlan,
  type CaptionChunkPlan,
  type CaptionTrackInput,
  type CaptionWordPlan,
} from "./chunk.js";
export {
  blockHeightPx,
  lineCount,
  textWidthPx,
  wrapLines,
  wrapWords,
  makeSingleLineFitPredicate,
  type MeasuredWord,
  type WrapOptions,
} from "./measure.js";
export {
  EMPHASIS_THRESHOLD,
  EMPHASIS_WEIGHTS,
  buildEmphasisContext,
  claimTokenSet,
  isContrastWord,
  isNumberOrProperNoun,
  isStopword,
  stopwordMayBeEmphasised,
  normalizeToken,
  pickEmphasis,
  rmsStats,
  scoreWord,
  type EmphasisContext,
  type ScoredWord,
} from "./emphasis.js";
export {
  BANNER_ANCHOR,
  BANNER_TOP_MARGIN_RATIO,
  CAPTION_POSITIONS,
  CONTENT_REGION_RATIO,
  BAR_CAPTION_Y,
  BAR_CAPTION_POSITIONS,
  isBarPosition,
  regionContainmentViolations,
  FACE_FLOOR_RATIO,
  DROP_SHADOW,
  FONT_ROLES,
  FRAME,
  HANDLE_OPACITY,
  LINE_HEIGHT,
  SAFE_MARGIN_RATIO,
  SPOKEN_OPACITY,
  TYPE_SCALE,
  anchorFor,
  contentRegion,
  captionWordAppearance,
  faceFloorOriginY,
  faceFloorViolationsForBlock,
  fontSizePx,
  g9Violations,
  g9ViolationsForBlock,
  handleAnchor,
  handleCornerForShot,
  letterboxVideoBand,
  positionForShot,
  textBoxBounds,
  textBoxVerticalExtent,
  withinSafeMargins,
  type Anchor,
  type CaptionPosition,
  type HandleCorner,
  type ScrimPolicy,
  type TextLayer,
  type WordAppearance,
  type WordVisualState,
} from "./layout.js";
