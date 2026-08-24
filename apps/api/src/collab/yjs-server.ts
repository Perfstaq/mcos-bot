import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import * as Y from "yjs";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import { requireActor, requireMeetingWrite } from "../authz.js";
import { runWithContext, type RequestContext } from "../context.js";
import { requireCtx } from "../http.js";
import { hydrateDoc, persistNote, projectPlainText } from "./persistence.js";

/**
 * Collaborative notes over websockets.
 *
 * The wire format is y-websocket's, byte for byte, because the browser side is
 * the stock `y-websocket` provider and it will not negotiate anything else: a
 * varuint message type, then either a y-protocols sync message or a
 * y-protocols awareness update.
 *
 * Everything interesting here is lifecycle rather than protocol. One Y.Doc per
 * meeting is shared by every socket on it, hydrated on the first connection and
 * evicted after the last one leaves, with a debounced write in between.
 */

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

/**
 * Long enough to coalesce a burst of typing into one row write, short enough
 * that a browser crash costs a sentence rather than a paragraph.
 */
const FLUSH_DEBOUNCE_MS = 2_000;

/**
 * A laptop lid closed on wifi never produces a `close` event. Without a
 * liveness probe that socket stays in the room forever, which means the doc is
 * never evicted and the meeting's notes sit in memory until the process
 * restarts.
 */
const PING_INTERVAL_MS = 30_000;

/**
 * `ws` defaults to a 100 MiB frame limit, which on an authenticated-but-hostile
 * client is a memory exhaustion lever. A whole-document SyncStep2 for a long
 * meeting is a few hundred kilobytes; five megabytes is generous.
 */
const MAX_MESSAGE_BYTES = 5 * 1024 * 1024;

/** Close codes. 4000-4999 is the range reserved for the application. */
const CLOSE_INTERNAL_ERROR = 4500;

/** `ws`'s OPEN readyState. Named because `1` at a call site means nothing. */
const SOCKET_OPEN = 1;

/**
 * The slice of the `ws` socket this file uses.
 *
 * `ws` ships no types and `@types/ws` is not a dependency, so @fastify/websocket
 * hands the handler an `any`. Naming the surface once stops that `any` from
 * spreading through the room bookkeeping below.
 */
interface CollabSocket {
  readonly readyState: number;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  ping(): void;
  on(event: "message", listener: (data: unknown, isBinary: boolean) => void): void;
  on(event: "close" | "error" | "pong", listener: (...args: unknown[]) => void): void;
}

type Member = {
  userId: string;
  /** Awareness client ids this socket speaks for, so they can be cleared on disconnect. */
  awarenessIds: Set<number>;
  /** Cleared by every pong; a socket that misses a whole interval is terminated. */
  alive: boolean;
};

type Room = {
  meetingId: string;
  /**
   * The tenant this room writes as. Pinned from whoever opened it rather than
   * read from the ambient store at flush time: every member is in the same
   * tenant (the meeting lookup guarantees it), so the only thing an ambient
   * read would add is a dependency on which socket happened to type last.
   */
  ctx: RequestContext;
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  sockets: Map<CollabSocket, Member>;
  log: FastifyBaseLogger;
  /** Last persisted revision. Ahead of the in-memory doc by at most one debounce window. */
  revision: number;
  dirty: boolean;
  flushTimer: NodeJS.Timeout | null;
  lastEditorUserId: string | null;
  evicted: boolean;
};

/**
 * Keyed by meeting id and holding a promise, not a room: two sockets arriving
 * at once on a cold meeting must share one hydration, not race to build two
 * docs and have one of them silently win.
 */
const rooms = new Map<string, Promise<Room>>();

declare module "fastify" {
  interface FastifyRequest {
    /** Set on the upgrade request by the collab route's preValidation hook. */
    collabRoom?: Room;
  }
}

/* -------------------------------------------------------------------------
 * Route
 * ---------------------------------------------------------------------- */

