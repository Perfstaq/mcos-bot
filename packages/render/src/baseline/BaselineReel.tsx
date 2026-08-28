import React from "react";
import {
  AbsoluteFill,
  interpolate,
  OffthreadVideo,
  Sequence,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { DROP_SHADOW, LINE_HEIGHT, textBoxBounds } from "../captions/layout.js";
import { EmbeddedFonts } from "../compositions/Reel.js";
import type { Anchor, Banner, CaptionChunk, Cut, Handle, RenderPlan, TemplateStyle } from "../plan.js";
import { BASELINE_EASE_FRAMES, baselineEnvelopeKnots } from "./plan.js";

/**
 * BaselineReel.tsx — the NAIVE BASELINE composition (W4.2). **Not production.**
 *
 * The control arm of the W4.3 comparison. `compositions/Reel.tsx` is untouched
 * and this file may never be imported by it; the dependency runs one way only
 * (this file reads Reel's font loader, because a font that decodes late is a
 * non-determinism bug and not an amateurism worth simulating).
 *
 * ── What is deliberately wrong here, and what it replaces ───────────────────
 *
 *  • **`interpolate()` everywhere.** `02 §1`: "Ban `interpolate()` for any
 *    visible motion… Linear tweens are the #1 tell of generated video."
 *    `Reel.tsx` says the same in its own words — "`interpolate()` appears
 *    nowhere". This is where it belongs. Remotion's `interpolate` is linear
 *    unless handed an `easing`, and none is handed to it.
 *
 *  • **Symmetric in and out.** `02 §1` also says exits run ~40% faster than
 *    entrances (`EXIT_SPEEDUP = 0.6`). Here they are the same length, because
 *    equal-and-opposite is what you write when you are not thinking about it.
 *
 *  • **Block captions.** The whole chunk appears at once and holds. No word
 *    onsets, no `pending`/`active`/`spoken` states, no accent word, no
 *    per-word scale. `CaptionChunkLayer` in `Reel.tsx` is the thing this is
 *    the absence of.
 *
 *  • **No camera.** The shot draws at a fixed scale. There is no punch
 *    multiplier and no drift spring — the plan's `fromScale === toScale`, and
 *    the lerp below is retained only so the code path is honestly the same
 *    shape with a static input rather than the motion having been deleted.
 *
 *  • **No grade beyond identity.** The plan carries `contrast: 1`,
 *    `saturation: 1`, `warmTint: 0`, `vignette: 0`, and the same filter and
 *    overlay code applies them, to no effect. Written this way on purpose: the
 *    difference a viewer sees must come from the VALUES on the plan, not from
 *    a second renderer that also happens to differ in how it composites.
 */

export type BaselineReelProps = {
  plan: RenderPlan;
  footageSrc: string;
};

const ACCENT = "#FF7A1A";
const textShadow = `0 ${DROP_SHADOW.offsetPx}px ${DROP_SHADOW.blurPx}px ${DROP_SHADOW.color}`;

/**
 * Linear ramp in, hold, linear ramp out — the same count at both ends.
 *
 * The knots come from `baselineEnvelopeKnots` (framework-free, so a test can
 * assert the symmetry without a renderer); `interpolate` supplies the curve
 * BETWEEN them, and is linear because no `easing` is passed to it. That is the
 * whole demonstration: `02 §1` bans this call for visible motion and calls a
 * linear tween "the #1 tell of generated video".
 */
function baselineEnvelope(localFrame: number, totalFrames: number): number {
  const { input, output } = baselineEnvelopeKnots(totalFrames);
  return interpolate(localFrame, input, output, {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
}

function anchorStyle(anchor: Anchor, width: number): React.CSSProperties {
  const { left, right } = textBoxBounds(anchor, width);
  return {
    position: "absolute",
    left,
    top: `${anchor.y * 100}%`,
    transform: "translateY(-50%)",
    width: right - left,
    textAlign: anchor.align === "left" ? "left" : anchor.align === "right" ? "right" : "center",
    textShadow,
  };
}

/** One shot at a fixed scale. No spring, no punch, no reframe. */
const BaselineShot: React.FC<{
  cut: Cut;
  src: string;
  fps: number;
  frames: number;
  content: TemplateStyle["content"];
  height: number;
}> = ({ cut, src, fps, frames, content, height }) => {
  // `fromScale === toScale` on every baseline cut, so this is a constant. The
  // lerp is kept rather than hardcoding 1 so the plan remains the only source
  // of the number (plan-as-props holds even here).
  const scale = cut.motion ? cut.motion.fromScale : 1;
  const regionHeight = height * content.regionRatio;
  const regionTop = (height - regionHeight) / 2;

  return (
    <AbsoluteFill>
      <div
        style={{
          position: "absolute",
          top: regionTop,
          left: 0,
          width: "100%",
          height: regionHeight,
          overflow: "hidden",
        }}
      >
        <div style={{ transform: `scale(${scale})`, transformOrigin: "50% 50%", width: "100%", height: "100%" }}>
          <OffthreadVideo
            src={src}
            startFrom={Math.round((cut.sourceInMs / 1000) * fps)}
            endAt={Math.round((cut.sourceInMs / 1000) * fps) + frames}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              objectPosition: `${content.cropX * 100}% ${content.cropY * 100}%`,
            }}
          />
        </div>
      </div>
    </AbsoluteFill>
  );
};

/**
 * A whole sentence, on screen at once, in one place, for its whole span.
 *
 * Every word draws identically: same size, same colour, same opacity, same
 * moment. The chunk's own words still carry their ASR timings on the plan —
 * this simply does not read them, which is what "no per-word timing" means as
 * a rendering decision rather than as missing data.
 */
const BaselineCaptionBlock: React.FC<{
  chunk: CaptionChunk;
  width: number;
  frames: number;
  style: TemplateStyle;
}> = ({ chunk, width, frames, style }) => {
  const frame = useCurrentFrame();
  const anchor = chunk.anchor!;
  const opacity = baselineEnvelope(frame, frames);

  // A flex row of one span per word with `gap: width * 0.02`, wrapping —
  // structurally identical to how `Reel.tsx` lays a chunk out, and identical
  // to the model `gateG9`'s `wrapWords` measures with. That is the point: the
  // gate must be predicting THIS layout, not a different one. Rendering the
  // sentence as a single text node with ordinary spaces put the two ~10px per
  // word apart, which is enough to move a line break and therefore the block
  // height every G9 bound reads.
  //
  // It stays a BLOCK caption regardless: every word appears at once, at one
  // size, at one opacity, with no per-word timing and no accent. The spans are
  // a layout mechanism, not a reveal.
  return (
    <div
      style={{
        ...anchorStyle(anchor, width),
        display: "flex",
        gap: width * 0.02,
        justifyContent: "center",
        flexWrap: "wrap",
        opacity,
        fontFamily: style.fonts.karaoke,
        fontWeight: 700,
        textTransform: "uppercase",
        fontSize: style.sizes.karaoke,
        letterSpacing: `${style.tracking.karaoke}em`,
        lineHeight: LINE_HEIGHT,
        color: "#FFFFFF",
      }}
    >
      {chunk.words.map((w, i) => (
        <span key={`${w.word}-${i}`} style={{ display: "inline-block" }}>
          {w.word}
        </span>
      ))}
    </div>
  );
};

/** The hook banner, entering on a linear ramp instead of a pop spring. */
const BaselineBanner: React.FC<{ banner: Banner; width: number; style: TemplateStyle }> = ({
  banner,
  width,
  style,
}) => {
  const frame = useCurrentFrame();
  const enter = interpolate(frame, [0, BASELINE_EASE_FRAMES], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const anchor = banner.anchor!;
  const tokens = banner.text.split(/\s+/).filter(Boolean);
  return (
    <div
      style={{
        ...anchorStyle(anchor, width),
        opacity: enter,
        // Linear scale as well as linear opacity — no overshoot, no settle.
        transform: `translateY(-50%) scale(${0.9 + 0.1 * enter})`,
        fontFamily: style.fonts.banner,
        fontWeight: 400,
        textTransform: "uppercase",
        fontSize: style.sizes.banner,
        letterSpacing: `${style.tracking.banner}em`,
        lineHeight: LINE_HEIGHT,
        color: "#FFFFFF",
        whiteSpace: style.bannerLines === 1 ? "nowrap" : "normal",
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

/** The handle, in the one corner the plan pins it to for the whole reel. */
const BaselineHandle: React.FC<{ handle: Handle; width: number; style: TemplateStyle }> = ({
  handle,
  width,
  style,
}) => (
  <div
    style={{
      ...anchorStyle({ x: 0.78, y: 0.155, align: "center" }, width),
      opacity: handle.opacity,
      fontFamily: style.fonts.handle,
      fontWeight: 600,
      fontSize: style.sizes.handle,
      letterSpacing: `${style.tracking.handle}em`,
      color: "#FFFFFF",
    }}
  >
    {handle.text}
  </div>
);

export const BaselineReel: React.FC<BaselineReelProps> = ({ plan, footageSrc }) => {
  const { fps, width, height } = useVideoConfig();
  const src = footageSrc.startsWith("http") || footageSrc.startsWith("/") ? footageSrc : staticFile(footageSrc);
  const style = plan.templateStyle!;

  const grade = `contrast(${plan.grade.contrast}) saturate(${plan.grade.saturation})`;
  const vignette = plan.grade.vignette ?? 0;

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      <EmbeddedFonts />

      <AbsoluteFill style={{ filter: grade }}>
        {plan.cuts.map((cut) => {
          const startFrame = Math.round((cut.outputStartMs / 1000) * fps);
          const endFrame = Math.round((cut.outputEndMs / 1000) * fps);
          const frames = Math.max(1, endFrame - startFrame);
          return (
            <Sequence key={cut.id} from={startFrame} durationInFrames={frames}>
              <BaselineShot cut={cut} src={src} fps={fps} frames={frames} content={style.content} height={height} />
            </Sequence>
          );
        })}
      </AbsoluteFill>

      {vignette > 0 ? (
        <AbsoluteFill
          style={{
            background: `radial-gradient(ellipse at 50% 50%, rgba(0,0,0,0) 45%, rgba(0,0,0,${vignette}) 100%)`,
            pointerEvents: "none",
          }}
        />
      ) : null}

      {plan.grade.warmTint > 0 ? (
        <AbsoluteFill
          style={{
            backgroundColor: "#FF8A3D",
            opacity: plan.grade.warmTint,
            mixBlendMode: "soft-light",
            pointerEvents: "none",
          }}
        />
      ) : null}

      {plan.banner ? <BaselineBanner banner={plan.banner} width={width} style={style} /> : null}

      {plan.captions.map((chunk, i) => {
        const startMs = chunk.startMs ?? chunk.words[0]!.startMs;
        const endMs = chunk.endMs ?? chunk.words[chunk.words.length - 1]!.endMs;
        const from = Math.round((startMs / 1000) * fps);
        const frames = Math.max(1, Math.round((endMs / 1000) * fps) - from);
        return (
          <Sequence key={`cap-${i}`} from={from} durationInFrames={frames}>
            <BaselineCaptionBlock chunk={chunk} width={width} frames={frames} style={style} />
          </Sequence>
        );
      })}

      {plan.handle ? <BaselineHandle handle={plan.handle} width={width} style={style} /> : null}
    </AbsoluteFill>
  );
};
