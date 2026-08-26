import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaimStatus, ClaimType, EvidenceKind, MeetingStatus, ReviewAction } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, resetDb, seedTenant } from "./helpers.js";

/**
 * The review gate, tested as a contract.
 *
 * Claims are seeded straight into the database because a *proposed* claim is
 * exactly what extraction is allowed to write — the gate is what happens next,
 * and that is what this file is about. Nothing here writes an approved status
 * by hand: every state change goes through the HTTP surface a reviewer uses,
 * which is the whole point of the invariant these tests defend.
 */

let app: FastifyInstance;
let queues: typeof import("../src/queue.js");

let tenantId: string;
let otherTenantId: string;
let meetingId: string;
let otherMeetingId: string;

const HOME = { "x-tenant-slug": "freshworks-demo", "x-reviewer-email": "reviewer@test.example" };
const AWAY = { "x-tenant-slug": "rival-corp", "x-reviewer-email": "spy@rival.example" };

type SeededClaim = { id: string; text: string; type: ClaimType; confidence: number };

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
  await resetDb();
  const home = await seedTenant();
  const away = await seedTenant("rival-corp");
  tenantId = home.id;
  otherTenantId = away.id;
  meetingId = await seedMeeting(tenantId, "Mid-market positioning review");
  otherMeetingId = await seedMeeting(otherTenantId, "Rival internal sync");
});

/* ------------------------------------------------------------------ fixtures */

async function seedMeeting(tenant: string, title: string): Promise<string> {
  const meeting = await db.meeting.create({
    data: {
      tenantId: tenant,
      title,
      meetingUrl: `https://meet.google.com/${title.replace(/\W+/g, "-").toLowerCase()}`,
      status: MeetingStatus.in_review,
      startedAt: new Date("2026-08-20T10:00:00Z"),
    },
  });

  const evidence = await db.evidenceSource.create({
    data: {
      tenantId: tenant,
      kind: EvidenceKind.meeting_transcript,
      meetingId: meeting.id,
      externalId: `transcript-${meeting.id}`,
      capturedAt: new Date("2026-08-20T11:00:00Z"),
    },
  });

  const transcript = await db.transcript.create({
    data: {
      tenantId: tenant,
      meetingId: meeting.id,
      evidenceSourceId: evidence.id,
      provider: "recall",
      segmentCount: 3,
      wordCount: 60,
      durationMs: 180_000,
    },
  });

  await db.transcriptSegment.createMany({
    data: [0, 1, 2].map((idx) => ({
      tenantId: tenant,
      transcriptId: transcript.id,
      idx,
      speaker: idx === 1 ? "Priya Raman" : "Daniel Cho",
      startMs: idx * 60_000,
      endMs: idx * 60_000 + 55_000,
      text: SEGMENT_TEXT[idx]!,
    })),
  });

  await db.extractionRun.create({
    data: {
      tenantId: tenant,
      meetingId: meeting.id,
      model: "gpt-5.6-terra",
      promptVersion: "propose_claims/v2-openai",
      status: "succeeded",
      chunkCount: 1,
    },
  });

  return meeting.id;
}

const SEGMENT_TEXT = [
  "Our sweet spot is two hundred to two thousand seats, nothing smaller.",
  "We are not a ticketing tool, we are the operating system for IT service delivery.",
  "Every deal we lost last quarter died on the procurement review, not on features.",
];

/** Seed proposed claims — extraction's legitimate output, pre-gate. */
async function seedClaims(
  tenant: string,
  meeting: string,
  specs: Array<{ type: ClaimType; text: string; confidence: number; segmentIdx?: number }>,
): Promise<SeededClaim[]> {
  const transcript = await db.transcript.findUniqueOrThrow({ where: { meetingId: meeting } });
  const evidence = await db.evidenceSource.findFirstOrThrow({ where: { meetingId: meeting } });
  const run = await db.extractionRun.findFirstOrThrow({ where: { meetingId: meeting } });
  const segments = await db.transcriptSegment.findMany({
    where: { transcriptId: transcript.id },
    orderBy: { idx: "asc" },
  });

  const out: SeededClaim[] = [];
  for (const [i, spec] of specs.entries()) {
    const segment = segments[spec.segmentIdx ?? i % segments.length]!;
    const created = await db.candidateClaim.create({
      data: {
        tenantId: tenant,
        meetingId: meeting,
        evidenceSourceId: evidence.id,
        extractionRunId: run.id,
        type: spec.type,
        text: spec.text,
        confidence: spec.confidence,
        verbatimQuote: segment.text,
        speaker: segment.speaker,
        timestampMs: segment.startMs,
        dedupeKey: `seed-${meeting.slice(0, 8)}-${i}`,
      },
    });
    await db.claimSegment.create({ data: { claimId: created.id, segmentId: segment.id } });
    out.push({ id: created.id, text: spec.text, type: spec.type, confidence: spec.confidence });
  }
  return out;
}

