import crypto from "node:crypto";
import { EvidenceKind, MeetingVisibility, CollaboratorRole } from "@prisma/client";
import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, resetDb } from "./helpers.js";
import { auth } from "../src/auth.js";
import { NOTE_ROOT, projectPlainText } from "../src/collab/persistence.js";
import { liveNote, shutdownCollab } from "../src/collab/yjs-server.js";
import { registerCore } from "../src/http.js";
import { actionItemRoutes } from "../src/routes/action-items.js";
// v2 owns GET /action-items; v1 keeps the meeting-scoped surface. Both are
// registered here because this suite exercises the round trip from a
// transcript-cited create through to the inbox listing.
import { actionItemsV2Routes } from "../src/routes/action-items-v2.js";
import { agendaRoutes } from "../src/routes/agenda.js";
import { collabRoutes } from "../src/collab/yjs-server.js";
import { notesRoutes } from "../src/routes/notes.js";

/**
 * These tests drive the real socket through the real authorization gate: the
 * upgrade carries a session cookie, Better Auth resolves it, and `resolveActor`
 * and `requireMeetingWrite` decide. Nothing about the gate is stubbed — a test
 * that injected an actor would be testing a door with no lock in it.
 *
 * The session rows are written directly rather than through `signUpEmail`
 * because sign-up is broken against the current schema (`Account.issuer` is
 * missing — see the note in `makeSession`). Credential exchange is not what
 * this file is about; everything downstream of the cookie is real.
 */

const MESSAGE_SYNC = 0;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Long enough to cover the server's 2s debounce plus a slow local Postgres. */
const FLUSH_WINDOW_MS = 6_000;

let app: FastifyInstance;
let tenantId: string;
let organizationId: string;
let owner: Session;
let editor: Session;
let viewer: Session;
let outsider: Session;

type Session = { userId: string; cookie: string };

beforeAll(async () => {
  await truncateAuthTables();
  await resetDb();

  app = await buildTestApp();

  owner = await makeSession("owner@collab.test", "Owner");
  editor = await makeSession("editor@collab.test", "Editor");
  viewer = await makeSession("viewer@collab.test", "Viewer");
  outsider = await makeSession("outsider@collab.test", "Outsider");

  const workspace = await makeWorkspace("collab-test");
  organizationId = workspace.organizationId;
  tenantId = workspace.tenantId;

  for (const session of [owner, editor, viewer, outsider]) {
    await addMember(organizationId, session.userId);
  }
}, 60_000);

afterAll(async () => {
  await shutdownCollab();
  await app.close();
  await truncateAuthTables();
  await db.$disconnect();
});

/* ------------------------------------------------------------------------ */

describe("plain-text projection", () => {
  it("flattens a ProseMirror-shaped document into indexable lines", () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment(NOTE_ROOT);

    const heading = new Y.XmlElement("heading");
    heading.insert(0, [new Y.XmlText("Pricing review")]);

    const paragraph = new Y.XmlElement("paragraph");
    const styled = new Y.XmlText("Ship the pricing page by Friday");
    // The formatted run is the point: toString() would render it as markup.
    styled.format(0, 4, { bold: true });
    paragraph.insert(0, [styled]);

    const list = new Y.XmlElement("bulletList");
    const item = new Y.XmlElement("listItem");
    item.insert(0, [new Y.XmlText("Daniel owns the copy")]);
    list.insert(0, [item]);

    fragment.insert(0, [heading, paragraph, list]);

    expect(projectPlainText(doc)).toBe(
      "Pricing review\nShip the pricing page by Friday\nDaniel owns the copy",
    );
    expect(projectPlainText(doc)).not.toContain("bold");
  });

  it("is empty for a document nobody has typed in", () => {
    expect(projectPlainText(new Y.Doc())).toBe("");
  });
});

