import React from "react";
import { AbsoluteFill, OffthreadVideo, Sequence, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import {
  BANNER_ANCHOR,
  DROP_SHADOW,
  LINE_HEIGHT,
  TYPE_SCALE,
  anchorFor,
  captionWordAppearance,
  handleAnchor,
  textBoxBounds,
  type WordVisualState,
} from "../captions/layout.js";
import { SPRINGS, SPRING_FRAMES } from "../motion/springs.js";
import type { Anchor, Banner, CaptionChunk, Cut, Handle, RenderPlan, ShotMotion } from "../plan.js";

/**
 * Reel.tsx — the composition shell (03_RENDER_PIPELINE §4, ARCHITECTURE §1.1).
 *
 * Ported shape from founder-journey's `Reel.tsx`: `<Sequence>` per span,
 * `<OffthreadVideo>`, plan-as-props, imports limited to react + remotion +
 * relative modules. Every entrance/overlay/broll/evidence branch was stripped
 * per ADR-4 — hard cuts only, and the plan schema has no field for any of it,
 * so none of it can come back without a visible schema change.
 *
 * **Plan-as-props is the rule here, not a preference.** Nothing below computes
 * a timing, a scale or a position: the planner and the caption engine decided
 * all of it and it arrived on `plan`. That is what makes a render
 * reproducible (G13) and what lets every gate be scored from the plan alone.
 * `Math.random()` and `Date.now()` are absent for the same reason.
 *
 * Agent M owns this only as far as proving the primitives render. Agent T owns
 * the real shell and the three templates on top of it (ARCHITECTURE §8).
 */

export type ReelProps = {
  plan: RenderPlan;
  footageSrc: string;
};

const ACCENT = "#FF7A1A";
const textShadow = `0 ${DROP_SHADOW.offsetPx}px ${DROP_SHADOW.blurPx}px ${DROP_SHADOW.color}`;

/**
 * Geometry comes from `textBoxBounds` so that what G9 asserts and what the
 * browser lays out are the same computation. Centring a fixed-width box on
 * every anchor is what pushed a left-aligned handle off the frame.
 */
function anchorStyle(anchor: Anchor, width: number): React.CSSProperties {
  const { left, right } = textBoxBounds(anchor, width);
  return {
    position: "absolute",
    left,
    top: `${anchor.y * 100}%`,
    transform: "translateY(-50%)",
    width: right - left,
    textAlign: anchor.align === "left" ? "left" : "center",
    textShadow,
  };
}

/**
 * One shot: the footage span plus its continuous micro-motion (02 §4.1 —
 * "every shot, no exceptions"; G7 wants scale delta >1% on 100% of shots).
 *
 * `durationInFrames` on the spring is mandatory and comes from the plan
 * (ARCHITECTURE §11.3). Left at its natural speed the overdamped drift
 * spring would traverse ~11% of its range in a 0.6s shot — a ~0.57% scale
 * move, which fails G7 — and 0.7–1.2s shots are the common case, not the
 * edge case. `interpolate()` appears nowhere: 02 §1 bans it for visible
 * motion, and a linear tween is the #1 tell of generated video.
 */
const Shot: React.FC<{ cut: Cut; src: string; motion: ShotMotion | undefined; fps: number; frames: number }> = ({
  cut,
  src,
  motion,
  fps,
  frames,
}) => {
  const frame = useCurrentFrame();
  const progress = motion
    ? spring({ frame, fps, config: SPRINGS[motion.spring], durationInFrames: motion.durationInFrames })
    : 0;
  const scale = motion ? motion.fromScale + (motion.toScale - motion.fromScale) * progress : 1;
  const origin = motion ? `${motion.originX * 100}% ${motion.originY * 100}%` : "50% 50%";

  return (
    <AbsoluteFill style={{ justifyContent: "center", overflow: "hidden" }}>
      <div style={{ transform: `scale(${scale})`, transformOrigin: origin, width: "100%" }}>
        <OffthreadVideo
          src={src}
          startFrom={Math.round((cut.sourceInMs / 1000) * fps)}
          endAt={Math.round((cut.sourceInMs / 1000) * fps) + frames}
          style={{ width: "100%" }}
        />
      </div>
    </AbsoluteFill>
  );
};

/**
 * Layer 2 — karaoke word captions (02 §2.2). Each word enters on its own
 * speech onset with SPRINGS.pop from `scale 0.82, opacity 0`, and recedes in
 * opacity once spoken. At most three words are ever on screen because the
 * chunker guarantees it (G5).
 *
 * The active word is highlighted by weight, NOT by hue: accent belongs to the
 * single emphasis word. 02 §2.2 asks for accent on the active word too, but
 * that makes an orange word ambiguous between "the payload of the approved
 * claim" and "the speaker is mid-sentence" — and on a one-word chunk the
 * active word is orange for its whole life on screen, which is how a
 * deliberately un-emphasised stopword ("IT") read as emphasised. See
 * captions/layout.ts for the full argument (01 §4 and §8 outrank here).
 */
const CaptionChunkLayer: React.FC<{ chunk: CaptionChunk; width: number; fps: number }> = ({ chunk, width, fps }) => {
  const frame = useCurrentFrame();
  const anchor = chunk.anchor ?? anchorFor("center_low");
  const chunkStart = chunk.startMs ?? chunk.words[0]!.startMs;

  return (
    <div style={{ ...anchorStyle(anchor, width), display: "flex", gap: width * 0.02, justifyContent: anchor.align === "left" ? "flex-start" : "center", flexWrap: "wrap" }}>
      {chunk.words.map((word, i) => {
        const onset = ((word.startMs - chunkStart) / 1000) * fps;
        const local = frame - onset;
        const enter = spring({
          frame: Math.max(0, local),
          fps,
          config: SPRINGS.pop,
          durationInFrames: SPRING_FRAMES.popEnter,
        });
        const offset = ((word.endMs - chunkStart) / 1000) * fps;
        const emphasis = word.isEmphasis === true || chunk.emphasisWordIndex === i;
        const state: WordVisualState = local < 0 ? "pending" : frame <= offset ? "active" : "spoken";
        // Accent is reserved for the ONE emphasis word (G8). The active word
        // is highlighted by weight, not hue — see captions/layout.ts for why
        // 02 §2.2's literal reading loses against 01 §8.
        const look = captionWordAppearance(state, emphasis);
        const size = TYPE_SCALE[look.sizeToken] * width;
        return (
          <span
            key={`${word.word}-${word.startMs}`}
            style={{
              display: "inline-block",
              fontFamily: "Georgia, 'Times New Roman', serif",
              fontWeight: 700,
              textTransform: "uppercase",
              fontSize: size,
              lineHeight: LINE_HEIGHT,
              color: look.colorRole === "accent" ? ACCENT : "#FFFFFF",
              opacity: state === "pending" ? 0 : enter * look.opacity,
              transform: `scale(${0.82 + 0.18 * (local < 0 ? 0 : enter)})`,
            }}
          >
            {word.word}
          </span>
        );
      })}
    </div>
  );
};

/** Layer 1 — the persistent hook banner (02 §2.1). Springs in over the first
 *  12 frames, then holds for the whole reel: it is the scroll-stopper. Only
 *  one word is coloured — "two coloured words halves the emphasis". */
const BannerLayer: React.FC<{ banner: Banner; width: number; fps: number }> = ({ banner, width, fps }) => {
  const frame = useCurrentFrame();
  const enter = spring({ frame, fps, config: SPRINGS.pop, durationInFrames: SPRING_FRAMES.popEnter });
  const anchor = banner.anchor ?? BANNER_ANCHOR;
  const tokens = banner.text.split(/\s+/).filter(Boolean);
  return (
    <div
      style={{
        ...anchorStyle(anchor, width),
        opacity: enter,
        transform: `translateY(-50%) scale(${0.9 + 0.1 * enter})`,
        fontFamily: "'Arial Narrow', 'Helvetica Neue', Impact, sans-serif",
        fontWeight: 900,
        textTransform: "uppercase",
        fontSize: TYPE_SCALE.banner * width,
        letterSpacing: "0.01em",
        lineHeight: LINE_HEIGHT,
        color: "#FFFFFF",
      }}
    >
      {tokens.map((token, i) => (
        <span key={`${token}-${i}`} style={{ color: i === banner.emphasisWordIndex ? ACCENT : "#FFFFFF" }}>
          {token}
          {i < tokens.length - 1 ? " " : ""}
        </span>
      ))}
    </div>
  );
};

/** Layer 3 — handle / brand bug (02 §2.3). Alternates corners across shots:
 *  a static bug reads as a watermark, an alternating one reads as design. */
const HandleLayer: React.FC<{ handle: Handle; shotIndex: number; width: number }> = ({ handle, shotIndex, width }) => {
  const corner = handle.cornerByShot[shotIndex % handle.cornerByShot.length] ?? "upper_right";
  const anchor = handleAnchor(corner);
  return (
    <div
      style={{
        ...anchorStyle(anchor, width),
        opacity: handle.opacity,
        fontFamily: "Helvetica, Arial, sans-serif",
        fontWeight: 600,
        fontSize: TYPE_SCALE.handle * width,
        letterSpacing: "0.08em",
        color: "#FFFFFF",
      }}
    >
      {handle.text}
    </div>
  );
};

export const Reel: React.FC<ReelProps> = ({ plan, footageSrc }) => {
  const { fps, width } = useVideoConfig();
  const src = footageSrc.startsWith("http") || footageSrc.startsWith("/") ? footageSrc : staticFile(footageSrc);
  const grade = `contrast(${plan.grade.contrast}) saturate(${plan.grade.saturation}) sepia(${Math.max(0, Math.min(1, plan.grade.warmTint))})`;

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      {/* Footage + per-shot micro-motion. One uniform grade for the whole
          reel (02 §6: "Do not grade per-shot"). */}
      <AbsoluteFill style={{ filter: grade }}>
        {plan.cuts.map((cut, shotIndex) => {
          const startFrame = Math.round((cut.outputStartMs / 1000) * fps);
          const endFrame = Math.round((cut.outputEndMs / 1000) * fps);
          const frames = Math.max(1, endFrame - startFrame);
          return (
            <Sequence key={cut.id} from={startFrame} durationInFrames={frames}>
              <Shot cut={cut} src={src} motion={cut.motion} fps={fps} frames={frames} />
            </Sequence>
          );
        })}
      </AbsoluteFill>

      {plan.scrim === "always" ? <AbsoluteFill style={{ backgroundColor: "rgba(0,0,0,0.35)" }} /> : null}

      {/* Three caption layers, three independent clocks (01 §4). */}
      {plan.banner ? <BannerLayer banner={plan.banner} width={width} fps={fps} /> : null}

      {plan.captions.map((chunk, i) => {
        const startMs = chunk.startMs ?? chunk.words[0]!.startMs;
        const endMs = chunk.endMs ?? chunk.words[chunk.words.length - 1]!.endMs;
        const from = Math.round((startMs / 1000) * fps);
        const frames = Math.max(1, Math.round((endMs / 1000) * fps) - from);
        return (
          <Sequence key={`cap-${i}`} from={from} durationInFrames={frames}>
            <CaptionChunkLayer chunk={chunk} width={width} fps={fps} />
          </Sequence>
        );
      })}

      {plan.handle
        ? plan.cuts.map((cut, shotIndex) => {
            const from = Math.round((cut.outputStartMs / 1000) * fps);
            const frames = Math.max(1, Math.round((cut.outputEndMs / 1000) * fps) - from);
            return (
              <Sequence key={`handle-${cut.id}`} from={from} durationInFrames={frames}>
                <HandleLayer handle={plan.handle!} shotIndex={shotIndex} width={width} />
              </Sequence>
            );
          })
        : null}
    </AbsoluteFill>
  );
};
