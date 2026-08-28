import { describe, expect, it } from "vitest";
import { RenderPlanSchema, type RenderPlan } from "@mcos/render/plan";
import {
  gateG1a,
  gateG1b,
  gateG2,
  gateG3,
  gateG4,
  gateG5,
  gateG6,
  gateG8,
  gateG10,
  gateG13,
  gateG14,
  parseIntegratedLufs,
  rollUpQc,
} from "../../../scripts/qc-render.js";

/**
 * scripts/qc-render.ts lives outside apps/api (07_QUALITY_GATES §1: it's a
 * standalone CLI, invoked by jobs/render-qc.ts the same way media-analyze.ts
 * shells to the Python sidecar) — this test reaches across that boundary by
 * relative import, same as any other TS file vitest transpiles on demand.
 * Only the pure, plan-introspection gate functions are unit-tested here;
 * G1b/G11/G12 need a real MP4 + ffmpeg/PySceneDetect and are exercised
 * manually (see the PR body for the worked example and its output).
 */

function plan(overrides: Partial<RenderPlan> = {}): RenderPlan {
  return RenderPlanSchema.parse({
    planVersion: "1",
    seed: 1,
    fps: 30,
    width: 1080,
    height: 1920,
    durationInFrames: 180,
    framing: "letterbox",
    footage: { assetId: "a", r2Key: "k" },
    cuts: [
      { id: "c0", sourceInMs: 0, sourceOutMs: 2000, outputStartMs: 0, outputEndMs: 2000 },
      { id: "c1", sourceInMs: 2000, sourceOutMs: 4000, outputStartMs: 2000, outputEndMs: 4000 },
      { id: "c2", sourceInMs: 4000, sourceOutMs: 6000, outputStartMs: 4000, outputEndMs: 6000 },
    ],
    captions: [
      { words: [{ word: "A", startMs: 0, endMs: 300 }], position: "center", emphasisWordIndex: null },
      { words: [{ word: "B", startMs: 2000, endMs: 2300 }], position: "lower-left", emphasisWordIndex: 0 },
      { words: [{ word: "C", startMs: 4000, endMs: 4300 }], position: "center-low", emphasisWordIndex: null },
    ],
    beatGrid: { method: "beat_track", tempoBpm: 60, beatTimesMs: [0, 1000, 2000, 3000, 4000, 5000, 6000], gridQuality: 3.0 },
    music: null,
    grade: { contrast: 1.08, saturation: 1.06, warmTint: 0.1 },
    ...overrides,
  });
}

describe("G1a — musical intent", () => {
  it("passes when every cut lands on a beat", () => {
    const g = gateG1a(plan());
    expect(g.pass).toBe(true);
    expect((g.measured as { ratio: number }).ratio).toBe(1);
  });

  it("fails when a cut drifts >150ms from the nearest beat", () => {
    const p = plan();
    p.cuts[1]!.outputStartMs = 2300; // 300ms from the 2000/3000 beats
    const g = gateG1a(p);
    expect(g.pass).toBe(false);
  });

  it("auto-fails a constant_grid plan — it can never pass G1a for merge evidence", () => {
    const p = plan({ beatGrid: { method: "constant_grid", tempoBpm: 112, beatTimesMs: [0, 500], gridQuality: null } });
    expect(gateG1a(p).pass).toBe(false);
  });

  it("fails when grid_quality is too far below the reference calibration, even if timing lines up", () => {
    const p = plan();
    p.beatGrid.gridQuality = 0.1; // far below 80% of the reference's 2.2003
    expect(gateG1a(p).pass).toBe(false);
  });
});

/**
 * A plan that REMOVES footage: each shot's source span does not continue where
 * the previous one ended, so output time ≠ source time and the boundaries are
 * real content discontinuities a scene detector can find. Same output timeline
 * as `plan()` — only the source spans differ — so the two fixtures isolate
 * exactly the property G1b's applicability turns on.
 */
function removalPlan(): RenderPlan {
  return plan({
    cuts: [
      { id: "c0", sourceInMs: 0, sourceOutMs: 2000, outputStartMs: 0, outputEndMs: 2000 },
      { id: "c1", sourceInMs: 9000, sourceOutMs: 11000, outputStartMs: 2000, outputEndMs: 4000 },
      { id: "c2", sourceInMs: 20000, sourceOutMs: 22000, outputStartMs: 4000, outputEndMs: 6000 },
    ],
  });
}