describe("collab socket authorization", () => {
  it("refuses an upgrade with no session", async () => {
    const meeting = await makeMeeting(owner.userId);
    await expect(app.injectWS(`/api/v1/collab/${meeting.id}`, { headers: {} })).rejects.toThrow(
      /401/,
    );
  });

  it("refuses a member who cannot see the meeting at all", async () => {
    const meeting = await makeMeeting(owner.userId);
    // 404 rather than 403: confirming a private meeting exists is itself a leak.
    await expect(
      app.injectWS(`/api/v1/collab/${meeting.id}`, { headers: { cookie: outsider.cookie } }),
    ).rejects.toThrow(/404/);
  });

  it("refuses a read-only collaborator instead of accepting the socket", async () => {
    const meeting = await makeMeeting(owner.userId);
    await db.meetingCollaborator.create({
      data: {
        tenantId,
        meetingId: meeting.id,
        userId: viewer.userId,
        role: CollaboratorRole.viewer,
      },
    });

    await expect(
      app.injectWS(`/api/v1/collab/${meeting.id}`, { headers: { cookie: viewer.cookie } }),
    ).rejects.toThrow(/403/);

    // And nothing was created on the way to being refused.
    expect(await liveNote(meeting.id)).toBeNull();
  });

  it("accepts a collaborator promoted to editor", async () => {
    const meeting = await makeMeeting(owner.userId);
    await db.meetingCollaborator.create({
      data: {
        tenantId,
        meetingId: meeting.id,
        userId: editor.userId,
        role: CollaboratorRole.editor,
      },
    });

    const client = await connect(meeting.id, editor.cookie);
    await client.close();
  });
});

describe("collaborative notes", () => {
  it("converges two documents through the sync protocol", async () => {
    const meeting = await makeMeeting(owner.userId);
    const a = await connect(meeting.id, owner.cookie);
    const b = await connect(meeting.id, owner.cookie);

    write(a.doc, "Renewal is the whole quarter");
    await waitFor(() => projectPlainText(b.doc).includes("Renewal is the whole quarter"));

    // And back the other way, so this is a shared document rather than a
    // one-directional broadcast that happens to look like one.
    write(b.doc, "Priya to send the numbers");
    await waitFor(() => projectPlainText(a.doc).includes("Priya to send the numbers"));

    expect(projectPlainText(a.doc)).toBe(projectPlainText(b.doc));

    await a.close();
    await b.close();
  });

  it("persists the text projection and bumps the revision", async () => {
    const meeting = await makeMeeting(owner.userId);
    const client = await connect(meeting.id, owner.cookie);

    write(client.doc, "Freeze the headcount discussion until Q3");

    await waitFor(async () => {
      const row = await db.meetingNote.findUnique({ where: { meetingId: meeting.id } });
      return Boolean(row?.plainText.includes("Freeze the headcount discussion until Q3"));
    }, FLUSH_WINDOW_MS);

    const row = await db.meetingNote.findUnique({ where: { meetingId: meeting.id } });
    expect(row?.revision).toBeGreaterThanOrEqual(1);
    expect(row?.state.byteLength).toBeGreaterThan(0);

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/meetings/${meeting.id}/note`,
      headers: { cookie: owner.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().note.plain_text).toContain("Freeze the headcount discussion");
    expect(response.json().note.active_editors).toBe(1);

    await client.close();
  }, 30_000);

  it("flushes and evicts the document when the last client leaves", async () => {
    const meeting = await makeMeeting(owner.userId);
    const first = await connect(meeting.id, owner.cookie);
    write(first.doc, "Evict me after a final flush");
    await waitFor(async () =>
      Boolean((await liveNote(meeting.id))?.plainText.includes("Evict me after a final flush")),
    );

    // Closed well inside the 2s debounce, so the only thing that can have
    // written this row is the flush on the way out.
    await first.close();
    await waitFor(async () => (await liveNote(meeting.id)) === null, FLUSH_WINDOW_MS);

    const row = await db.meetingNote.findUnique({ where: { meetingId: meeting.id } });
    expect(row?.plainText).toContain("Evict me after a final flush");

    // A later reader rebuilds the doc from the row, which is the other half of
    // eviction being safe.
    const second = await connect(meeting.id, owner.cookie);
    await waitFor(() => projectPlainText(second.doc).includes("Evict me after a final flush"));
    await second.close();
  }, 30_000);

  it("serves the note over HTTP for a client that cannot hold a socket", async () => {
    const meeting = await makeMeeting(owner.userId);
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/meetings/${meeting.id}/note`,
      headers: { cookie: owner.cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().note).toMatchObject({ plain_text: "", revision: 0, active_editors: 0 });
  });
});

