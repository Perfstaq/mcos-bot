import OpenAI from "openai";
import { ClaimType } from "@prisma/client";
import { env } from "../env.js";
import { CLAIM_TYPES, isClaimType } from "../domain/claims.js";
import { renderChunk, segmentHandle, type Chunk } from "../domain/chunking.js";
import { formatTimestamp } from "../domain/transcript.js";

/** Bumped whenever the prompt, the schema or the provider changes — every
 *  extraction_runs row records which harness produced its claims. */
export const PROMPT_VERSION = "propose_claims/v2-openai";

const client = new OpenAI({
  apiKey: env.OPENAI_API_KEY,
  maxRetries: 3,
  timeout: 120_000,
});

export type ProposedClaim = {
  type: ClaimType;
  text: string;
  confidence: number;
  evidence: {
    transcript_segment_ids: string[];
    verbatim_quote: string;
    speaker: string;
    timestamp_ms: number;
  };
};

export type ChunkExtraction = {
  claims: ProposedClaim[];
  inputTokens: number;
  outputTokens: number;
};

export class ExtractionRefused extends Error {
  constructor(readonly refusal: string) {
    super(`Model refused the extraction request: ${refusal}`);
    this.name = "ExtractionRefused";
  }
}

const SYSTEM_PROMPT = `You extract typed marketing-context claims from B2B meeting transcripts.

These claims become a company's Living Positioning Brief — a durable record of what
the company believes about its own positioning. Every claim you propose is reviewed
by a human before it enters that record. Your job is to propose precisely, not to
summarise.

You are NOT writing meeting notes. Do not produce summaries, action items,
next steps, attendee lists, or narrative recaps. Only typed claims.

The seven claim types:

- positioning_statement — how the company positions itself, its category, or its
  differentiation. "We are the system of record for X, not another Y tool."
- icp_fact — a concrete, checkable fact about who the ideal customer is: segment,
  company size, industry, role, buying trigger, budget owner.
- pain_point — a problem the customer or market experiences, stated as their problem.
- objection — a specific reason a buyer resists, hesitates, or pushes back.
- messaging_decision — an explicit decision about what to say, stop saying, or say
  differently. Requires a decision, not a musing.
- competitor_mention — a named competitor plus what was actually said about them.
- proof_point — a specific, citable piece of evidence: a metric, named customer,
  benchmark, award, or result.

Rules:

1. EVIDENCE IS MANDATORY. Every claim must cite at least one segment id from the
   transcript below, and verbatim_quote must be copied exactly from those segments.
   Never paraphrase inside verbatim_quote. Never cite a segment id that is not in
   the transcript you were given. A claim you cannot evidence is a claim you do
   not propose.
2. Write "text" as a standalone assertion the company could act on, in the third
   person, understandable without the transcript. Not "he said pricing is confusing"
   but "Mid-market buyers find the pricing page confusing at the tier boundaries."
3. One claim per idea. Do not bundle two facts into one claim.
4. confidence is a number between 0 and 1 reflecting how firmly the transcript
   supports the claim: 0.9+ when it is stated outright, 0.5-0.7 when it is implied
   or hedged, below 0.5 when it is a reasonable but uncertain reading.
5. Skip small talk, scheduling, and logistics entirely.
6. Returning an empty claims array is a valid and correct answer for a chunk that
   contains no positioning content. Do not manufacture claims to fill the response.`;

/**
 * Strict Structured Outputs schema.
 *
 * Strict mode is a hard grammar constraint, not a request: every object needs
 * `additionalProperties: false` and every property listed in `required`, and
 * validation keywords (`minimum`, `minItems`, …) are NOT part of the supported
 * subset. Ranges and non-empty-array rules are therefore enforced in
 * `coerceClaims` below and in the evidence gate in jobs/extract.ts, which is
 * where they were being enforced anyway — the model cannot be trusted to police
 * its own evidence.
 */
const CLAIMS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["claims"],
  properties: {
    claims: {
      type: "array",
      description: "The claims found in this chunk. Empty when the chunk contains none.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "text", "confidence", "evidence"],
        properties: {
          type: { type: "string", enum: [...CLAIM_TYPES] },
          text: { type: "string", description: "The claim as a standalone third-person assertion." },
          confidence: { type: "number", description: "Between 0 and 1." },
          evidence: {
            type: "object",
            additionalProperties: false,
            required: ["transcript_segment_ids", "verbatim_quote", "speaker", "timestamp_ms"],
            properties: {
              transcript_segment_ids: {
                type: "array",
                items: { type: "string" },
                description: 'Segment handles, e.g. ["s0012"]. Must appear in the chunk, and at least one is required.',
              },
              verbatim_quote: {
                type: "string",
                description: "Copied exactly from the cited segments. Never paraphrased.",
              },
              speaker: { type: "string" },
              timestamp_ms: { type: "integer", description: "Milliseconds from recording start." },
            },
          },
        },
      },
    },
  },
} as const;

