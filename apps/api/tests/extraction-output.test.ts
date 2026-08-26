import { describe, expect, it, vi } from "vitest";
import {
  CONFIDENCE_VALUE,
  ExtractionRefused,
  MalformedExtractionError,
  parseExtractionResponse,
  retryOnceOnMalformed,
} from "../src/integrations/openai.js";

/**
 * The structured-output contract, tested without a network: what the model
 * hands back is either schema-shaped claims, a refusal, or a truncation — and
 * the two failure shapes must surface as MalformedExtractionError so the
 * retry-once policy can see them, never as silently-zero claims.
 */

const claim = (over: Record<string, unknown> = {}) => ({
  type: "icp_fact",
  text: "ICP sweet spot is 200-2,000 seats.",
  confidence: "high",
  evidence: {
    transcript_segment_ids: ["s0026"],
    verbatim_quote: "our sweet spot is really two hundred to two thousand seats",
    speaker: "Priya Raman",
    timestamp_ms: 262_000,
    ...(over["evidence"] as Record<string, unknown> | undefined),
  },
  ...over,
});

const response = (over: Record<string, unknown> = {}) => ({
  status: "completed",
  output: [],
  output_text: JSON.stringify({ claims: [claim()] }),
  usage: { input_tokens: 900, output_tokens: 120 },
  ...over,
});

describe("parseExtractionResponse", () => {
  it("maps schema-shaped output into claims with tiered confidence", () => {
    const parsed = parseExtractionResponse(response());
    expect(parsed.claims).toHaveLength(1);
    expect(parsed.claims[0]!.confidence).toBe(CONFIDENCE_VALUE.high);
    expect(parsed.claims[0]!.evidence.transcript_segment_ids).toEqual(["s0026"]);
    expect(parsed.inputTokens).toBe(900);
    expect(parsed.outputTokens).toBe(120);
  });

  it("maps every confidence tier onto its ordered numeric value", () => {
    expect(CONFIDENCE_VALUE.high).toBeGreaterThan(CONFIDENCE_VALUE.medium);
    expect(CONFIDENCE_VALUE.medium).toBeGreaterThan(CONFIDENCE_VALUE.low);
    for (const tier of ["high", "medium", "low"] as const) {
      const parsed = parseExtractionResponse(
        response({ output_text: JSON.stringify({ claims: [claim({ confidence: tier })] }) }),
      );
      expect(parsed.claims[0]!.confidence).toBe(CONFIDENCE_VALUE[tier]);
    }
  });

  it("treats an unknown confidence value as medium rather than crashing", () => {
    const parsed = parseExtractionResponse(
      response({ output_text: JSON.stringify({ claims: [claim({ confidence: "certain" })] }) }),
    );
    expect(parsed.claims[0]!.confidence).toBe(CONFIDENCE_VALUE.medium);
  });

  it("drops a claim whose type is not in the union", () => {
    const parsed = parseExtractionResponse(
      response({ output_text: JSON.stringify({ claims: [claim({ type: "meeting_summary" })] }) }),
    );
    expect(parsed.claims).toHaveLength(0);
  });

  it("drops a claim with no quote or no cited segments", () => {
    const noQuote = claim({ evidence: { verbatim_quote: "" } });
    const noSegments = claim({ evidence: { transcript_segment_ids: [] } });
    const parsed = parseExtractionResponse(
      response({ output_text: JSON.stringify({ claims: [noQuote, noSegments] }) }),
    );
    expect(parsed.claims).toHaveLength(0);
  });

  it("accepts an empty claims array as a valid answer", () => {
    const parsed = parseExtractionResponse(
      response({ output_text: JSON.stringify({ claims: [] }) }),
    );
    expect(parsed.claims).toEqual([]);
  });

  it("surfaces a refusal as ExtractionRefused, which is malformed output", () => {
    const refusing = response({
      output: [{ type: "message", content: [{ type: "refusal", refusal: "cannot comply" }] }],
      output_text: "",
    });
    expect(() => parseExtractionResponse(refusing)).toThrowError(ExtractionRefused);
    try {
      parseExtractionResponse(refusing);
    } catch (error) {
      expect(error).toBeInstanceOf(MalformedExtractionError);
    }
  });

  it("surfaces a truncated response as malformed, never as zero claims", () => {
    expect(() =>
      parseExtractionResponse(
        response({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }),
      ),
    ).toThrowError(MalformedExtractionError);
  });

  it("surfaces non-JSON output as malformed despite the strict schema", () => {
    expect(() =>
      parseExtractionResponse(response({ output_text: "Here are the claims: {..." })),
    ).toThrowError(MalformedExtractionError);
  });
});

describe("retryOnceOnMalformed", () => {
  it("retries exactly once when the first attempt is malformed", async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new MalformedExtractionError("bad JSON"))
      .mockResolvedValueOnce("ok");
    await expect(retryOnceOnMalformed(fn)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("fails with the reason after a second malformed attempt", async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(new MalformedExtractionError("truncated (max_output_tokens)"));
    await expect(retryOnceOnMalformed(fn)).rejects.toThrowError(/truncated \(max_output_tokens\)/);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not retry errors that are not malformed output", async () => {
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(new Error("ECONNRESET"));
    await expect(retryOnceOnMalformed(fn)).rejects.toThrowError("ECONNRESET");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
