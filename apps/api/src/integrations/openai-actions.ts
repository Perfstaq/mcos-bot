import OpenAI from "openai";
import { env } from "../env.js";
import { renderChunk, type Chunk } from "../domain/chunking.js";
import { formatTimestamp } from "../domain/transcript.js";

/** Bumped whenever the prompt or the schema changes, for the same reason
 *  PROMPT_VERSION exists on the claim harness: a suggestion nobody can trace
 *  to a prompt is a suggestion nobody can debug. */
export const ACTION_PROMPT_VERSION = "suggest_action_items/v1-openai";

/**
 * A second client rather than a shared one. It is the same constructor with the
 * same options, but suggestion work is not on the meeting's critical path and
 * will eventually want its own timeout and retry budget; sharing the instance
 * now would make that a refactor of the claim pipeline.
 */
const client = new OpenAI({
  apiKey: env.OPENAI_API_KEY,
  maxRetries: 3,
  timeout: 120_000,
});

export type SuggestedAction = {
  title: string;
  description: string | null;
  /** A name or email as the transcript said it. Resolved to a workspace member
   *  — or not — by the job; the model has no user directory. */
  ownerHint: string | null;
  /** `YYYY-MM-DD`, already resolved against the meeting's date by the model. */
  dueDate: string | null;
  /** A bucket name such as "Top priority", or null for the inbox. */
  groupHint: string | null;
  confidence: number;
  /** The segment handle the model cited, e.g. "s0012". Unresolved: turning a
   *  handle into a real foreign key is the job's evidence gate, not this file's. */
  sourceHandle: string;
  quote: string;
};

export type ChunkSuggestions = {
  suggestions: SuggestedAction[];
  inputTokens: number;
  outputTokens: number;
};

export class SuggestionRefused extends Error {
  constructor(readonly refusal: string) {
    super(`Model refused the action-item request: ${refusal}`);
    this.name = "SuggestionRefused";
  }
}

const SYSTEM_PROMPT = `You find commitments in B2B meeting transcripts and propose them as action items.

Every item you propose is shown to a person as a SUGGESTION and does nothing until
they accept it. You are not assigning work; you are pointing at the moment somebody
said they would do something. Propose precisely, not generously.

What counts as an action item:

- Somebody committed to doing a specific thing. "I'll send the updated deck by Friday."
- The group decided a specific thing must be done and it is clear what it is.
- Somebody asked another named person to do something and they agreed.

What does NOT count, and must never be proposed:

- Opinions, positioning, objections or decisions about messaging. Those are claims,
  a different pipeline handles them, and duplicating them here is noise.
- Vague intentions with no deliverable. "We should think about pricing" is not an
  action item. "Rewrite the pricing page tier boundaries" is.
- Anything that already happened.
- Scheduling and logistics ("let's move this to Thursday").

Rules:

1. EVIDENCE IS MANDATORY. Every item cites exactly one segment id from the
   transcript below — the segment where the commitment was actually made — and
   "quote" is copied exactly from that segment. Never paraphrase inside "quote".
   Never cite a segment id you were not given. An item you cannot evidence is an
   item you do not propose.
2. "title" is an imperative the assignee could act on without the transcript:
   "Send the revised pricing deck to Priya", not "Daniel said he'd send something".
   Under 120 characters.
3. "owner_hint" is the name or email as spoken, when a specific person took it on.
   Null when nobody did. Do not guess an owner from who happened to be talking.
4. "due_date" is YYYY-MM-DD, resolved against the meeting date you are given, and
   only when the transcript actually states or clearly implies a date. Otherwise null.
5. "group_hint" is a short bucket name only when the transcript itself groups the
   work ("this is the top priority for launch"). Otherwise null. Do not invent a
   taxonomy.
6. "confidence" is between 0 and 1: 0.9+ when someone plainly committed, 0.5-0.7
   when it is implied, below 0.5 when it is a reasonable but uncertain reading.
7. Returning an empty array is a correct answer for a chunk where nobody committed
   to anything. Do not manufacture items to fill the response.`;

/**
 * Strict Structured Outputs schema.
 *
 * Two constraints of strict mode shape this, both confirmed against the current
 * Responses API guide (developers.openai.com/api/docs/guides/structured-outputs):
 * every property must appear in `required`, so an optional field is spelled as a
 * union with null (`"type": ["string", "null"]`); and validation keywords such as
 * `minimum`, `maximum`, `minItems` and `maxItems` are not part of the supported
 * subset, so ranges and non-empty rules are applied in `coerceSuggestions` below
 * and in the job's evidence gate — which is where they belonged anyway, since the
 * model cannot be trusted to police its own citations.
 */
