import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertValidRenderPlan, type RenderPlan } from "@mcos/render/plan";
import { getTemplate } from "@mcos/render/templates";
import { BannerFitError } from "@mcos/render/templates/resolve";
import {
  assertValidEditFingerprint,
  type EditFingerprint,
} from "../../apps/api/src/domain/studio/fingerprint.js";
import {
  assertStyleTransferConstraints,
  mapFingerprintToTemplate,
  StyleTransferInfeasible,
  type StyleTransferMapping,
} from "../../apps/api/src/domain/studio/style-transfer.js";
import { buildTemplatePlan } from "./build-template-plan.js";

/**
 * build-style-transfer-plan.ts — fingerprint + the user's footage → RenderPlan.
 *
 * `04 §4` step 5: "Emit a normal RenderPlan. Everything downstream is
 * unchanged." This script is the proof of that sentence. It composes Agent
 * F's mapping with Agent T's existing `buildTemplatePlan`, and what comes out
 * is an ordinary plan that `qc-render.ts` scores with the ordinary gates —
 * there is no style-transfer-shaped branch anywhere downstream.
 *
 * **This is a script, not the job.** `apps/api/src/jobs/plan-build.ts` is
 * Agent I's and is being built in parallel; nothing here should be read as
 * that job, and nothing here writes to a database. The two functions the job
 * needs are `mapFingerprintToTemplate` (choose and parameterise) and
 * `assertStyleTransferConstraints` (04 §5's hard checks on the finished
 * plan). Both are importable from `domain/studio/style-transfer.ts` and
 * neither needs anything from this file.
 *
 * ── The one thing that must not be got wrong ────────────────────────────
 * The `--words` and `--beats` inputs are the USER's footage, analysed by the
 * same sidecar. The fingerprint contributes tempo and rhythm SHAPE and
 * nothing else. `assertStyleTransferConstraints` re-checks that on the
 * finished plan (00_MASTER invariant 5, ARCHITECTURE §12.13) rather than
 * trusting this comment.
 *
 * Usage:
 *   npx tsx scripts/studio/build-style-transfer-plan.ts \
 *     --fingerprint <fingerprint.json> \
 *     --words <user-footage-words.json> --beats <user-footage-beats.json> \
 *     --out <plan.json> [--duration <sec>] [--hook "..."] [--emphasis WORD]
 *     [--handle @handle] [--seed 42]
 */

type WordsJson = {
  durationSec: number;
  segments: { words: { word: string; start: number; end: number; rms?: number | null }[] }[];
};
type BeatsJson = {
  method: "beat_track" | "onset_env" | "constant_grid";
  tempoBpm: number | null;
  beatTimesMs: number[];
  gridQuality: number | null;
};

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]!;
  if (fallback !== undefined) return fallback;
  throw new Error(`missing required --${name}`);
}

export type StyleTransferPlanInput = {
  fingerprint: EditFingerprint;
  /** The USER's footage — never the reference's. */
  words: { word: string; start: number; end: number; rms?: number | null }[];
  durationSec: number;
  beats: BeatsJson;
  seed: number;
  hook: string;
  emphasisWord: string | null;
  handleText: string;
  footage: { assetId: string; r2Key: string };
};

export type StyleTransferPlanResult = {
  plan: RenderPlan;
  mapping: StyleTransferMapping;
};

/**
 * The whole of 04 §4, end to end.
 *
 * Steps 1–3 are the mapping; step 4 (re-derive the grid from the NEW audio)
 * happens by passing the user's own `beats` through to `buildTemplatePlan`,
 * which embeds the grid the planner actually scored against; step 5 is that
 * the return value is an ordinary `RenderPlan` with nothing style-transfer
 * shaped on it.
 */
