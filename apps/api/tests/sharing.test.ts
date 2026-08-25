import crypto from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auth } from "../src/auth.js";
import { authBaseUrl, env } from "../src/env.js";
import { registerCore } from "../src/http.js";
import { sharingRoutes } from "../src/routes/sharing.js";
import { workspaceRoutes } from "../src/routes/workspace.js";
import { db } from "./helpers.js";

/**
 * Sharing and workspace administration.
 *
 * These routes are not mounted in server.ts yet — the integrator owns that file
 * — so the suite builds the same stack the server does: registerCore for the
 * context/tenancy hooks and the error handler, then the two route plugins under
 * /api/v1. When the routes land in server.ts this harness can be swapped for
 * buildServer() without touching a single assertion.
 */

/**
 * The session cookie Better Auth would have issued, minted directly.
 *
 * Credential sign-up cannot run against this schema at all: Better Auth 1.7
 * writes `account.issuer` on every link and the Account model has no such
 * column, so `signUpEmail` dies inside the Prisma adapter before a session
 * exists. Until that lands, this is how a test gets a signed-in person.
 *
 * What is skipped is password sign-up. What is *not* skipped is everything this
 * suite is about: the cookie below is verified by the real `getSession`, the
 * actor is resolved by the real `resolveActor`, and every workspace route still
 * runs through the organization plugin's own endpoints. Once the column exists,
 * `signIn` collapses to a single `auth.api.signUpEmail` call and nothing else
 * in this file changes.
 *
 * The name carries the `__Secure-` prefix on an https base URL, and the value
 * is `token.HMAC-SHA256(secret, token)` base64, percent-encoded — the same two
 * rules auth.ts's `secure` attribute and better-call's cookie signer follow. A
 * drift in either shows up as a 401 on the first assertion, not as a silent
 * pass.
 */
const SESSION_COOKIE = `${authBaseUrl.startsWith("https") ? "__Secure-" : ""}better-auth.session_token`;

/** Text that exists only inside the transcript. If it ever appears in a share
 *  response, the share is leaking the transcript. */
const TRANSCRIPT_ONLY = "zsecretzz-said-off-the-record-before-anyone-was-recording";
/** Same idea for the verbatim quote hanging off an approved claim. */
const QUOTE_ONLY = "zsecretzz-verbatim-quote-lifted-straight-from-the-tape";

let app: FastifyInstance;

type Person = { userId: string; email: string; cookie: string };
type Workspace = { organizationId: string; tenantId: string; slug: string; owner: Person };

beforeAll(async () => {
  app = await buildTestApp();
});

afterAll(async () => {
  await app?.close();
  await db.$disconnect();
});

beforeEach(async () => {
  await resetAll();
});

/* --- harness -------------------------------------------------------------- */

async function buildTestApp(withRateLimit = false): Promise<FastifyInstance> {
  const instance = Fastify({ logger: false });
  if (withRateLimit) {
    await instance.register(rateLimit, {
      max: 1000,
      timeWindow: "1 minute",
      keyGenerator: (request) => request.actor?.userId ?? request.ip,
    });
  }
  registerCore(instance);
  await instance.register(
    async (api) => {
      await api.register(workspaceRoutes);
      await api.register(sharingRoutes);
    },
    { prefix: "/api/v1" },
  );
  await instance.ready();
  return instance;
}

/**
 * One statement, not two.
 *
 * The domain tables hang off `tenants` and the auth tables off `organization`
 * and `user`, so CASCADE reaches all of them from these four roots — which is
 * why resetDb()'s list is not reused here. Running its truncate and a second
 * one for the auth tables deadlocks: between the two statements a connection
 * that is still finishing the previous test's session lookup takes a RowShare
 * lock on `user`, and the two orders cross. A single TRUNCATE takes every lock
 * it needs in one command and leaves no window to interleave with.
 */
async function resetAll(): Promise<void> {
  await db.$executeRawUnsafe(
    `TRUNCATE TABLE "tenants", "organization", "user", "verification" CASCADE`,
  );
}

