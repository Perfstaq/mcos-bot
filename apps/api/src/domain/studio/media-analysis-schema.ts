import { z } from "zod";
import { BeatGridSchema, type BeatGrid } from "@mcos/render/plan";

/**
 * The Node-side contract for services/analyzer's CLI output.
 *
 * `analyzer.py` writes `words.json`/`beats.json` to a temp dir; the
 * `media-analyze` job zod-validates each file before it ever reaches
 * `MediaAnalysis` (ARCHITECTURE.md §5 — same "loud loaders" discipline as
 * founder-journey's `schema.ts`/`io.ts`: validation fails loudly, never
 * silently, and a malformed sidecar output never becomes a silently-wrong
 * database row).
 *
 * The beat-grid shape is `@mcos/render`'s `BeatGridSchema` (plan.ts),
 * imported directly rather than duplicated — `packages/render` now has a
 * real `tsc` build (dist/ + .d.ts), so it's safe for apps/api's compiled
 * production runtime to depend on. Only `words.json`'s shape is local to
 * apps/api: it has no counterpart in the render plan (captions are a
 * separate, richer contract M owns), so there's nothing to import.
 */

export const WordSchema = z.object({
  word: z.string(),
  start: z.number().min(0),
  end: z.number().min(0),
  score: z.number().nullable().optional(),
  // librosa RMS energy over [start, end) — ARCHITECTURE §11.1 R1:
  // 02_MOTION_SYSTEM §3's emphasis scorer weights `audio_energy_zscore(word)`
  // at 1.5, and nothing downstream can compute it without this. Optional
  // because analyzerVersion < 0.2.0 rows predate it.
  rms: z.number().nonnegative().nullable().optional(),
});
export type Word = z.infer<typeof WordSchema>;

export const SegmentSchema = z.object({
  start: z.number().min(0),
  end: z.number().min(0),
  text: z.string(),
  words: z.array(WordSchema),
});
export type Segment = z.infer<typeof SegmentSchema>;

export const WordsResultSchema = z.object({
  language: z.string(),
  durationSec: z.number().nonnegative(),
  segments: z.array(SegmentSchema),
});
export type WordsResult = z.infer<typeof WordsResultSchema>;

export { BeatGridSchema };
export type BeatGridResult = BeatGrid;

function loudParse<T>(schema: z.ZodType<T>, raw: unknown, label: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  • [${i.path.join(".")}] ${i.message}`);
    throw new Error(`sidecar output validation failed for ${label}:\n${lines.join("\n")}`);
  }
  return parsed.data;
}

export function assertValidWordsResult(raw: unknown, label = "words.json"): WordsResult {
  return loudParse(WordsResultSchema, raw, label);
}

export function assertValidBeatGrid(raw: unknown, label = "beats.json"): BeatGridResult {
  return loudParse(BeatGridSchema, raw, label);
}
