import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BASELINE_CAPTION_POSITION,
  BASELINE_CUT_INTERVAL_SEC,
  BASELINE_EASE_FRAMES,
  baselineEnvelopeKnots,
  buildBaselinePlan,
  fixedIntervalBoundaries,
  splitIntoSentences,
} from "@mcos/render/baseline/plan";
import { gateG1a } from "@mcos/render/gates/g1a";
import { planDecidableGateResults, type WordsFile } from "@mcos/render/gates/plan-gates";
import { KARAOKE_MAX_WORDS_PER_CHUNK, RenderPlanSchema, planRemovesFootage } from "@mcos/render/plan";
import { describe, expect, it } from "vitest";
import { buildTemplatePlan } from "../../../scripts/studio/build-template-plan.js";

/**
 * studio-baseline.test.ts — W4.2's naive baseline, and the fence around it.
 *
 * Two jobs, and the second matters as much as the first:
 *
 *  1. **The baseline is honestly bad, and stays that way.** Every assertion
 *     below pins a way in which it is worse than the pipeline. A future change
 *     that quietly improves the control arm — snapping its cuts, splitting its
 *     captions, giving a shot a camera — breaks a test. That is the point: an
 *     agent optimising for "the comparison looks good" softens the baseline
 *     without noticing, and a softened baseline makes the comparison worthless.
 *
 *  2. **It cannot leak into production.** `render-containment.test.ts` proves
 *     the same kind of property for `remotion` and explains the reasoning: a
 *     property that must hold is checked by a test, not left as a convention.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const inputsDir = path.join(repoRoot, "docs/studio/evidence/inputs");

const WORDS = JSON.parse(fs.readFileSync(path.join(inputsDir, "talking-head-v1-words.json"), "utf8")) as {
  durationSec: number;
  segments: { words: { word: string; start: number; end: number; rms?: number | null }[] }[];
};
const BEATS = JSON.parse(fs.readFileSync(path.join(inputsDir, "talking-head-v1-beats.json"), "utf8")) as {
  method: "beat_track" | "onset_env" | "constant_grid";
  tempoBpm: number | null;
  beatTimesMs: number[];
  gridQuality: number | null;
};

/** The fixture's own container duration — the number the real chain used. */
const FIXTURE_DURATION_SEC = 59.605;
const FLAT_WORDS = WORDS.segments.flatMap((s) => s.words);
const WORDS_FILE: WordsFile = {
  segments: [{ words: FLAT_WORDS.map((w) => ({ word: w.word, start: w.start, end: w.end })) }],
};

function baselinePlan(templateId = "statement_serif") {
  return buildBaselinePlan({
    templateId,
    words: FLAT_WORDS,
    durationSec: FIXTURE_DURATION_SEC,
    beats: BEATS,
    seed: 42,
    hook: "GRAVITY IS AGEING YOU",
    emphasisWord: "AGEING",
    handleText: "@PERFSTAQ",
    footage: { assetId: "talking-head-v1-1080", r2Key: "studio/talking-head-v1-1080.mp4" },
  });
}

function gate(id: string) {
  return planDecidableGateResults(baselinePlan(), WORDS_FILE).find((g) => g.id === id)!;
}