const SUGGESTIONS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["action_items"],
  properties: {
    action_items: {
      type: "array",
      description: "Commitments found in this chunk. Empty when there are none.",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "title",
          "description",
          "owner_hint",
          "due_date",
          "group_hint",
          "confidence",
          "source_segment_id",
          "quote",
        ],
        properties: {
          title: {
            type: "string",
            description: "Imperative, standalone, under 120 characters.",
          },
          description: {
            type: ["string", "null"],
            description: "One sentence of context, or null when the title says it all.",
          },
          owner_hint: {
            type: ["string", "null"],
            description: "The person's name or email as spoken, or null.",
          },
          due_date: {
            type: ["string", "null"],
            description: "YYYY-MM-DD resolved against the meeting date, or null.",
          },
          group_hint: {
            type: ["string", "null"],
            description: 'A bucket the transcript itself named, e.g. "Top priority", or null.',
          },
          confidence: { type: "number", description: "Between 0 and 1." },
          source_segment_id: {
            type: "string",
            description: 'One segment handle, e.g. "s0012". Must appear in the chunk.',
          },
          quote: {
            type: "string",
            description: "Copied exactly from the cited segment. Never paraphrased.",
          },
        },
      },
    },
  },
} as const;

/**
 * Propose action items from one chunk.
 *
 * Deliberately the same shape as `extractFromChunk`: strict decoding, so there
 * is no free-text JSON to parse, and the only two non-schema outcomes — a
 * refusal and a truncated response — are raised rather than returned as an
 * empty array. A chunk that failed must not be indistinguishable from a chunk
 * where nobody committed to anything, or a rate-limited run quietly becomes
 * "this meeting produced no follow-ups".
 */
export async function suggestFromChunk(args: {
  chunk: Chunk;
  meetingTitle: string | null;
  /**
   * Anchors relative phrases like "by Friday". The meeting's own date, never
   * the wall clock: re-running this job a month later must not slide every due
   * date a month forward.
   */
  meetingDate: Date;
  model?: string;
}): Promise<ChunkSuggestions> {
  const rendered = renderChunk(args.chunk, formatTimestamp);
  const header = args.meetingTitle ? `Meeting: ${args.meetingTitle}\n` : "";
  const dateLine = `Meeting date: ${args.meetingDate.toISOString().slice(0, 10)}\n\n`;

  const response = await client.responses.create({
    model: args.model ?? env.OPENAI_MODEL,
    input: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content:
          `${header}${dateLine}Transcript chunk ${args.chunk.index + 1}. Each line is one ` +
          `speaker turn, prefixed with its segment id.\n\n${rendered}\n\n` +
          `Propose action items. Cite only segment ids that appear above.`,
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "suggest_action_items",
        strict: true,
        schema: SUGGESTIONS_SCHEMA,
      },
    },
    reasoning: { effort: env.OPENAI_REASONING_EFFORT },
    max_output_tokens: 8_000,
  });

  const refusal = findRefusal(response);
  if (refusal) throw new SuggestionRefused(refusal);

  if (response.status === "incomplete") {
    throw new Error(
      `Suggestion response truncated (${response.incomplete_details?.reason ?? "unknown reason"}) — ` +
        "the chunk is too large for max_output_tokens",
    );
  }

  const text = response.output_text ?? "";
  return {
    suggestions: text ? coerceSuggestions(safeParse(text)) : [],
    inputTokens: response.usage?.input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
  };
}

function findRefusal(response: OpenAI.Responses.Response): string | null {
  for (const item of response.output ?? []) {
    if (item.type !== "message") continue;
    for (const part of item.content ?? []) {
      if (part.type === "refusal") return part.refusal;
    }
  }
  return null;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Only reachable if strict decoding is bypassed by a future API change.
    throw new Error("Suggestion response was not valid JSON despite strict schema");
  }
}

/**
 * The schema is strict, so the shape is already guaranteed — this is the belt
 * to that braces, and it applies the rules strict mode cannot express. A schema
 * change on either side degrades into dropped suggestions rather than a crash
 * halfway through a meeting's transcript.
 *
 * A missing citation is dropped here rather than defaulted, because a default
 * would be a fabricated provenance and those are worse than none.
 */
export function coerceSuggestions(input: unknown): SuggestedAction[] {
  if (typeof input !== "object" || input === null) return [];
  const raw = (input as { action_items?: unknown }).action_items;
  if (!Array.isArray(raw)) return [];

  const out: SuggestedAction[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const a = item as Record<string, unknown>;

    const title = str(a["title"]).slice(0, 300);
    const handle = str(a["source_segment_id"]);
    const quote = str(a["quote"]);
    if (!title || !handle || !quote) continue;

    out.push({
      title,
      description: nullableStr(a["description"], 4_000),
      ownerHint: nullableStr(a["owner_hint"], 200),
      dueDate: nullableStr(a["due_date"], 10),
      // 60 characters is what a group chip can show; a longer "bucket" is a
      // sentence, and a sentence is not a bucket.
      groupHint: nullableStr(a["group_hint"], 60),
      confidence: clamp01(Number(a["confidence"] ?? 0.5)),
      sourceHandle: handle,
      quote,
    });
  }
  return out;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function nullableStr(value: unknown, max: number): string | null {
  const text = str(value);
  return text ? text.slice(0, max) : null;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}
