import OpenAI from "openai";
import { ClaimType, ContentArchetype } from "@prisma/client";
import { env } from "../env.js";
import { CLAIM_TYPES } from "../domain/claims.js";

/**
 * ContentBrief generation — OpenAI Structured Outputs, its own client and its
 * own file.
 *
 * ARCHITECTURE.md §11.2 R5: `05_BRIEF_INTEGRATION.md §2` says "Anthropic
 * tool-calling schema" and `06_AGENTS_AND_MODELS.md §1` lists `claude-*`
 * runtime models; CLAUDE.md says "Do NOT switch LLM provider in this
 * milestone" and the only client wired anywhere in the service is OpenAI.
 * CLAUDE.md wins. This mirrors the proven house pattern in
 * `integrations/openai.ts` (Responses API, `strict: true` json_schema,
 * refusal/incomplete handling, a coercion layer for the non-empty-array rules
 * strict mode's schema subset cannot express) rather than importing from that
 * file directly — extraction and the meeting digest are a different concern
 * with a different model tier, and `openai.ts` is shared M1 code this
 * milestone does not otherwise touch.
 *
 * What this file does NOT decide: which framework backs a brief, its evidence
 * tier, or its expected metric. Those are scored deterministically against
 * claim-type signals by `domain/studio/frameworks.ts` — "framework selection
 * is the engine's job, not the user's" (05 §2) means a scoring function, not
 * an LLM guess. This model call writes only the creative surface (hook,
 * emphasis word, beats) and picks which of the candidate claims it is
 * actually citing for a given archetype.
 */

const client = new OpenAI({
  apiKey: env.OPENAI_API_KEY,
  maxRetries: 3,
  timeout: 120_000,
});

export type CandidateClaimForGeneration = {
  id: string;
  type: ClaimType;
  text: string;
};

export type BeatRole = "hook" | "agitate" | "resolve" | "proof" | "cta";
export const BEAT_ROLES: readonly BeatRole[] = ["hook", "agitate", "resolve", "proof", "cta"];

export type ProposedBeat = {
  role: BeatRole;
  script: string;
  targetMs: number;
  fillsFrom: ClaimType[];
};

/**
 * The hook banner's hard length cap — G9's carve-out, not a text-field
 * sanity bound. Strict mode's schema subset has no `maxLength`, so a hook
 * that fits the model's own idea of "short" can still wrap to two lines at
 * render time, breaching the ~6.3%-ink banner allowance in every frame of
 * the reel it's placed in — a gate violation baked into the output rather
 * than caught before it. Enforced here (over-long → refused, same posture
 * as every other citation/non-empty drop below) and again in
 * `routes/content.ts`'s edit schema, so a reviewer's rewrite can't
 * reintroduce it.
 *
 * PLACEHOLDER pending Agent T's measurement: the real constraint is "fits
 * one line at 0.062·W" against the template's actual font metrics, which
 * only T's template work can measure. 60 is a conservative guess (most
 * short-form hook copy runs 30-50 characters); replace with T's number once
 * it exists, in this one place.
 */
export const HOOK_TEXT_MAX = 60;

export type ProposedBrief = {
  archetype: ContentArchetype;
  claimIds: string[];
  hookText: string;
  emphasisWord: string;
  beats: ProposedBeat[];
};

export type BriefGenerationRefusal = { archetype: ContentArchetype; reason: string };

/** What `parseBriefResponse` (pure — no model identity to report) hands
 *  back. `generateBriefsFromModel` adds `model` on top of this, below. */
export type ParsedBriefGeneration = {
  briefs: ProposedBrief[];
  refusals: BriefGenerationRefusal[];
  inputTokens: number;
  outputTokens: number;
};

export type BriefGenerationResult = ParsedBriefGeneration & {
  /** The model that actually produced this result — `args.model`/
   *  `env.CONTENT_BRIEF_MODEL` normally, or the fallback when the primary's
   *  output was malformed and the retry used it instead. Recorded so a
   *  caller writing provenance (`ContentBrief.generatedByModel`) stores what
   *  really answered — same reasoning as `generateMeetingDigest`'s `model`
   *  field in `integrations/openai.ts`, and required by 06 §1: "never mix
   *  models within one brief." */
  model: string;
};

