import crypto from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auth } from "../src/auth.js";
import { authBaseUrl, env } from "../src/env.js";
import { registerCore } from "../src/http.js";
import { actionItemsV2Routes } from "../src/routes/action-items-v2.js";
import {
  parseDueDate,
  resolveCitations,
  resolveOwner,
  type SegmentRow,
} from "../src/jobs/suggest-action-items.js";
import type { SuggestedAction } from "../src/integrations/openai-actions.js";
import { db } from "./helpers.js";

/**
 * The suggestion gate.
 *
 * Two things are being defended here and they are not the same thing. The
 * first is provenance: a suggestion whose citation does not resolve never
 * reaches a person, and the drop is counted rather than silently absorbed. The
 * second is the gate itself: a pending suggestion is invisible to every
 * working list until somebody accepts it, and accepting is a per-workspace act
 * even when it is spelled "accept all".
 *
 * The harness mirrors tests/sharing.test.ts — these routes are not mounted in
 * server.ts yet, so the suite builds the same stack the server does and mints
 * the session cookie Better Auth would have issued. See that file for why
 * credential sign-up cannot run against this schema.
 */

const SESSION_COOKIE = `${authBaseUrl.startsWith("https") ? "__Secure-" : ""}better-auth.session_token`;

const SEGMENT_TEXT =
  "Right, I'll rewrite the pricing page tier boundaries before the launch review on Friday.";

/** Matches `session.expiresIn` in src/auth.ts. See `signIn` for why it matters. */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

let app: FastifyInstance;

type Person = { userId: string; email: string; cookie: string };
type Workspace = { organizationId: string; tenantId: string; slug: string; owner: Person };

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerCore(app);
  await app.register(async (api) => api.register(actionItemsV2Routes), { prefix: "/api/v1" });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await db.$disconnect();
});

beforeEach(async () => {
  await resetAll();
});

/**
 * One statement, for the reason tests/sharing.test.ts gives: CASCADE reaches
 * every domain and auth table from these four roots, and splitting it into two
 * truncates leaves a window for another connection to interleave.
 *
 * The retry is a guard, not a fix. TRUNCATE wants AccessExclusiveLock, and any
 * connection still holding a RowShareLock on "user" deadlocks against it;
 * Postgres breaks the cycle by killing one side, and retrying is the correct
 * response to 40P01. The actual source of those stray locks is dealt with in
 * `signIn` — this is here so a future one does not turn into a mystery.
 */
async function resetAll(): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await db.$executeRawUnsafe(
        `TRUNCATE TABLE "tenants", "organization", "user", "verification" CASCADE`,
      );
      return;
    } catch (error) {
      if (attempt >= 5 || !/40P01|40001/.test((error as Error).message)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
    }
  }
}

/* --- harness -------------------------------------------------------------- */

async function signIn(email: string, name: string): Promise<Person> {
  const id = `user-${crypto.randomBytes(8).toString("hex")}`;
  const user = await db.user.create({ data: { id, name, email, emailVerified: true } });

  const token = crypto.randomBytes(32).toString("base64url");
  await db.session.create({
    data: {
      id: `session-${id}`,
      token,
      userId: user.id,
      // A full `session.expiresIn` from now, not an hour or a day. Better Auth
      // rolls a session forward whenever its remaining life has dropped by more
      // than `updateAge`, and that write is not awaited by `getSession` — so a
      // short-lived fixture makes every request leave a stray UPDATE on "user"
      // and "session" behind it, which then deadlocks against the next test's
      // TRUNCATE. Minting the session already fresh means there is nothing to
      // roll forward.
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    },
  });

  const signature = crypto
    .createHmac("sha256", env.BETTER_AUTH_SECRET)
    .update(token)
    .digest("base64");
  return {
    userId: user.id,
    email,
    cookie: `${SESSION_COOKIE}=${encodeURIComponent(`${token}.${signature}`)}`,
  };
}

async function createWorkspace(slug: string, owner: Person): Promise<Workspace> {
  const organization = await auth.api.createOrganization({
    body: { name: `Workspace ${slug}`, slug },
    headers: new Headers({ cookie: owner.cookie }),
  });
  if (!organization) throw new Error(`createOrganization returned nothing for ${slug}`);

  const tenant = await db.tenant.findUniqueOrThrow({ where: { organizationId: organization.id } });
  return { organizationId: organization.id, tenantId: tenant.id, slug, owner };
}