describe("baseline cutting is fixed-interval, beat-blind and word-blind", () => {
  it("puts every boundary on an exact multiple of the interval", () => {
    const plan = baselinePlan();
    const starts = plan.cuts.map((c) => c.outputStartMs);
    for (const [i, start] of starts.entries()) {
      expect(start).toBe(Math.round(i * BASELINE_CUT_INTERVAL_SEC * 1000));
    }
  });

  /**
   * The definitive test of beat-blindness, and it had to become this.
   *
   * The obvious version — "no cut boundary coincides exactly with a beat" —
   * FAILS on this fixture: 37500ms and 52500ms are both exact beat times. That
   * is not the baseline cheating, it is the phase-lock below showing up a
   * second way, and an assertion that a coincidence cannot happen is an
   * assertion about the fixture rather than about the code.
   *
   * Replacing the grid entirely is the claim actually worth making: a plan
   * that consults the grid changes when the grid changes, and this one does
   * not move by a millisecond.
   */
  it("produces identical cuts when handed a completely different beat grid", () => {
    const withRealGrid = baselinePlan().cuts.map((c) => c.outputStartMs);
    const alien = buildBaselinePlan({
      templateId: "statement_serif",
      words: FLAT_WORDS,
      durationSec: FIXTURE_DURATION_SEC,
      beats: { method: "onset_env", tempoBpm: 71, beatTimesMs: [0, 5000, 41000], gridQuality: 9 },
      seed: 42,
      hook: "GRAVITY IS AGEING YOU",
      emphasisWord: "AGEING",
      handleText: "@PERFSTAQ",
      footage: { assetId: "talking-head-v1-1080", r2Key: "studio/talking-head-v1-1080.mp4" },
    });
    expect(alien.cuts.map((c) => c.outputStartMs)).toEqual(withRealGrid);
    // …and the alien grid is still carried on the plan verbatim, so G1a can
    // say how badly the cuts missed it.
    expect(alien.beatGrid.beatTimesMs).toEqual([0, 5000, 41000]);
  });

  it("leaves the final shot short rather than merging it — no judgement about shot length", () => {
    const b = fixedIntervalBoundaries(10, 2.5);
    expect(b).toEqual([0, 2.5, 5, 7.5, 10]);
    const ragged = fixedIntervalBoundaries(9, 2.5);
    expect(ragged[ragged.length - 1]! - ragged[ragged.length - 2]!).toBeCloseTo(1.5, 6);
  });

  it("cuts land mid-word, which is precisely what the planner exists to avoid (G10)", () => {
    const g10 = gate("G10");
    expect(g10.computable).toBe(true);
    expect(g10.pass).toBe(false);
    expect((g10.measured as { violations: number }).violations).toBeGreaterThan(0);
  });

  it("removes no footage, so G1b is n/a for the same derived reason on both arms (§12.37)", () => {
    expect(planRemovesFootage(baselinePlan())).toBe(false);
  });
});

/**
 * ARCHITECTURE §4.1 warned that G1a's margin "is inside methodology noise"; this
 * is that warning arriving from an unexpected direction. On THIS fixture the
 * beat period is ~418ms and the naive 2.5s interval is 5.98 beats — so a rule
 * that consults no grid at all lands within 150ms of one 87% of the time and
 * clears the 85% gate, while a blind cut would be expected to hit ~69% (the
 * fraction of the timeline a ±150ms window around each beat covers).
 *
 * Recorded as a test rather than a README sentence so that it is re-measured
 * rather than remembered. The neighbouring intervals are the control: if 2.5s
 * passed on musicality rather than arithmetic, 2.25s and 2.75s would be close
 * behind it, and they are not.
 */
describe("G1a does not discriminate the naive baseline on this fixture — an accidental phase-lock", () => {
  function lockRatio(intervalSec: number): number {
    const cuts: number[] = [];
    for (let t = intervalSec; t < FIXTURE_DURATION_SEC; t += intervalSec) cuts.push(Math.round(t * 1000));
    const within = cuts.filter(
      (c) => Math.min(...BEATS.beatTimesMs.map((b) => Math.abs(b - c))) <= 150,
    ).length;
    return within / cuts.length;
  }

  it("2.5s is ~6 beats at this tempo, so the beat-blind plan passes G1a", () => {
    const g1a = gateG1a(baselinePlan());
    expect(g1a.pass).toBe(true);
    expect((g1a.measured as { ratio: number }).ratio).toBeGreaterThanOrEqual(0.85);
    // The arithmetic behind it, stated rather than implied.
    const medianGapMs = 418;
    expect(BASELINE_CUT_INTERVAL_SEC * 1000).toBeGreaterThan(6 * medianGapMs - 30);
    expect(BASELINE_CUT_INTERVAL_SEC * 1000).toBeLessThan(6 * medianGapMs + 30);
    // Close enough that two boundaries land on a beat EXACTLY — the same
    // coincidence seen from the other side, and the reason the beat-blindness
    // test above had to be written as a grid swap instead.
    const exact = [2500, 5000, 7500].concat([37500, 52500]).filter((t) => BEATS.beatTimesMs.includes(t));
    expect(exact).toEqual([37500, 52500]);
  });

  it("every neighbouring interval fails it — the pass is arithmetic, not musicality", () => {
    for (const interval of [1.5, 1.75, 2.0, 2.25, 2.75, 3.0, 3.5, 4.0]) {
      expect(lockRatio(interval), `interval ${interval}s`).toBeLessThan(0.85);
    }
  });
});

