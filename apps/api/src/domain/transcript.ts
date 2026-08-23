import type { RecallTranscriptEntry } from "../integrations/recall.js";

export type ParsedSegment = {
  idx: number;
  speaker: string;
  speakerId: number | null;
  startMs: number;
  endMs: number;
  text: string;
};

export type ParsedTranscript = {
  segments: ParsedSegment[];
  languageCode: string | null;
  wordCount: number;
  durationMs: number;
};

/**
 * Recall's transcript download is an array of utterances, each already
 * attributed to a participant. That utterance is exactly the granularity we
 * want for evidence: it is what a human sees quoted on a review card, and it
 * is small enough that "this claim cites segment 12" is a precise statement.
 * So the mapping is 1:1 — no re-chunking, no merging of adjacent turns.
 *
 * Timestamps are `relative` seconds from recording start. `absolute` is null
 * for async transcription, which is the flow we use, so relative is the only
 * usable clock.
 */
export function parseTranscript(entries: RecallTranscriptEntry[]): ParsedTranscript {
  const segments: ParsedSegment[] = [];
  let wordCount = 0;
  let languageCode: string | null = null;
  let durationMs = 0;

  for (const entry of entries) {
    const words = entry.words ?? [];
    if (words.length === 0) continue;

    const text = words
      .map((w) => w.text)
      .join(" ")
      .replace(/\s+([,.!?;:])/g, "$1")
      .trim();
    if (!text) continue;

    const first = words[0];
    const last = words[words.length - 1];
    const startMs = Math.max(0, Math.round((first?.start_timestamp?.relative ?? 0) * 1000));
    const endMs = Math.max(
      startMs,
      Math.round((last?.end_timestamp?.relative ?? last?.start_timestamp?.relative ?? 0) * 1000),
    );

    languageCode ??= entry.language_code ?? null;
    wordCount += words.length;
    durationMs = Math.max(durationMs, endMs);

    segments.push({
      idx: segments.length,
      speaker: speakerName(entry),
      speakerId: entry.participant?.id ?? null,
      startMs,
      endMs,
      text,
    });
  }

  return { segments, languageCode, wordCount, durationMs };
}

function speakerName(entry: RecallTranscriptEntry): string {
  const name = entry.participant?.name?.trim();
  if (name) return name;
  const id = entry.participant?.id;
  return id === undefined || id === null ? "Unknown speaker" : `Speaker ${id}`;
}

export function formatTimestamp(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}