/** One archetype the caller wants generated, with the claims it may cite. */
export type BriefGenerationRequestItem = {
  archetype: ContentArchetype;
  /** Why this archetype was selected — claim-signal rationale, handed to the
   *  model as grounding, not as an instruction it can override. */
  frameworkWhenToUse: string;
  candidates: CandidateClaimForGeneration[];
};

/**
 * Output that violated the structured-output contract: a refusal, a
 * truncated response, or non-JSON text where the strict schema promised JSON.
 * One class for all three — same reasoning as `integrations/openai.ts`'s
 * `MalformedExtractionError` — because they share a policy (retry once, then
 * surface the reason) and the retry must not trigger on network errors the
 * OpenAI client already retries itself.
 */
export class MalformedBriefGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedBriefGenerationError";
  }
}

export class ContentBriefRefused extends MalformedBriefGenerationError {
  constructor(readonly refusal: string) {
    super(`Model refused the content brief generation request: ${refusal}`);
    this.name = "ContentBriefRefused";
  }
}

const ARCHETYPES = Object.values(ContentArchetype);

/**
 * Strict Structured Outputs schema. Same subset limitation as
 * `integrations/openai.ts`'s `CLAIMS_SCHEMA`: no `minItems`/`minLength`, so
 * "claim_ids must be non-empty", "hook_text must be non-empty" and "beats
 * must be non-empty" are enforced in `coerceBriefs` below, not here.
 */
const BRIEF_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["briefs"],
  properties: {
    briefs: {
      type: "array",
      description: "One entry per requested archetype, in the order requested.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["archetype", "status", "refusal_reason", "claim_ids", "hook_text", "emphasis_word", "beats"],
        properties: {
          archetype: { type: "string", enum: [...ARCHETYPES] },
          status: {
            type: "string",
            enum: ["generated", "refused"],
            description:
              '"refused" when the candidate claims handed to you do not genuinely support this ' +
              "archetype — say so in refusal_reason rather than inventing a hook.",
          },
          refusal_reason: {
            type: ["string", "null"],
            description: "Required when status is refused; null when generated.",
          },
          claim_ids: {
            type: "array",
            items: { type: "string" },
            description:
              "Which of the candidate claim ids you actually used. Must be a subset of the ids " +
              "given for this archetype. Empty when refused.",
          },
          hook_text: { type: "string", description: "The on-screen banner. Empty string when refused." },
          emphasis_word: {
            type: "string",
            description: "The ONE word in the hook that gets colour emphasis. Empty string when refused.",
          },
          beats: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["role", "script", "target_ms", "fills_from"],
              properties: {
                role: { type: "string", enum: [...BEAT_ROLES] },
                script: { type: "string" },
                target_ms: { type: "integer", description: "Approximate on-screen duration budget, in ms." },
                fills_from: {
                  type: "array",
                  items: { type: "string", enum: [...CLAIM_TYPES] },
                  description: "Which claim type(s) this beat's script draws from.",
                },
              },
            },
          },
        },
      },
    },
  },
} as const;

export type BriefModelResponse = {
  status?: string | null;
  incomplete_details?: { reason?: string | null } | null;
  output?: Array<{ type: string; content?: Array<{ type: string; refusal?: string }> | null }> | null;
  output_text?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number } | null;
};

function renderCandidates(items: BriefGenerationRequestItem[]): string {
  return items
    .map((item, i) => {
      const claims = item.candidates.map((c) => `  - [${c.id}] (${c.type}) "${c.text}"`).join("\n");
      return (
        `${i + 1}. archetype: ${item.archetype}\n` +
        `   why this archetype: ${item.frameworkWhenToUse}\n` +
        `   candidate claims (cite ONLY these ids; cite none and refuse if they do not fit):\n${claims}`
      );
    })
    .join("\n\n");
}

const SYSTEM_PROMPT = `You write short-form video content briefs for a B2B marketing team, from claims a human
has already approved into that company's positioning memory.

Rules, in order of importance:
1. CITATION OR REFUSAL. Every brief you generate must cite at least one of the candidate claim ids
   given for its archetype, copied exactly. Never invent a claim, a statistic, or a customer detail
   that is not backed by one of the candidates. If the candidates do not genuinely support the
   archetype, set status to "refused" and say why in refusal_reason — do not force a hook out of
   claims that do not fit.
2. One archetype produces one brief. Do not merge two archetypes into one hook.
3. hook_text is the on-screen banner: short, concrete, and specific to the claims cited — never
   generic ("Here's why we're different").
4. emphasis_word is exactly one word from hook_text.
5. beats sequence hook -> agitate -> resolve -> proof -> cta as the archetype calls for (not every
   archetype needs every role); each beat's script is a short spoken line, and fills_from names
   which claim type(s) it draws from.`;

