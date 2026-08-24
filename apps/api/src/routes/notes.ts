import type { FastifyInstance } from "fastify";
import { requireActor, requireMeetingRead } from "../authz.js";
import { loadNote } from "../collab/persistence.js";
import { liveNote } from "../collab/yjs-server.js";
import { noStore } from "../http.js";

/**
 * The read-only door onto a collaborative note.
 *
 * The note itself lives in the CRDT and is edited over the websocket in
 * `collab/yjs-server.ts`. This exists for everything that cannot hold a socket
 * open: a share page, a digest email, a mobile client on a train. It returns
 * text, never the Yjs state — a caller that could hold the binary state could
 * hold a socket, and handing out a state vector to a reader invites a client to
 * write back through some second path that does not exist.
 */
export async function notesRoutes(app: FastifyInstance): Promise<void> {
  app.get("/meetings/:id/note", async (request, reply) => {
    const actor = requireActor(request);
    const { id } = request.params as { id: string };
    await requireMeetingRead(actor, id);

    const stored = await loadNote(id);
    const live = await liveNote(id);

    // A meeting with no note row has never been edited, which is not the same
    // as missing — hence an empty note rather than a 404. Otherwise every
    // client would carry an error path for the ordinary case of a fresh
    // meeting. The row is created by the first flush, not with the meeting.
    noStore(reply);
    return {
      note: {
        meeting_id: id,
        // In-memory text wins when a room is open: the row behind it is at most
        // one debounce window stale, and a reader who has just been told there
        // are two active editors will not thank us for two-second-old text.
        plain_text: live?.plainText ?? stored?.plainText ?? "",
        revision: stored?.revision ?? 0,
        updated_at: stored?.updatedAt.toISOString() ?? null,
        updated_by_user_id: stored?.updatedByUserId ?? null,
        active_editors: live?.editors ?? 0,
      },
    };
  });
}
