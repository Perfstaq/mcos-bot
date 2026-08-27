import crypto from "node:crypto";
import { ClaimType, ContentBriefStatus, EvidenceKind, MeetingStatus } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb, seedTenant } from "./helpers.js";
import { HOOK_TEXT_MAX } from "../src/integrations/content-brief-model.js";

/**
 * The content-brief surface, tested as a contract — same posture as
 * `review-gate.test.ts`: fixtures are seeded straight into the database
 * (a BriefVersion + BriefClaim rows are exactly what M1's merge already
 * produces), and every state change goes through the HTTP surface a reviewer
 * — or the generation endpoint — actually uses.
 *
 * `integrations/content-brief-model.ts` is mocked so these tests exercise the
 * real citation/refusal and framework-scoring logic without a network call,
 * the same pattern `pipeline.test.ts` uses for `integrations/openai.js`.
 */
const generateBriefsFromModel = vi.fn();
vi.mock("../src/integrations/content-brief-model.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/integrations/content-brief-model.js")>();
  return { ...actual, generateBriefsFromModel: (...args: unknown[]) => generateBriefsFromModel(...args) };
});

let app: FastifyInstance;
let queues: typeof import("../src/queue.js");

let tenantId: string;

const HOME = { "x-tenant-slug": "freshworks-demo", "x-reviewer-email": "reviewer@test.example" };

beforeAll(async () => {
  queues = await import("../src/queue.js");
  app = await (await import("../src/server.js")).buildServer();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await queues?.closeQueues();
  await db.$disconnect();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await resetDb();
  const home = await seedTenant();
  tenantId = home.id;
});

/* ------------------------------------------------------------------ fixtures */

/** A BriefVersion + BriefClaim set — what mergeApprovedClaims already
 *  produces, seeded directly since content-gate's job starts downstream of it. */
async function seedBriefVersion(
  claims: Array<{ type: ClaimType; text: string; confidence?: number }>,
): Promise<{ versionId: string; version: number; claimIds: string[] }> {
  const meeting = await db.meeting.create({
    data: { tenantId, meetingUrl: "https://meet.google.com/seed", status: MeetingStatus.merged },
  });
  const evidence = await db.evidenceSource.create({
    data: { tenantId, kind: EvidenceKind.meeting_transcript, meetingId: meeting.id, capturedAt: new Date() },
  });
  const run = await db.extractionRun.create({
    data: { tenantId, meetingId: meeting.id, model: "test-model", promptVersion: "v1", status: "succeeded", chunkCount: 1 },
  });

  const created = [];
  for (const [i, c] of claims.entries()) {
    const claim = await db.candidateClaim.create({
      data: {
        tenantId,
        meetingId: meeting.id,
        evidenceSourceId: evidence.id,
        extractionRunId: run.id,
        type: c.type,
        text: c.text,
        confidence: c.confidence ?? 0.9,
        status: "approved",
        verbatimQuote: c.text,
        speaker: "Priya Raman",
        timestampMs: i * 1000,
        dedupeKey: `seed-${crypto.randomUUID()}`,
      },
    });
    created.push(claim);
  }

  const version = await db.briefVersion.create({
    data: { tenantId, version: 1, createdBy: "seed@test.example", addedCount: created.length, totalCount: created.length },
  });
  for (const claim of created) {
    await db.briefClaim.create({
      data: {
        tenantId,
        briefVersionId: version.id,
        claimId: claim.id,
        meetingId: meeting.id,
        type: claim.type,
        text: claim.text,
        verbatimQuote: claim.verbatimQuote,
        speaker: claim.speaker,
        timestampMs: claim.timestampMs,
        confidence: claim.confidence,
        introducedInVersion: 1,
      },
    });
  }
  return { versionId: version.id, version: version.version, claimIds: created.map((c) => c.id) };
}

/** A trivial mock response: one "generated" entry per requested archetype,
 *  citing the first candidate id it was given for that archetype. */