/**
 * Run one attempt against `primary`; on malformed output only, run exactly
 * one more against `fallback` rather than hammering the primary a second
 * time — 06_AGENTS_AND_MODELS.md §1's fallback ladder ("never skip a rung"),
 * applied to a single call instead of a whole milestone. Extends
 * `integrations/openai.ts`'s `retryOnceOnMalformed` policy (same two-strikes
 * rule) with the model downshift `CONTENT_BRIEF_FALLBACK` exists for.
 */
export async function retryOnceOnMalformed<T>(
  attempt: (model: string) => Promise<T>,
  primary: string,
  fallback: string,
): Promise<{ result: T; model: string }> {
  try {
    return { result: await attempt(primary), model: primary };
  } catch (error) {
    if (!(error instanceof MalformedBriefGenerationError)) throw error;
    try {
      return { result: await attempt(fallback), model: fallback };
    } catch (retryError) {
      if (retryError instanceof MalformedBriefGenerationError) {
        throw new MalformedBriefGenerationError(
          `malformed content-brief generation output twice in a row (${primary}, then fallback ${fallback}): ${retryError.message}`,
        );
      }
      throw retryError;
    }
  }
}

export async function generateBriefsFromModel(args: {
  requests: BriefGenerationRequestItem[];
  model?: string;
  fallbackModel?: string;
}): Promise<BriefGenerationResult> {
  const primary = args.model ?? env.CONTENT_BRIEF_MODEL;
  const fallback = args.fallbackModel ?? env.CONTENT_BRIEF_FALLBACK;

  const { result, model } = await retryOnceOnMalformed(
    async (m) => {
      const response = await client.responses.create({
        model: m,
        input: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content:
              `Generate one content brief per archetype below.\n\n${renderCandidates(args.requests)}\n\n` +
              "Return exactly one entry per archetype listed, in the same order.",
          },
        ],
        text: { format: { type: "json_schema", name: "propose_content_briefs", strict: true, schema: BRIEF_SCHEMA } },
        reasoning: { effort: "medium" },
        max_output_tokens: 8_000,
      });

      return parseBriefResponse(response);
    },
    primary,
    fallback,
  );

  return { ...result, model };
}

export function parseBriefResponse(response: BriefModelResponse): ParsedBriefGeneration {
  const refusal = findRefusal(response);
  if (refusal) throw new ContentBriefRefused(refusal);

  if (response.status === "incomplete") {
    throw new MalformedBriefGenerationError(
      `content-brief generation response truncated (${response.incomplete_details?.reason ?? "unknown reason"})`,
    );
  }

  const text = response.output_text ?? "";
  const { briefs, refusals } = text ? coerceBriefs(safeParse(text)) : { briefs: [], refusals: [] };
  return {
    briefs,
    refusals,
    inputTokens: response.usage?.input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
  };
}

function findRefusal(response: BriefModelResponse): string | null {
  for (const item of response.output ?? []) {
    if (item.type !== "message") continue;
    for (const part of item.content ?? []) {
      if (part.type === "refusal" && part.refusal) return part.refusal;
    }
  }
  return null;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new MalformedBriefGenerationError(
      "content-brief generation response was not valid JSON despite the strict schema",
    );
  }
}

const ARCHETYPE_SET = new Set<string>(ARCHETYPES);
const BEAT_ROLE_SET = new Set<string>(BEAT_ROLES);
const CLAIM_TYPE_SET = new Set<string>(CLAIM_TYPES);

/**
 * `05 §1`: "emphasis_word: the ONE colored word" — meant to be a word FROM
 * hook_text, not an independent label. Case-insensitive because the model
 * (or a reviewer editing the hook) may return different capitalization than
 * where the word sits in the sentence (sentence-initial vs. mid-sentence),
 * and a byte-exact match would reject good output over casing alone.
 *
 * Exported so `domain/content-gate.ts`'s `editApprove` applies the identical
 * rule to a reviewer's edit — an edit that changes the hook or the emphasis
 * word independently can otherwise orphan the emphasis word from the text
 * it is supposed to be colouring.
 */