const THREE_CLAIMS = [
  { type: ClaimType.icp_fact, text: "ICP sweet spot is 200-2,000 seats.", confidence: 0.94 },
  {
    type: ClaimType.positioning_statement,
    text: "Not a ticketing tool: the operating system for IT service delivery.",
    confidence: 0.91,
  },
  { type: ClaimType.objection, text: "Deals die in procurement review, not on features.", confidence: 0.52 },
];

/* ------------------------------------------------------------------- reading */

describe("review queue", () => {
  it("serves proposed claims for one meeting with full provenance on every card", async () => {
    const seeded = await seedClaims(tenantId, meetingId, THREE_CLAIMS);

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/review-queue?status=proposed&meeting_id=${meetingId}`,
      headers: HOME,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.claims).toHaveLength(seeded.length);

    for (const claim of body.claims) {
      expect(claim.type).toBeTruthy();
      expect(claim.type_label).toBeTruthy();
      expect(claim.status).toBe("proposed");
      expect(typeof claim.confidence).toBe("number");
      expect(claim.evidence.verbatim_quote.length).toBeGreaterThan(10);
      expect(claim.evidence.speaker).toBeTruthy();
      expect(claim.evidence.timestamp_label).toMatch(/^\d+:\d{2}$/);
      expect(claim.evidence.segments.length).toBeGreaterThan(0);
      expect(claim.evidence.segments[0].id).toBeTruthy();
      expect(claim.meeting.id).toBe(meetingId);
    }
  });

  it("bands confidence so the bulk panel knows what is safe to keep in one keystroke", async () => {
    await seedClaims(tenantId, meetingId, THREE_CLAIMS);

    const body = (
      await app.inject({ method: "GET", url: "/api/v1/review-queue", headers: HOME })
    ).json();

    const bands = Object.fromEntries(body.claims.map((c: { text: string; confidence_band: string }) => [c.text, c.confidence_band]));
    expect(bands["ICP sweet spot is 200-2,000 seats."]).toBe("high");
    expect(bands["Not a ticketing tool: the operating system for IT service delivery."]).toBe("high");
    expect(bands["Deals die in procurement review, not on features."]).toBe("low");
  });

  it("never shows another tenant's claims", async () => {
    await seedClaims(otherTenantId, otherMeetingId, THREE_CLAIMS);

    const mine = (await app.inject({ method: "GET", url: "/api/v1/review-queue", headers: HOME })).json();
    expect(mine.claims).toHaveLength(0);

    const scoped = await app.inject({
      method: "GET",
      url: `/api/v1/review-queue?meeting_id=${otherMeetingId}`,
      headers: HOME,
    });
    expect(scoped.json().claims).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ deciding */

describe("approve and reject", () => {
  it("approves a claim and records who decided it, when, and how", async () => {
    const [claim] = await seedClaims(tenantId, meetingId, THREE_CLAIMS);

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/claims/${claim!.id}/approve`,
      headers: { ...HOME, "x-reviewer-email": "priya@freshworks.example" },
      payload: { note: "checked against the deck" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().claim.status).toBe("approved");

    const stored = await db.candidateClaim.findUniqueOrThrow({ where: { id: claim!.id } });
    expect(stored.status).toBe(ClaimStatus.approved);
    expect(stored.decidedAt).toBeInstanceOf(Date);

    const decisions = await db.reviewDecision.findMany({ where: { claimId: claim!.id } });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.action).toBe(ReviewAction.approve);
    expect(decisions[0]!.reviewer).toBe("priya@freshworks.example");
    expect(decisions[0]!.note).toBe("checked against the deck");
    expect(decisions[0]!.createdAt).toBeInstanceOf(Date);
    expect(decisions[0]!.tenantId).toBe(tenantId);
  });

  it("keeps a rejected claim's row and logs the decision", async () => {
    const [claim] = await seedClaims(tenantId, meetingId, THREE_CLAIMS);

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/claims/${claim!.id}/reject`,
      headers: HOME,
      payload: { note: "already in the brief" },
    });
    expect(response.statusCode).toBe(200);

    const stored = await db.candidateClaim.findUnique({ where: { id: claim!.id } });
    expect(stored).not.toBeNull();
    expect(stored!.status).toBe(ClaimStatus.rejected);

    const decisions = await db.reviewDecision.findMany({ where: { claimId: claim!.id } });
    expect(decisions[0]!.action).toBe(ReviewAction.reject);
  });

  it("404s on another tenant's claim instead of deciding it", async () => {
    const [theirs] = await seedClaims(otherTenantId, otherMeetingId, THREE_CLAIMS);

    for (const url of [`/api/v1/claims/${theirs!.id}/approve`, `/api/v1/claims/${theirs!.id}/reject`]) {
      const response = await app.inject({ method: "POST", url, headers: HOME, payload: {} });
      expect(response.statusCode).toBe(404);
    }

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/v1/claims/${theirs!.id}`,
      headers: HOME,
      payload: { text: "Rewritten by someone who should not see this." },
    });
    expect(patched.statusCode).toBe(404);

    const undone = await app.inject({
      method: "POST",
      url: `/api/v1/claims/${theirs!.id}/undo`,
      headers: HOME,
      payload: {},
    });
    expect(undone.statusCode).toBe(404);

    const stored = await db.candidateClaim.findUniqueOrThrow({ where: { id: theirs!.id } });
    expect(stored.status).toBe(ClaimStatus.proposed);
    expect(await db.reviewDecision.count()).toBe(0);
  });
});

