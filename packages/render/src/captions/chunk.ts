import {
  buildEmphasisContext,
  pickEmphasis,
  type EmphasisContext,
  type ScoredWord,
} from "./emphasis.js";
import { positionForShot, type CaptionPosition } from "./layout.js";

/**
 * chunk.ts — the karaoke layer's timing (02_MOTION_SYSTEM §2.2, 01 §4).
 *
 * "**1–3 words on screen at a time. Never a sentence.** Chunk by: break on
 * punctuation, break at 3 words max, break at any gap >280ms." The reference
 * measures exactly this — "WORKING", "MORE THAN WORK", "SMALL" — and G5 gates
 * it at ≤3.
 *
 * Word timings come from the analyzer's `words` stage (faster-whisper + Silero
 * VAD; ARCHITECTURE §10 — read "WhisperX" in the specs as "word-level ASR").
 */

/** 02 §2.2's chunk-break gap. */
export const CHUNK_GAP_MS = 280;
/** G5. */
export const MAX_WORDS_PER_CHUNK = 3;

const SENTENCE_END = /[.!?…]$/;
const CLAUSE_END = /[,;:—-]$/;

export type CaptionWordPlan = {
  word: string;
  startMs: number;
  endMs: number;
  isEmphasis: boolean;
};

export type CaptionChunkPlan = {
  words: CaptionWordPlan[];
  startMs: number;
  endMs: number;
  position: CaptionPosition;
  /** Index into `words`, or null — G8 allows at most one. */
  emphasisWordIndex: number | null;
};

function endsSentence(word: string): boolean {
  return SENTENCE_END.test(word.trim());
}

function endsClause(word: string): boolean {
  return CLAUSE_END.test(word.trim());
}

/**
 * Whether a chunk can be DRAWN where it is going (§12.43).
 *
 * The chunker's own rules are about meaning — word count, punctuation, gaps —
 * and knew nothing about how wide the words render. That was fine while
 * captions sat over the footage, where a block could wrap to two lines and
 * still have room. In the bars it is not: the bottom bar is 129.6px and a
 * second line does not fit, so a chunk that wraps has nowhere legal to go and
 * would be rejected by the containment check with no way to fix it downstream.
 *
 * Passed IN rather than computed here on purpose: this file would otherwise
 * have to import font metrics and type scales, which are template-resolved
 * and belong on the other side of that boundary. Optional, and omitting it
 * restores the previous word-count-only behaviour exactly.
 */
export type ChunkFitPredicate = (words: ScoredWord[]) => boolean;

/**
 * Split any chunk that cannot be drawn into ones that can.
 *
 * Greedy from the left, and it never returns an empty chunk: a single word too
 * wide for the box is emitted alone and left to the G9 horizontal check, which
 * is the same posture `wrapLines` takes for an unbreakable word. Splitting is
 * always safe for timing because every chunk's start/end are read from its own
 * words, so two halves simply show one after the other.
 */
export function splitChunksToFit(chunks: ScoredWord[][], fits: ChunkFitPredicate): ScoredWord[][] {
  const out: ScoredWord[][] = [];
  for (const chunk of chunks) {
    let current: ScoredWord[] = [];
    for (const word of chunk) {
      const candidate = [...current, word];
      if (current.length > 0 && !fits(candidate)) {
        out.push(current);
        current = [word];
      } else {
        current = candidate;
      }
    }
    if (current.length) out.push(current);
  }
  return out;
}

/** Split a word list into 1–3 word groups by 02 §2.2's three rules. */
export function chunkWords(words: ScoredWord[]): ScoredWord[][] {
  const chunks: ScoredWord[][] = [];
  let current: ScoredWord[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    current.push(w);
    const next = words[i + 1];
    const full = current.length >= MAX_WORDS_PER_CHUNK;
    const punctuation = endsSentence(w.word) || endsClause(w.word);
    const gap = next ? next.startMs - w.endMs > CHUNK_GAP_MS : true;
    if (full || punctuation || gap) {
      chunks.push(current);
      current = [];
    }
  }
  if (current.length) chunks.push(current);
  return chunks;
}

