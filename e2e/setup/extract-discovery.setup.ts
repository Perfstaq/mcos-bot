import { ClaimStatus, MeetingStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import answerKey from "../../apps/api/tests/fixtures/transcripts/golden-discovery-answer-key.json" with { type: "json" };

/** See extract-freshworks.setup.ts for what this mock is and is not. Run
 *  separately (its own vitest invocation, its own module registry) so the
 *  discovery transcript's segment handles are never resolved against the
 *  freshworks answer key or vice versa — the two transcripts number their
 *  segments from zero independently. */
vi.mock("../../apps/api/src/integrations/openai.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../apps/api/src/integrations/openai.js")>();
  const { createExtractFromChunkMockFromAnswerKey } = await import(
    "../../apps/api/tests/helpers/llm-mock.js"
  );
  return { ...actual, extractFromChunk: createExtractFromChunkMockFromAnswerKey(answerKey) };
});

import { prisma } from "../../apps/api/src/db.js";
import { runExtraction } from "../../apps/api/src/jobs/extract.js";

describe("e2e setup — discovery golden meeting", () => {
  it("runs the real extraction pipeline against a deterministic mock and reaches in_review", async () => {
    const tenant = await prisma.tenant.findFirstOrThrow({ where: { slug: "freshworks-demo" } });
    const meeting = await prisma.meeting.findFirstOrThrow({
      where: { tenantId: tenant.id, title: "Golden: Freshworks discovery call" },
    });

    await runExtraction({ meetingId: meeting.id, tenantId: tenant.id });

    const after = await prisma.meeting.findUniqueOrThrow({ where: { id: meeting.id } });
    expect(after.status).toBe(MeetingStatus.in_review);

    const proposed = await prisma.candidateClaim.count({
      where: { meetingId: meeting.id, status: ClaimStatus.proposed },
    });
    expect(proposed).toBeGreaterThan(2);
  });
});