/* ---------------------------------------------------------------- edit gate */

describe("edit-approve", () => {
  it("writes a new approved claim, supersedes the original and keeps its evidence", async () => {
    const [claim] = await seedClaims(tenantId, meetingId, THREE_CLAIMS);
    const before = await db.candidateClaim.findUniqueOrThrow({
      where: { id: claim!.id },
      include: { segments: true },
    });

    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/claims/${claim!.id}`,
      headers: { ...HOME, "x-reviewer-email": "priya@freshworks.example" },
      payload: { text: "ICP sweet spot is 200-2,000 seats, IT-led." },
    });
    expect(response.statusCode).toBe(200);

    const original = await db.candidateClaim.findUniqueOrThrow({ where: { id: claim!.id } });
    expect(original.status).toBe(ClaimStatus.superseded);
    expect(original.text).toBe(claim!.text);

    const successor = await db.candidateClaim.findFirstOrThrow({
      where: { editedFromId: claim!.id },
      include: { segments: true },
    });
    expect(successor.id).not.toBe(claim!.id);
    expect(successor.status).toBe(ClaimStatus.approved);
    expect(successor.text).toBe("ICP sweet spot is 200-2,000 seats, IT-led.");
    expect(successor.type).toBe(before.type);
    expect(successor.confidence).toBe(before.confidence);
    // Same evidence, carried across verbatim. An edited claim that lost its
    // provenance would be a claim nobody can check.
    expect(successor.verbatimQuote).toBe(before.verbatimQuote);
    expect(successor.speaker).toBe(before.speaker);
    expect(successor.timestampMs).toBe(before.timestampMs);
    expect(successor.evidenceSourceId).toBe(before.evidenceSourceId);
    expect(successor.segments.map((s) => s.segmentId).sort()).toEqual(
      before.segments.map((s) => s.segmentId).sort(),
    );

    const decisions = await db.reviewDecision.findMany({ where: { claimId: claim!.id } });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.action).toBe(ReviewAction.edit_approve);
    expect(decisions[0]!.reviewer).toBe("priya@freshworks.example");
    expect(decisions[0]!.previousText).toBe(claim!.text);
    expect(decisions[0]!.editedText).toBe("ICP sweet spot is 200-2,000 seats, IT-led.");
    expect(decisions[0]!.resultClaimId).toBe(successor.id);
  });

  it("keeps the lineage flat when an edit is itself edited", async () => {
    const [claim] = await seedClaims(tenantId, meetingId, THREE_CLAIMS);

    await app.inject({
      method: "PATCH",
      url: `/api/v1/claims/${claim!.id}`,
      headers: HOME,
      payload: { text: "First rewrite of the ICP claim." },
    });
    const first = await db.candidateClaim.findFirstOrThrow({ where: { editedFromId: claim!.id } });

    const second = await app.inject({
      method: "PATCH",
      url: `/api/v1/claims/${first.id}`,
      headers: HOME,
      payload: { text: "Second rewrite of the ICP claim." },
    });
    expect(second.statusCode).toBe(200);

    const lineage = await db.candidateClaim.findMany({
      where: { OR: [{ id: claim!.id }, { editedFromId: claim!.id }] },
      orderBy: { createdAt: "asc" },
    });
    expect(lineage).toHaveLength(3);
    expect(lineage.map((c) => c.status)).toEqual([
      ClaimStatus.superseded,
      ClaimStatus.superseded,
      ClaimStatus.approved,
    ]);
    // Every successor points at the ORIGINAL, so the brief has one stable
    // identity for the claim no matter how many times it is rewritten.
    expect(lineage[2]!.editedFromId).toBe(claim!.id);
  });

  it("refuses to re-decide a superseded claim", async () => {
    const [claim] = await seedClaims(tenantId, meetingId, THREE_CLAIMS);
    await app.inject({
      method: "PATCH",
      url: `/api/v1/claims/${claim!.id}`,
      headers: HOME,
      payload: { text: "A rewrite that supersedes the original." },
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/claims/${claim!.id}/approve`,
      headers: HOME,
      payload: {},
    });
    expect(response.statusCode).toBe(409);

    const original = await db.candidateClaim.findUniqueOrThrow({ where: { id: claim!.id } });
    expect(original.status).toBe(ClaimStatus.superseded);
  });
});

/* --------------------------------------------------------------- bulk keep */