async function signIn(email: string, name: string): Promise<Person> {
  const id = `user-${crypto.randomBytes(8).toString("hex")}`;
  const user = await db.user.create({ data: { id, name, email, emailVerified: true } });

  const token = crypto.randomBytes(32).toString("base64url");
  await db.session.create({
    data: { id: `session-${id}`, token, userId: user.id, expiresAt: new Date(Date.now() + 86_400_000) },
  });

  const signature = crypto.createHmac("sha256", env.BETTER_AUTH_SECRET).update(token).digest("base64");
  const cookie = `${SESSION_COOKIE}=${encodeURIComponent(`${token}.${signature}`)}`;
  return { userId: user.id, email, cookie };
}

/**
 * Every test user belongs to exactly one workspace on purpose: `resolveActor`
 * selects the single membership implicitly, so the tests do not depend on the
 * session's cached active-organization cookie being fresh.
 */
async function createWorkspace(slug: string, owner: Person): Promise<Workspace> {
  const organization = await auth.api.createOrganization({
    body: { name: `Workspace ${slug}`, slug },
    headers: new Headers({ cookie: owner.cookie }),
  });
  if (!organization) throw new Error(`createOrganization returned nothing for ${slug}`);

  const tenant = await db.tenant.findUniqueOrThrow({ where: { organizationId: organization.id } });
  return { organizationId: organization.id, tenantId: tenant.id, slug, owner };
}

async function addMember(
  workspace: Workspace,
  person: Person,
  role: "owner" | "admin" | "member",
): Promise<void> {
  await auth.api.addMember({
    body: { userId: person.userId, role, organizationId: workspace.organizationId },
  });
}

async function createMeeting(workspace: Workspace, title: string): Promise<string> {
  const meeting = await db.meeting.create({
    data: {
      tenantId: workspace.tenantId,
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      title,
      createdByUserId: workspace.owner.userId,
    },
  });
  return meeting.id;
}

/** Notes, an agenda item, an action item, a transcript, and one approved claim
 *  that has already been merged into a brief version. */
async function seedMeetingContent(workspace: Workspace, meetingId: string, notes: string): Promise<void> {
  const { tenantId } = workspace;

  await db.meetingNote.create({
    data: { tenantId, meetingId, state: Buffer.from([1, 2, 3]), plainText: notes, revision: 1 },
  });
  await db.agendaItem.create({
    data: { tenantId, meetingId, position: 0, title: "Pricing objections", durationMins: 15 },
  });
  await db.actionItem.create({
    data: { tenantId, meetingId, title: "Rewrite the pricing page" },
  });

  const evidence = await db.evidenceSource.create({
    data: { tenantId, kind: "meeting_transcript", meetingId, capturedAt: new Date() },
  });
  const transcript = await db.transcript.create({
    data: {
      tenantId,
      meetingId,
      evidenceSourceId: evidence.id,
      provider: "recall",
      segmentCount: 1,
      wordCount: 12,
      durationMs: 60_000,
    },
  });
  await db.transcriptSegment.create({
    data: {
      tenantId,
      transcriptId: transcript.id,
      idx: 0,
      speaker: "Dana Whitfield",
      startMs: 0,
      endMs: 4_000,
      text: TRANSCRIPT_ONLY,
    },
  });

  const run = await db.extractionRun.create({
    data: { tenantId, meetingId, model: "test-model", promptVersion: "test/v1" },
  });
  const claim = await db.candidateClaim.create({
    data: {
      tenantId,
      meetingId,
      evidenceSourceId: evidence.id,
      extractionRunId: run.id,
      type: "positioning_statement",
      text: "Position as the layer that flattens the support cost curve.",
      confidence: 0.92,
      status: "approved",
      verbatimQuote: QUOTE_ONLY,
      speaker: "Dana Whitfield",
      timestampMs: 0,
      dedupeKey: `dedupe-${meetingId}`,
    },
  });
  const version = await db.briefVersion.create({
    data: { tenantId, version: 1, createdBy: "reviewer@test.example", addedCount: 1, totalCount: 1 },
  });
  await db.briefClaim.create({
    data: {
      tenantId,
      briefVersionId: version.id,
      claimId: claim.id,
      meetingId,
      type: "positioning_statement",
      text: claim.text,
      verbatimQuote: QUOTE_ONLY,
      speaker: "Dana Whitfield",
      timestampMs: 0,
      confidence: 0.92,
      introducedInVersion: 1,
    },
  });
}

