import { describe, expect, it, vi } from "vitest";
import {
  ContentBriefRefused,
  HOOK_TEXT_MAX,
  MalformedBriefGenerationError,
  parseBriefResponse,
  retryOnceOnMalformed,
} from "../src/integrations/content-brief-model.js";

/**
 * The ContentBrief structured-output contract, tested without a network —
 * mirrors `extraction-output.test.ts`'s approach for `parseExtractionResponse`.
 * Strict mode guarantees the shape; this proves the coercion layer applies
 * every rule strict mode's schema subset cannot (non-empty claim_ids,
 * hook_text, emphasis_word, beats — 05 §3's "citation or refusal").
 */

const generated = (over: Record<string, unknown> = {}) => ({
  archetype: "pain_ladder",
  status: "generated",
  refusal_reason: null,
  claim_ids: ["claim-1"],
  hook_text: "Support tickets are eating your renewal margin",
  emphasis_word: "eating",
  beats: [{ role: "hook", script: "Opening line.", target_ms: 1200, fills_from: ["pain_point"] }],
  ...over,
});

const response = (over: Record<string, unknown> = {}) => ({
  status: "completed",
  output: [],
  output_text: JSON.stringify({ briefs: [generated()] }),
  usage: { input_tokens: 500, output_tokens: 200 },
  ...over,
});

describe("parseBriefResponse", () => {
  it("maps a schema-shaped generated entry into a ProposedBrief", () => {
    const parsed = parseBriefResponse(response());
    expect(parsed.briefs).toHaveLength(1);
    expect(parsed.briefs[0]!.archetype).toBe("pain_ladder");
    expect(parsed.briefs[0]!.claimIds).toEqual(["claim-1"]);
    expect(parsed.briefs[0]!.beats[0]!.role).toBe("hook");
    expect(parsed.refusals).toHaveLength(0);
    expect(parsed.inputTokens).toBe(500);
    expect(parsed.outputTokens).toBe(200);
  });

  it("treats an explicit status:refused entry as a refusal, never a brief", () => {
    const parsed = parseBriefResponse(
      response({
        output_text: JSON.stringify({
          briefs: [generated({ status: "refused", refusal_reason: "no proof point in memory", claim_ids: [], hook_text: "", emphasis_word: "", beats: [] })],
        }),
      }),
    );
    expect(parsed.briefs).toHaveLength(0);
    expect(parsed.refusals).toEqual([{ archetype: "pain_ladder", reason: "no proof point in memory" }]);
  });

  it("drops a 'generated' entry with an empty claim_ids array as a refusal (citation or refusal)", () => {
    const parsed = parseBriefResponse(response({ output_text: JSON.stringify({ briefs: [generated({ claim_ids: [] })] }) }));
    expect(parsed.briefs).toHaveLength(0);
    expect(parsed.refusals).toHaveLength(1);
  });

  it("drops a 'generated' entry whose hook_text is longer than the one-line cap (G9)", () => {
    const overLong = "x".repeat(HOOK_TEXT_MAX + 1);
    const parsed = parseBriefResponse(response({ output_text: JSON.stringify({ briefs: [generated({ hook_text: overLong })] }) }));
    expect(parsed.briefs).toHaveLength(0);
    expect(parsed.refusals).toHaveLength(1);
    expect(parsed.refusals[0]!.reason).toMatch(/one-line limit/);
  });

  it("keeps a hook_text exactly at the cap", () => {
    const atCap = "x".repeat(HOOK_TEXT_MAX);
    const parsed = parseBriefResponse(
      response({ output_text: JSON.stringify({ briefs: [generated({ hook_text: atCap, emphasis_word: "x" })] }) }),
    );
    expect(parsed.briefs).toHaveLength(1);
  });

  it("drops a 'generated' entry with an empty hook_text, emphasis_word, or beats array", () => {
    for (const over of [{ hook_text: "" }, { emphasis_word: "" }, { beats: [] }]) {
      const parsed = parseBriefResponse(response({ output_text: JSON.stringify({ briefs: [generated(over)] }) }));
      expect(parsed.briefs, JSON.stringify(over)).toHaveLength(0);
      expect(parsed.refusals).toHaveLength(1);
    }
  });

  it("drops a beat naming an unknown role, but keeps well-formed sibling beats", () => {
    const parsed = parseBriefResponse(
      response({
        output_text: JSON.stringify({
          briefs: [
            generated({
              beats: [
                { role: "hook", script: "ok", target_ms: 1000, fills_from: [] },
                { role: "not-a-role", script: "bad", target_ms: 1000, fills_from: [] },
              ],
            }),
          ],
        }),
      }),
    );
    expect(parsed.briefs[0]!.beats).toHaveLength(1);
    expect(parsed.briefs[0]!.beats[0]!.role).toBe("hook");
  });

  it("ignores an entry whose archetype is not in the enum, even for attributing a refusal", () => {
    const parsed = parseBriefResponse(response({ output_text: JSON.stringify({ briefs: [generated({ archetype: "not-a-real-archetype" })] }) }));
    expect(parsed.briefs).toHaveLength(0);
    expect(parsed.refusals).toHaveLength(0);
  });

  it("accepts an empty briefs array as a valid answer", () => {
    const parsed = parseBriefResponse(response({ output_text: JSON.stringify({ briefs: [] }) }));
    expect(parsed.briefs).toEqual([]);
    expect(parsed.refusals).toEqual([]);
  });

  it("surfaces a refusal as ContentBriefRefused, which is malformed output", () => {
    const refusing = response({
      output: [{ type: "message", content: [{ type: "refusal", refusal: "cannot comply" }] }],
      output_text: "",
    });
    expect(() => parseBriefResponse(refusing)).toThrowError(ContentBriefRefused);
    try {
      parseBriefResponse(refusing);
    } catch (error) {
      expect(error).toBeInstanceOf(MalformedBriefGenerationError);
    }
  });

  it("surfaces a truncated response as MalformedBriefGenerationError", () => {
    expect(() =>
      parseBriefResponse(response({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } })),
    ).toThrowError(MalformedBriefGenerationError);
  });

  it("surfaces non-JSON output_text as MalformedBriefGenerationError despite the strict schema", () => {
    expect(() => parseBriefResponse(response({ output_text: "not json {" }))).toThrowError(
      MalformedBriefGenerationError,
    );
  });
});