describe("bulk approve", () => {
  it("keeps every high-confidence claim and reports the rest per id", async () => {
    const seeded = await seedClaims(tenantId, meetingId, THREE_CLAIMS);
    const lowConfidence = seeded[2]!;

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/claims/bulk-approve",
      headers: HOME,
      payload: { claim_ids: seeded.map((c) => c.id) },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.approved.map((c: { id: string }) => c.id).sort()).toEqual(
      [seeded[0]!.id, seeded[1]!.id].sort(),
    );
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].claim_id).toBe(lowConfidence.id);
    expect(body.errors[0].code).toBe("not_high_confidence");
    expect(body.errors[0].message).toBeTruthy();

    const still = await db.candidateClaim.findUniqueOrThrow({ where: { id: lowConfidence.id } });
    expect(still.status).toBe(ClaimStatus.proposed);
    expect(await db.reviewDecision.count()).toBe(2);
  });

  it("reports unknown and cross-tenant ids as not found without touching them", async () => {
    const mine = await seedClaims(tenantId, meetingId, [THREE_CLAIMS[0]!]);
    const [theirs] = await seedClaims(otherTenantId, otherMeetingId, [THREE_CLAIMS[0]!]);
    const ghost = "00000000-0000-4000-8000-000000000000";

    const body = (
      await app.inject({
        method: "POST",
        url: "/api/v1/claims/bulk-approve",
        headers: HOME,
        payload: { claim_ids: [mine[0]!.id, theirs!.id, ghost] },
      })
    ).json();

    expect(body.approved).toHaveLength(1);
    expect(body.errors.map((e: { claim_id: string; code: string }) => e.code)).toEqual([
      "not_found",
      "not_found",
    ]);

    const untouched = await db.candidateClaim.findUniqueOrThrow({ where: { id: theirs!.id } });
    expect(untouched.status).toBe(ClaimStatus.proposed);
    expect(await db.reviewDecision.count({ where: { tenantId: otherTenantId } })).toBe(0);
  });

  it("refuses to silently re-decide a claim that has already been reviewed", async () => {
    const seeded = await seedClaims(tenantId, meetingId, [THREE_CLAIMS[0]!, THREE_CLAIMS[1]!]);
    await app.inject({
      method: "POST",
      url: `/api/v1/claims/${seeded[0]!.id}/reject`,
      headers: HOME,
      payload: {},
    });

    const body = (
      await app.inject({
        method: "POST",
        url: "/api/v1/claims/bulk-approve",
        headers: HOME,
        payload: { claim_ids: seeded.map((c) => c.id) },
      })
    ).json();

    expect(body.approved).toHaveLength(1);
    expect(body.errors[0].code).toBe("already_decided");
    const rejected = await db.candidateClaim.findUniqueOrThrow({ where: { id: seeded[0]!.id } });
    expect(rejected.status).toBe(ClaimStatus.rejected);
  });
});

/* -------------------------------------------------------------------- undo */

describe("undo", () => {
  it("compensates an approval with another logged decision instead of erasing one", async () => {
    const [claim] = await seedClaims(tenantId, meetingId, THREE_CLAIMS);
    await app.inject({ method: "POST", url: `/api/v1/claims/${claim!.id}/approve`, headers: HOME, payload: {} });

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/claims/${claim!.id}/undo`,
      headers: HOME,
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().claim.status).toBe("proposed");

    const back = await db.candidateClaim.findUniqueOrThrow({ where: { id: claim!.id } });
    expect(back.status).toBe(ClaimStatus.proposed);
    expect(back.decidedAt).toBeNull();

    // The approval is still on the record. Undo adds history, it never removes it.
    const decisions = await db.reviewDecision.findMany({
      where: { claimId: claim!.id },
      orderBy: { createdAt: "asc" },
    });
    expect(decisions).toHaveLength(2);
    expect(decisions[0]!.action).toBe(ReviewAction.approve);
    expect(decisions[1]!.action).toBe(ReviewAction.undo);
  });

  it("withdraws an edit by rejecting the successor and reproposing the original", async () => {
    const [claim] = await seedClaims(tenantId, meetingId, THREE_CLAIMS);
    await app.inject({
      method: "PATCH",
      url: `/api/v1/claims/${claim!.id}`,
      headers: HOME,
      payload: { text: "An edit the reviewer immediately regrets." },
    });
    const successor = await db.candidateClaim.findFirstOrThrow({ where: { editedFromId: claim!.id } });

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/claims/${claim!.id}/undo`,
      headers: HOME,
      payload: {},
    });
    expect(response.statusCode).toBe(200);

    const original = await db.candidateClaim.findUniqueOrThrow({ where: { id: claim!.id } });
    expect(original.status).toBe(ClaimStatus.proposed);

    const withdrawn = await db.candidateClaim.findUniqueOrThrow({ where: { id: successor.id } });
    expect(withdrawn.status).toBe(ClaimStatus.rejected);

    const undo = await db.reviewDecision.findFirstOrThrow({
      where: { claimId: claim!.id, action: ReviewAction.undo },
    });
    expect(undo.resultClaimId).toBe(successor.id);
  });

  it("refuses to undo a decision that has already reached the brief", async () => {
    const [claim] = await seedClaims(tenantId, meetingId, THREE_CLAIMS);
    await app.inject({ method: "POST", url: `/api/v1/claims/${claim!.id}/approve`, headers: HOME, payload: {} });
    await app.inject({ method: "POST", url: "/api/v1/brief/versions", headers: HOME, payload: {} });

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/claims/${claim!.id}/undo`,
      headers: HOME,
      payload: {},
    });
    expect(response.statusCode).toBe(409);
  });

  it("refuses to undo a claim nobody has decided", async () => {
    const [claim] = await seedClaims(tenantId, meetingId, THREE_CLAIMS);
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/claims/${claim!.id}/undo`,
      headers: HOME,
      payload: {},
    });
    expect(response.statusCode).toBe(409);
  });
});

