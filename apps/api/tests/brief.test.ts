import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaimStatus } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb, seedTenant } from "./helpers.js";
import freshworksAnswerKey from "./fixtures/transcripts/golden-answer-key.json" with { type: "json" };
import discoveryAnswerKey from "./fixtures/transcripts/golden-discovery-answer-key.json" with { type: "json" };

/**
 * The Living Positioning Brief, tested end to end from the two golden calls.
 *
 * Nothing here writes a brief row by hand. Claims arrive through the real
 * extraction job (against the answer-key mock, so the evidence gate still runs
 * for real), a human decides each one through the HTTP review gate, and only
 * then is a version merged. That is the only sequence the product permits, so
 * it is the only sequence these tests use — a fixture that inserted an approved
 * claim directly would be testing a code path that must not exist.
 */

/**
 * The two transcripts number their segments from zero independently, so
 * "s0012" means something different in each. Feeding both answer keys to one
 * mock would cross-fire; the active key is swapped per meeting instead.
 */
const answerKey = vi.hoisted(() => ({
  current: [] as Array<{
    type: string | null;
    text_gist: string;
    evidence_segment_ids: string[];
    must_extract: boolean;
  }>,
}));

vi.mock("../src/integrations/openai.js", async () => {
  const { segmentHandle } = await import("../src/domain/chunking.js");
  const { createExtractFromChunkMockFromAnswerKey } = await import("./helpers/llm-mock.js");
  return {
    PROMPT_VERSION: "propose_claims/v2-openai",
    segmentHandle,
    extractFromChunk: (args: never) => createExtractFromChunkMockFromAnswerKey(answerKey.current)(args),
  };
});

const HOME = { "x-tenant-slug": "freshworks-demo", "x-reviewer-email": "reviewer@test.example" };

const WORKSHOP = "Golden: Freshworks positioning workshop";
const DISCOVERY = "Golden: Freshworks discovery call";

let app: FastifyInstance;
let queues: typeof import("../src/queue.js");
let runExtraction: typeof import("../src/jobs/extract.js")["runExtraction"];
let seedGoldenMeetings: typeof import("../src/seed-golden.js")["seedGoldenMeetings"];
let runWithContext: typeof import("../src/context.js")["runWithContext"];

let tenantId: string;
let tenantSlug: string;
let workshopId: string;
let discoveryId: string;

beforeAll(async () => {
  queues = await import("../src/queue.js");
  runExtraction = (await import("../src/jobs/extract.js")).runExtraction;
  seedGoldenMeetings = (await import("../src/seed-golden.js")).seedGoldenMeetings;
  runWithContext = (await import("../src/context.js")).runWithContext;
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
  for (const queue of queues.allQueues) await queue.obliterate({ force: true });

  const tenant = await seedTenant();
  tenantId = tenant.id;
  tenantSlug = tenant.slug;

  const summary = await runWithContext(
    { tenantId, tenantSlug, reviewer: "seed" },
    () => seedGoldenMeetings(tenantId),
  );
  workshopId = summary.meetings.find((m) => m.title === WORKSHOP)!.meetingId;
  discoveryId = summary.meetings.find((m) => m.title === DISCOVERY)!.meetingId;
});

/* --------------------------------------------------------------- helpers */

/** Run the real extraction job over one golden meeting's own answer key. */
async function extract(meetingId: string): Promise<void> {
  answerKey.current = meetingId === workshopId ? freshworksAnswerKey : discoveryAnswerKey;
  await runExtraction({ meetingId, tenantId });
}

async function proposedClaims(meetingId: string) {
  return db.candidateClaim.findMany({
    where: { meetingId, status: ClaimStatus.proposed },
    orderBy: [{ type: "asc" }, { timestampMs: "asc" }, { id: "asc" }],
  });
}

/**
 * "Keep all high-confidence" — the button a reviewer actually presses to clear
 * a call's queue. Used here instead of a loop of single approvals because it is
 * one request rather than thirty, which keeps a twelve-test file inside the
 * rate limiter the real API runs behind.
 */
async function approveAll(claims: Array<{ id: string }>) {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/claims/bulk-approve",
    headers: HOME,
    payload: { claim_ids: claims.map((c) => c.id) },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json().error_count).toBe(0);
  expect(res.json().approved_count).toBe(claims.length);
}

async function reject(claimId: string) {
  const res = await app.inject({
    method: "POST",
    url: `/api/v1/claims/${claimId}/reject`,
    headers: HOME,
    payload: {},
  });
  expect(res.statusCode).toBe(200);
}