export async function collabRoutes(app: FastifyInstance): Promise<void> {
  // @fastify/websocket is fastify-plugin wrapped, so it decorates the enclosing
  // scope and registering it twice fails on the duplicate `websocketServer`
  // decorator. Defer to whoever registered it first.
  if (!app.hasDecorator("websocketServer")) {
    await app.register(websocket, { options: { maxPayload: MAX_MESSAGE_BYTES } });
  }

  // Nested so the route is declared in a scope created *after* the plugin's
  // onRoute hook exists. A websocket route registered before that hook is never
  // upgraded and fails as a bare 404, with nothing to suggest why.
  await app.register(async (scoped) => {
    scoped.get<{ Params: { meetingId: string } }>(
      "/collab/:meetingId",
      {
        websocket: true,
        /**
         * Authorization runs on the upgrade, not after it.
         *
         * Checking inside the handler means the socket exists — accepted,
         * upgraded, able to send — for the whole window in which the check is
         * awaited. Every "we close it immediately" websocket hole is that
         * window. Throwing here makes the upgrade fail as an HTTP 401/403/404
         * and the raw socket is destroyed by the plugin's onResponse hook.
         */
        preValidation: async (request) => {
          const actor = requireActor(request);
          await requireMeetingWrite(actor, request.params.meetingId);

          // Hydrated here, before the upgrade, so the handler below can attach
          // its listeners synchronously. `ws` drops a message that arrives
          // while nothing is listening for it, and a y-websocket client sends
          // its opening SyncStep1 the instant the socket opens — awaiting a
          // database round trip inside the handler eats that message and leaves
          // the client staring at an empty document it will never fill.
          request.collabRoom = await openRoom(
            request.params.meetingId,
            requireCtx(request),
            request.log,
          );
        },
      },
      // Deliberately not async: see the note above.
      (rawSocket, request) => {
        const socket = rawSocket as CollabSocket;
        const room = request.collabRoom;
        if (!room) {
          // Unreachable — preValidation either sets the room or throws — but a
          // socket with no document is worse than a refused one.
          socket.close(CLOSE_INTERNAL_ERROR, "note unavailable");
          return;
        }

        // The client can be gone before the handler runs; a reload part-way
        // through connecting is exactly that. Joining would file a member whose
        // `close` has already fired with nobody listening, and the room would
        // never be evicted.
        if (socket.readyState !== SOCKET_OPEN) {
          void evictIfEmpty(room).catch((error) => {
            room.log.error({ err: error, meetingId: room.meetingId }, "collab evict failed");
          });
          return;
        }

        join(room, socket, requireActor(request).userId);
      },
    );

    // Eviction normally happens when the last socket leaves; a shutdown has no
    // last socket, so the rooms still open would take their unflushed edits
    // with them.
    scoped.addHook("onClose", async () => {
      await shutdownCollab();
    });
  });
}

/* -------------------------------------------------------------------------
 * Connection lifecycle
 * ---------------------------------------------------------------------- */

function join(room: Room, socket: CollabSocket, userId: string): void {
  const member: Member = { userId, awarenessIds: new Set(), alive: true };
  room.sockets.set(socket, member);

  // Client-server sync is asymmetric: the server announces its state vector and
  // lets the client decide what to send back. See the protocol note in
  // y-protocols/sync.
  const sync = encoding.createEncoder();
  encoding.writeVarUint(sync, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(sync, room.doc);
  socket.send(encoding.toUint8Array(sync));

  const states = room.awareness.getStates();
  if (states.size > 0) {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(room.awareness, [...states.keys()]),
    );
    socket.send(encoding.toUint8Array(encoder));
  }

  const ping = setInterval(() => {
    if (!member.alive) {
      // Terminate rather than close: a half-open socket will not answer a
      // close handshake either.
      socket.terminate();
      return;
    }
    member.alive = false;
    socket.ping();
  }, PING_INTERVAL_MS);

  socket.on("message", (data) => {
    const bytes = toBytes(data);
    if (!bytes) return;
    try {
      handleMessage(room, socket, member, bytes);
    } catch (error) {
      // A malformed frame is one client's problem. Dropping it beats tearing
      // down a document everyone else is still editing.
      room.log.warn({ err: error, meetingId: room.meetingId }, "collab message rejected");
    }
  });

  socket.on("pong", () => {
    member.alive = true;
  });

  socket.on("error", (error) => {
    room.log.warn({ err: error, meetingId: room.meetingId }, "collab socket error");
  });

  socket.on("close", () => {
    clearInterval(ping);
    void leave(room, socket).catch((error) => {
      room.log.error({ err: error, meetingId: room.meetingId }, "collab room failed to close");
    });
  });
}