function mockGeneratesOnePerArchetype() {
  generateBriefsFromModel.mockImplementation(
    async (args: { requests: Array<{ archetype: string; candidates: Array<{ id: string }> }> }) => ({
      briefs: args.requests.map((r) => ({
        archetype: r.archetype,
        claimIds: [r.candidates[0]!.id],
        hookText: `Hook for ${r.archetype}`,
        emphasisWord: "Hook",
        beats: [{ role: "hook", script: "Opening line.", targetMs: 1500, fillsFrom: [] }],
      })),
      refusals: [],
      inputTokens: 100,
      outputTokens: 50,
      model: "gpt-5.6-sol",
    }),
  );
}

async function generate(body: Record<string, unknown>) {
  return app.inject({ method: "POST", url: "/api/v1/content/briefs", headers: HOME, payload: body });
}

/* --------------------------------------------------------------- generation */

describe("POST /content/briefs — generation", () => {
  it("generates a brief per feasible archetype, citing only claims it was actually given, framework resolved deterministically", async () => {
    const { versionId } = await seedBriefVersion([
      { type: ClaimType.pain_point, text: "Support tickets pile up during renewal season." },
      { type: ClaimType.objection, text: "Deals die in procurement, not on features." },
    ]);
    mockGeneratesOnePerArchetype();

    const response = await generate({ brief_version_id: versionId, channel: "reels", count: 1 });
    expect(response.statusCode).toBe(200);
    const body = response.json();

    expect(body.generated_count).toBe(1);
    const brief = body.briefs[0];
    expect(brief.status).toBe("proposed");
    // jobs_to_be_done is the only framework favoring pain_point/objection.
    expect(brief.framework.id).toBe("jobs_to_be_done");
    expect(brief.framework.evidence_tier).toBe("B");
    expect(["pain_ladder", "objection_killer"]).toContain(brief.archetype);
    expect(brief.expected_metric).toBeTruthy();
    expect(brief.claim_ids.length).toBeGreaterThan(0);
    expect(brief.claim_snapshots[0].text).toBeTruthy();
    expect(brief.generated_by_model).toBe("gpt-5.6-sol");

    const stored = await db.contentBrief.findUnique({ where: { id: brief.id } });
    expect(stored?.status).toBe(ContentBriefStatus.proposed);
  });

  it("refuses an archetype outright, before ever calling the model, when no claim signal supports it", async () => {
    const { versionId } = await seedBriefVersion([
      { type: ClaimType.pain_point, text: "Support tickets pile up during renewal season." },
    ]);
    mockGeneratesOnePerArchetype();

    // count=10 forces the ranking to walk every archetype, so at least one
    // with zero claim signal must be skipped and explicitly refused.
    const response = await generate({ brief_version_id: versionId, channel: "reels", count: 10 });
    const body = response.json();

    expect(body.refused_count).toBeGreaterThan(0);
    expect(body.refusals.some((r: { reason: string }) => /No approved claim/.test(r.reason))).toBe(true);
    // Never invents to pad the count.
    expect(body.generated_count + body.refused_count).toBeLessThanOrEqual(10);

    const requestedArchetypeCount = generateBriefsFromModel.mock.calls[0]![0].requests.length;
    expect(requestedArchetypeCount).toBeLessThan(10);
  });

  it("drops a brief and counts it as refused when the model cites a claim id it was never given (citation or refusal)", async () => {
    const { versionId } = await seedBriefVersion([
      { type: ClaimType.pain_point, text: "Support tickets pile up during renewal season." },
      { type: ClaimType.objection, text: "Deals die in procurement, not on features." },
    ]);
    generateBriefsFromModel.mockImplementation(async (args: { requests: Array<{ archetype: string }> }) => ({
      briefs: [
        {
          // Echo back whichever archetype was actually requested — which one
          // that is depends on tie-break order among equally-scored
          // archetypes, and is not this test's concern.
          archetype: args.requests[0]!.archetype,
          claimIds: ["not-a-real-claim-id"],
          hookText: "Invented hook",
          emphasisWord: "Invented",
          beats: [{ role: "hook", script: "x", targetMs: 1000, fillsFrom: [] }],
        },
      ],
      refusals: [],
      inputTokens: 10,
      outputTokens: 5,
      model: "gpt-5.6-sol",
    }));

    const response = await generate({ brief_version_id: versionId, channel: "reels", count: 1 });
    const body = response.json();

    expect(body.generated_count).toBe(0);
    expect(body.refused_count).toBe(1);
    expect(body.refusals[0].reason).toMatch(/cited no claim id/i);
    expect(await db.contentBrief.count()).toBe(0);
  });

  it("refuses every archetype without ever calling the model when the brief version has no approved claims", async () => {
    const { versionId } = await seedBriefVersion([]);

    const response = await generate({ brief_version_id: versionId, channel: "reels", count: 3 });
    const body = response.json();

    expect(body.generated_count).toBe(0);
    expect(body.refused_count).toBe(10); // all ten archetypes
    expect(generateBriefsFromModel).not.toHaveBeenCalled();
  });

  it("404s for a brief_version_id that does not exist", async () => {
    const response = await generate({ brief_version_id: crypto.randomUUID(), channel: "reels", count: 1 });
    expect(response.statusCode).toBe(404);
  });

  it("resolves the tenant's current brief version when brief_version_id is omitted", async () => {
    await seedBriefVersion([{ type: ClaimType.pain_point, text: "Older version's claim." }]);
    // A second version, higher-numbered and empty, is the one omission should
    // resolve to — proven by the returned brief_version number, independent
    // of whether it has claims to generate from.
    await db.briefVersion.create({ data: { tenantId, version: 2, createdBy: "seed@test.example", totalCount: 0 } });

    const response = await generate({ channel: "reels", count: 1 });
    expect(response.statusCode).toBe(200);
    expect(response.json().brief_version).toBe(2);
  });
});