async function editApprove(claimId: string, text: string) {
  const res = await app.inject({
    method: "PATCH",
    url: `/api/v1/claims/${claimId}`,
    headers: HOME,
    payload: { text },
  });
  expect(res.statusCode).toBe(200);
  return res.json();
}

async function merge(body: Record<string, unknown> = {}) {
  return app.inject({ method: "POST", url: "/api/v1/brief/versions", headers: HOME, payload: body });
}

async function mergeOk(body: Record<string, unknown> = {}) {
  const res = await merge(body);
  expect(res.statusCode).toBe(201);
  return res.json().version as {
    version: number;
    added: number;
    removed: number;
    edited: number;
    total: number;
  };
}

async function getJson(url: string) {
  const res = await app.inject({ method: "GET", url, headers: HOME });
  expect(res.statusCode).toBe(200);
  return res.json();
}

type DocClaim = { claim_id: string; text: string; meeting_id: string; source: { meeting_title: string } };

function textsOf(doc: { claims_by_type: Array<{ claims: DocClaim[] }> }): string[] {
  return doc.claims_by_type.flatMap((g) => g.claims.map((c) => c.text)).sort();
}

/* ------------------------------------------------- the two golden merges */

describe("merging the golden meetings", () => {
  it("makes v1 exactly what the reviewer kept from the first call", async () => {
    await extract(workshopId);
    const proposals = await proposedClaims(workshopId);
    expect(proposals.length).toBeGreaterThan(10);

    // A real review session: most kept, two thrown away.
    const kept = proposals.slice(0, proposals.length - 2);
    const tossed = proposals.slice(proposals.length - 2);
    await approveAll(kept);
    for (const c of tossed) await reject(c.id);

    const v1 = await mergeOk({ meeting_id: workshopId });
    expect(v1).toMatchObject({
      version: 1,
      added: kept.length,
      edited: 0,
      removed: 0,
      total: kept.length,
    });

    const doc = await getJson("/api/v1/brief/versions/1");
    expect(doc.total).toBe(kept.length);
    expect(textsOf(doc)).toEqual(kept.map((c) => c.text).sort());

    // Nothing the reviewer rejected is anywhere in the brief.
    const rejectedTexts = new Set(tossed.map((c) => c.text));
    for (const text of textsOf(doc)) expect(rejectedTexts.has(text)).toBe(false);

    // Grouped by type, in the document's own order, with provenance attached.
    expect(doc.claims_by_type.length).toBeGreaterThan(1);
    for (const group of doc.claims_by_type) {
      for (const claim of group.claims) {
        expect(claim.meeting_id).toBe(workshopId);
        expect(claim.source.meeting_title).toBe(WORKSHOP);
        expect(claim.evidence.verbatim_quote.length).toBeGreaterThan(0);
        expect(claim.evidence.speaker.length).toBeGreaterThan(0);
      }
    }
  });

  it("makes v2's diff against v1 the second review session and nothing else", async () => {
    await extract(workshopId);
    const first = await proposedClaims(workshopId);
    await approveAll(first);
    const v1 = await mergeOk({ meeting_id: workshopId });

    await extract(discoveryId);
    const second = await proposedClaims(discoveryId);
    expect(second.length).toBeGreaterThan(2);
    const kept = second.slice(0, second.length - 1);
    const tossed = second[second.length - 1]!;
    await approveAll(kept);
    await reject(tossed.id);

    const v2 = await mergeOk({ meeting_id: discoveryId });
    expect(v2).toMatchObject({
      version: 2,
      added: kept.length,
      edited: 0,
      removed: 0,
      total: v1.total + kept.length,
    });

    const diff = await getJson("/api/v1/brief/versions/1/diff/2");
    expect(diff.added).toHaveLength(kept.length);
    expect(diff.removed).toHaveLength(0);
    expect(diff.edited).toHaveLength(0);
    expect(diff.unchanged).toBe(v1.total);
    expect(diff.added.map((c: DocClaim) => c.text).sort()).toEqual(kept.map((c) => c.text).sort());
    // Everything added in v2 came from the call that was just reviewed.
    for (const c of diff.added) expect(c.meeting_id).toBe(discoveryId);
  });

  it("reads an edit to a merged claim as an edit, not a removal and an addition", async () => {
    await extract(workshopId);
    const proposals = await proposedClaims(workshopId);
    await approveAll(proposals);
    const v1 = await mergeOk({ meeting_id: workshopId });

    const target = proposals[0]!;
    const rewritten = "Rewritten by the reviewer: this is what the brief should say.";
    await editApprove(target.id, rewritten);

    const v2 = await mergeOk({ meeting_id: workshopId });
    expect(v2).toMatchObject({ version: 2, added: 0, edited: 1, removed: 0, total: v1.total });

    const diff = await getJson("/api/v1/brief/versions/1/diff/2");
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.edited).toHaveLength(1);
    // The spec's field names: an edit is a from → to, on one identity.
    expect(diff.edited[0].from).toBe(target.text);
    expect(diff.edited[0].to).toBe(rewritten);
    expect(diff.edited[0].claim_id).toBe(target.id);
  });

  it("drops a claim the reviewer changed their mind about out of the next version only", async () => {
    await extract(workshopId);
    const proposals = await proposedClaims(workshopId);
    await approveAll(proposals);
    const v1 = await mergeOk({ meeting_id: workshopId });

    const target = proposals[0]!;
    await reject(target.id);

    const v2 = await mergeOk({ meeting_id: workshopId });
    expect(v2).toMatchObject({ version: 2, added: 0, edited: 0, removed: 1, total: v1.total - 1 });

    const diff = await getJson("/api/v1/brief/versions/1/diff/2");
    expect(diff.removed).toHaveLength(1);
    expect(diff.removed[0].text).toBe(target.text);

    // v1 still contains it. Append-only means earlier versions do not change.
    const asOfV1 = await getJson("/api/v1/brief/versions/1");
    expect(textsOf(asOfV1)).toContain(target.text);
  });

  it("refuses a re-merge that has no new decisions behind it", async () => {
    await extract(workshopId);
    await approveAll(await proposedClaims(workshopId));
    await mergeOk({ meeting_id: workshopId });

    const again = await merge({ meeting_id: workshopId });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("no_changes");

    // And it created nothing.
    expect(await db.briefVersion.count({ where: { tenantId } })).toBe(1);
  });

  it("records the call the reviewer merged from", async () => {
    await extract(workshopId);
    await approveAll(await proposedClaims(workshopId));
    await mergeOk({ meeting_id: workshopId });

    const list = await getJson("/api/v1/brief/versions");
    expect(list.versions).toHaveLength(1);
    expect(list.versions[0]).toMatchObject({
      version: 1,
      source_meeting: { id: workshopId, title: WORKSHOP },
    });
    expect(list.versions[0].counts).toEqual({
      added: list.versions[0].added,
      removed: 0,
      edited: 0,
    });

    const doc = await getJson("/api/v1/brief/versions/1");
    expect(doc.source_meeting).toMatchObject({ id: workshopId, title: WORKSHOP });
  });

  it("infers the source call when the reviewer did not name one", async () => {
    await extract(discoveryId);
    await approveAll(await proposedClaims(discoveryId));
    await mergeOk();

    const list = await getJson("/api/v1/brief/versions");
    expect(list.versions[0].source_meeting.id).toBe(discoveryId);
  });

  /**
   * The inference is computed from the claims being merged, so it cannot name a
   * call that contributed nothing. That property is the reason the review queue
   * sends no meeting_id of its own: the queue's state holds what has NOT been
   * decided, so a screen deriving the source from it would name the one meeting
   * whose claims are absent from the version.
   */
  it("never names a source call that put no claims in the version", async () => {
    await extract(workshopId);
    await extract(discoveryId);
    await approveAll(await proposedClaims(workshopId));
    await approveAll(await proposedClaims(discoveryId));

    await mergeOk();

    const list = await getJson("/api/v1/brief/versions");
    // Two calls contributed; neither one is the answer, so there is no answer.
    expect(list.versions[0].source_meeting).toBeNull();

    const doc = await getJson("/api/v1/brief/versions/1");
    const contributors = new Set(
      doc.claims_by_type.flatMap((g: { claims: DocClaim[] }) => g.claims.map((c) => c.meeting_id)),
    );
    expect(contributors).toEqual(new Set([workshopId, discoveryId]));
  });

  it("infers one call's worth of provenance even when another call is still unreviewed", async () => {
    // The exact shape the queue used to get wrong: two meetings extracted, only
    // one reviewed. The version is entirely the workshop's, so the workshop is
    // what it must say — never the call whose claims are all still proposed.
    await extract(workshopId);
    await extract(discoveryId);
    await approveAll(await proposedClaims(workshopId));

    await mergeOk();

    const list = await getJson("/api/v1/brief/versions");
    expect(list.versions[0].source_meeting.id).toBe(workshopId);
    expect(list.versions[0].source_meeting.id).not.toBe(discoveryId);

    const doc = await getJson("/api/v1/brief/versions/1");
    for (const group of doc.claims_by_type) {
      for (const claim of group.claims) expect(claim.meeting_id).toBe(workshopId);
    }
  });

  it("refuses a merge that names a meeting from another workspace", async () => {
    const away = await seedTenant("rival-corp");
    const theirs = await db.meeting.create({
      data: { tenantId: away.id, title: "Rival sync", meetingUrl: "https://meet.google.com/rival" },
    });

    await extract(workshopId);
    await approveAll(await proposedClaims(workshopId));

    const res = await merge({ meeting_id: theirs.id });
    expect(res.statusCode).toBe(404);
    expect(await db.briefVersion.count({ where: { tenantId } })).toBe(0);
  });

  it("still shows what v1 said after v2 rewrote the claim", async () => {
    await extract(workshopId);
    const proposals = await proposedClaims(workshopId);
    await approveAll(proposals);
    await mergeOk({ meeting_id: workshopId });

    const target = proposals[0]!;
    await editApprove(target.id, "A later, different sentence entirely.");
    await mergeOk({ meeting_id: workshopId });

    const v1 = await getJson("/api/v1/brief/versions/1");
    const v2 = await getJson("/api/v1/brief/versions/2");
    expect(textsOf(v1)).toContain(target.text);
    expect(textsOf(v1)).not.toContain("A later, different sentence entirely.");
    expect(textsOf(v2)).toContain("A later, different sentence entirely.");
    expect(textsOf(v2)).not.toContain(target.text);
  });
});