async function addMember(workspace: Workspace, person: Person): Promise<void> {
  await auth.api.addMember({
    body: { userId: person.userId, role: "member", organizationId: workspace.organizationId },
  });
}

/** A meeting with one real transcript segment, so a suggestion has something
 *  to cite that actually exists. */
async function createMeeting(
  workspace: Workspace,
  title: string,
  visibility: "workspace" | "private" = "workspace",
): Promise<{ meetingId: string; segmentId: string }> {
  const { tenantId } = workspace;
  const meeting = await db.meeting.create({
    data: {
      tenantId,
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      title,
      visibility,
      createdByUserId: workspace.owner.userId,
    },
  });

  const evidence = await db.evidenceSource.create({
    data: { tenantId, kind: "meeting_transcript", meetingId: meeting.id, capturedAt: new Date() },
  });
  const transcript = await db.transcript.create({
    data: {
      tenantId,
      meetingId: meeting.id,
      evidenceSourceId: evidence.id,
      provider: "recall",
      segmentCount: 1,
      wordCount: 15,
      durationMs: 60_000,
    },
  });
  const segment = await db.transcriptSegment.create({
    data: {
      tenantId,
      transcriptId: transcript.id,
      idx: 0,
      speaker: "Daniel Okafor",
      startMs: 0,
      endMs: 9_000,
      text: SEGMENT_TEXT,
    },
  });

  return { meetingId: meeting.id, segmentId: segment.id };
}

async function seedSuggestion(
  workspace: Workspace,
  place: { meetingId: string; segmentId: string },
  overrides: { title?: string; groupName?: string | null } = {},
): Promise<string> {
  const item = await db.actionItem.create({
    data: {
      tenantId: workspace.tenantId,
      meetingId: place.meetingId,
      title: overrides.title ?? "Rewrite the pricing page tier boundaries",
      origin: "ai_suggested",
      groupName: overrides.groupName ?? null,
      sourceSegmentId: place.segmentId,
    },
  });
  return item.id;
}

const get = (person: Person, url: string) =>
  app.inject({ method: "GET", url, headers: { cookie: person.cookie } });

const post = (person: Person, url: string, payload: Record<string, unknown> = {}) =>
  app.inject({ method: "POST", url, headers: { cookie: person.cookie }, payload });

/* --- the evidence gate ---------------------------------------------------- */

const suggestion = (overrides: Partial<SuggestedAction> = {}): SuggestedAction => ({
  title: "Rewrite the pricing page tier boundaries",
  description: null,
  ownerHint: null,
  dueDate: null,
  groupHint: null,
  confidence: 0.9,
  sourceHandle: "s0000",
  quote: "I'll rewrite the pricing page tier boundaries before the launch review",
  ...overrides,
});

const handles = new Map<string, SegmentRow>([
  ["s0000", { id: "segment-uuid", idx: 0, text: SEGMENT_TEXT }],
]);

describe("suggestion validation", () => {
  it("keeps a suggestion whose citation resolves to a real segment", () => {
    const { resolved, dropped } = resolveCitations([suggestion()], handles);
    expect(dropped).toBe(0);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.segmentId).toBe("segment-uuid");
  });

  it("drops a suggestion citing a handle the transcript does not contain, and counts it", () => {
    const { resolved, dropped } = resolveCitations(
      [suggestion({ sourceHandle: "s0042" }), suggestion()],
      handles,
    );
    expect(dropped).toBe(1);
    expect(resolved).toHaveLength(1);
  });

  it("drops a suggestion whose quote is not in the segment it cited", () => {
    const { resolved, dropped } = resolveCitations(
      [
        suggestion({
          quote: "I will personally rebuild the entire onboarding flow next quarter",
        }),
      ],
      handles,
    );
    expect(dropped).toBe(1);
    expect(resolved).toHaveLength(0);
  });

  it("refuses to guess an owner when the hint matches nobody, or matches two people", () => {
    const members = [
      { userId: "u1", name: "Priya Raman", email: "priya@example.com" },
      { userId: "u2", name: "Priya Chandra", email: "priya.c@example.com" },
    ];
    expect(resolveOwner("Priya", members)).toBeNull();
    expect(resolveOwner("Nobody At All", members)).toBeNull();
    expect(resolveOwner("Priya Raman", members)).toBe("u1");
    expect(resolveOwner("priya@example.com", members)).toBe("u1");
  });

  it("loses a malformed due date rather than the commitment attached to it", () => {
    expect(parseDueDate("2026-09-04")?.toISOString()).toBe("2026-09-04T00:00:00.000Z");
    expect(parseDueDate("next Friday")).toBeNull();
    expect(parseDueDate("2026-02-31")).toBeNull();
  });
});

