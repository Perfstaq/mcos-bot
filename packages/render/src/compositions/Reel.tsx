import React from "react";
import {
  AbsoluteFill,
  OffthreadVideo,
  Sequence,
  continueRender,
  delayRender,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import {
  BANNER_ANCHOR,
  CONTENT_REGION_RATIO,
  DROP_SHADOW,
  LINE_HEIGHT,
  TYPE_SCALE,
  anchorFor,
  captionWordAppearance,
  handleAnchor,
  textBoxBounds,
  type WordVisualState,
} from "../captions/layout.js";
import { embeddedFamilies, fontFaceCss } from "../fonts/index.js";
import { SPRINGS, SPRING_FRAMES } from "../motion/springs.js";
import type {
  Anchor,
  Banner,
  CaptionChunk,
  Cut,
  Handle,
  RenderPlan,
  ShotMotion,
  TemplateStyle,
} from "../plan.js";

/**
 * Reel.tsx — the composition shell (03_RENDER_PIPELINE §4, ARCHITECTURE §1.1).
 *
 * Ported shape from founder-journey's `Reel.tsx`: `<Sequence>` per span,
 * `<OffthreadVideo>`, plan-as-props, imports limited to react + remotion +
 * relative modules. Every entrance/overlay/broll/evidence branch is gone per
 * ADR-4 — the 44 `ENTER_VALUES` entrances, the Giphy overlay, the Pexels
 * b-roll, the 8 SFX kinds, the accent system. None of it can come back
 * quietly: the plan schema has no field for any of it, so a template
 * physically cannot reach for an effect that does not exist in the contract.
 * That is ADR-4's "absence in the contract, not a lint rule" and it is worth
 * more than a comment saying not to.
 *
 * **Plan-as-props is the rule here, not a preference.** Nothing below computes
 * a timing, a scale, a position or a font size: the planner, the caption
 * engine and the template resolver decided all of it and it arrived on
 * `plan`. That is what makes a render reproducible (G13) and what lets every
 * gate be scored from the plan alone (§12.6). `Math.random()` and `Date.now()`
 * are absent for the same reason — and so is any lookup into the template
 * registry, because a plan must render the same way after someone edits a
 * constant in `templates/index.ts`.
 */

export type ReelProps = {
  plan: RenderPlan;
  footageSrc: string;
};

const ACCENT = "#FF7A1A";
const textShadow = `0 ${DROP_SHADOW.offsetPx}px ${DROP_SHADOW.blurPx}px ${DROP_SHADOW.color}`;

/**
 * The look a plan renders with when it carries no `templateStyle` — plans
 * written before the template registry landed, and the Studio preview. It is
 * the reference's own combination (01 §4: condensed banner, serif karaoke),
 * so an un-templated plan degrades to T1's typography rather than to
 * whatever the host happens to have installed.
 */
function fallbackStyle(width: number): TemplateStyle {
  return {
    templateId: "unstyled",
    templateVersion: 1,
    fonts: {
      banner: `"Bebas Neue", "Arial Narrow", Impact, sans-serif`,
      karaoke: `"Playfair Display", Georgia, serif`,
      handle: `"Inter", Helvetica, Arial, sans-serif`,
    },
    fontTokens: { banner: "display_condensed", karaoke: "display_serif", handle: "body_sans" },
    sizes: {
      banner: TYPE_SCALE.banner * width,
      karaoke: TYPE_SCALE.karaoke * width,
      emphasis: TYPE_SCALE.emphasis * width,
      handle: TYPE_SCALE.handle * width,
    },
    tracking: { banner: 0.01, karaoke: 0, handle: 0.08 },
    bannerLines: 1,
    punchScale: 0.06,
    content: { regionRatio: CONTENT_REGION_RATIO, cropX: 0.5, cropY: 0.5 },
  };
}

/**
 * Embedded fonts, injected as a `<style>` and then WAITED FOR.
 *
 * The wait is the whole point. Remotion captures frames as fast as the page
 * can paint, and a face that has not finished decoding when frame 0 is taken
 * renders in the fallback — silently, and only on some runs, which is the
 * worst kind of non-determinism to debug. `delayRender`/`continueRender`
 * around `document.fonts.load` makes the renderer wait for exactly the
 * families we embedded. A `data:` URL cannot hang on a network, so unlike a
 * fetched font this can never stall the render past a decode.
 */
const EmbeddedFonts: React.FC = () => {
  const [handle] = React.useState(() => delayRender("embedded fonts decoding"));

  React.useEffect(() => {
    let cancelled = false;
    const families = embeddedFamilies();
    Promise.all(families.map((f) => document.fonts.load(`1em "${f}"`)))
      .catch(() => undefined) // a failed decode falls back; it must not wedge the render
      .then(() => {
        if (!cancelled) continueRender(handle);
      });
    return () => {
      cancelled = true;
      continueRender(handle);
    };
  }, [handle]);

  return <style dangerouslySetInnerHTML={{ __html: fontFaceCss() }} />;
};

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
 * The emphasis punch (02 §4.2): "+6% over 8 frames with SPRINGS.punch, settle
 * over 14 frames", landing on the emphasis word's onset. Additive on top of
 * the shot's drift scale, so micro-motion (and G7, which is scored off the
 * shot's declared from/to scales) is untouched.
 *
 * Returns a multiplier, not a scale: the caller composes it with drift.
 */
function punchMultiplier(frame: number, onsetFrame: number | null, fps: number, depth: number): number {
  if (onsetFrame === null || depth <= 0) return 1;
  const local = frame - onsetFrame;
  if (local < 0) return 1;
  const attack = spring({
    frame: local,
    fps,
    config: SPRINGS.punch,
    durationInFrames: SPRING_FRAMES.punchAttack,
  });
  const settleLocal = local - SPRING_FRAMES.punchAttack;
  const settle =
    settleLocal <= 0
      ? 0
      : spring({
          frame: settleLocal,
          fps,
          config: SPRINGS.punch,
          durationInFrames: SPRING_FRAMES.punchSettle,
        });
  // Up on the attack, back down on the settle — a punch, not a step.
  return 1 + depth * (attack - settle);
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
 *
 * **Framing is letterbox and only letterbox** (§11.1 R2), but NOT by scaling
 * to width. That was the original reading of `01 §7` and it was wrong twice
 * over: §12.4 measured the reference's content region at ≈0.9:1 rather than
 * 16:9, and §12.16 established that the difference is the whole ballgame — a
 * width-fit puts video in 31.6% of frame height against the reference's
 * 62.5%, halving the subject and turning two-thirds of the frame into bars.
 * The footage now COVERS a 0.625 content region and is cropped at the sides,
 * which is what the reference does.
 *
 * R2's conclusion still holds — no face detection in v1 — but its stated
 * reason ("captions in the bars structurally cannot occlude a face") was
 * falsified by a rendered frame with a caption across a subject's mouth
 * (§12.16). What actually keeps captions clear of faces is that the content
 * region is large enough to have room below the chin, plus static per-template
 * crop offsets, which locked-off interview footage does not need a tracker for.
 *
 * `fill` remains deferred to v2 with MediaPipe face boxes, and the two must
 * land together, so this refuses it loudly rather than rendering something
 * plausible and wrong.
 */
const Shot: React.FC<{
  cut: Cut;
  src: string;
  motion: ShotMotion | undefined;
  fps: number;
  frames: number;
  punch: number;
  content: TemplateStyle["content"];
  height: number;
}> = ({ cut, src, motion, fps, frames, punch, content, height }) => {
  const frame = useCurrentFrame();
  const progress = motion
    ? spring({ frame, fps, config: SPRINGS[motion.spring], durationInFrames: motion.durationInFrames })
    : 0;
  const driftScale = motion ? motion.fromScale + (motion.toScale - motion.fromScale) * progress : 1;
  const scale = driftScale * punch;
  const origin = motion ? `${motion.originX * 100}% ${motion.originY * 100}%` : "50% 50%";

  const regionHeight = height * content.regionRatio;
  const regionTop = (height - regionHeight) / 2;

  // The content region: a fixed box the footage COVERS and overflows, rather
  // than a full-width fit that leaves the video occupying a third of the
  // frame (§12.16). `object-fit: cover` + `object-position` does the zoom and
  // the side crop without the composition needing the source's dimensions —
  // which matters because the plan does not carry them and a component that
  // measured its own source would stop being a pure plan-consumer.
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
        <div style={{ transform: `scale(${scale})`, transformOrigin: origin, width: "100%", height: "100%" }}>
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
 * Layer 2 — karaoke word captions (02 §2.2). Each word enters on its own
 * speech onset with SPRINGS.pop from `scale 0.82, opacity 0`, and recedes in
 * opacity once spoken. At most three words are ever on screen because the
 * chunker guarantees it (G5).
 *
 * The active word is highlighted by opacity, NOT by hue: accent belongs to
 * the single emphasis word (§12.9). 02 §2.2 asks for accent on the active
 * word too, but that makes an orange word ambiguous between "the payload of
 * the approved claim" and "the speaker is mid-sentence" — and on a one-word
 * chunk the active word is orange for its whole life on screen, which is how
 * a deliberately un-emphasised stopword ("IT") read as emphasised.
 */
const CaptionChunkLayer: React.FC<{
  chunk: CaptionChunk;
  width: number;
  fps: number;
  style: TemplateStyle;
}> = ({ chunk, width, fps, style }) => {
  const frame = useCurrentFrame();
  const anchor = chunk.anchor ?? anchorFor("center_low");
  const chunkStart = chunk.startMs ?? chunk.words[0]!.startMs;
  const gap = width * 0.02;

  return (
    <div
      style={{
        ...anchorStyle(anchor, width),
        display: "flex",
        gap,
        justifyContent: anchor.align === "left" ? "flex-start" : "center",
        flexWrap: "wrap",
      }}
    >
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
        const look = captionWordAppearance(state, emphasis);
        const size = look.sizeToken === "emphasis" ? style.sizes.emphasis : style.sizes.karaoke;
        return (
          <span
            key={`${word.word}-${word.startMs}`}
            style={{
              display: "inline-block",
              fontFamily: style.fonts.karaoke,
              fontWeight: 700,
              textTransform: "uppercase",
              fontSize: size,
              letterSpacing: `${style.tracking.karaoke}em`,
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
 *  one word is coloured — "two coloured words halves the emphasis".
 *
 *  `whiteSpace: nowrap` is not a style choice, it is the enforcement of the
 *  wrap assertion. `resolveTemplateStyle` proved this hook fits on
 *  `style.bannerLines` line(s) against the real font metrics; if a hook ever
 *  reaches the composition unmeasured, it overflows visibly rather than
 *  quietly wrapping into G9's carve-out at ~6.3% (ARCHITECTURE §12.11). A
 *  visible failure is the point. */
const BannerLayer: React.FC<{ banner: Banner; width: number; fps: number; style: TemplateStyle }> = ({
  banner,
  width,
  fps,
  style,
}) => {
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

/** Layer 3 — handle / brand bug (02 §2.3). Alternates corners across shots:
 *  a static bug reads as a watermark, an alternating one reads as design. */
const HandleLayer: React.FC<{
  handle: Handle;
  shotIndex: number;
  width: number;
  style: TemplateStyle;
}> = ({ handle, shotIndex, width, style }) => {
  const corner = handle.cornerByShot[shotIndex % handle.cornerByShot.length] ?? "upper_right";
  const anchor = handleAnchor(corner);
  return (
    <div
      style={{
        ...anchorStyle(anchor, width),
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
};

export const Reel: React.FC<ReelProps> = ({ plan, footageSrc }) => {
  const { fps, width, height } = useVideoConfig();
  const src = footageSrc.startsWith("http") || footageSrc.startsWith("/") ? footageSrc : staticFile(footageSrc);
  const style = plan.templateStyle ?? fallbackStyle(width);

  if (plan.framing !== "letterbox") {
    // §11.1 R2: v1 ships letterbox only, because that is what removes the need
    // for face detection. `fill` without face boxes puts captions over faces.
    throw new Error(
      `framing "${plan.framing}" is not renderable in v1 — letterbox only (ARCHITECTURE §11.1 R2; ` +
        `\`fill\` ships with MediaPipe face boxes in v2, and the two must land together)`,
    );
  }

  // 02 §6: one look per reel, applied globally. "Do not grade per-shot."
  const grade = `contrast(${plan.grade.contrast}) saturate(${plan.grade.saturation})`;
  const vignette = plan.grade.vignette ?? 0;

  // The emphasis onset for each shot: the first emphasised word that starts
  // inside it. Read off the plan — the scorer already decided which word, and
  // 02 §4.2 says the punch lands on that word's onset.
  const punchOnsetMsByShot = plan.cuts.map((cut) => {
    for (const chunk of plan.captions) {
      if (chunk.emphasisWordIndex === null) continue;
      const word = chunk.words[chunk.emphasisWordIndex];
      if (!word) continue;
      if (word.startMs >= cut.outputStartMs && word.startMs < cut.outputEndMs) return word.startMs;
    }
    return null;
  });

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      <EmbeddedFonts />

      {/* Footage + per-shot micro-motion, under one uniform grade. */}
      <AbsoluteFill style={{ filter: grade }}>
        {plan.cuts.map((cut, shotIndex) => {
          const startFrame = Math.round((cut.outputStartMs / 1000) * fps);
          const endFrame = Math.round((cut.outputEndMs / 1000) * fps);
          const frames = Math.max(1, endFrame - startFrame);
          const onsetMs = punchOnsetMsByShot[shotIndex] ?? null;
          const onsetFrame = onsetMs === null ? null : Math.round(((onsetMs - cut.outputStartMs) / 1000) * fps);
          return (
            <Sequence key={cut.id} from={startFrame} durationInFrames={frames}>
              <PunchedShot
                cut={cut}
                src={src}
                motion={cut.motion}
                fps={fps}
                frames={frames}
                onsetFrame={onsetFrame}
                depth={style.punchScale}
                content={style.content}
                height={height}
              />
            </Sequence>
          );
        })}
      </AbsoluteFill>

      {/* 02 §6's "slight vignette (0.12)". A grade, not decoration — 01 §6
          measures the reference as deliberately graded, and a vignette is how
          crushed corners read on a flat panel. */}
      {vignette > 0 ? (
        <AbsoluteFill
          style={{
            background: `radial-gradient(ellipse at 50% 50%, rgba(0,0,0,0) 45%, rgba(0,0,0,${vignette}) 100%)`,
            pointerEvents: "none",
          }}
        />
      ) : null}

      {/* 02 §6's warm shift, as an overlay rather than a `sepia()` filter:
          sepia desaturates the whole frame toward brown, which is a different
          look from warming the highlights and is not what 01 §6 measured
          ("warm-shadow … saturated reds", not "monochrome brown"). */}
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

      {plan.scrim === "always" ? <AbsoluteFill style={{ backgroundColor: "rgba(0,0,0,0.35)" }} /> : null}

      {/* Three caption layers, three independent clocks (01 §4). */}
      {plan.banner ? <BannerLayer banner={plan.banner} width={width} fps={fps} style={style} /> : null}

      {plan.captions.map((chunk, i) => {
        const startMs = chunk.startMs ?? chunk.words[0]!.startMs;
        const endMs = chunk.endMs ?? chunk.words[chunk.words.length - 1]!.endMs;
        const from = Math.round((startMs / 1000) * fps);
        const frames = Math.max(1, Math.round((endMs / 1000) * fps) - from);
        return (
          <Sequence key={`cap-${i}`} from={from} durationInFrames={frames}>
            <CaptionChunkLayer chunk={chunk} width={width} fps={fps} style={style} />
          </Sequence>
        );
      })}

      {plan.handle
        ? plan.cuts.map((cut, shotIndex) => {
            const from = Math.round((cut.outputStartMs / 1000) * fps);
            const frames = Math.max(1, Math.round((cut.outputEndMs / 1000) * fps) - from);
            return (
              <Sequence key={`handle-${cut.id}`} from={from} durationInFrames={frames}>
                <HandleLayer handle={plan.handle!} shotIndex={shotIndex} width={width} style={style} />
              </Sequence>
            );
          })
        : null}
    </AbsoluteFill>
  );
};

/** Splits the punch's frame-local clock out of `Reel` so the hook order stays
 *  stable — `useCurrentFrame` inside a `<Sequence>` is shot-relative, which is
 *  exactly the clock 02 §4.2's onset is expressed against. */
const PunchedShot: React.FC<{
  cut: Cut;
  src: string;
  motion: ShotMotion | undefined;
  fps: number;
  frames: number;
  onsetFrame: number | null;
  depth: number;
  content: TemplateStyle["content"];
  height: number;
}> = ({ cut, src, motion, fps, frames, onsetFrame, depth, content, height }) => {
  const frame = useCurrentFrame();
  const punch = punchMultiplier(frame, onsetFrame, fps, depth);
  return (
    <Shot cut={cut} src={src} motion={motion} fps={fps} frames={frames} punch={punch} content={content} height={height} />
  );
};
