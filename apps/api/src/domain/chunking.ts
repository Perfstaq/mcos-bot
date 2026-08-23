export type ChunkableSegment = {
  id: string;
  idx: number;
  speaker: string;
  startMs: number;
  text: string;
};

export type Chunk = {
  index: number;
  segments: ChunkableSegment[];
  /** Segments carried over from the previous chunk, for context only. */
  overlapCount: number;
};

/** ~4 characters per token is close enough for budgeting; we are sizing a
 *  request, not billing for one. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const OVERLAP_TURNS = 2;

/**
 * Chunk a transcript for extraction.
 *
 * Splits on speaker-turn boundaries only. A claim's evidence must never
 * straddle a chunk boundary invisibly — cutting mid-turn would hand the model
 * half a sentence and invite it to invent the other half. Two turns of overlap
 * carry context across the seam; the duplicate claims that overlap inevitably
 * produces are collapsed downstream by dedupe key.
 *
 * A single turn longer than the budget is emitted alone rather than split:
 * an over-budget request is a recoverable error, a fabricated quote is not.
 */
export function chunkBySpeakerTurns(
  segments: ChunkableSegment[],
  maxTokens = 8_000,
): Chunk[] {
  if (segments.length === 0) return [];

  const chunks: Chunk[] = [];
  let current: ChunkableSegment[] = [];
  let currentTokens = 0;
  let overlapCount = 0;

  const flush = () => {
    if (current.length === 0) return;
    chunks.push({ index: chunks.length, segments: current, overlapCount });
    const tail = current.slice(-OVERLAP_TURNS);
    current = [...tail];
    currentTokens = tail.reduce((sum, s) => sum + estimateTokens(s.text), 0);
    overlapCount = tail.length;
  };

  for (const segment of segments) {
    const cost = estimateTokens(segment.text) + 16; // + the speaker/handle line
    if (current.length > overlapCount && currentTokens + cost > maxTokens) flush();
    current.push(segment);
    currentTokens += cost;
  }

  if (current.length > overlapCount) {
    chunks.push({ index: chunks.length, segments: current, overlapCount });
  }

  return chunks;
}

/** Short, stable handle for a segment. Cheap in tokens and unambiguous to cite. */
export function segmentHandle(idx: number): string {
  return `s${String(idx).padStart(4, "0")}`;
}

export function renderChunk(chunk: Chunk, formatTime: (ms: number) => string): string {
  return chunk.segments
    .map((s) => `[${segmentHandle(s.idx)}] (${formatTime(s.startMs)}) ${s.speaker}: ${s.text}`)
    .join("\n");
}