/* ----------------------------------------------------------- append-only */

describe("append-only enforcement", () => {
  it("refuses to update or delete a published version through the service client", async () => {
    await extract(workshopId);
    await approveAll(await proposedClaims(workshopId));
    await mergeOk({ meeting_id: workshopId });

    const { prisma } = await import("../src/db.js");
    const { AppendOnlyViolationError } = await import("../src/domain/append-only.js");

    await runWithContext({ tenantId, tenantSlug, reviewer: "attacker" }, async () => {
      await expect(
        prisma.briefVersion.updateMany({ where: { version: 1 }, data: { note: "rewritten" } }),
      ).rejects.toBeInstanceOf(AppendOnlyViolationError);

      await expect(
        prisma.briefVersion.deleteMany({ where: { version: 1 } }),
      ).rejects.toBeInstanceOf(AppendOnlyViolationError);

      await expect(
        prisma.briefClaim.updateMany({ where: {}, data: { text: "rewritten" } }),
      ).rejects.toBeInstanceOf(AppendOnlyViolationError);

      await expect(prisma.briefClaim.deleteMany({ where: {} })).rejects.toBeInstanceOf(
        AppendOnlyViolationError,
      );
    });

    // Nothing moved.
    const version = await db.briefVersion.findFirstOrThrow({ where: { tenantId, version: 1 } });
    expect(version.note).toBeNull();
    expect(await db.briefClaim.count({ where: { tenantId } })).toBe(version.totalCount);
  });

  /**
   * Naming a redactable column is not the same as redacting. A write that puts
   * arbitrary text in `verbatimQuote` rewrites the evidence a reviewer vouched
   * for while wearing the purge's clothes, so the guard checks the values too.
   */
  it("refuses an evidence rewrite dressed up as a redaction", async () => {
    await extract(workshopId);
    await approveAll(await proposedClaims(workshopId));
    await mergeOk({ meeting_id: workshopId });

    const { prisma } = await import("../src/db.js");
    const { AppendOnlyViolationError, REDACTED } = await import("../src/domain/append-only.js");

    await runWithContext({ tenantId, tenantSlug, reviewer: "attacker" }, async () => {
      // A quote that is not the sentinel.
      await expect(
        prisma.briefClaim.updateMany({
          where: {},
          data: { evidenceRedacted: true, verbatimQuote: "something they never said" },
        }),
      ).rejects.toBeInstanceOf(AppendOnlyViolationError);

      // Un-redacting: there is no transcript left to restore from.
      await expect(
        prisma.briefClaim.updateMany({ where: {}, data: { evidenceRedacted: false } }),
      ).rejects.toBeInstanceOf(AppendOnlyViolationError);

      // The real thing still goes through.
      await expect(
        prisma.briefClaim.updateMany({
          where: {},
          data: { evidenceRedacted: true, verbatimQuote: REDACTED },
        }),
      ).resolves.toMatchObject({ count: expect.any(Number) });
    });

    const claims = await db.briefClaim.findMany({ where: { tenantId } });
    expect(claims.every((c) => c.verbatimQuote === "[evidence redacted]")).toBe(true);

    // Nothing moved.
    const version = await db.briefVersion.findFirstOrThrow({ where: { tenantId, version: 1 } });
    expect(version.note).toBeNull();
    expect(await db.briefClaim.count({ where: { tenantId } })).toBe(version.totalCount);
  });

  it("still lets the purge redact evidence in place", async () => {
    await extract(workshopId);
    await approveAll(await proposedClaims(workshopId));
    await mergeOk({ meeting_id: workshopId });

    const purge = await app.inject({
      method: "DELETE",
      url: `/api/v1/meetings/${workshopId}`,
      headers: HOME,
    });
    expect(purge.statusCode).toBe(204);

    const claims = await db.briefClaim.findMany({ where: { tenantId } });
    expect(claims.length).toBeGreaterThan(0);
    expect(claims.every((c) => c.evidenceRedacted)).toBe(true);
    // The brief kept its content — only the evidence was scrubbed.
    expect(claims.every((c) => c.text.length > 0)).toBe(true);
  });

  it("has no module in src/ that rewrites a brief row for any reason but redaction", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const srcRoot = path.resolve(here, "../src");

    const offenders: string[] = [];
    const seen: string[] = [];
    for (const file of walk(srcRoot)) {
      const source = fs.readFileSync(file, "utf-8");
      for (const call of briefWriteCalls(source)) {
        const where = `${path.relative(srcRoot, file)} -> ${call.model}.${call.op}`;
        seen.push(where);
        if (CREATE_OPS.has(call.op)) continue;
        const isRedaction =
          call.model === "briefClaim" &&
          (call.op === "update" || call.op === "updateMany") &&
          onlyRedactionFields(call.args);
        if (!isRedaction) offenders.push(where);
      }
    }

    expect(offenders).toEqual([]);

    // …and the scan is still finding things. An empty offender list is only
    // evidence of anything if the regex that produces it still matches the
    // writes we know are there — otherwise a rename upstream turns this test
    // into one that passes no matter what anybody does to the brief tables.
    expect(seen).toContain("domain/brief.ts -> briefVersion.create");
    expect(seen.filter((s) => s === "domain/brief.ts -> briefClaim.createMany")).toHaveLength(2);
    expect(seen).toContain("routes/meetings.ts -> briefClaim.updateMany");
  });
});