/**
 * The model-downshift retry (§12's minor: CONTENT_BRIEF_FALLBACK was declared
 * and documented but read by nothing). Mirrors extraction-output.test.ts's
 * coverage of integrations/openai.ts's retryOnceOnMalformed, extended with
 * the fallback-model dimension this one adds.
 */
describe("retryOnceOnMalformed", () => {
  it("succeeds on the first attempt using the primary model, without touching the fallback", async () => {
    const attempt = vi.fn<(model: string) => Promise<string>>().mockResolvedValue("ok");
    const { result, model } = await retryOnceOnMalformed(attempt, "primary-model", "fallback-model");
    expect(result).toBe("ok");
    expect(model).toBe("primary-model");
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(attempt).toHaveBeenCalledWith("primary-model");
  });

  it("downshifts to the fallback model when the primary's output is malformed, and reports which model answered", async () => {
    const attempt = vi
      .fn<(model: string) => Promise<string>>()
      .mockRejectedValueOnce(new MalformedBriefGenerationError("bad JSON"))
      .mockResolvedValueOnce("ok from fallback");
    const { result, model } = await retryOnceOnMalformed(attempt, "primary-model", "fallback-model");
    expect(result).toBe("ok from fallback");
    expect(model).toBe("fallback-model");
    expect(attempt).toHaveBeenNthCalledWith(1, "primary-model");
    expect(attempt).toHaveBeenNthCalledWith(2, "fallback-model");
  });

  it("fails, naming both models, when the fallback is also malformed", async () => {
    const attempt = vi.fn<(model: string) => Promise<string>>().mockRejectedValue(new MalformedBriefGenerationError("still bad"));
    await expect(retryOnceOnMalformed(attempt, "primary-model", "fallback-model")).rejects.toThrowError(
      /primary-model.*fallback-model/s,
    );
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("does not retry, and never touches the fallback, for an error that is not malformed output", async () => {
    const attempt = vi.fn<(model: string) => Promise<string>>().mockRejectedValue(new Error("ECONNRESET"));
    await expect(retryOnceOnMalformed(attempt, "primary-model", "fallback-model")).rejects.toThrowError("ECONNRESET");
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});
