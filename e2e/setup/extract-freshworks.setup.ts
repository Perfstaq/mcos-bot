import { ClaimStatus, MeetingStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import answerKey from "../../apps/api/tests/fixtures/transcripts/golden-answer-key.json" with { type: "json" };

/**
 * The env-gated, test-only extraction stub the milestone spec asks for —
 * wired the same way `apps/api/tests/brief.test.ts` already wires it for the
 * unit suite: `extractFromChunk` is replaced with
 * `createExtractFromChunkMockFromAnswerKey`, so `jobs/extract.ts` (untouched)
 * runs its real evidence gate against deterministic, answer-key-driven
 * output instead of a live OpenAI call. This file is never imported by
 * `apps/api/src/*` or by production code — it only exists to be run,
 * explicitly, by e2e/global-setup.ts and e2e/tests/ring.spec.ts, against the
 * self-contained e2e database. It is not a gate bypass: the claims it
 * produces still have to survive `jobs/extract.ts`'s validation, still land
 * as `proposed`, and still require a human decision through the real review
 * routes before anything reaches the brief — see ring.spec.ts.
 */
vi.mock("../../apps/api/src/integrations/openai.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../apps/api/src/integrations/openai.js")>();
  const { createExtractFromChunkMockFromAnswerKey } = await import(
    "../../apps/api/tests/helpers/llm-mock.js"
  );
  return { ...actual, extractFromChunk: createExtractFromChunkMockFromAnswerKey(answerKey) };
});

import { prisma } from "../../apps/api/src/db.js";
import { runExtraction } from "../../apps/api/src/jobs/extract.js";

describe("e2e setup — freshworks golden meeting", () => {
  it("runs the real extraction pipeline against a deterministic mock and reaches in_review", async () => {
    const tenant = await prisma.tenant.findFirstOrThrow({ where: { slug: "freshworks-demo" } });
    const meeting = await prisma.meeting.findFirstOrThrow({
      where: { tenantId: tenant.id, title: "Golden: Freshworks positioning workshop" },
    });

    await runExtraction({ meetingId: meeting.id, tenantId: tenant.id });

    const after = await prisma.meeting.findUniqueOrThrow({ where: { id: meeting.id } });
    expect(after.status).toBe(MeetingStatus.in_review);

    const proposed = await prisma.candidateClaim.count({
      where: { meetingId: meeting.id, status: ClaimStatus.proposed },
    });
    expect(proposed).toBeGreaterThan(10);
  });
});