async function createShare(
  person: Person,
  meetingId: string,
  body: Record<string, unknown> = {},
): Promise<{ token: string; id: string; url: string }> {
  const response = await app.inject({
    method: "POST",
    url: `/api/v1/meetings/${meetingId}/share`,
    headers: { cookie: person.cookie },
    payload: body,
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json().share;
}

const openShare = (token: string, headers: Record<string, string> = {}) =>
  app.inject({ method: "GET", url: `/api/v1/shared/${token}`, headers });

/* --- token quality -------------------------------------------------------- */

describe("share tokens", () => {
  let owner: Person;
  let workspace: Workspace;
  let meetingId: string;

  beforeEach(async () => {
    owner = await signIn("owner@acme.test", "Ada Owner");
    workspace = await createWorkspace("acme", owner);
    meetingId = await createMeeting(workspace, "Positioning review");
  });

  it("mints 256 bits of unbiased randomness, never twice the same", async () => {
    const tokens: string[] = [];
    for (let i = 0; i < 24; i++) tokens.push((await createShare(owner, meetingId)).token);

    expect(new Set(tokens).size).toBe(tokens.length);

    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(Buffer.from(token, "base64url")).toHaveLength(32);
    }

    // A token built from a counter, a timestamp or a hash of the meeting id
    // would hold some bits constant across every sample while still passing the
    // length and uniqueness checks above. Requiring every one of the 256 bits
    // to vary is what actually distinguishes "random" from "distinct".
    const bytes = tokens.map((token) => Buffer.from(token, "base64url"));
    for (let bit = 0; bit < 256; bit++) {
      const values = new Set(bytes.map((b) => (b[bit >> 3]! >> (bit % 8)) & 1));
      expect(values.size, `bit ${bit} never changed across ${tokens.length} tokens`).toBe(2);
    }
  });

  it("carries nothing derived from the meeting it points at", async () => {
    const { token } = await createShare(owner, meetingId);
    // Guessing one live link from another meeting's id is the cheapest attack
    // there is, and the only defence is that the id is not an input.
    for (const fragment of meetingId.split("-")) {
      expect(token).not.toContain(fragment);
    }
  });

  it("refuses a token that was never issued", async () => {
    const response = await openShare("Zm9yZ2VkLXRva2VuLXRoYXQtbmV2ZXItZXhpc3RlZA");
    expect(response.statusCode).toBe(404);
  });

  it("refuses a revoked token, and keeps the row so the audit trail survives", async () => {
    const share = await createShare(owner, meetingId);
    expect((await openShare(share.token)).statusCode).toBe(200);

    const revoked = await app.inject({
      method: "DELETE",
      url: `/api/v1/shares/${share.id}`,
      headers: { cookie: owner.cookie },
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().share.status).toBe("revoked");

    expect((await openShare(share.token)).statusCode).toBe(404);

    const row = await db.meetingShare.findUniqueOrThrow({ where: { id: share.id } });
    expect(row.revokedAt).not.toBeNull();
    expect(row.viewCount).toBe(1);
    expect(row.createdByUserId).toBe(owner.userId);
  });

  it("refuses an expired token", async () => {
    const share = await createShare(owner, meetingId, {
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect((await openShare(share.token)).statusCode).toBe(200);

    await db.meetingShare.update({
      where: { id: share.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    expect((await openShare(share.token)).statusCode).toBe(404);
  });

  it("refuses to mint a link that is already expired", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/meetings/${meetingId}/share`,
      headers: { cookie: owner.cookie },
      payload: { expires_at: new Date(Date.now() - 60_000).toISOString() },
    });
    expect(response.statusCode).toBe(400);
  });

  it("counts every open", async () => {
    const share = await createShare(owner, meetingId);
    for (let i = 0; i < 3; i++) expect((await openShare(share.token)).statusCode).toBe(200);

    const row = await db.meetingShare.findUniqueOrThrow({ where: { id: share.id } });
    expect(row.viewCount).toBe(3);
  });
});

/* --- what a link exposes -------------------------------------------------- */

describe("what a share link exposes", () => {
  let owner: Person;
  let workspace: Workspace;
  let meetingId: string;

  beforeEach(async () => {
    owner = await signIn("owner@acme.test", "Ada Owner");
    workspace = await createWorkspace("acme", owner);
    meetingId = await createMeeting(workspace, "Positioning review");
    await seedMeetingContent(workspace, meetingId, "We agreed to lead with the cost curve.");
  });

  it("returns the notes, agenda, action items and approved claims", async () => {
    const share = await createShare(owner, meetingId);
    const response = await openShare(share.token);
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();

    expect(body.meeting.title).toBe("Positioning review");
    expect(body.notes.text).toBe("We agreed to lead with the cost curve.");
    expect(body.agenda).toHaveLength(1);
    expect(body.agenda[0].title).toBe("Pricing objections");
    expect(body.action_items).toHaveLength(1);
    expect(body.action_items[0].title).toBe("Rewrite the pricing page");
    expect(body.brief_claims).toHaveLength(1);
    expect(body.brief_claims[0].text).toContain("cost curve");
  });

  it("never exposes the transcript, in any field, under any name", async () => {
    const share = await createShare(owner, meetingId);
    const response = await openShare(share.token);
    expect(response.statusCode).toBe(200);

    // The whole serialised response, not a field-by-field check: a leak that
    // matters is one that arrives through a field nobody thought to assert on.
    expect(response.body).not.toContain(TRANSCRIPT_ONLY);
    expect(response.body).not.toContain(QUOTE_ONLY);

    const body = response.json();
    expect(body).not.toHaveProperty("transcript");
    expect(body).not.toHaveProperty("segments");
    // Provenance stays inside the workspace: an approved claim travels without
    // the quote it was lifted from.
    expect(body.brief_claims[0]).not.toHaveProperty("evidence");
    expect(body.brief_claims[0]).not.toHaveProperty("verbatim_quote");

    // And the transcript really is there to be leaked — otherwise this test
    // passes for the wrong reason.
    const segments = await db.transcriptSegment.count({ where: { tenantId: workspace.tenantId } });
    expect(segments).toBe(1);
  });

  it("omits the recording unless the link opted in", async () => {
    const closed = await createShare(owner, meetingId);
    expect((await openShare(closed.token)).json().recording).toBeNull();
    expect((await openShare(closed.token)).json().shared.includes_recording).toBe(false);

    const open = await createShare(owner, meetingId, { include_recording: true });
    expect((await openShare(open.token)).json().shared.includes_recording).toBe(true);
  });

  it("is not cacheable", async () => {
    const share = await createShare(owner, meetingId);
    const response = await openShare(share.token);
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("dies with the meeting", async () => {
    const share = await createShare(owner, meetingId);
    await db.meeting.update({ where: { id: meetingId }, data: { deletedAt: new Date() } });
    expect((await openShare(share.token)).statusCode).toBe(404);
  });
});

/* --- tenancy -------------------------------------------------------------- */

describe("a share token is never a way around tenancy", () => {
  let acme: Workspace;
  let globex: Workspace;
  let acmeMeeting: string;
  let globexMeeting: string;

  beforeEach(async () => {
    const acmeOwner = await signIn("owner@acme.test", "Ada Owner");
    acme = await createWorkspace("acme", acmeOwner);
    acmeMeeting = await createMeeting(acme, "Acme positioning");
    await seedMeetingContent(acme, acmeMeeting, "ACME-ONLY-NOTES");

    const globexOwner = await signIn("owner@globex.test", "Gil Owner");
    globex = await createWorkspace("globex", globexOwner);
    globexMeeting = await createMeeting(globex, "Globex positioning");
    await seedMeetingContent(globex, globexMeeting, "GLOBEX-ONLY-NOTES");
  });

  it("resolves to exactly one meeting in exactly one tenant", async () => {
    const share = await createShare(acme.owner, acmeMeeting);
    const response = await openShare(share.token);

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("ACME-ONLY-NOTES");
    expect(response.body).not.toContain("GLOBEX-ONLY-NOTES");
    expect(response.json().meeting.id).toBe(acmeMeeting);
  });

  it("ignores an ambient tenant the caller supplies alongside it", async () => {
    // AUTH_DEV_HEADERS is on in tests, so x-tenant-slug puts a *different*
    // tenant into request.ctx before the route runs. The route must resolve its
    // tenant from the token and nothing else — if it ever read request.ctx,
    // this is the request that would return the wrong workspace's meeting.
    const share = await createShare(acme.owner, acmeMeeting);
    const response = await openShare(share.token, { "x-tenant-slug": globex.slug });

    expect(response.statusCode).toBe(200);
    expect(response.json().meeting.id).toBe(acmeMeeting);
    expect(response.body).toContain("ACME-ONLY-NOTES");
    expect(response.body).not.toContain("GLOBEX-ONLY-NOTES");
  });

  it("leaves the other tenant's brief claims where they are", async () => {
    const share = await createShare(acme.owner, acmeMeeting);
    const claims = (await openShare(share.token)).json().brief_claims;

    const acmeClaimIds = (
      await db.briefClaim.findMany({ where: { tenantId: acme.tenantId }, select: { claimId: true } })
    ).map((c) => c.claimId);
    expect(claims).toHaveLength(1);
    expect(acmeClaimIds).toContain(claims[0].claim_id);
  });

  it("does not let a member of one workspace share another workspace's meeting", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/meetings/${globexMeeting}/share`,
      headers: { cookie: acme.owner.cookie },
      payload: {},
    });
    // 404, not 403: confirming the meeting exists is itself the leak.
    expect(response.statusCode).toBe(404);
    expect(await db.meetingShare.count({ where: { meetingId: globexMeeting } })).toBe(0);
  });
});

/* --- workspace administration --------------------------------------------- */

describe("workspace administration", () => {
  let owner: Person;
  let second: Person;
  let workspace: Workspace;

  beforeEach(async () => {
    owner = await signIn("owner@acme.test", "Ada Owner");
    workspace = await createWorkspace("acme", owner);
    second = await signIn("member@acme.test", "Mo Member");
    await addMember(workspace, second, "member");
  });

  const patchRole = (actor: Person, userId: string, role: string) =>
    app.inject({
      method: "PATCH",
      url: `/api/v1/workspace/members/${userId}`,
      headers: { cookie: actor.cookie },
      payload: { role },
    });

  it("reports the workspace, its size and the actor's role", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/workspace",
      headers: { cookie: owner.cookie },
    });
    expect(response.statusCode).toBe(200);

    const workspaceBody = response.json().workspace;
    expect(workspaceBody.slug).toBe("acme");
    expect(workspaceBody.member_count).toBe(2);
    expect(workspaceBody.role).toBe("owner");
    expect(workspaceBody.tenant_id).toBe(workspace.tenantId);
  });

  it("lists members with the identity behind each membership", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/workspace/members",
      headers: { cookie: owner.cookie },
    });
    expect(response.statusCode).toBe(200);

    const emails = response.json().members.map((m: { email: string }) => m.email);
    expect(emails).toContain("owner@acme.test");
    expect(emails).toContain("member@acme.test");
  });

  it("refuses to demote the last owner", async () => {
    const response = await patchRole(owner, owner.userId, "admin");
    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toMatch(/at least one owner/i);

    const unchanged = await db.member.findFirstOrThrow({
      where: { organizationId: workspace.organizationId, userId: owner.userId },
    });
    expect(unchanged.role).toBe("owner");
  });

  it("allows the demotion once a second owner exists", async () => {
    expect((await patchRole(owner, second.userId, "owner")).statusCode).toBe(200);
    expect((await patchRole(owner, owner.userId, "admin")).statusCode).toBe(200);

    const demoted = await db.member.findFirstOrThrow({
      where: { organizationId: workspace.organizationId, userId: owner.userId },
    });
    expect(demoted.role).toBe("admin");
  });

  it("lets only an owner change roles", async () => {
    const response = await patchRole(second, owner.userId, "member");
    expect(response.statusCode).toBe(403);
  });

  it("clears a removed member's per-meeting grants", async () => {
    const meetingId = await createMeeting(workspace, "Positioning review");
    const added = await app.inject({
      method: "POST",
      url: `/api/v1/meetings/${meetingId}/collaborators`,
      headers: { cookie: owner.cookie },
      payload: { user_id: second.userId, role: "editor" },
    });
    expect(added.statusCode).toBe(200);

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/v1/workspace/members/${second.userId}`,
      headers: { cookie: owner.cookie },
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().revoked_collaborations).toBe(1);
    expect(await db.meetingCollaborator.count({ where: { userId: second.userId } })).toBe(0);
  });

  it("refuses to add a collaborator who is not in the workspace", async () => {
    const outsider = await signIn("outsider@globex.test", "Otto Outsider");
    await createWorkspace("globex", outsider);
    const meetingId = await createMeeting(workspace, "Positioning review");

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/meetings/${meetingId}/collaborators`,
      headers: { cookie: owner.cookie },
      payload: { user_id: outsider.userId, role: "viewer" },
    });
    expect(response.statusCode).toBe(400);
    expect(await db.meetingCollaborator.count({ where: { meetingId } })).toBe(0);
  });

  it("creates an invitation and cancels it", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/workspace/invitations",
      headers: { cookie: owner.cookie },
      payload: { email: "New.Hire@acme.test", role: "member" },
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().invitation.email).toBe("new.hire@acme.test");

    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/workspace/invitations",
      headers: { cookie: owner.cookie },
    });
    expect(listed.json().invitations).toHaveLength(1);

    const cancelled = await app.inject({
      method: "DELETE",
      url: `/api/v1/workspace/invitations/${created.json().invitation.id}`,
      headers: { cookie: owner.cookie },
    });
    expect(cancelled.statusCode).toBe(204);

    const invitation = await db.invitation.findUniqueOrThrow({
      where: { id: created.json().invitation.id },
    });
    expect(invitation.status).toBe("canceled");
  });

  it("refuses to cancel an invitation belonging to another workspace", async () => {
    const globexOwner = await signIn("owner@globex.test", "Gil Owner");
    const globex = await createWorkspace("globex", globexOwner);
    const foreign = await db.invitation.create({
      data: {
        id: "invitation-from-globex",
        organizationId: globex.organizationId,
        email: "target@globex.test",
        role: "member",
        status: "pending",
        expiresAt: new Date(Date.now() + 86_400_000),
        inviterId: globexOwner.userId,
      },
    });

    const response = await app.inject({
      method: "DELETE",
      url: `/api/v1/workspace/invitations/${foreign.id}`,
      headers: { cookie: owner.cookie },
    });
    expect(response.statusCode).toBe(404);
    expect((await db.invitation.findUniqueOrThrow({ where: { id: foreign.id } })).status).toBe("pending");
  });
});

/* --- rate limiting -------------------------------------------------------- */

describe("the public route is rate limited harder than the rest", () => {
  let limited: FastifyInstance;

  beforeAll(async () => {
    limited = await buildTestApp(true);
  });

  afterAll(async () => {
    await limited?.close();
  });

  it("cuts off an anonymous client long before the global budget", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) {
      statuses.push(
        (await limited.inject({ method: "GET", url: "/api/v1/shared/never-issued-token" })).statusCode,
      );
    }
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
    expect(statuses.slice(0, 20).every((s) => s === 404)).toBe(true);

    // The same client hammering an authenticated route is still inside the
    // global budget, which is what "harder than the rest" has to mean.
    const others: number[] = [];
    for (let i = 0; i < 25; i++) {
      others.push(
        (await limited.inject({ method: "GET", url: "/api/v1/workspace" })).statusCode,
      );
    }
    expect(others.every((s) => s === 401)).toBe(true);
  });
});