/* ------------------------------------------------------------------- the gate */

describe("content-brief gate — approve / reject / edit / undo", () => {
  async function generateOne(): Promise<string> {
    const { versionId } = await seedBriefVersion([
      { type: ClaimType.pain_point, text: "Support tickets pile up during renewal season." },
      { type: ClaimType.objection, text: "Deals die in procurement, not on features." },
    ]);
    mockGeneratesOnePerArchetype();
    const response = await generate({ brief_version_id: versionId, channel: "reels", count: 1 });
    return response.json().briefs[0].id as string;
  }

  it("approves a proposed brief", async () => {
    const id = await generateOne();
    const response = await app.inject({ method: "POST", url: `/api/v1/content/briefs/${id}/approve`, headers: HOME, payload: {} });
    expect(response.statusCode).toBe(200);
    expect(response.json().brief.status).toBe("approved");
  });

  it("rejects a proposed brief", async () => {
    const id = await generateOne();
    const response = await app.inject({ method: "POST", url: `/api/v1/content/briefs/${id}/reject`, headers: HOME, payload: {} });
    expect(response.statusCode).toBe(200);
    expect(response.json().brief.status).toBe("rejected");
  });

  it("edit-approve writes a NEW row and marks the original superseded, preserving claim_ids", async () => {
    const id = await generateOne();
    const original = await db.contentBrief.findUniqueOrThrow({ where: { id } });

    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/content/briefs/${id}`,
      headers: HOME,
      payload: { hook_text: "A rewritten, sharper hook" },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.brief.status).toBe("superseded");
    expect(body.result_brief.status).toBe("approved");
    expect(body.result_brief.edited_from).toBe(id);

    const successor = await db.contentBrief.findUniqueOrThrow({ where: { id: body.result_brief.id } });
    expect(successor.hookText).toBe("A rewritten, sharper hook");
    expect(successor.claimIds).toEqual(original.claimIds);
  });

  it("refuses an edit that would reintroduce a hook longer than the one-line cap (G9)", async () => {
    const id = await generateOne();
    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/content/briefs/${id}`,
      headers: HOME,
      payload: { hook_text: "x".repeat(HOOK_TEXT_MAX + 1) },
    });
    expect(response.statusCode).toBe(400);
    expect(await db.contentBrief.count({ where: { status: ContentBriefStatus.superseded } })).toBe(0);
  });

  it("undo reverses an approve back to proposed", async () => {
    const id = await generateOne();
    await app.inject({ method: "POST", url: `/api/v1/content/briefs/${id}/approve`, headers: HOME, payload: {} });

    const response = await app.inject({ method: "POST", url: `/api/v1/content/briefs/${id}/undo`, headers: HOME, payload: {} });
    expect(response.statusCode).toBe(200);
    expect(response.json().brief.status).toBe("proposed");
  });

  it("refuses to decide a brief that was already replaced by an edit", async () => {
    const id = await generateOne();
    await app.inject({ method: "PATCH", url: `/api/v1/content/briefs/${id}`, headers: HOME, payload: { hook_text: "New hook" } });

    const response = await app.inject({ method: "POST", url: `/api/v1/content/briefs/${id}/approve`, headers: HOME, payload: {} });
    expect(response.statusCode).toBe(409);
  });

  it("GET /content/briefs lists the queue, defaulting to proposed", async () => {
    await generateOne();
    const response = await app.inject({ method: "GET", url: "/api/v1/content/briefs", headers: HOME });
    expect(response.statusCode).toBe(200);
    expect(response.json().briefs.length).toBe(1);
  });
});