/* ------------------------------------------------------------- audit feed */

describe("session audit feed", () => {
  it("returns this tenant's decisions newest first, filterable by meeting", async () => {
    const seeded = await seedClaims(tenantId, meetingId, THREE_CLAIMS);
    const elsewhere = await seedMeeting(tenantId, "Another call");
    const other = await seedClaims(tenantId, elsewhere, [THREE_CLAIMS[0]!]);
    const [theirs] = await seedClaims(otherTenantId, otherMeetingId, [THREE_CLAIMS[0]!]);

    await app.inject({ method: "POST", url: `/api/v1/claims/${seeded[0]!.id}/approve`, headers: HOME, payload: {} });
    await app.inject({ method: "POST", url: `/api/v1/claims/${seeded[1]!.id}/reject`, headers: HOME, payload: {} });
    await app.inject({ method: "POST", url: `/api/v1/claims/${other[0]!.id}/approve`, headers: HOME, payload: {} });
    await app.inject({ method: "POST", url: `/api/v1/claims/${theirs!.id}/approve`, headers: AWAY, payload: {} });

    const all = (await app.inject({ method: "GET", url: "/api/v1/review-decisions", headers: HOME })).json();
    expect(all.decisions).toHaveLength(3);
    expect(all.decisions[0].claim.id).toBe(other[0]!.id);

    const scoped = (
      await app.inject({
        method: "GET",
        url: `/api/v1/review-decisions?meeting_id=${meetingId}`,
        headers: HOME,
      })
    ).json();
    expect(scoped.decisions).toHaveLength(2);
    expect(scoped.decisions.every((d: { claim: { meeting_id: string } }) => d.claim.meeting_id === meetingId)).toBe(true);
  });
});

/* ------------------------------------------------------- the gate itself */

describe("gate enforcement", () => {
  it("leaves no decided claim without an audit row", async () => {
    const seeded = await seedClaims(tenantId, meetingId, THREE_CLAIMS);

    await app.inject({ method: "POST", url: `/api/v1/claims/${seeded[0]!.id}/approve`, headers: HOME, payload: {} });
    await app.inject({ method: "POST", url: `/api/v1/claims/${seeded[1]!.id}/reject`, headers: HOME, payload: {} });
    await app.inject({
      method: "PATCH",
      url: `/api/v1/claims/${seeded[2]!.id}`,
      headers: HOME,
      payload: { text: "Procurement review, not features, is where deals die." },
    });

    const claims = await db.candidateClaim.findMany({ where: { meetingId } });
    const decisions = await db.reviewDecision.findMany({ where: { tenantId } });
    const covered = new Set<string>();
    for (const d of decisions) {
      covered.add(d.claimId);
      if (d.resultClaimId) covered.add(d.resultClaimId);
    }

    for (const claim of claims) {
      if (claim.status === ClaimStatus.proposed) continue;
      expect(covered.has(claim.id)).toBe(true);
    }
    expect(claims.some((c) => c.status === ClaimStatus.approved)).toBe(true);
    expect(claims.some((c) => c.status === ClaimStatus.superseded)).toBe(true);
  });

  it("has exactly one module in src/ that is allowed to write a claim status", async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const srcRoot = path.resolve(here, "../src");
    const gate = path.join(srcRoot, "domain", "review-gate.ts");
    expect(fs.existsSync(gate)).toBe(true);

    const offenders: string[] = [];
    for (const file of walk(srcRoot)) {
      if (file === gate) continue;
      const source = fs.readFileSync(file, "utf-8");
      for (const call of claimWriteCalls(source)) {
        if (/\bstatus\s*:/.test(call.args)) {
          offenders.push(`${path.relative(srcRoot, file)} -> candidateClaim.${call.op}`);
        }
      }
    }

    expect(offenders).toEqual([]);

    // …and the gate really is where that write lives, so this test cannot pass
    // by the codebase having no write path at all.
    const gateSource = fs.readFileSync(gate, "utf-8");
    expect(claimWriteCalls(gateSource).some((c) => /\bstatus\s*:/.test(c.args))).toBe(true);
  });
});

function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile() && full.endsWith(".ts")) yield full;
  }
}

/**
 * Every `candidateClaim.<write>(…)` call in a source file, with its argument
 * text. Balanced-paren scan rather than a regex, so a nested object or a
 * multi-line call is captured whole and an unrelated `status:` elsewhere in the
 * file cannot make this test cry wolf.
 */
function claimWriteCalls(source: string): Array<{ op: string; args: string }> {
  const found: Array<{ op: string; args: string }> = [];
  const pattern = /candidateClaim\.(update|updateMany|upsert|create|createMany|createManyAndReturn)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    let depth = 1;
    let i = pattern.lastIndex;
    while (i < source.length && depth > 0) {
      if (source[i] === "(") depth += 1;
      else if (source[i] === ")") depth -= 1;
      i += 1;
    }
    found.push({ op: match[1]!, args: source.slice(pattern.lastIndex, i - 1) });
  }
  return found;
}