async function leave(room: Room, socket: CollabSocket): Promise<void> {
  const member = room.sockets.get(socket);
  room.sockets.delete(socket);

  if (member && member.awarenessIds.size > 0) {
    // Otherwise the departed client's cursor sits in everyone else's editor for
    // the 30 seconds awareness takes to time it out.
    awarenessProtocol.removeAwarenessStates(room.awareness, [...member.awarenessIds], "disconnect");
  }

  await evictIfEmpty(room);
}

async function evictIfEmpty(room: Room): Promise<void> {
  if (room.evicted || room.sockets.size > 0) return;

  if (room.flushTimer) {
    clearTimeout(room.flushTimer);
    room.flushTimer = null;
  }
  // The doc is about to stop existing, so a debounce window's worth of edits
  // would go with it.
  await flush(room);

  // A reconnect can land while the final flush is in flight — a page reload is
  // exactly that shape. Evicting anyway would drop the doc out from under a
  // socket that is already synced against it.
  if (room.sockets.size > 0) return;

  evict(room);
}

/**
 * Idempotent because two paths reach it: the last socket leaving, and shutdown
 * closing every socket at once. The second makes the first fire again a tick
 * later, on a document that has already been destroyed.
 */
function evict(room: Room): void {
  if (room.evicted) return;
  room.evicted = true;
  room.awareness.destroy();
  room.doc.destroy();
  rooms.delete(room.meetingId);
}

/* -------------------------------------------------------------------------
 * Rooms
 * ---------------------------------------------------------------------- */

async function openRoom(
  meetingId: string,
  ctx: RequestContext,
  log: FastifyBaseLogger,
): Promise<Room> {
  const existing = rooms.get(meetingId);
  if (existing) return existing;

  const pending = (async (): Promise<Room> => {
    const doc = new Y.Doc();
    const revision = await runWithContext(ctx, () => hydrateDoc(meetingId, doc));

    const awareness = new awarenessProtocol.Awareness(doc);
    // The server is a relay, not a participant; a local state would show up as
    // a phantom cursor in every client.
    awareness.setLocalState(null);

    const room: Room = {
      meetingId,
      ctx,
      doc,
      awareness,
      sockets: new Map(),
      log,
      revision,
      dirty: false,
      flushTimer: null,
      lastEditorUserId: null,
      evicted: false,
    };

    // Attached after hydration on purpose: replaying the stored state would
    // otherwise mark a freshly loaded doc dirty and rewrite the row unchanged.
    doc.on("update", (update: Uint8Array, origin: unknown) => onDocUpdate(room, update, origin));
    awareness.on("update", (changes: AwarenessChanges, origin: unknown) =>
      onAwarenessUpdate(room, changes, origin),
    );

    return room;
  })();

  rooms.set(meetingId, pending);
  // A failed hydration must not leave a rejected promise in the registry, or
  // every later connection to this meeting fails with the same stale error.
  pending.catch(() => {
    if (rooms.get(meetingId) === pending) rooms.delete(meetingId);
  });

  return pending;
}

/**
 * The note as it stands in memory, for readers that are not holding a socket.
 *
 * `revision` is the last *persisted* one, so a live doc's text can be ahead of
 * its revision by less than one debounce window. That gap is precisely what the
 * debounce buys, and pretending otherwise would mean handing out a revision
 * number no row has.
 */
export async function liveNote(
  meetingId: string,
): Promise<{ plainText: string; revision: number; editors: number } | null> {
  const pending = rooms.get(meetingId);
  if (!pending) return null;
  const room = await pending;
  return {
    plainText: projectPlainText(room.doc),
    revision: room.revision,
    editors: room.sockets.size,
  };
}