const CREATE_OPS = new Set(["create", "createMany", "createManyAndReturn"]);

/** The only fields the purge is allowed to touch on a published brief row. */
const REDACTION_FIELDS = ["evidenceRedacted", "verbatimQuote"];

function onlyRedactionFields(args: string): boolean {
  const data = args.slice(args.indexOf("data:"));
  const keys = [...data.matchAll(/(\w+)\s*:/g)].map((m) => m[1]!).filter((k) => k !== "data");
  return keys.length > 0 && keys.every((k) => REDACTION_FIELDS.includes(k));
}

function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile() && full.endsWith(".ts")) yield full;
  }
}

/**
 * Every `brief(Version|Claim).<write>(…)` call in a source file, with its
 * argument text. Balanced-paren scan for the same reason the gate scan in
 * review-gate.test.ts uses one: a multi-line call has to be captured whole.
 */
function briefWriteCalls(source: string): Array<{ model: string; op: string; args: string }> {
  const found: Array<{ model: string; op: string; args: string }> = [];
  const pattern =
    /\b(briefVersion|briefClaim)\.(update|updateMany|upsert|delete|deleteMany|create|createMany|createManyAndReturn)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    let depth = 1;
    let i = pattern.lastIndex;
    while (i < source.length && depth > 0) {
      if (source[i] === "(") depth += 1;
      else if (source[i] === ")") depth -= 1;
      i += 1;
    }
    found.push({ model: match[1]!, op: match[2]!, args: source.slice(pattern.lastIndex, i - 1) });
  }
  return found;
}