/* -------------------------------------------- edits, merges and deletions */

describe("an edited claim that reached the brief", () => {
  /**
   * The lineage root is what brief_claims points at, and brief_claims cascades
   * from candidate_claims. Purging a meeting deletes every claim that never
   * reached a brief — so if the merge forgets to stamp the superseded root,
   * the purge takes a published version's row with it. Brief versions are
   * immutable; this is invariant 3 with a delete statement behind it.
   */
  it("survives its meeting being purged", async () => {
    const [claim] = await seedClaims(tenantId, meetingId, THREE_CLAIMS);

    await app.inject({
      method: "PATCH",
      url: `/api/v1/claims/${claim!.id}`,
      headers: HOME,
      payload: { text: "ICP sweet spot is 200-2,000 seats, IT-led." },
    });
    const merged = await app.inject({ method: "POST", url: "/api/v1/brief/versions", headers: HOME, payload: {} });
    expect(merged.statusCode).toBe(201);

    // Both the successor AND the superseded root it is filed under must be
    // stamped, or the purge below sweeps the root away.
    const root = await db.candidateClaim.findUniqueOrThrow({ where: { id: claim!.id } });
    expect(root.status).toBe(ClaimStatus.superseded);
    expect(root.mergedAt).toBeInstanceOf(Date);

    const purged = await app.inject({ method: "DELETE", url: `/api/v1/meetings/${meetingId}`, headers: HOME });
    expect(purged.statusCode).toBeLessThan(300);

    const v1 = (await app.inject({ method: "GET", url: "/api/v1/brief/versions/1", headers: HOME })).json();
    expect(v1.total).toBe(1);
    expect(v1.claims_by_type[0].claims[0].text).toBe("ICP sweet spot is 200-2,000 seats, IT-led.");
    // The evidence is redacted, as a purge should. The claim itself is not gone.
    expect(v1.claims_by_type[0].claims[0].evidence.redacted).toBe(true);
    expect(await db.briefClaim.count()).toBe(1);
  });
});