describe("baseline captions are static sentence blocks", () => {
  it("splits on sentence punctuation only, with a mechanical word cap", () => {
    const words = [
      { word: "One", start: 0, end: 1 },
      { word: "two.", start: 1, end: 2 },
      { word: "Three", start: 2, end: 3 },
    ];
    expect(splitIntoSentences(words).map((s) => s.map((w) => w.word))).toEqual([
      ["One", "two."],
      ["Three"],
    ]);
  });

  it("exceeds G5's ≤3 words, so the gate measures the real count rather than a disguised one", () => {
    const g5 = gate("G5");
    expect(g5.pass).toBe(false);
    expect(g5.measured as number).toBeGreaterThan(KARAOKE_MAX_WORDS_PER_CHUNK);
  });

  it("uses one position for the whole reel, failing G6's ≥3 distinct", () => {
    const plan = baselinePlan();
    expect(new Set(plan.captions.map((c) => c.position))).toEqual(new Set([BASELINE_CAPTION_POSITION]));
    expect(gate("G6").pass).toBe(false);
  });

  it("marks no emphasis word anywhere — and G8 cannot see that, which is a finding", () => {
    const plan = baselinePlan();
    expect(plan.captions.every((c) => c.emphasisWordIndex === null)).toBe(true);
    expect(plan.captions.every((c) => c.words.every((w) => w.isEmphasis !== true))).toBe(true);
    // G8 asks "≤1 emphasis word per chunk, and it must index a real word".
    // Zero emphasis words satisfies both clauses, so a reel with no editorial
    // emphasis at all scores clean. Pinned deliberately: the gate is passing
    // here on a technicality, and that belongs in a test rather than only in
    // the comparison README. Same shape as §12.43's stopword finding — G8
    // "mechanically clean while being editorially wrong".
    expect(gate("G8").pass).toBe(true);
  });

  it("breaches G9 by sitting where a subtitle burner puts text, with no knowledge of the bars", () => {
    const g9 = gate("G9");
    expect(g9.pass).toBe(false);
    expect((g9.measured as { violations: number }).violations).toBeGreaterThan(0);
  });

  /**
   * §12.45's bug, reproduced in the baseline and caught the same way.
   *
   * `BaselineReel` first computed its caption size from a module constant while
   * the plan still carried the template's 0.075·W display size, so `gateG9`
   * predicted a six-line 510px block where the renderer drew three lines. The
   * gate was internally consistent and wrong, and only a frame disagreed with
   * it. Running QC on the baseline is worth something only if its failures are
   * measured on what it actually draws, so the size lives on the plan and the
   * composition reads it.
   */
  it("carries its caption size on the plan, so G9 measures the size the renderer draws", () => {
    const style = baselinePlan().templateStyle!;
    expect(style.sizes.karaoke).toBeCloseTo(0.045 * 1080, 6);
    // No emphasis treatment at all, so the emphasis size is not a larger one.
    expect(style.sizes.emphasis).toBe(style.sizes.karaoke);
    // And it is genuinely different from the template's display karaoke,
    // which is what made the mismatch possible in the first place.
    expect(style.sizes.karaoke).toBeLessThan(0.075 * 1080);
    const source = fs.readFileSync(
      path.join(repoRoot, "packages/render/src/baseline/BaselineReel.tsx"),
      "utf-8",
    );
    expect(source).toMatch(/fontSize:\s*style\.sizes\.karaoke/);
  });
});

