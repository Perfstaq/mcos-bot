/**
 * emphasis.ts — pick the ONE word (02_MOTION_SYSTEM §3).
 *
 *   score(word) =
 *       2.0 * appears_in_claim_text(word)
 *     + 1.5 * audio_energy_zscore(word)
 *     + 1.0 * is_number_or_proper_noun(word)
 *     + 0.8 * is_contrast_word(word)
 *     - 2.0 * is_stopword(word)
 *
 * Two data seams the orchestrator ruled on (ARCHITECTURE §11.1):
 *
 * - **R1 — `audio_energy_zscore` has real data.** No stage produced per-word
 *   RMS when 02 was written; Agent P added it to the analyzer's `words` stage
 *   (`services/analyzer/stages/words.py`, `Word.rms`). The term is NOT
 *   dropped — audio stress is genuinely how a speaker marks emphasis. The
 *   z-score is taken over the whole clip's words, so it means "louder than
 *   this speaker normally is", not "loud".
 * - **R3 — claim text arrives denormalized.** `appears_in_claim_text` needs
 *   claim text; a ContentBrief carries only `claim_ids`, and 05 §1 forbids
 *   reaching into claim tables. The brief therefore stores the claim texts
 *   alongside the ids, frozen at generation time — so a later edit to a claim
 *   cannot retroactively change what an already-approved brief emphasised
 *   (invariant 6). This module codes against that contract and never queries.
 *
 * "**Maximum one emphasis per chunk**" (G8) and "if nothing scores above
 * threshold, no emphasis — restraint over decoration" are both enforced here
 * rather than left to the caller: a caller that forgets is a silent G8
 * failure, and the reference colours exactly one word (01 §4).
 */

export type ScoredWord = {
  word: string;
  startMs: number;
  endMs: number;
  /** librosa RMS over the word's span; null on rows predating analyzer 0.2.0. */
  rms?: number | null;
};

export const EMPHASIS_WEIGHTS = {
  claimText: 2.0,
  audioEnergy: 1.5,
  numberOrProperNoun: 1.0,
  contrast: 0.8,
  stopword: -2.0,
} as const;

/** Below this, restraint wins and the chunk gets no emphasis at all. */
export const EMPHASIS_THRESHOLD = 1.0;

/** 02 §3's examples, plus the rest of the small closed class they belong to. */
const CONTRAST_WORDS = new Set([
  "but",
  "never",
  "actually",
  "instead",
  "however",
  "yet",
  "although",
  "though",
  "except",
  "unless",
  "rather",
  "nobody",
  "nothing",
  "none",
  "not",
  "no",
  "always",
  "only",
]);

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "of", "to", "in", "on", "at", "for", "with", "as", "by", "from",
  "is", "are", "was", "were", "be", "been", "being", "am", "do", "does", "did", "have", "has", "had",
  "i", "you", "he", "she", "it", "we", "they", "me", "him", "her", "us", "them", "my", "your", "his",
  "its", "our", "their", "this", "that", "these", "those", "there", "here", "so", "just", "very",
  "really", "like", "well", "okay", "ok", "um", "uh", "yeah",
]);

const NUMBER_WORDS = new Set([
  "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "hundred", "thousand", "million", "billion", "percent", "half", "double", "triple",
]);

export function normalizeToken(word: string): string {
  return word
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9'%$]/g, "");
}

/** Every normalized token in the brief's frozen claim texts (R3). */
export function claimTokenSet(claimTexts: string[]): Set<string> {
  const set = new Set<string>();
  for (const text of claimTexts) {
    for (const raw of text.split(/\s+/)) {
      const t = normalizeToken(raw);
      if (t) set.add(t);
    }
  }
  return set;
}

export function isStopword(word: string): boolean {
  return STOPWORDS.has(normalizeToken(word));
}

export function isContrastWord(word: string): boolean {
  return CONTRAST_WORDS.has(normalizeToken(word));
}

/**
 * A digit anywhere, a spelled-out number, or a capital that is not simply the
 * first word of a sentence. Deliberately a heuristic and not a POS tagger:
 * 02 §3 is a ranking function, the cost of a miss is that a different word in
 * the same 1–3 word chunk gets the accent colour, and ARCHITECTURE §1.2 was
 * explicit that this scorer is ~40 lines against claim text and RMS (which is
 * why `keywords.ts`/RAKE stayed behind).
 */
export function isNumberOrProperNoun(word: string, indexInSentence: number): boolean {
  const bare = word.replace(/[^\p{L}\p{N}'%$.,-]/gu, "");
  if (/\d/.test(bare)) return true;
  if (NUMBER_WORDS.has(normalizeToken(bare))) return true;
  if (indexInSentence === 0) return false; // sentence-initial capital proves nothing
  return /^\p{Lu}/u.test(bare);
}

/** Mean and standard deviation of per-word RMS across the whole clip. */
export function rmsStats(words: ScoredWord[]): { mean: number; stdDev: number } {
  const values = words.map((w) => w.rms).filter((v): v is number => typeof v === "number");
  if (values.length < 2) return { mean: 0, stdDev: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return { mean, stdDev: Math.sqrt(variance) };
}

export type EmphasisContext = {
  claimTokens: Set<string>;
  rms: { mean: number; stdDev: number };
};

export function buildEmphasisContext(allWords: ScoredWord[], claimTexts: string[]): EmphasisContext {
  return { claimTokens: claimTokenSet(claimTexts), rms: rmsStats(allWords) };
}

export function scoreWord(word: ScoredWord, indexInSentence: number, ctx: EmphasisContext): number {
  const token = normalizeToken(word.word);
  let score = 0;
  if (token && ctx.claimTokens.has(token)) score += EMPHASIS_WEIGHTS.claimText;
  if (typeof word.rms === "number" && ctx.rms.stdDev > 0) {
    score += EMPHASIS_WEIGHTS.audioEnergy * ((word.rms - ctx.rms.mean) / ctx.rms.stdDev);
  }
  if (isNumberOrProperNoun(word.word, indexInSentence)) score += EMPHASIS_WEIGHTS.numberOrProperNoun;
  if (isContrastWord(word.word)) score += EMPHASIS_WEIGHTS.contrast;
  if (isStopword(word.word)) score += EMPHASIS_WEIGHTS.stopword;
  return score;
}

/**
 * The index of the single emphasis word in `words`, or null for none.
 * `sentenceOffset` is the position of `words[0]` within its sentence, so the
 * proper-noun heuristic can tell a real capital from a sentence-initial one
 * even though a chunk is only 1–3 words wide.
 */
export function pickEmphasis(
  words: ScoredWord[],
  ctx: EmphasisContext,
  sentenceOffset = 1,
  threshold = EMPHASIS_THRESHOLD,
): number | null {
  let bestIndex: number | null = null;
  let bestScore = threshold;
  for (let i = 0; i < words.length; i++) {
    const score = scoreWord(words[i]!, sentenceOffset + i, ctx);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }
  return bestIndex;
}
