import { ClaimType } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { parseTranscript } from "../src/domain/transcript.js";
import { segmentHandle } from "../src/domain/chunking.js";
import type { RecallTranscriptEntry } from "../src/integrations/recall.js";
import freshworksTranscript from "./fixtures/transcripts/golden-freshworks.json" with { type: "json" };
import freshworksAnswerKey from "./fixtures/transcripts/golden-answer-key.json" with { type: "json" };
import discoveryTranscript from "./fixtures/transcripts/golden-discovery.json" with { type: "json" };
import discoveryAnswerKey from "./fixtures/transcripts/golden-discovery-answer-key.json" with { type: "json" };

type AnswerKeyEntry = {
  type: string | null;
  text_gist: string;
  evidence_segment_ids: string[];
  must_extract: boolean;
};

/**
 * The one hard contract downstream agents build on: every id an answer key
 * cites must resolve to a segment that actually exists once the matching
 * transcript fixture is parsed the same way jobs/ingest-transcript.ts parses
 * a real Recall download. If this ever goes red, either the transcript or the
 * answer key drifted and every extraction/review/brief test built on top of
 * these fixtures is exercising fiction.
 */
function assertEvidenceResolves(answerKey: AnswerKeyEntry[], entries: RecallTranscriptEntry[]): void {
  const parsed = parseTranscript(entries);
  const validHandles = new Set(parsed.segments.map((s) => segmentHandle(s.idx)));

  for (const claim of answerKey) {
    expect(claim.evidence_segment_ids.length).toBeGreaterThan(0);
    for (const id of claim.evidence_segment_ids) {
      expect(validHandles.has(id)).toBe(true);
    }
  }
}

/**
 * `type` is a free-standing string in the fixture JSON, not an enum-checked
 * value — a typo (e.g. "postioning_statement") would still load and would
 * only surface downstream as a Prisma enum-validation error when a claim
 * actually gets persisted. Catching it here, against the same ClaimType
 * Prisma generates, keeps that failure local to the fixture that caused it.
 */
const VALID_CLAIM_TYPES = new Set<string>(Object.values(ClaimType));

function assertTypesAreValid(answerKey: AnswerKeyEntry[]): void {
  for (const claim of answerKey) {
    if (claim.type === null) continue;
    expect(VALID_CLAIM_TYPES.has(claim.type)).toBe(true);
  }
}

function countsByType(answerKey: AnswerKeyEntry[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const claim of answerKey) {
    const key = claim.must_extract ? (claim.type ?? "unknown") : "noise";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

describe("golden-freshworks fixture", () => {
  it("loads in under a second", () => {
    const start = performance.now();
    JSON.parse(JSON.stringify(freshworksTranscript));
    JSON.parse(JSON.stringify(freshworksAnswerKey));
    expect(performance.now() - start).toBeLessThan(1_000);
  });

  it("is a 30-40 minute, 4-speaker, 250-400 turn transcript", () => {
    const parsed = parseTranscript(freshworksTranscript as RecallTranscriptEntry[]);
    expect(parsed.segments.length).toBeGreaterThanOrEqual(250);
    expect(parsed.segments.length).toBeLessThanOrEqual(400);
    expect(parsed.durationMs).toBeGreaterThanOrEqual(30 * 60_000);
    expect(parsed.durationMs).toBeLessThanOrEqual(40 * 60_000);

    const speakers = new Set(parsed.segments.map((s) => s.speaker));
    expect(speakers.size).toBe(4);
  });

  it("every answer-key evidence_segment_ids entry resolves to a real segment", () => {
    assertEvidenceResolves(
      freshworksAnswerKey as AnswerKeyEntry[],
      freshworksTranscript as RecallTranscriptEntry[],
    );
  });

  it("every non-null answer-key type is a real ClaimType", () => {
    assertTypesAreValid(freshworksAnswerKey as AnswerKeyEntry[]);
  });

  it("meets the minimum count for every required claim type, plus noise", () => {
    const counts = countsByType(freshworksAnswerKey as AnswerKeyEntry[]);
    expect(counts["positioning_statement"] ?? 0).toBeGreaterThanOrEqual(5);
    expect(counts["icp_fact"] ?? 0).toBeGreaterThanOrEqual(4);
    expect(counts["pain_point"] ?? 0).toBeGreaterThanOrEqual(4);
    expect(counts["objection"] ?? 0).toBeGreaterThanOrEqual(3);
    expect(counts["messaging_decision"] ?? 0).toBeGreaterThanOrEqual(2);
    expect(counts["competitor_mention"] ?? 0).toBeGreaterThanOrEqual(2);
    expect(counts["proof_point"] ?? 0).toBeGreaterThanOrEqual(2);
    expect(counts["noise"] ?? 0).toBeGreaterThanOrEqual(5);
  });

  it("embeds the required verbatim positioning and proof phrases", () => {
    const parsed = parseTranscript(freshworksTranscript as RecallTranscriptEntry[]);
    const full = parsed.segments.map((s) => s.text).join(" | ");
    expect(full).toContain("mid-market IT teams underserved by legacy ITSM");
    expect(full.toLowerCase()).toContain("live in six days");
    expect(full).toContain("Acme");
  });

  it("names the required competitors", () => {
    const parsed = parseTranscript(freshworksTranscript as RecallTranscriptEntry[]);
    const full = parsed.segments.map((s) => s.text).join(" ");
    expect(full).toContain("Zendesk");
    expect(full).toContain("ServiceNow");
  });

  it("embeds the ICP seat-range fact (spoken form) and objection to security review", () => {
    const parsed = parseTranscript(freshworksTranscript as RecallTranscriptEntry[]);
    const full = parsed.segments.map((s) => s.text).join(" ");
    expect(full).toContain("two hundred to two thousand seats");
    expect(full.toLowerCase()).toContain("security review will take too long");
  });
});

describe("golden-discovery fixture", () => {
  it("loads in under a second", () => {
    const start = performance.now();
    JSON.parse(JSON.stringify(discoveryTranscript));
    JSON.parse(JSON.stringify(discoveryAnswerKey));
    expect(performance.now() - start).toBeLessThan(1_000);
  });

  it("is roughly a 15 minute call", () => {
    const parsed = parseTranscript(discoveryTranscript as RecallTranscriptEntry[]);
    expect(parsed.durationMs).toBeGreaterThanOrEqual(10 * 60_000);
    expect(parsed.durationMs).toBeLessThanOrEqual(20 * 60_000);
  });

  it("every answer-key evidence_segment_ids entry resolves to a real segment", () => {
    assertEvidenceResolves(
      discoveryAnswerKey as AnswerKeyEntry[],
      discoveryTranscript as RecallTranscriptEntry[],
    );
  });

  it("every non-null answer-key type is a real ClaimType", () => {
    assertTypesAreValid(discoveryAnswerKey as AnswerKeyEntry[]);
  });

  it("has its own mini set of claims and at least a couple of noise entries", () => {
    const counts = countsByType(discoveryAnswerKey as AnswerKeyEntry[]);
    const claimTypeCount = Object.keys(counts).filter((k) => k !== "noise").length;
    expect(claimTypeCount).toBeGreaterThanOrEqual(4);
    expect(counts["noise"] ?? 0).toBeGreaterThanOrEqual(2);
  });
});
