import React from "react";
import { AbsoluteFill, OffthreadVideo, Sequence, staticFile } from "remotion";
import type { RenderPlan } from "../plan.js";

/**
 * Reel.tsx — scaffold shell.
 *
 * Plan-as-props (03_RENDER_PIPELINE §4): every timing value below comes from
 * `plan`, nothing is computed here. `<Sequence>` per cut, `<OffthreadVideo>`
 * for footage — the same shape 03 §4 and the ported founder-journey
 * `Reel.tsx` shell use (ARCHITECTURE.md §1.1). This scaffold intentionally
 * stops there: no motion (Agent M), no captions (Agent M), no grade filter
 * chain, no music/ducking. Agent T owns fleshing this out into the real
 * shell per ADR-4 (hard cuts only — no entrance/overlay/broll/sfx branches
 * ever get added back).
 *
 * `footageSrc` is a `staticFile`-relative path (dev/CI local renderer,
 * ADR-7) or a presigned URL passed straight through as a prop — the
 * composition does not know or care which; that decision belongs to
 * `render.submit`.
 */
export type ReelProps = {
  plan: RenderPlan;
  footageSrc: string;
};

export const Reel: React.FC<ReelProps> = ({ plan, footageSrc }) => {
  const src = footageSrc.startsWith("http") || footageSrc.startsWith("/") ? footageSrc : staticFile(footageSrc);

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      {plan.cuts.map((cut) => {
        const startFrame = Math.round((cut.outputStartMs / 1000) * plan.fps);
        const endFrame = Math.round((cut.outputEndMs / 1000) * plan.fps);
        const durationInFrames = Math.max(1, endFrame - startFrame);
        return (
          <Sequence key={cut.id} from={startFrame} durationInFrames={durationInFrames}>
            <OffthreadVideo
              src={src}
              startFrom={Math.round((cut.sourceInMs / 1000) * plan.fps)}
              endAt={Math.round((cut.sourceOutMs / 1000) * plan.fps)}
              muted={false}
            />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