/* --- the gate, end to end ------------------------------------------------- */

describe("the suggestion gate", () => {
  it("keeps a pending suggestion out of the working list until it is accepted", async () => {
    const owner = await signIn("owner-a@example.com", "Owner A");
    const workspace = await createWorkspace("gate-workspace", owner);
    const place = await createMeeting(workspace, "Pricing review");
    const id = await seedSuggestion(workspace, place);

    const before = await get(owner, "/api/v1/action-items?scope=all");
    expect(before.statusCode, before.body).toBe(200);
    expect(before.json().action_items).toHaveLength(0);

    const inbox = await get(owner, "/api/v1/action-items/suggestions");
    expect(inbox.statusCode, inbox.body).toBe(200);
    const [pending] = inbox.json().suggestions;
    expect(pending.id).toBe(id);
    expect(pending.pending).toBe(true);
    // The citation travels with the suggestion, words included — accepting is
    // a judgement about evidence, so the evidence has to be on the screen.
    expect(pending.source.segment_id).toBe(place.segmentId);
    expect(pending.source.text).toBe(SEGMENT_TEXT);

    const accepted = await post(owner, `/api/v1/action-items/suggestions/${id}/accept`);
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json().item.accepted_at).not.toBeNull();
    // Accepting is the click that made the item real, and it goes on the record.
    expect(accepted.json().item.created_by_user_id).toBe(owner.userId);

    const after = await get(owner, "/api/v1/action-items?scope=all");
    expect(after.json().action_items.map((item: { id: string }) => item.id)).toEqual([id]);

    const emptied = await get(owner, "/api/v1/action-items/suggestions");
    expect(emptied.json().suggestions).toHaveLength(0);
  });

  it("is idempotent about dismissal and refuses to un-dismiss", async () => {
    const owner = await signIn("owner-b@example.com", "Owner B");
    const workspace = await createWorkspace("dismiss-workspace", owner);
    const place = await createMeeting(workspace, "Pricing review");
    const id = await seedSuggestion(workspace, place);

    const first = await post(owner, `/api/v1/action-items/suggestions/${id}/dismiss`);
    expect(first.statusCode, first.body).toBe(200);
    const dismissedAt = first.json().item.dismissed_at;
    expect(dismissedAt).not.toBeNull();

    const second = await post(owner, `/api/v1/action-items/suggestions/${id}/dismiss`);
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json().item.dismissed_at).toBe(dismissedAt);

    // A dismissed suggestion is gone from both lists, not merely from one.
    expect((await get(owner, "/api/v1/action-items/suggestions")).json().suggestions).toHaveLength(0);
    expect((await get(owner, "/api/v1/action-items?scope=all")).json().action_items).toHaveLength(0);

    const reversal = await post(owner, `/api/v1/action-items/suggestions/${id}/accept`);
    expect(reversal.statusCode).toBe(409);
  });

  it("accepts all of the caller's suggestions and none of another workspace's", async () => {
    const ownerA = await signIn("bulk-a@example.com", "Owner A");
    const workspaceA = await createWorkspace("bulk-workspace-a", ownerA);
    const placeA = await createMeeting(workspaceA, "Pricing review");
    const mine = await seedSuggestion(workspaceA, placeA);
    const alsoMine = await seedSuggestion(workspaceA, placeA, { title: "Draft the launch note" });

    const ownerB = await signIn("bulk-b@example.com", "Owner B");
    const workspaceB = await createWorkspace("bulk-workspace-b", ownerB);
    const placeB = await createMeeting(workspaceB, "Their pricing review");
    const theirs = await seedSuggestion(workspaceB, placeB);

    const response = await post(ownerA, "/api/v1/action-items/suggestions/accept-all");
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().accepted).toBe(2);
    expect(response.json().ids.sort()).toEqual([mine, alsoMine].sort());

    const untouched = await db.actionItem.findUniqueOrThrow({ where: { id: theirs } });
    expect(untouched.acceptedAt).toBeNull();
    expect(untouched.dismissedAt).toBeNull();

    // And the other workspace's owner still sees their own suggestion pending.
    const theirInbox = await get(ownerB, "/api/v1/action-items/suggestions");
    expect(theirInbox.json().suggestions.map((s: { id: string }) => s.id)).toEqual([theirs]);
  });

  /** Run as a plain member on purpose: an owner is an admin, and an admin
   *  skips the visibility filter entirely — so an owner would never exercise
   *  the relation predicate this aggregate has to carry. */
  it("counts the named groups, with the inbox as its own bucket", async () => {
    const owner = await signIn("groups-owner@example.com", "Owner");
    const workspace = await createWorkspace("groups-workspace", owner);
    const colleague = await signIn("groups-member@example.com", "Colleague");
    await addMember(workspace, colleague);
    const place = await createMeeting(workspace, "Pricing review");

    const top = await seedSuggestion(workspace, place, { groupName: "Top priority" });
    const accepted = await post(colleague, `/api/v1/action-items/suggestions/${top}/accept`);
    expect(accepted.statusCode, accepted.body).toBe(200);
    await db.actionItem.create({
      data: {
        tenantId: workspace.tenantId,
        meetingId: place.meetingId,
        title: "Book the retro",
        createdByUserId: owner.userId,
      },
    });

    const response = await get(colleague, "/api/v1/action-items/groups?scope=all");
    expect(response.statusCode, response.body).toBe(200);
    const groups: { group_name: string | null; key: string; count: number }[] =
      response.json().groups;
    expect(groups).toContainEqual({ group_name: "Top priority", key: "Top priority", count: 1 });
    expect(groups).toContainEqual({ group_name: null, key: "inbox", count: 1 });
  });

  it("separates my items from the ones I handed to somebody else", async () => {
    const owner = await signIn("scope-owner@example.com", "Owner");
    const workspace = await createWorkspace("scope-workspace", owner);
    const colleague = await signIn("scope-member@example.com", "Colleague");
    await addMember(workspace, colleague);
    const place = await createMeeting(workspace, "Pricing review");

    const delegated = await db.actionItem.create({
      data: {
        tenantId: workspace.tenantId,
        meetingId: place.meetingId,
        title: "Rewrite the pricing page",
        createdByUserId: owner.userId,
        assigneeUserId: colleague.userId,
      },
    });
    const kept = await db.actionItem.create({
      data: {
        tenantId: workspace.tenantId,
        meetingId: place.meetingId,
        title: "Book the retro",
        createdByUserId: owner.userId,
        assigneeUserId: owner.userId,
      },
    });

    const ids = async (person: Person, scope: string) =>
      (await get(person, `/api/v1/action-items?scope=${scope}`))
        .json()
        .action_items.map((item: { id: string }) => item.id);

    // An item I created and kept is mine, not "assigned to others" — counting
    // it in both is what makes the second list useless.
    expect(await ids(owner, "assigned_by_me")).toEqual([delegated.id]);
    expect(await ids(owner, "mine")).toEqual([kept.id]);
    expect(await ids(colleague, "mine")).toEqual([delegated.id]);
    expect(await ids(colleague, "assigned_by_me")).toEqual([]);
  });

  it("does not show a private meeting's suggestions to the rest of the workspace", async () => {
    const owner = await signIn("private-owner@example.com", "Owner");
    const workspace = await createWorkspace("private-workspace", owner);
    const colleague = await signIn("private-member@example.com", "Colleague");
    await addMember(workspace, colleague);

    const place = await createMeeting(workspace, "Compensation planning", "private");
    const id = await seedSuggestion(workspace, place);

    const theirs = await get(colleague, "/api/v1/action-items/suggestions");
    expect(theirs.statusCode, theirs.body).toBe(200);
    expect(theirs.json().suggestions).toHaveLength(0);

    const ours = await get(owner, "/api/v1/action-items/suggestions");
    expect(ours.json().suggestions.map((s: { id: string }) => s.id)).toEqual([id]);
  });
});