describe("agenda ordering", () => {
  it("keeps positions unique when several clients reorder at once", async () => {
    const meeting = await makeMeeting(owner.userId);
    const ids: string[] = [];
    for (const title of ["Intros", "Pipeline", "Pricing", "Support load", "Next steps"]) {
      const created = await request("POST", `/api/v1/meetings/${meeting.id}/agenda`, owner, {
        title,
      });
      expect(created.statusCode).toBe(201);
      ids.push(created.json().item.id);
    }
    expect(await positionsOf(meeting.id)).toEqual([0, 1, 2, 3, 4]);

    const orders = [
      [...ids].reverse(),
      [ids[2]!, ids[0]!, ids[4]!, ids[1]!, ids[3]!],
      [ids[1]!, ids[3]!, ids[0]!, ids[2]!, ids[4]!],
      [...ids],
    ];

    const responses = await Promise.all(
      orders.map((item_ids) =>
        request("POST", `/api/v1/meetings/${meeting.id}/agenda/reorder`, owner, { item_ids }),
      ),
    );
    for (const response of responses) expect(response.statusCode).toBe(200);

    const final = await db.agendaItem.findMany({
      where: { meetingId: meeting.id },
      orderBy: { position: "asc" },
      select: { id: true, position: true },
    });
    expect(final.map((item) => item.position)).toEqual([0, 1, 2, 3, 4]);

    // Whichever drag committed last, the result has to be one of the orders
    // that was actually asked for — not a blend of two of them.
    const committed = final.map((item) => item.id);
    expect(orders.some((order) => order.join() === committed.join())).toBe(true);
  }, 30_000);

  it("refuses an order computed against a stale agenda", async () => {
    const meeting = await makeMeeting(owner.userId);
    const first = await request("POST", `/api/v1/meetings/${meeting.id}/agenda`, owner, {
      title: "Intros",
    });
    const second = await request("POST", `/api/v1/meetings/${meeting.id}/agenda`, owner, {
      title: "Pricing",
    });

    const stale = await request(
      "POST",
      `/api/v1/meetings/${meeting.id}/agenda/reorder`,
      owner,
      { item_ids: [second.json().item.id] },
    );
    expect(stale.statusCode).toBe(409);
    expect(await positionsOf(meeting.id)).toEqual([0, 1]);
    expect(first.statusCode).toBe(201);
  });

  it("closes the gap left by a deletion", async () => {
    const meeting = await makeMeeting(owner.userId);
    const created = [];
    for (const title of ["A", "B", "C"]) {
      created.push(
        (await request("POST", `/api/v1/meetings/${meeting.id}/agenda`, owner, { title })).json()
          .item,
      );
    }

    const removed = await request("DELETE", `/api/v1/agenda-items/${created[1]!.id}`, owner);
    expect(removed.statusCode).toBe(204);
    expect(await positionsOf(meeting.id)).toEqual([0, 1]);
  });
});

