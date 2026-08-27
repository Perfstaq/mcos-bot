/**
 * motion/ — the house motion system (02_MOTION_SYSTEM §1, §4).
 *
 * Ported per ARCHITECTURE.md §1.1's ledger: `motion.ts` (with changes) and
 * `duck.ts` (as-is). The 44 `ENTER_VALUES` entrances, `decayingScaleFloor`
 * and `atmosphericWashAllowed` deliberately stayed behind — ADR-4, hard cuts
 * only.
 */
export {
  EXIT_SPEEDUP,
  MIN_VISIBLE_SCALE_DELTA,
  SPRINGS,
  SPRING_FRAMES,
  driftDurationInFrames,
  exitFrames,
  type HouseSpringConfig,
  type SpringName,
} from "./springs.js";
export {
  MAX_GROW,
  MIN_GROW,
  PUNCH_SCALE_BOOST,
  effectiveMotion,
  passesMicroMotionGate,
  scaleAt,
  scaleDelta,
  shotCamera,
  type ShotCamera,
  type SpanMotion,
} from "./camera.js";
export { duckGain, type DuckOptions, type SpeechWindow } from "./duck.js";