describe("baseline motion", () => {
  it("declares a camera that does not move, so G7 is SCORED and fails", () => {
    const plan = baselinePlan();
    expect(plan.cuts.every((c) => c.motion && c.motion.fromScale === c.motion.toScale)).toBe(true);
    const g7 = gate("G7");
    // Both halves matter. Omitting `motion` entirely would make G7
    // `computable: false`, and an excluded gate would flatter the baseline by
    // dropping the one that measures exactly what it lacks.
    expect(g7.computable).toBe(true);
    expect(g7.pass).toBe(false);
    expect((g7.measured as { staticShots: number; shots: number })).toMatchObject({
      staticShots: plan.cuts.length,
    });
  });

  it("has no grade: contrast, saturation, warm tint and vignette are all identity", () => {
    expect(baselinePlan().grade).toEqual({ contrast: 1, saturation: 1, warmTint: 0, vignette: 0 });
  });

  it("disables the emphasis punch at the plan, not in the renderer", () => {
    expect(baselinePlan().templateStyle!.punchScale).toBe(0);
  });

  it("pins the handle in one corner for the whole reel (02 §2.3's watermark tell)", () => {
    expect(new Set(baselinePlan().handle!.cornerByShot).size).toBe(1);
  });

  it("eases symmetrically, which 02 §1's EXIT_SPEEDUP forbids", () => {
    const { input, output } = baselineEnvelopeKnots(300);
    expect(input[1]! - input[0]!).toBe(BASELINE_EASE_FRAMES);
    // In-ramp and out-ramp are the same length. Exits should be ~40% faster.
    expect(input[3]! - input[2]!).toBe(input[1]! - input[0]!);
    expect(output).toEqual([0, 1, 1, 0]);
  });

  /**
   * A regression test for a bug that killed the first baseline render.
   *
   * The knots clamped the hold segment with `Math.max(ease, total - ease)`, so
   * a 12-frame chunk produced `[0, 6, 6, 12]` — not strictly increasing, which
   * `interpolate` rejects at frame 0. Short chunks are not exotic here: the
   * naive splitter emits whatever the transcript's punctuation gives it.
   */
  it("produces a strictly increasing input range at every chunk length", () => {
    for (let frames = 1; frames <= 400; frames++) {
      const { input, output } = baselineEnvelopeKnots(frames);
      expect(input.length, `frames=${frames}`).toBe(output.length);
      for (let i = 1; i < input.length; i++) {
        expect(input[i]!, `frames=${frames} knot ${i}`).toBeGreaterThan(input[i - 1]!);
      }
    }
  });

  it("its composition uses interpolate() and calls no spring at all", () => {
    const source = fs.readFileSync(
      path.join(repoRoot, "packages/render/src/baseline/BaselineReel.tsx"),
      "utf-8",
    );
    // 02 §1: "Ban `interpolate()` for any visible motion… Linear tweens are the
    // #1 tell of generated video." The baseline is where it belongs.
    expect(source).toMatch(/\binterpolate\(/);
    // And no easing curve is handed to it, so the tween is genuinely linear.
    expect(source).not.toMatch(/easing\s*:/);
    expect(source).not.toMatch(/\bspring\(/);
  });
});

describe("the baseline is fenced off from production", () => {
  const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".venv", "__pycache__"]);
  /**
   * The two references that are allowed to exist, and why each is unavoidable:
   * `Root.tsx` because `remotion render` can only reach a composition the root
   * registers, `render-evidence.ts` because `--baseline` is the CLI entry
   * point, and this file because it is the fence.
   */
  const ALLOWED = new Set([
    "packages/render/src/Root.tsx",
    "scripts/studio/render-evidence.ts",
    "scripts/studio/build-comparison.ts",
    "apps/api/tests/studio-baseline.test.ts",
  ]);

  function* walk(dir: string): Generator<string> {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        yield* walk(full);
      } else if (entry.isFile() && /\.(ts|tsx)$/.test(full)) {
        yield full;
      }
    }
  }

  it("is referenced by nothing outside packages/render/src/baseline but the entry points", () => {
    const offenders: string[] = [];
    for (const dir of ["apps", "packages", "scripts", "e2e", "services"]) {
      for (const file of walk(path.join(repoRoot, dir))) {
        const rel = path.relative(repoRoot, file);
        if (rel.startsWith(path.join("packages", "render", "src", "baseline"))) continue;
        if (ALLOWED.has(rel.split(path.sep).join("/"))) continue;
        if (/["'][^"']*baseline\/(plan|BaselineReel)/.test(fs.readFileSync(file, "utf-8"))) {
          offenders.push(rel);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("is not vacuous — the allowed entry points really do reference it", () => {
    const root = fs.readFileSync(path.join(repoRoot, "packages/render/src/Root.tsx"), "utf-8");
    const cli = fs.readFileSync(path.join(repoRoot, "scripts/studio/render-evidence.ts"), "utf-8");
    expect(root).toMatch(/baseline\/plan/);
    expect(cli).toMatch(/baseline\/plan/);
  });

  it("no production plan builder emits captionMode", () => {
    const built = buildTemplatePlan({
      templateId: "statement_serif",
      words: FLAT_WORDS,
      durationSec: FIXTURE_DURATION_SEC,
      beats: BEATS,
      seed: 42,
      hook: "GRAVITY IS AGEING YOU",
      emphasisWord: "AGEING",
      handleText: "@PERFSTAQ",
      footage: { assetId: "talking-head-v1-1080", r2Key: "studio/talking-head-v1-1080.mp4" },
    });
    expect(built.captionMode).toBeUndefined();
    expect(baselinePlan().captionMode).toBe("block");
  });
});

/**
 * The schema guarantee `captionMode` had to leave intact.
 *
 * `CaptionChunkSchema.words` used to carry `.max(3)`, so ADR-4's "a template
 * physically cannot reach for an effect that does not exist in the contract"
 * covered caption density. Moving the bound to the plan's refinement must not
 * have weakened that for any plan production builds.
 */
describe("moving G5's bound off the chunk did not weaken the production contract", () => {
  const base = {
    planVersion: "1",
    seed: 0,
    fps: 30,
    width: 1080,
    height: 1920,
    durationInFrames: 150,
    framing: "letterbox",
    footage: { assetId: "x", r2Key: "y" },
    cuts: [{ id: "c0", sourceInMs: 0, sourceOutMs: 5000, outputStartMs: 0, outputEndMs: 5000 }],
    beatGrid: { method: "constant_grid", tempoBpm: null, beatTimesMs: [], gridQuality: null },
    music: null,
    grade: { contrast: 1, saturation: 1, warmTint: 0 },
  };
  const fourWords = [
    {
      words: [0, 1, 2, 3].map((i) => ({ word: `w${i}`, startMs: i * 100, endMs: i * 100 + 90 })),
      position: "center_low",
      emphasisWordIndex: null,
    },
  ];

  it("still refuses a fourth word on a plan that does not declare captionMode: block", () => {
    expect(() => RenderPlanSchema.parse({ ...base, captions: fourWords })).toThrow(/at most 3/);
  });

  it("still refuses it when captionMode is explicitly karaoke", () => {
    expect(() => RenderPlanSchema.parse({ ...base, captions: fourWords, captionMode: "karaoke" })).toThrow();
  });

  it("permits it only for a block plan, which G5 then fails anyway", () => {
    const parsed = RenderPlanSchema.parse({ ...base, captions: fourWords, captionMode: "block" });
    expect(parsed.captions[0]!.words).toHaveLength(4);
    expect(planDecidableGateResults(parsed, null).find((g) => g.id === "G5")!.pass).toBe(false);
  });
});