describe("undoing an edit that was itself edited", () => {
  /**
   * Withdrawing a link in the middle of the chain would put the original back
   * in the queue while its grandchild stayed approved — two live claims in one
   * lineage, which the brief cannot represent, because a lineage is exactly one
   * row there. The merge would then die on a unique constraint and stay dead.
   */
  it("is refused, pointing at the newer edit", async () => {
    const [claim] = await seedClaims(tenantId, meetingId, THREE_CLAIMS);

    await app.inject({
      method: "PATCH",
      url: `/api/v1/claims/${claim!.id}`,
      headers: HOME,
      payload: { text: "First rewrite." },
    });
    const first = await db.candidateClaim.findFirstOrThrow({ where: { editedFromId: claim!.id } });
    await app.inject({
      method: "PATCH",
      url: `/api/v1/claims/${first.id}`,
      headers: HOME,
      payload: { text: "Second rewrite." },
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/claims/${claim!.id}/undo`,
      headers: HOME,
      payload: {},
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toMatch(/itself edited/i);

    // Nothing moved: exactly one live claim in the lineage, and it is the last
    // rewrite. The merge that follows must not explode.
    const lineage = await db.candidateClaim.findMany({
      where: { OR: [{ id: claim!.id }, { editedFromId: claim!.id }] },
      orderBy: { createdAt: "asc" },
    });
    expect(lineage.filter((c) => c.status === ClaimStatus.approved)).toHaveLength(1);
    expect(lineage.filter((c) => c.status === ClaimStatus.approved)[0]!.text).toBe("Second rewrite.");

    const merged = await app.inject({ method: "POST", url: "/api/v1/brief/versions", headers: HOME, payload: {} });
    expect(merged.statusCode).toBe(201);
  });

  it("succeeds when the newest edit is unwound first", async () => {
    const [claim] = await seedClaims(tenantId, meetingId, THREE_CLAIMS);

    await app.inject({
      method: "PATCH",
      url: `/api/v1/claims/${claim!.id}`,
      headers: HOME,
      payload: { text: "First rewrite." },
    });
    const first = await db.candidateClaim.findFirstOrThrow({ where: { editedFromId: claim!.id } });
    await app.inject({
      method: "PATCH",
      url: `/api/v1/claims/${first.id}`,
      headers: HOME,
      payload: { text: "Second rewrite." },
    });

    const unwindNewer = await app.inject({
      method: "POST",
      url: `/api/v1/claims/${first.id}/undo`,
      headers: HOME,
      payload: {},
    });
    expect(unwindNewer.statusCode).toBe(200);

    const unwindOlder = await app.inject({
      method: "POST",
      url: `/api/v1/claims/${claim!.id}/undo`,
      headers: HOME,
      payload: {},
    });
    expect(unwindOlder.statusCode).toBe(200);

    const original = await db.candidateClaim.findUniqueOrThrow({ where: { id: claim!.id } });
    expect(original.status).toBe(ClaimStatus.proposed);
  });
});

describe("two live claims in one lineage", () => {
  /**
   * The gate no longer allows this state to be reached. If a future change ever
   * does, the merge must say which claims collided rather than surfacing a raw
   * unique-constraint failure as a 500 and wedging every later merge.
   */
  it("is refused by the merge with an explanation, not a 500", async () => {
    const [claim] = await seedClaims(tenantId, meetingId, THREE_CLAIMS);
    await app.inject({
      method: "PATCH",
      url: `/api/v1/claims/${claim!.id}`,
      headers: HOME,
      payload: { text: "The legitimate rewrite." },
    });
    const successor = await db.candidateClaim.findFirstOrThrow({ where: { editedFromId: claim!.id } });

    // Forge the impossible state directly, bypassing the gate on purpose.
    await db.candidateClaim.create({
      data: {
        tenantId,
        meetingId,
        evidenceSourceId: successor.evidenceSourceId,
        extractionRunId: successor.extractionRunId,
        type: successor.type,
        text: "A second live claim in the same lineage.",
        confidence: successor.confidence,
        status: ClaimStatus.approved,
        verbatimQuote: successor.verbatimQuote,
        speaker: successor.speaker,
        timestampMs: successor.timestampMs,
        dedupeKey: "forged-duplicate-lineage",
        editedFromId: claim!.id,
      },
    });

    const response = await app.inject({ method: "POST", url: "/api/v1/brief/versions", headers: HOME, payload: {} });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toMatch(/share the edit lineage/i);
    expect(await db.briefVersion.count()).toBe(0);
  });
});

/* ------------------------------------------------------------ concurrency */

describe("racing decisions", () => {
  it("refuses to re-decide a claim the way it is already decided", async () => {
    const [claim] = await seedClaims(tenantId, meetingId, THREE_CLAIMS);
    await app.inject({ method: "POST", url: `/api/v1/claims/${claim!.id}/approve`, headers: HOME, payload: {} });

    const again = await app.inject({
      method: "POST",
      url: `/api/v1/claims/${claim!.id}/approve`,
      headers: HOME,
      payload: {},
    });
    expect(again.statusCode).toBe(409);

    // One decision, because one thing was decided.
    expect(await db.reviewDecision.count({ where: { claimId: claim!.id } })).toBe(1);
  });

  it("lets exactly one of two simultaneous decisions win", async () => {
    const [claim] = await seedClaims(tenantId, meetingId, THREE_CLAIMS);

    const [approve, reject] = await Promise.all([
      app.inject({ method: "POST", url: `/api/v1/claims/${claim!.id}/approve`, headers: HOME, payload: {} }),
      app.inject({ method: "POST", url: `/api/v1/claims/${claim!.id}/reject`, headers: HOME, payload: {} }),
    ]);

    // Either order is legitimate; what is not legitimate is both landing and
    // the audit log disagreeing with the claim.
    const outcomes = [approve.statusCode, reject.statusCode].sort();
    expect(outcomes[0]).toBe(200);

    const stored = await db.candidateClaim.findUniqueOrThrow({ where: { id: claim!.id } });
    const decisions = await db.reviewDecision.findMany({ where: { claimId: claim!.id } });

    if (outcomes[1] === 200) {
      // Both were serialised cleanly: the last decision is the claim's state.
      const last = decisions.sort((a, b) => +a.createdAt - +b.createdAt).at(-1)!;
      expect(last.action).toBe(stored.status === ClaimStatus.approved ? ReviewAction.approve : ReviewAction.reject);
    } else {
      expect(outcomes[1]).toBe(409);
      expect(decisions).toHaveLength(1);
      expect(decisions[0]!.action).toBe(
        stored.status === ClaimStatus.approved ? ReviewAction.approve : ReviewAction.reject,
      );
    }
  });

  it("reports a conflict per id when a claim is decided under the batch", async () => {
    const seeded = await seedClaims(tenantId, meetingId, [THREE_CLAIMS[0]!, THREE_CLAIMS[1]!]);
    const { runWithContext } = await import("../src/context.js");
    const { recordDecision } = await import("../src/domain/review-gate.js");

    // The state the batch was assembled against, asserted inside the write
    // transaction. A claim someone rejected in the gap must not be flipped.
    await app.inject({ method: "POST", url: `/api/v1/claims/${seeded[0]!.id}/reject`, headers: HOME, payload: {} });

    await runWithContext(
      { tenantId, tenantSlug: "freshworks-demo", reviewer: "reviewer@test.example" },
      async () => {
        await expect(
          recordDecision({
            claimId: seeded[0]!.id,
            reviewer: "reviewer@test.example",
            action: "approve",
            expectStatus: ClaimStatus.proposed,
          }),
        ).rejects.toMatchObject({ status: 409 });
      },
    );

    const stored = await db.candidateClaim.findUniqueOrThrow({ where: { id: seeded[0]!.id } });
    expect(stored.status).toBe(ClaimStatus.rejected);
    expect(await db.reviewDecision.count({ where: { claimId: seeded[0]!.id } })).toBe(1);
  });
});

/* ------------------------------------------------- the brief, still intact */

describe("merge after an edit", () => {
  it("carries an edited claim into the next version as an edit, not a duplicate", async () => {
    const [claim] = await seedClaims(tenantId, meetingId, THREE_CLAIMS);

    await app.inject({ method: "POST", url: `/api/v1/claims/${claim!.id}/approve`, headers: HOME, payload: {} });
    const first = await app.inject({ method: "POST", url: "/api/v1/brief/versions", headers: HOME, payload: {} });
    expect(first.statusCode).toBe(201);

    await app.inject({
      method: "PATCH",
      url: `/api/v1/claims/${claim!.id}`,
      headers: HOME,
      payload: { text: "ICP sweet spot is 200-2,000 seats, IT-led." },
    });
    const second = await app.inject({ method: "POST", url: "/api/v1/brief/versions", headers: HOME, payload: {} });
    expect(second.statusCode).toBe(201);
    expect(second.json().version).toMatchObject({ version: 2, added: 0, edited: 1, total: 1 });

    const current = (await app.inject({ method: "GET", url: "/api/v1/brief/current", headers: HOME })).json();
    expect(current.total).toBe(1);
    expect(current.claims_by_type[0].claims[0].text).toBe("ICP sweet spot is 200-2,000 seats, IT-led.");

    const diff = (
      await app.inject({ method: "GET", url: "/api/v1/brief/versions/1/diff/2", headers: HOME })
    ).json();
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.edited).toHaveLength(1);
    expect(diff.edited[0].before).toBe(claim!.text);
    expect(diff.edited[0].after).toBe("ICP sweet spot is 200-2,000 seats, IT-led.");
  });

  /**
   * Whether a claim is still in the brief is a question about the lineage's
   * CURRENT member, not its root. These two cases pull in opposite directions
   * and both run through the same branch.
   */
  it("drops a lineage out when the edit that replaced the original is rejected", async () => {
    const [claim] = await seedClaims(tenantId, meetingId, THREE_CLAIMS);

    await app.inject({ method: "POST", url: `/api/v1/claims/${claim!.id}/approve`, headers: HOME, payload: {} });
    await app.inject({ method: "POST", url: "/api/v1/brief/versions", headers: HOME, payload: {} });

    await app.inject({
      method: "PATCH",
      url: `/api/v1/claims/${claim!.id}`,
      headers: HOME,
      payload: { text: "A rewrite that turns out to be wrong." },
    });
    await app.inject({ method: "POST", url: "/api/v1/brief/versions", headers: HOME, payload: {} });

    const successor = await db.candidateClaim.findFirstOrThrow({ where: { editedFromId: claim!.id } });
    await app.inject({ method: "POST", url: `/api/v1/claims/${successor.id}/reject`, headers: HOME, payload: {} });

    const third = await app.inject({ method: "POST", url: "/api/v1/brief/versions", headers: HOME, payload: {} });
    expect(third.statusCode).toBe(201);
    expect(third.json().version).toMatchObject({ version: 3, removed: 1, total: 0 });

    const current = (await app.inject({ method: "GET", url: "/api/v1/brief/current", headers: HOME })).json();
    expect(current.total).toBe(0);

    // The versions that already contained it still do. Append-only means the
    // brief loses a claim going forward, never retroactively.
    const v2 = (await app.inject({ method: "GET", url: "/api/v1/brief/versions/2", headers: HOME })).json();
    expect(v2.total).toBe(1);
  });

  it("keeps a lineage when an edit is withdrawn by undo rather than rejected", async () => {
    const [claim] = await seedClaims(tenantId, meetingId, THREE_CLAIMS);

    await app.inject({ method: "POST", url: `/api/v1/claims/${claim!.id}/approve`, headers: HOME, payload: {} });
    await app.inject({ method: "POST", url: "/api/v1/brief/versions", headers: HOME, payload: {} });

    // Edit, then think better of it. Undo marks the abandoned successor
    // rejected — which must NOT read as "the reviewer rejected this claim".
    await app.inject({
      method: "PATCH",
      url: `/api/v1/claims/${claim!.id}`,
      headers: HOME,
      payload: { text: "An edit the reviewer immediately regrets." },
    });
    const undone = await app.inject({
      method: "POST",
      url: `/api/v1/claims/${claim!.id}/undo`,
      headers: HOME,
      payload: {},
    });
    expect(undone.statusCode).toBe(200);

    const successor = await db.candidateClaim.findFirstOrThrow({ where: { editedFromId: claim!.id } });
    expect(successor.status).toBe(ClaimStatus.rejected);

    // Nothing to merge — and crucially, no removal either.
    const second = await app.inject({ method: "POST", url: "/api/v1/brief/versions", headers: HOME, payload: {} });
    expect(second.statusCode).toBe(409);

    const current = (await app.inject({ method: "GET", url: "/api/v1/brief/current", headers: HOME })).json();
    expect(current.version).toBe(1);
    expect(current.total).toBe(1);
    expect(current.claims_by_type[0].claims[0].text).toBe(claim!.text);
  });
});