export function buildStyleTransferPlan(input: StyleTransferPlanInput): StyleTransferPlanResult {
  const mapping = mapFingerprintToTemplate(input.fingerprint);
  const template = getTemplate(mapping.templateId);

  const plan = buildTemplatePlan({
    templateId: mapping.templateId,
    words: input.words,
    durationSec: input.durationSec,
    // The USER's grid. The fingerprint's beat times are not in scope here and
    // `assertStyleTransferConstraints` verifies that below.
    beats: input.beats,
    seed: input.seed,
    hook: input.hook,
    emphasisWord: input.emphasisWord,
    handleText: input.handleText,
    footage: input.footage,
    // 04 §4 step 2 — the reference's pace on this template's shape. Without
    // this the re-timed curve would be computed and then thrown away, and
    // "style transfer" would amount to picking a template.
    rhythm: mapping.retimed.rhythm,
  });

  const styled = assertValidRenderPlan(plan, `style-transfer plan (${mapping.templateId})`);
  assertStyleTransferConstraints(styled, input.fingerprint);

  void template;
  return { plan: styled, mapping };
}

function main(): void {
  const fingerprint = assertValidEditFingerprint(
    JSON.parse(readFileSync(arg("fingerprint"), "utf8")),
    arg("fingerprint"),
  );
  const wordsJson = JSON.parse(readFileSync(arg("words"), "utf8")) as WordsJson;
  const beats = JSON.parse(readFileSync(arg("beats"), "utf8")) as BeatsJson;
  const outPath = arg("out");

  const flat = wordsJson.segments.flatMap((s) => s.words);
  const durationSec = Number(arg("duration", String(wordsJson.durationSec)));

  let result: StyleTransferPlanResult;
  try {
    result = buildStyleTransferPlan({
      fingerprint,
      words: flat,
      durationSec,
      beats,
      seed: Number(arg("seed", "42")),
      hook: arg("hook", "THE POWER OF OBSESSION"),
      emphasisWord: arg("emphasis", "OBSESSION"),
      handleText: arg("handle", "@PERFSTAQ"),
      footage: {
        assetId: arg("footage-id", "user-footage"),
        r2Key: arg("footage-key", "demo/user-footage.mp4"),
      },
    });
  } catch (e) {
    if (e instanceof StyleTransferInfeasible) {
      // 03 §7's `plan_infeasible`: a real, actionable, user-facing failure,
      // not a crash. Exit 2 so a caller can tell it from a bug.
      console.error(`plan_infeasible(style_transfer): ${e.message}`);
      process.exit(2);
    }
    if (e instanceof BannerFitError) {
      console.error(`plan_infeasible(banner_wrap): ${e.message}`);
      process.exit(2);
    }
    throw e;
  }

  const { plan, mapping } = result;
  writeFileSync(outPath, JSON.stringify(plan, null, 2));

  const shots = plan.cuts.map((c) => (c.outputEndMs - c.outputStartMs) / 1000).sort((a, b) => a - b);
  const median = shots[Math.floor(shots.length / 2)] ?? 0;

  console.log(`fingerprint     ${fingerprint.fingerprintVersion} (${fingerprint.sourceAssetId ?? "—"})`);
  console.log(
    `reference       ${fingerprint.rhythm.cutsPerMin}/min, median ${fingerprint.rhythm.medianShotMs}ms, ` +
      `${fingerprint.audio.tempoBpm} BPM, ${fingerprint.framing}, pattern=${fingerprint.rhythm.pattern}`,
  );
  console.log(`template        ${mapping.templateId}  (ranked: ${mapping.selection.ranked.map((r) => `${r.templateId} ${r.distance.toFixed(3)}`).join(", ")})`);
  console.log(
    `re-timed        rescale ${mapping.retimed.rescale}${mapping.retimed.clamped ? " (CLAMPED)" : ""}, ` +
      `min shot ${mapping.retimed.minShotSecAfter.toFixed(2)}s`,
  );
  console.log(`plan            ${path.resolve(outPath)}`);
  console.log(
    `cuts            ${plan.cuts.length - 1}  (${((plan.cuts.length - 1) / (durationSec / 60)).toFixed(1)}/min, median ${median.toFixed(2)}s)`,
  );
  console.log(`grid            ${plan.beatGrid.method}, ${plan.beatGrid.tempoBpm} BPM, ${plan.beatGrid.beatTimesMs.length} beats — from the USER's audio`);
  console.log("");
  console.log("field sources (04 §3 — low confidence falls back to the template):");
  for (const [field, source] of Object.entries(mapping.fieldSources)) {
    console.log(`  ${source === "fingerprint" ? "◆" : "·"} ${field.padEnd(32)} ${source}`);
  }
  console.log("");
  for (const note of mapping.fallbacks) console.log(`  note: ${note}`);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