/**
 * Extract claims from one chunk.
 *
 * Structured Outputs with `strict: true` constrains decoding to the schema, so
 * there is no free-text JSON to parse and no "the model wrapped it in a code
 * fence" failure mode. The only two non-schema outcomes are a refusal and an
 * incomplete response, and both are surfaced as errors rather than silently
 * becoming zero claims — a chunk that failed must not look like a chunk that
 * had nothing in it.
 */
export async function extractFromChunk(args: {
  chunk: Chunk;
  meetingTitle: string | null;
  model?: string;
}): Promise<ChunkExtraction> {
  const rendered = renderChunk(args.chunk, formatTimestamp);
  const header = args.meetingTitle ? `Meeting: ${args.meetingTitle}\n\n` : "";

  const response = await client.responses.create({
    model: args.model ?? env.OPENAI_MODEL,
    input: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content:
          `${header}Transcript chunk ${args.chunk.index + 1}. Each line is one speaker turn, ` +
          `prefixed with its segment id.\n\n${rendered}\n\n` +
          `Propose claims. Cite only segment ids that appear above.`,
      },
    ],
    text: {
      format: { type: "json_schema", name: "propose_claims", strict: true, schema: CLAIMS_SCHEMA },
    },
    reasoning: { effort: env.OPENAI_REASONING_EFFORT },
    max_output_tokens: 16_000,
  });

  const refusal = findRefusal(response);
  if (refusal) throw new ExtractionRefused(refusal);

  if (response.status === "incomplete") {
    throw new Error(
      `Extraction response truncated (${response.incomplete_details?.reason ?? "unknown reason"}) — ` +
        "the chunk is too large for max_output_tokens",
    );
  }

  const text = response.output_text ?? "";
  return {
    claims: text ? coerceClaims(safeParse(text)) : [],
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
    throw new Error("Extraction response was not valid JSON despite strict schema");
  }
}

/**
 * The schema is strict, so the shape is already guaranteed — this is the belt
 * to that braces. It exists so a schema change on either side degrades into
 * dropped claims rather than a runtime crash mid-pipeline, and it applies the
 * range and non-empty rules that strict mode cannot express.
 */
function coerceClaims(input: unknown): ProposedClaim[] {
  if (typeof input !== "object" || input === null) return [];
  const raw = (input as { claims?: unknown }).claims;
  if (!Array.isArray(raw)) return [];

  const out: ProposedClaim[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const c = item as Record<string, unknown>;
    const evidence = c["evidence"] as Record<string, unknown> | undefined;
    if (!evidence) continue;

    const type = typeof c["type"] === "string" ? c["type"] : "";
    if (!isClaimType(type)) continue;

    const text = typeof c["text"] === "string" ? c["text"].trim() : "";
    const quote = typeof evidence["verbatim_quote"] === "string" ? evidence["verbatim_quote"].trim() : "";
    const ids = Array.isArray(evidence["transcript_segment_ids"])
      ? evidence["transcript_segment_ids"].filter((v): v is string => typeof v === "string")
      : [];

    if (!text || !quote || ids.length === 0) continue;

    out.push({
      type,
      text,
      confidence: clamp01(Number(c["confidence"] ?? 0.5)),
      evidence: {
        transcript_segment_ids: ids,
        verbatim_quote: quote,
        speaker: typeof evidence["speaker"] === "string" ? evidence["speaker"] : "Unknown speaker",
        timestamp_ms: Math.max(0, Math.round(Number(evidence["timestamp_ms"] ?? 0)) || 0),
      },
    });
  }
  return out;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}

export { segmentHandle };

/* --------------------------------------------------------- meeting digest */

/** Bumped whenever the digest prompt or schema changes — meetings.digest_model
 *  records which harness produced a given digest, the same reasoning as
 *  PROMPT_VERSION above. */
export const DIGEST_PROMPT_VERSION = "meeting_digest/v1-openai";