export function hookContainsEmphasisWord(hookText: string, emphasisWord: string): boolean {
  if (!emphasisWord.trim()) return false;
  return hookText.toLowerCase().includes(emphasisWord.trim().toLowerCase());
}

/**
 * The belt to strict mode's braces — see `integrations/openai.ts`'s
 * `coerceClaims` doc comment. Applies every non-empty-array/non-empty-string
 * rule strict mode's schema subset cannot express, and turns "refused" (or
 * any structurally invalid entry) into a `BriefGenerationRefusal` rather than
 * a persisted, hollow brief.
 */
function coerceBriefs(input: unknown): { briefs: ProposedBrief[]; refusals: BriefGenerationRefusal[] } {
  const briefs: ProposedBrief[] = [];
  const refusals: BriefGenerationRefusal[] = [];
  if (typeof input !== "object" || input === null) return { briefs, refusals };
  const raw = (input as { briefs?: unknown }).briefs;
  if (!Array.isArray(raw)) return { briefs, refusals };

  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const c = item as Record<string, unknown>;

    const archetype = typeof c["archetype"] === "string" ? c["archetype"] : "";
    if (!ARCHETYPE_SET.has(archetype)) continue; // cannot even attribute a refusal
    const typedArchetype = archetype as ContentArchetype;

    if (c["status"] !== "generated") {
      const reason = typeof c["refusal_reason"] === "string" && c["refusal_reason"] ? c["refusal_reason"] : "Model declined without a reason.";
      refusals.push({ archetype: typedArchetype, reason });
      continue;
    }

    const hookText = typeof c["hook_text"] === "string" ? c["hook_text"].trim() : "";
    const emphasisWord = typeof c["emphasis_word"] === "string" ? c["emphasis_word"].trim() : "";
    const claimIds = Array.isArray(c["claim_ids"])
      ? [...new Set(c["claim_ids"].filter((v): v is string => typeof v === "string" && v.trim().length > 0))]
      : [];
    const beats = coerceBeats(c["beats"]);

    // Citation or refusal (00_MASTER §4.3 / 05 §3): a "generated" brief with
    // no citations, no hook, or no beats is not a brief — it is exactly the
    // dropped-and-counted case, tracked here as a refusal so the caller can
    // report it rather than silently losing it.
    if (!hookText || !emphasisWord || claimIds.length === 0 || beats.length === 0) {
      refusals.push({
        archetype: typedArchetype,
        reason: "Generated output failed the citation/non-empty check and was dropped.",
      });
      continue;
    }

    // G9's banner carve-out (see HOOK_TEXT_MAX's doc comment): a hook that
    // does not fit one line renders a gate violation into every frame, so it
    // is dropped exactly like a missing citation, not truncated and shipped.
    if (hookText.length > HOOK_TEXT_MAX) {
      refusals.push({
        archetype: typedArchetype,
        reason: `Hook text is ${hookText.length} characters, over the ${HOOK_TEXT_MAX}-character one-line limit.`,
      });
      continue;
    }

    // 05 §1: emphasis_word must actually BE the coloured word IN the hook —
    // not an independent label the renderer can never find and highlight.
    if (!hookContainsEmphasisWord(hookText, emphasisWord)) {
      refusals.push({
        archetype: typedArchetype,
        reason: `emphasis_word "${emphasisWord}" does not appear in hook_text.`,
      });
      continue;
    }

    briefs.push({ archetype: typedArchetype, claimIds, hookText, emphasisWord, beats });
  }

  return { briefs, refusals };
}

function coerceBeats(raw: unknown): ProposedBeat[] {
  if (!Array.isArray(raw)) return [];
  const out: ProposedBeat[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const b = item as Record<string, unknown>;
    const role = typeof b["role"] === "string" && BEAT_ROLE_SET.has(b["role"]) ? (b["role"] as BeatRole) : null;
    const script = typeof b["script"] === "string" ? b["script"].trim() : "";
    if (!role || !script) continue;
    const fillsFrom = Array.isArray(b["fills_from"])
      ? b["fills_from"].filter((v): v is ClaimType => typeof v === "string" && CLAIM_TYPE_SET.has(v))
      : [];
    const targetMs = Math.max(0, Math.round(Number(b["target_ms"] ?? 0)) || 0);
    out.push({ role, script, targetMs, fillsFrom });
  }
  return out;
}