/** Flush and evict every open room. Wired to the server's onClose hook. */
export async function shutdownCollab(): Promise<void> {
  const open = [...rooms.values()];
  await Promise.allSettled(
    open.map(async (pending) => {
      const room = await pending;
      if (room.flushTimer) {
        clearTimeout(room.flushTimer);
        room.flushTimer = null;
      }
      for (const socket of room.sockets.keys()) socket.close(1001, "server shutting down");
      room.sockets.clear();
      await flush(room);
      evict(room);
    }),
  );
}

/* -------------------------------------------------------------------------
 * Persistence scheduling
 * ---------------------------------------------------------------------- */

function scheduleFlush(room: Room): void {
  if (room.flushTimer) return;
  room.flushTimer = setTimeout(() => {
    room.flushTimer = null;
    void flush(room);
  }, FLUSH_DEBOUNCE_MS);
}

async function flush(room: Room): Promise<void> {
  if (!room.dirty) return;
  room.dirty = false;
  try {
    room.revision = await runWithContext(room.ctx, () =>
      persistNote({
        tenantId: room.ctx.tenantId,
        meetingId: room.meetingId,
        doc: room.doc,
        editorUserId: room.lastEditorUserId,
      }),
    );
  } catch (error) {
    // Stay dirty so the next edit — or the eviction flush — tries again. The
    // doc in memory is still authoritative; only the snapshot is behind.
    room.dirty = true;
    room.log.error({ err: error, meetingId: room.meetingId }, "collab note flush failed");
  }
}

/* -------------------------------------------------------------------------
 * Wire protocol
 * ---------------------------------------------------------------------- */

function handleMessage(room: Room, socket: CollabSocket, member: Member, data: Uint8Array): void {
  const decoder = decoding.createDecoder(data);
  const messageType = decoding.readVarUint(decoder);

  if (messageType === MESSAGE_SYNC) {
    // Attribute the write before applying it: readSyncMessage runs the doc's
    // update handler synchronously, and that is where the flush is scheduled.
    room.lastEditorUserId = member.userId;

    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.readSyncMessage(decoder, encoder, room.doc, socket);
    // Only SyncStep1 produces a reply; anything longer than the type byte is one.
    if (encoding.length(encoder) > 1) socket.send(encoding.toUint8Array(encoder));
    return;
  }

  if (messageType === MESSAGE_AWARENESS) {
    awarenessProtocol.applyAwarenessUpdate(
      room.awareness,
      decoding.readVarUint8Array(decoder),
      socket,
    );
    return;
  }

  // Unknown types are ignored rather than fatal: a newer client speaking one
  // extra message must not knock the document offline for everyone.
}

function onDocUpdate(room: Room, update: Uint8Array, origin: unknown): void {
  room.dirty = true;
  scheduleFlush(room);

  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeUpdate(encoder, update);
  const message = encoding.toUint8Array(encoder);

  for (const socket of room.sockets.keys()) {
    // The originating socket already applied this locally.
    if (socket !== origin) send(room, socket, message);
  }
}

type AwarenessChanges = { added: number[]; updated: number[]; removed: number[] };

function onAwarenessUpdate(room: Room, changes: AwarenessChanges, origin: unknown): void {
  const member = room.sockets.get(origin as CollabSocket);
  if (member) {
    for (const id of changes.added) member.awarenessIds.add(id);
    for (const id of changes.removed) member.awarenessIds.delete(id);
  }

  const changed = [...changes.added, ...changes.updated, ...changes.removed];
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(
    encoder,
    awarenessProtocol.encodeAwarenessUpdate(room.awareness, changed),
  );
  const message = encoding.toUint8Array(encoder);

  // Echoed to the origin too: awareness state is clock-ordered, so a client
  // that sees its own update back learns the clock the room settled on.
  for (const socket of room.sockets.keys()) send(room, socket, message);
}

function send(room: Room, socket: CollabSocket, message: Uint8Array): void {
  try {
    socket.send(message);
  } catch (error) {
    // A socket that cannot be written to is gone; dropping it here keeps one
    // dead peer from stalling the fan-out to everyone else.
    room.log.warn({ err: error, meetingId: room.meetingId }, "collab send failed");
    socket.terminate();
  }
}

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  // `ws` delivers a fragmented binary message as an array of chunks.
  if (Array.isArray(data)) return Buffer.concat(data as Uint8Array[]);
  return null;
}