describe("action item provenance", () => {
  it("refuses a transcript-sourced item with no citation", async () => {
    const meeting = await makeMeeting(owner.userId);
    const response = await request(
      "POST",
      `/api/v1/meetings/${meeting.id}/action-items`,
      owner,
      { title: "Send the security questionnaire", origin: "transcript" },
    );

    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.json())).toContain("source_segment_id");
  });

  it("refuses a citation that belongs to a different meeting", async () => {
    const mine = await makeMeeting(owner.userId);
    const other = await makeMeeting(owner.userId);
    const foreign = await makeSegment(other.id, "We agreed to send the questionnaire");

    const response = await request("POST", `/api/v1/meetings/${mine.id}/action-items`, owner, {
      title: "Send the security questionnaire",
      origin: "transcript",
      source_segment_id: foreign.id,
    });

    expect(response.statusCode).toBe(422);
    expect(await db.actionItem.count({ where: { meetingId: mine.id } })).toBe(0);
  });

  it("keeps the citation on an item lifted from the transcript", async () => {
    const meeting = await makeMeeting(owner.userId);
    const segment = await makeSegment(meeting.id, "Daniel will send the questionnaire on Monday");

    const created = await request(
      "POST",
      `/api/v1/meetings/${meeting.id}/action-items`,
      owner,
      {
        title: "Send the security questionnaire",
        origin: "transcript",
        source_segment_id: segment.id,
        assignee_user_id: editor.userId,
      },
    );
    expect(created.statusCode).toBe(201);
    expect(created.json().item.source).toMatchObject({ segment_id: segment.id, idx: 0 });

    const inbox = await request("GET", "/api/v1/action-items", editor);
    expect(inbox.statusCode).toBe(200);
    const items = inbox.json().action_items as Array<{
      title: string;
      source: unknown;
      source_redacted?: boolean;
    }>;
    const assigned = items.find((i) => i.title === "Send the security questionnaire");

    // Assigned work is visible to its assignee even though the meeting is
    // private and they are not on it — otherwise the assignment fails silently.
    expect(assigned).toBeDefined();

    // But the citation is a verbatim transcript line from a meeting they
    // cannot read, so it does not travel with the item.
    expect(assigned?.source).toBeNull();
    expect(assigned?.source_redacted).toBe(true);
  });

  it("keeps the citation when the assignee can read the meeting", async () => {
    const meeting = await makeMeeting(owner.userId);
    await db.meeting.update({
      where: { id: meeting.id },
      data: { visibility: MeetingVisibility.workspace },
    });
    const segment = await makeSegment(meeting.id, "Daniel will send the questionnaire on Monday");

    await request("POST", `/api/v1/meetings/${meeting.id}/action-items`, owner, {
      title: "Send the workspace-visible questionnaire",
      origin: "transcript",
      source_segment_id: segment.id,
      assignee_user_id: editor.userId,
    });

    const inbox = await request("GET", "/api/v1/action-items", editor);
    const items = inbox.json().action_items as Array<{
      title: string;
      source: { segment_id: string } | null;
    }>;
    const assigned = items.find((i) => i.title === "Send the workspace-visible questionnaire");
    expect(assigned?.source).toMatchObject({ segment_id: segment.id });
  });

  it("will not assign an item to somebody outside the workspace", async () => {
    const meeting = await makeMeeting(owner.userId);
    const stranger = await makeSession("stranger@collab.test", "Stranger");

    const response = await request("POST", `/api/v1/meetings/${meeting.id}/action-items`, owner, {
      title: "Not yours to hand out",
      assignee_user_id: stranger.userId,
    });
    expect(response.statusCode).toBe(400);
  }, 30_000);
});

/* ------------------------------------------------------------------------
 * Harness
 * --------------------------------------------------------------------- */

async function buildTestApp(): Promise<FastifyInstance> {
  // Not `buildServer()`: these routes are not mounted in server.ts yet, and the
  // point of this app is the collab stack plus the real request context, not
  // CORS, helmet and rate limiting.
  const instance = Fastify({ logger: false });
  registerCore(instance);
  // Registered here rather than left to collabRoutes' own fallback: the plugin
  // decorates whichever instance registers it, and `injectWS` has to land on
  // the one these tests hold. collabRoutes sees the decorator and stands down.
  await instance.register(websocket);
  await instance.register(
    async (api) => {
      await api.register(collabRoutes);
      await api.register(notesRoutes);
      await api.register(agendaRoutes);
      await api.register(actionItemRoutes);
      await api.register(actionItemsV2Routes);
    },
    { prefix: "/api/v1" },
  );
  await instance.ready();
  return instance;
}

/**
 * A signed-in user, without going through sign-up.
 *
 * `auth.api.signUpEmail` cannot run against this schema: Better Auth 1.7 scopes
 * account identity by `issuer` and writes that column, and `model Account` in
 * schema.prisma does not have it. The session row and its cookie are the whole
 * input `resolveActor` needs, so they are written here — and the cookie is
 * signed exactly as better-call signs it, so Better Auth verifies it for real
 * rather than being talked out of checking.
 */
async function makeSession(email: string, name: string): Promise<Session> {
  const now = new Date();
  const user = await db.user.create({
    data: {
      id: crypto.randomUUID(),
      name,
      email,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    },
  });

  const token = crypto.randomBytes(32).toString("base64url");
  await db.session.create({
    data: {
      id: crypto.randomUUID(),
      token,
      userId: user.id,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      createdAt: now,
      updatedAt: now,
    },
  });

  const context = await auth.$context;
  const signature = crypto.createHmac("sha256", context.secret).update(token).digest("base64");
  const value = encodeURIComponent(`${token}.${signature}`);
  return { userId: user.id, cookie: `${context.authCookies.sessionToken.name}=${value}` };
}

async function makeWorkspace(slug: string): Promise<{ organizationId: string; tenantId: string }> {
  // Written directly rather than through the organization plugin: this file is
  // about collaboration, and the workspace only has to exist and be consistent.
  const organization = await db.organization.create({
    data: { id: crypto.randomUUID(), name: slug, slug, createdAt: new Date() },
  });
  const tenant = await db.tenant.create({
    data: { slug, name: slug, organizationId: organization.id },
  });
  return { organizationId: organization.id, tenantId: tenant.id };
}

