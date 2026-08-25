import * as Y from "yjs";
import { prisma } from "../db.js";

/**
 * The bridge between a live Y.Doc and the `meeting_notes` row behind it.
 *
 * The CRDT is the system of record for the note's *content*; the row is a
 * snapshot of it plus a projection that Postgres can index. Keeping the two
 * concerns in one file makes it obvious that they must be written together —
 * a snapshot without a refreshed projection is a note that silently stops
 * being findable.
 */

/**
 * The note document's root shared type.
 *
 * `default` as a Y.XmlFragment is what y-prosemirror (and therefore Tiptap)
 * binds to with no configuration, so the browser and this server agree without
 * either of them carrying a setting. Pinning one root rather than projecting
 * whatever roots happen to exist is deliberate: the projection below is what
 * full-text search indexes, and an index that silently goes empty is a bug
 * nobody notices for months.
 */
export const NOTE_ROOT = "default";

export type NoteRecord = {
  state: Uint8Array;
  plainText: string;
  revision: number;
  updatedAt: Date;
  updatedByUserId: string | null;
};

export async function loadNote(meetingId: string): Promise<NoteRecord | null> {
  return prisma.meetingNote.findUnique({
    where: { meetingId },
    select: {
      state: true,
      plainText: true,
      revision: true,
      updatedAt: true,
      updatedByUserId: true,
    },
  });
}

/**
 * Bring an empty doc up to the persisted state and report the revision it is
 * now at. Returns 0 for a meeting that has never been edited — the note row is
 * created by the first flush rather than eagerly with the meeting, so most
 * meetings never carry one.
 */
export async function hydrateDoc(meetingId: string, doc: Y.Doc): Promise<number> {
  const row = await loadNote(meetingId);
  if (!row) return 0;
  Y.applyUpdate(doc, row.state);
  return row.revision;
}

/**
 * Snapshot the doc into its row and return the new revision.
 *
 * `encodeStateAsUpdate` writes the whole document, not a delta. That makes the
 * row self-contained: a client that has been offline for a week is brought
 * current from one read, and there is no append log to prune. The cost is that
 * every flush rewrites the note, which is exactly why the caller debounces.
 */
export async function persistNote(args: {
  tenantId: string;
  meetingId: string;
  doc: Y.Doc;
  editorUserId: string | null;
}): Promise<number> {
  // Prisma 6 types `Bytes` as a Uint8Array backed by a plain ArrayBuffer; Yjs
  // makes no such promise about the view it returns. The copy is what reconciles
  // them, and a note-sized copy is cheaper than reasoning about the alternative.
  const state = Uint8Array.from(Y.encodeStateAsUpdate(args.doc));
  const plainText = projectPlainText(args.doc);

  const row = await prisma.meetingNote.upsert({
    where: { meetingId: args.meetingId },
    create: {
      tenantId: args.tenantId,
      meetingId: args.meetingId,
      state,
      plainText,
      revision: 1,
      updatedByUserId: args.editorUserId,
    },
    update: {
      state,
      plainText,
      revision: { increment: 1 },
      updatedByUserId: args.editorUserId,
    },
    select: { revision: true },
  });
  return row.revision;
}

/**
 * Flatten the note into the plain text that `meeting_notes.plain_text` holds.
 *
 * The GIN index is on `to_tsvector('english', coalesce(plain_text,''))`, so
 * this only has to preserve words and their separation — layout, marks and
 * attributes are noise to a tsvector and are dropped.
 */
export function projectPlainText(doc: Y.Doc): string {
  const lines: string[] = [];
  collectLines(doc.getXmlFragment(NOTE_ROOT), lines);
  return lines.join("\n");
}

function collectLines(node: Y.XmlFragment, lines: string[]): void {
  let line = "";
  for (const child of node.toArray()) {
    if (child instanceof Y.XmlText) {
      line += deltaText(child);
    } else if (child instanceof Y.XmlElement) {
      // In a ProseMirror document every element is a block or an embed —
      // inline styling lives in Y.Text formatting, not in elements — so an
      // element boundary is always a word boundary, never mid-word.
      if (line.trim().length > 0) lines.push(line.trim());
      line = "";
      collectLines(child, lines);
    }
  }
  if (line.trim().length > 0) lines.push(line.trim());
}

/**
 * `Y.XmlText.toString()` re-renders formatting marks as XML tags, which would
 * put `strong` and `em` into the search index as if they were words. The delta
 * carries the same characters with the marks as attributes instead, so it is
 * the honest source for a text projection.
 */
function deltaText(text: Y.XmlText): string {
  const ops = text.toDelta() as Array<{ insert?: unknown }>;
  let out = "";
  for (const op of ops) {
    if (typeof op.insert === "string") out += op.insert;
  }
  return out;
}