/**
 * Position within the enclosing sentence, so the proper-noun heuristic can
 * tell "Obsession" from a sentence-initial "The" even inside a 1–3 word chunk.
 */
function sentenceOffsets(words: ScoredWord[]): number[] {
  const offsets: number[] = [];
  let offset = 0;
  for (const w of words) {
    offsets.push(offset);
    offset = endsSentence(w.word) ? 0 : offset + 1;
  }
  return offsets;
}

/** The shot a time falls in, given the plan's cut boundaries. */
function shotIndexAt(timeMs: number, cutTimesMs: number[]): number {
  let index = 0;
  for (const cut of cutTimesMs) {
    if (timeMs >= cut) index++;
    else break;
  }
  return index;
}

export type CaptionTrackInput = {
  words: ScoredWord[];
  /** Plan cut times in ms (excluding t=0) — drives per-shot position rotation. */
  cutTimesMs: number[];
  /** ContentBrief's frozen claim texts (ARCHITECTURE §11.1 R3). */
  claimTexts: string[];
  /**
   * The template's own rotation (02 §2.2: "Set per template"). Defaults to
   * `positionForShot`, the house rotation, so existing callers are unchanged.
   *
   * A callback rather than a list because the invariant that matters — never
   * the same position twice in a row, ≥3 distinct (G6) — is a property of the
   * *walk*, and templates express it by ordering the same three names
   * differently rather than by inventing positions. `templatePositionForShot`
   * is the implementation templates pass in.
   */
  positionForShot?: (shotIndex: number) => CaptionPosition;
  /**
   * §12.43 — whether a chunk fits on one line where it will be drawn. Chunks
   * that do not are split until they do. Omitted means "everything fits",
   * which is the pre-§12.43 behaviour.
   */
  fits?: ChunkFitPredicate;
};

/**
 * The karaoke track: chunked, positioned, and with exactly one emphasis word
 * per chunk at most (G8). Position rotates **per shot** (02 §2.2), so every
 * chunk that starts inside the same shot shares that shot's position and
 * consecutive shots never repeat one.
 */
export function buildCaptionTrack(input: CaptionTrackInput): CaptionChunkPlan[] {
  const ctx: EmphasisContext = buildEmphasisContext(input.words, input.claimTexts);
  const offsets = sentenceOffsets(input.words);
  const chunks = input.fits
    ? splitChunksToFit(chunkWords(input.words), input.fits)
    : chunkWords(input.words);
  const positionAt = input.positionForShot ?? positionForShot;

  const plans: CaptionChunkPlan[] = [];
  let cursor = 0;
  for (const chunk of chunks) {
    const sentenceOffset = offsets[cursor] ?? 1;
    cursor += chunk.length;
    const startMs = chunk[0]!.startMs;
    const endMs = chunk[chunk.length - 1]!.endMs;
    const emphasisWordIndex = pickEmphasis(chunk, ctx, sentenceOffset);
    plans.push({
      words: chunk.map((w, i) => ({
        word: w.word,
        startMs: w.startMs,
        endMs: w.endMs,
        isEmphasis: i === emphasisWordIndex,
      })),
      startMs,
      endMs,
      position: positionAt(shotIndexAt(startMs, input.cutTimesMs)),
      emphasisWordIndex,
    });
  }
  return plans;
}

/**
 * 02 §2.1 — the persistent banner. "Only one word is coloured. Two coloured
 * words halves the emphasis." The hook text and its emphasis word both come
 * from the approved ContentBrief; nothing is chosen here at render time.
 */
export type BannerPlan = {
  text: string;
  /** Index into `text.split(/\s+/)`, or null when the brief names no word. */
  emphasisWordIndex: number | null;
};

export function buildBanner(hookText: string, emphasisWord: string | null): BannerPlan {
  const tokens = hookText.split(/\s+/).filter(Boolean);
  if (!emphasisWord) return { text: hookText, emphasisWordIndex: null };
  const target = emphasisWord.toLowerCase().replace(/[^a-z0-9]/g, "");
  const index = tokens.findIndex((t) => t.toLowerCase().replace(/[^a-z0-9]/g, "") === target);
  return { text: hookText, emphasisWordIndex: index >= 0 ? index : null };
}