export type MeetingDigest = {
  title: string;
  digest: string;
  /** The model actually used for this call — `args.model` when the caller
   *  overrode it, otherwise `env.DIGEST_MODEL` — so a caller recording
   *  provenance stores what really answered, not what the env default
   *  happened to be at storage time. */
  model: string;
  inputTokens: number;
  outputTokens: number;
};

export class DigestRefused extends Error {
  constructor(readonly refusal: string) {
    super(`Model refused the digest request: ${refusal}`);
    this.name = "DigestRefused";
  }
}

const DIGEST_SYSTEM_PROMPT = `You write a one-line title and a short digest for a B2B meeting transcript.

This is a convenience label shown in a meetings list and atop a review queue — not an
analysis, and not a substitute for reading the transcript. Be concrete and specific to
what was actually discussed; never generic ("Team sync", "Client call").

Rules:

1. "title" is under 80 characters, third person, naming the actual subject
   ("Mid-market pricing objections and the Zendesk comparison" not "Sales call").
2. "digest" is exactly three sentences, plain prose, summarising what the call was
   about and what came out of it. No bullet points, no headers, no claims about
   positioning that belong to the review gate instead — this is a summary for a
   human deciding whether to open the call, not a substitute for reviewing it.
3. Never invent attendees, numbers, or outcomes that are not evident from the
   excerpt. When the excerpt is thin, say so plainly rather than padding.`;

const DIGEST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "digest"],
  properties: {
    title: { type: "string", description: "Under 80 characters, third person, specific." },
    digest: { type: "string", description: "Exactly three sentences of plain prose." },
  },
} as const;

/**
 * Generate a one-line title and three-sentence digest from a transcript
 * excerpt.
 *
 * Deliberately the same strict-Structured-Outputs shape as `extractFromChunk`:
 * no free-text JSON to parse, and a refusal or truncated response is an error
 * rather than a silently empty digest — the caller (jobs/digest.ts) decides
 * what "no digest" means, this function never guesses.
 *
 * A NEW function, added alongside the existing extraction harness rather than
 * folded into it: the digest is a different prompt, a different (cheaper)
 * model tier, and a different failure posture (non-blocking), and giving it
 * its own entry point keeps all three from leaking into `extractFromChunk`.
 */
export async function generateMeetingDigest(args: {
  transcriptExcerpt: string;
  existingTitle: string | null;
  model?: string;
}): Promise<MeetingDigest> {
  // `jobs/digest.ts` never overwrites a title a human (or an earlier working
  // title) already gave the meeting — `meeting.title ?? result.title` only
  // ever reaches for `result.title` when there is none. So when
  // `existingTitle` is set, this call's own `title` output is guaranteed to
  // be discarded by its caller; the header says so rather than asking the
  // model to do work ("replace it with something better") that can never
  // land. The schema still requires `title` — this just stops the prompt
  // from promising an effect the code doesn't have.
  const header = args.existingTitle
    ? `For context only: this meeting already has the title "${args.existingTitle}", which is ` +
      `never overwritten by what you write here — "title" below is still required by the ` +
      `schema, but only used for a meeting that has no title yet.\n\n`
    : "";

  const model = args.model ?? env.DIGEST_MODEL;
  const response = await client.responses.create({
    model,
    input: [
      { role: "system", content: DIGEST_SYSTEM_PROMPT },
      {
        role: "user",
        content: `${header}Transcript excerpt:\n\n${args.transcriptExcerpt}\n\nWrite the title and digest.`,
      },
    ],
    text: { format: { type: "json_schema", name: "meeting_digest", strict: true, schema: DIGEST_SCHEMA } },
    reasoning: { effort: "minimal" },
    max_output_tokens: 1_000,
  });

  const refusal = findRefusal(response);
  if (refusal) throw new DigestRefused(refusal);

  if (response.status === "incomplete") {
    throw new Error(
      `Digest response truncated (${response.incomplete_details?.reason ?? "unknown reason"})`,
    );
  }

  const text = response.output_text ?? "";
  const parsed = text ? coerceDigest(safeParse(text)) : null;
  if (!parsed) throw new Error("Digest response did not contain a usable title and digest");

  return {
    ...parsed,
    model,
    inputTokens: response.usage?.input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
  };
}

function coerceDigest(input: unknown): { title: string; digest: string } | null {
  if (typeof input !== "object" || input === null) return null;
  const obj = input as Record<string, unknown>;
  const title = typeof obj["title"] === "string" ? obj["title"].trim().slice(0, 200) : "";
  const digest = typeof obj["digest"] === "string" ? obj["digest"].trim() : "";
  if (!title || !digest) return null;
  return { title, digest };
}