describe("G1b — render fidelity, scored only where it is applicable (ARCHITECTURE §12.37)", () => {
  it("returns not-applicable — NOT a failure — for a continuous playthrough", () => {
    // §12.3: a scene detector finds content DISCONTINUITIES, and a plan that
    // plays footage continuously and only changes framing has none to find.
    // The old behaviour scored this 2/29 and reported a hard red on every
    // template; a permanently red gate is a dead gate.
    const g = gateG1b(plan(), [2010, 4030]);

    expect(g.pass).toBeNull();
    expect(g.computable).toBe(false);
    expect(g.notApplicable).toEqual({
      code: "continuous_playback_no_discontinuities",
      see: "ARCHITECTURE §12.3, §12.13",
    });
  });

  it("is distinguishable from a gate that genuinely passed", () => {
    const excluded = gateG1b(plan(), [2010, 4030]);
    const scored = gateG1b(removalPlan(), [2010, 4030]);

    expect(scored.pass).toBe(true);
    expect(scored.notApplicable).toBeUndefined();
    // Same gate id, same detected cuts, opposite verdicts — the difference is
    // the plan, which is the whole point.
    expect(excluded.pass).not.toBe(scored.pass);
  });

  it("carries the evidence for the exclusion, so it is never a bare assertion", () => {
    const g = gateG1b(plan(), [2010, 4030]);
    const measured = g.measured as { removesFootage: boolean; planCuts: number; detectedCuts: number };
    expect(measured.removesFootage).toBe(false);
    expect(measured.planCuts).toBe(2);
    expect(measured.detectedCuts).toBe(2);
    expect(g.note).toMatch(/continuous/i);
  });

  it("still SCORES a plan that removes footage — the exclusion is derived, not hardcoded", () => {
    // The day 03 §6's selection stage ships, G1b starts measuring again with
    // no code change. This is that assertion.
    const g = gateG1b(removalPlan(), [2010, 4030]);
    expect(g.notApplicable).toBeUndefined();
    expect(g.computable).toBe(true);
    expect(g.pass).toBe(true);
  });

  it("fails a removal plan when fewer than 90% of its cuts have a matching detected cut", () => {
    const g = gateG1b(removalPlan(), [2010]); // only 1 of 2 cuts matched
    expect(g.pass).toBe(false);
    expect(g.notApplicable).toBeUndefined();
  });

  it("reports the informational pixel beat-lock ratio without gating on it", () => {
    // Detected cuts intentionally far from both plan cuts AND the beat grid —
    // matchedRatio fails, but the gate must still report the informational
    // number rather than omitting it.
    const g = gateG1b(removalPlan(), [2010, 4030, 5900]);
    const measured = g.measured as { informationalPixelBeatLockRatio: number | null };
    expect(measured.informationalPixelBeatLockRatio).not.toBeNull();
  });

  it("treats a one-millisecond source gap as rounding, not as a removal", () => {
    // The same tolerance `assertOutputTimeGrid` uses: a real removal is orders
    // of magnitude larger than ms-rounding at a span boundary.
    const p = plan();
    p.cuts[1]!.sourceInMs = 2001;
    expect(gateG1b(p, [2010, 4030]).notApplicable).not.toBeUndefined();
  });
});

describe("the QC rollup — an excluded gate is visibly excluded, never silently dropped", () => {
  it("does not let a not-applicable hard gate turn the report red", () => {
    const gates = [gateG1a(plan()), gateG1b(plan(), [2010, 4030])];
    const roll = rollUpQc(gates);

    expect(roll.overallPass).toBe(true);
    expect(roll.excludedGates).toEqual([
      { id: "G1b", code: "continuous_playback_no_discontinuities", see: "ARCHITECTURE §12.3, §12.13" },
    ]);
  });

  it("still fails the report when an APPLICABLE hard gate fails", () => {
    const roll = rollUpQc([gateG1a(plan()), gateG1b(removalPlan(), [2010])]);
    expect(roll.overallPass).toBe(false);
    expect(roll.excludedGates).toEqual([]);
  });

  it("does not count a not-applicable gate toward the scored total", () => {
    const roll = rollUpQc([gateG1a(plan()), gateG1b(plan(), [2010, 4030])]);
    expect(roll.scored).toBe(1);
  });

  it("excludes a not-applicable gate even if it were also marked computable", () => {
    // Belt and braces on purpose: the rollup must not depend on `computable`
    // and `notApplicable` agreeing. If a later gate sets one and not the
    // other, a hard gate must not silently rejoin the pass set.
    const g = { ...gateG1b(plan(), [2010, 4030]), computable: true, pass: false as boolean | null };
    expect(rollUpQc([g]).overallPass).toBe(true);
  });
});

