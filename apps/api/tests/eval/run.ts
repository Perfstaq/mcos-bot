/**
 * Extraction-quality eval on the golden Freshworks transcript.
 *
 *   npm run eval:extraction -- --mock    deterministic; proves the scorer and
 *                                        the harness without a model call
 *   npm run eval:extraction              live; calls the configured OpenAI
 *                                        model through the real integration
 *
 * DB-FREE BY DESIGN: this loads fixtures from disk, runs chunking, the real
 * evidence gate and the real dedupe in memory, and writes one JSON report.
 * It never imports src/db.ts and never writes to Postgres or Redis — a live
 * dev stack on this machine is not touched by an eval run.
 *
 * Output: metrics on stdout, full report in eval-results.json at the repo
 * root (gitignored). eval-results.golden.json is the committed --mock
 * snapshot proving what a perfect extraction scores.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseTranscript } from "../../src/domain/transcript.js";
import type { RecallTranscriptEntry } from "../../src/integrations/recall.js";
import { createExtractFromChunkMockFromAnswerKey } from "../helpers/llm-mock.js";
import {
  runDbFreeExtraction,
  scoreAgainstAnswerKey,
  type AnswerKeyEntry,
  type ExtractFn,
} from "./score.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");
const fixtures = path.resolve(here, "../fixtures/transcripts");

const THRESHOLDS = {
  recall: 0.8,
  falsePositives: 0,
  typeAccuracy: 0.85,
  evidenceAccuracy: 0.9,
} as const;

function loadJson<T>(file: string): T {
  return JSON.parse(readFileSync(path.join(fixtures, file), "utf8")) as T;
}

async function main(): Promise<void> {
  const mock = process.argv.includes("--mock");

  const transcript = loadJson<RecallTranscriptEntry[]>("golden-freshworks.json");
  const answerKey = loadJson<AnswerKeyEntry[]>("golden-answer-key.json");
  const parsed = parseTranscript(transcript);

  let extract: ExtractFn;
  let model: string;
  let promptVersion: string;

  if (mock) {
    extract = createExtractFromChunkMockFromAnswerKey(answerKey);
    model = "mock(answer-key)";
    ({ PROMPT_VERSION: promptVersion } = await import(
      "../../src/integrations/prompts/extract-v3.js"
    ));
  } else {
    // Imported lazily: the real integration validates the full environment on
    // load, and a --mock run must work with no environment at all.
    const openai = await import("../../src/integrations/openai.js");
    const { env } = await import("../../src/env.js");
    extract = openai.extractFromChunk;
    model = env.OPENAI_MODEL;
    promptVersion = openai.PROMPT_VERSION;
  }

  const startedAt = Date.now();
  const result = await runDbFreeExtraction({
    segments: parsed.segments,
    extract,
    meetingTitle: "Freshworks positioning sync",
  });
  const scores = scoreAgainstAnswerKey(result.predicted, answerKey);
  const elapsedMs = Date.now() - startedAt;

  const pass =
    scores.recall >= THRESHOLDS.recall &&
    scores.falsePositives <= THRESHOLDS.falsePositives &&
    scores.typeAccuracy >= THRESHOLDS.typeAccuracy &&
    scores.evidenceAccuracy >= THRESHOLDS.evidenceAccuracy;

  const report = {
    generatedAt: new Date().toISOString(),
    mode: mock ? "mock" : "live",
    model,
    promptVersion,
    transcript: "golden-freshworks.json",
    thresholds: THRESHOLDS,
    pass,
    metrics: {
      recall: round(scores.recall),
      falsePositives: scores.falsePositives,
      typeAccuracy: round(scores.typeAccuracy),
      evidenceAccuracy: round(scores.evidenceAccuracy),
    },
    counts: {
      segments: parsed.segments.length,
      chunks: result.chunkCount,
      mustExtract: scores.mustExtract,
      matched: scores.matched,
      predicted: scores.predictedCount,
      proposedByModel: result.proposed,
      droppedByEvidenceGate: result.dropped,
      duplicatesCollapsed: result.duplicates,
      unscoredExtras: scores.unscoredExtras,
    },
    tokens: { input: result.inputTokens, output: result.outputTokens },
    elapsedMs,
    missed: scores.missed,
    typeMisses: scores.typeMisses,
    evidenceMisses: scores.evidenceMisses,
    falsePositiveClaims: scores.falsePositiveClaims,
  };

  const out = path.join(repoRoot, "eval-results.json");
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);

  const fmt = (n: number) => n.toFixed(2);
  console.log(`\nExtraction eval — golden-freshworks (${report.mode}, ${model})`);
  console.log(`  prompt          ${promptVersion}`);
  console.log(`  recall          ${fmt(scores.recall)}   (floor ${THRESHOLDS.recall}) — ${scores.matched}/${scores.mustExtract}`);
  console.log(`  noise FPs       ${scores.falsePositives}      (ceiling ${THRESHOLDS.falsePositives})`);
  console.log(`  type accuracy   ${fmt(scores.typeAccuracy)}   (floor ${THRESHOLDS.typeAccuracy})`);
  console.log(`  evidence acc.   ${fmt(scores.evidenceAccuracy)}   (floor ${THRESHOLDS.evidenceAccuracy})`);
  console.log(`  pipeline        ${result.chunkCount} chunks · ${result.proposed} proposed · ${result.dropped} dropped · ${result.duplicates} duplicates · ${scores.predictedCount} kept`);
  if (scores.missed.length > 0) {
    console.log(`  missed:`);
    for (const gist of scores.missed) console.log(`    - ${gist}`);
  }
  for (const miss of scores.typeMisses) {
    console.log(`  type miss: expected ${miss.expected}, got ${miss.got} — ${miss.gist}`);
  }
  for (const fp of scores.falsePositiveClaims) {
    console.log(`  FALSE POSITIVE (${fp.type}): ${fp.text}`);
  }
  console.log(`  ${pass ? "PASS" : "FAIL"} — full report in eval-results.json\n`);

  process.exitCode = pass ? 0 : 1;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