/* ------------------------------------------------------- plan.build enforcement */

describe("POST /content/plans — approved-only enforcement", () => {
  async function seedTemplateAndFootage() {
    // MotionTemplate is a global catalog (no tenant_id — ARCHITECTURE.md §3)
    // so it is not wiped by resetDb()'s tenant-cascade truncate; a unique
    // name per call keeps repeated seeds in this describe block from
    // colliding on the (name, version) constraint.
    const template = await db.motionTemplate.create({
      data: {
        name: `vertical-standard-${crypto.randomUUID()}`,
        archetype: "objection_killer",
        framing: "letterbox",
        slots: {},
        fonts: {},
        grade: {},
      },
    });
    const footage = await db.mediaAsset.create({
      data: { tenantId, kind: "footage", r2Key: `tenants/${tenantId}/studio/footage/${crypto.randomUUID()}`, contentType: "video/mp4", bytes: 1000n },
    });
    return { templateId: template.id, footageAssetId: footage.id };
  }

  it("refuses to build a plan from a brief that is not approved", async () => {
    const { versionId } = await seedBriefVersion([{ type: ClaimType.pain_point, text: "x" }]);
    mockGeneratesOnePerArchetype();
    const gen = await generate({ brief_version_id: versionId, channel: "reels", count: 1 });
    const briefId = gen.json().briefs[0].id as string;
    const { templateId, footageAssetId } = await seedTemplateAndFootage();

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/content/plans",
      headers: HOME,
      payload: { content_brief_id: briefId, template_id: templateId, footage_asset_id: footageAssetId },
    });
    expect(response.statusCode).toBe(422);
  });

  it("accepts an approved brief and returns a queued plan handle", async () => {
    const { versionId } = await seedBriefVersion([{ type: ClaimType.pain_point, text: "x" }]);
    mockGeneratesOnePerArchetype();
    const gen = await generate({ brief_version_id: versionId, channel: "reels", count: 1 });
    const briefId = gen.json().briefs[0].id as string;
    await app.inject({ method: "POST", url: `/api/v1/content/briefs/${briefId}/approve`, headers: HOME, payload: {} });
    const { templateId, footageAssetId } = await seedTemplateAndFootage();

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/content/plans",
      headers: HOME,
      payload: { content_brief_id: briefId, template_id: templateId, footage_asset_id: footageAssetId },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("queued");
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("refuses to undo an approve once a render plan has been built from it", async () => {
    const { versionId } = await seedBriefVersion([{ type: ClaimType.pain_point, text: "x" }]);
    mockGeneratesOnePerArchetype();
    const gen = await generate({ brief_version_id: versionId, channel: "reels", count: 1 });
    const briefId = gen.json().briefs[0].id as string;
    await app.inject({ method: "POST", url: `/api/v1/content/briefs/${briefId}/approve`, headers: HOME, payload: {} });
    const { templateId, footageAssetId } = await seedTemplateAndFootage();

    // Simulate the plan.build worker having already materialized a RenderPlan
    // (that worker is out of this agent's scope — see routes/content.ts).
    await db.renderPlan.create({
      data: {
        tenantId,
        contentBriefId: briefId,
        templateId,
        footageAssetId,
        plan: {},
        seed: 1,
        planVersion: "1",
        createdBy: "test",
      },
    });

    const response = await app.inject({ method: "POST", url: `/api/v1/content/briefs/${briefId}/undo`, headers: HOME, payload: {} });
    expect(response.statusCode).toBe(409);
  });
});