async function addMember(orgId: string, userId: string): Promise<void> {
  // "member", never "admin": an admin gets write access to every meeting in the
  // workspace, which would quietly make the read-only test unfalsifiable.
  await db.member.create({
    data: { id: crypto.randomUUID(), organizationId: orgId, userId, role: "member", createdAt: new Date() },
  });
}

async function makeMeeting(createdByUserId: string) {
  return db.meeting.create({
    data: {
      tenantId,
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      title: "Quarterly sync",
      visibility: MeetingVisibility.private,
      createdByUserId,
    },
  });
}

async function makeSegment(meetingId: string, text: string) {
  const evidenceSource = await db.evidenceSource.create({
    data: {
      tenantId,
      kind: EvidenceKind.meeting_transcript,
      meetingId,
      capturedAt: new Date(),
    },
  });
  const transcript = await db.transcript.create({
    data: {
      tenantId,
      meetingId,
      evidenceSourceId: evidenceSource.id,
      provider: "test",
      segmentCount: 1,
      wordCount: text.split(" ").length,
      durationMs: 10_000,
    },
  });
  return db.transcriptSegment.create({
    data: {
      tenantId,
      transcriptId: transcript.id,
      idx: 0,
      speaker: "Daniel",
      startMs: 0,
      endMs: 10_000,
      text,
    },
  });
}

function request(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  session: Session,
  payload?: unknown,
) {
  return app.inject({
    method,
    url,
    headers: { cookie: session.cookie },
    ...(payload === undefined ? {} : { payload }),
  });
}

async function positionsOf(meetingId: string): Promise<number[]> {
  const items = await db.agendaItem.findMany({
    where: { meetingId },
    orderBy: { position: "asc" },
    select: { position: true },
  });
  return items.map((item) => item.position);
}

/* --- A minimal y-websocket client, so the server talks to the real protocol */

type Client = { doc: Y.Doc; close: () => Promise<void> };

async function connect(meetingId: string, cookie: string): Promise<Client> {
  const doc = new Y.Doc();
  const socket = await app.injectWS(`/api/v1/collab/${meetingId}`, { headers: { cookie } });

  // The upgrade resolves before the route handler has joined the room, and the
  // handler's own SyncStep1 is the first thing it sends. Waiting for it makes
  // "connected" mean the server is listening, not just that the socket exists.
  let joined: () => void;
  const inRoom = new Promise<void>((resolve) => {
    joined = resolve;
  });

  socket.on("message", (data: Buffer) => {
    joined();
    const decoder = decoding.createDecoder(Uint8Array.from(data));
    if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) return;

    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.readSyncMessage(decoder, encoder, doc, "server");
    if (encoding.length(encoder) > 1) socket.send(encoding.toUint8Array(encoder));
  });

  doc.on("update", (update: Uint8Array, origin: unknown) => {
    // Anything the server sent is already there; echoing it back is a loop.
    if (origin === "server") return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    socket.send(encoding.toUint8Array(encoder));
  });

  // The client opens the conversation — see the client/server note in
  // y-protocols/sync. The server has already sent its own SyncStep1.
  const step1 = encoding.createEncoder();
  encoding.writeVarUint(step1, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(step1, doc);
  socket.send(encoding.toUint8Array(step1));

  await inRoom;

  return {
    doc,
    close: () =>
      new Promise<void>((resolve) => {
        socket.on("close", () => resolve());
        // `terminate`, not `close`: the injected transport is a pair of
        // in-memory streams and the closing handshake never completes over it,
        // so a graceful close would leave the server socket open forever.
        socket.terminate();
      }),
  };
}

function write(doc: Y.Doc, text: string): void {
  const paragraph = new Y.XmlElement("paragraph");
  paragraph.insert(0, [new Y.XmlText(text)]);
  const fragment = doc.getXmlFragment(NOTE_ROOT);
  fragment.insert(fragment.length, [paragraph]);
}

async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function truncateAuthTables(): Promise<void> {
  // Better Auth's tables are outside resetDb()'s list, and a leftover user with
  // the same email would make sign-up fail on the second run.
  await db.$executeRawUnsafe(
    `TRUNCATE TABLE "user", "session", "account", "verification", "organization", "member", "invitation" CASCADE`,
  );
}