describe("plan-introspection gates", () => {
  it("G2 cut density — 2 real cuts in 6s (t=0 isn't a cut, ADR-8) is 20/min, below 25-40", () => {
    const g = gateG2(plan());
    expect(g.measured).toBe(20);
    expect(g.pass).toBe(false);
  });

  it("G3/G4 shot length — three 2s shots: median 2.0s (pass), min 2.0s (pass)", () => {
    expect(gateG3(plan()).pass).toBe(true);
    expect(gateG4(plan()).pass).toBe(true);
  });

  it("G4 fails a shot under 0.6s", () => {
    const p = plan();
    p.cuts[0]!.outputEndMs = 300;
    p.cuts[1]!.outputStartMs = 300;
    expect(gateG4(p).pass).toBe(false);
  });

  it("G5 caption density passes at ≤3 words (schema already caps it, this recomputes anyway)", () => {
    expect(gateG5(plan()).pass).toBe(true);
  });

  it("G6 position variance — 3 distinct positions passes; collapsing to 1 fails", () => {
    expect(gateG6(plan()).pass).toBe(true);
    const p = plan();
    for (const c of p.captions) c.position = "center";
    expect(gateG6(p).pass).toBe(false);
  });

  it("G8 emphasis — flags an out-of-range emphasis index", () => {
    const p = plan();
    p.captions[0]!.emphasisWordIndex = 5; // chunk only has 1 word
    expect(gateG8(p).pass).toBe(false);
  });
});

describe("G10 — word integrity", () => {
  it("is not computable without a words file — never silently true", () => {
    const g = gateG10(plan(), null);
    expect(g.computable).toBe(false);
    expect(g.pass).toBeNull();
  });

  it("passes when every cut boundary falls in a gap between words", () => {
    const words = { segments: [{ words: [{ word: "x", start: 0, end: 0.5 }, { word: "y", start: 4.5, end: 5 }] }] };
    expect(gateG10(plan(), words).pass).toBe(true);
  });

  it("fails when a cut boundary lands strictly inside a word", () => {
    const words = { segments: [{ words: [{ word: "x", start: 1.5, end: 2.5 }] }] }; // engulfs the 2000ms cut
    const g = gateG10(plan(), words);
    expect(g.pass).toBe(false);
    expect((g.measured as { violations: number }).violations).toBeGreaterThan(0);
  });
});

describe("G13/G14", () => {
  it("G13 is informational (pass: null) with no prior checksum to compare", () => {
    // sha256File reads a real path — use this test file itself, contents don't matter.
    const g = gateG13(new URL(import.meta.url).pathname);
    expect(g.pass).toBeNull();
    expect((g.measured as { checksum: string }).checksum).toMatch(/^sha256:/);
  });

  it("G14 is not computable without a contentBriefId (Agent B's model doesn't exist yet)", () => {
    expect(gateG14(undefined).computable).toBe(false);
  });

  it("G14 passes on a non-empty contentBriefId", () => {
    expect(gateG14("brief-123").pass).toBe(true);
  });
});

describe("parseIntegratedLufs", () => {
  it("parses ffmpeg's ebur128 summary block", () => {
    const sample = "  Integrated loudness:\n    I:         -21.9 LUFS\n    Threshold: -31.9 LUFS\n";
    expect(parseIntegratedLufs(sample)).toBe(-21.9);
  });

  it("returns null on unparseable output rather than a fabricated number", () => {
    expect(parseIntegratedLufs("no loudness info here")).toBeNull();
  });
});
