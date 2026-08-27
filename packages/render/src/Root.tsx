import React from "react";
import { Composition } from "remotion";
import { Reel, type ReelProps } from "./compositions/Reel.js";
import { RenderPlanSchema, type RenderPlan } from "./plan.js";

/** A minimal, schema-valid default plan — only used by the Remotion Studio
 *  preview and smoke renders; real renders always pass a persisted
 *  `RenderPlan` row as props (G13: same plan + footage ⇒ same output). */
const DEFAULT_PLAN: RenderPlan = RenderPlanSchema.parse({
  planVersion: "1",
  seed: 0,
  fps: 30,
  width: 1080,
  height: 1920,
  durationInFrames: 150,
  framing: "letterbox",
  footage: { assetId: "preview", r2Key: "preview" },
  cuts: [{ id: "c0", sourceInMs: 0, sourceOutMs: 5000, outputStartMs: 0, outputEndMs: 5000 }],
  captions: [],
  beatGrid: { method: "constant_grid", tempoBpm: null, beatTimesMs: [], gridQuality: null },
  music: null,
  grade: { contrast: 1.08, saturation: 1.06, warmTint: 0.1 },
});

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="Reel"
      component={Reel}
      durationInFrames={DEFAULT_PLAN.durationInFrames}
      fps={DEFAULT_PLAN.fps}
      width={DEFAULT_PLAN.width}
      height={DEFAULT_PLAN.height}
      defaultProps={{ plan: DEFAULT_PLAN, footageSrc: "preview.mp4" } satisfies ReelProps}
      calculateMetadata={async ({ props }) => ({
        durationInFrames: props.plan.durationInFrames,
        fps: props.plan.fps,
        width: props.plan.width,
        height: props.plan.height,
      })}
    />
  );
};
