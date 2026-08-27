import { z } from "zod";

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
 * Deliberately independent from `packages/render`'s `BeatGridSchema`
 * (plan.ts) rather than importing it: `packages/render` has no build/`dist`
 * step yet (its package.json "exports" point at TS source, fine for
 * tsx/vitest but not for `apps/api`'s compiled production runtime — see the
 * comment there), so nothing in `apps/api/src` imports it. The two schemas
 * describe the same shape on purpose; when `plan.build` copies
 * `MediaAnalysis.beats` into `RenderPlan.plan.beatGrid` verbatim
 * (ARCHITECTURE.md §4.1), both schemas must be kept in sync by hand until
 * that packaging gap is closed.
 */

export const WordSchema = z.object({
  word: z.string(),
  start: z.number().min(0),
  end: z.number().min(0),
  score: z.number().nullable().optional(),
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

export const BeatMethodSchema = z.enum(["beat_track", "onset_env", "constant_grid"]);
export type BeatMethod = z.infer<typeof BeatMethodSchema>;

export const BeatGridResultSchema = z.object({
  method: BeatMethodSchema,
  tempoBpm: z.number().positive().nullable(),
  beatTimesMs: z.array(z.number().int().nonnegative()),
  gridQuality: z.number().nonnegative().nullable(),
});
export type BeatGridResult = z.infer<typeof BeatGridResultSchema>;

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
  return loudParse(BeatGridResultSchema, raw, label);
}
