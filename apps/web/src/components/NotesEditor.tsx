import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import type { DecorationAttrs } from "@tiptap/pm/view";
import StarterKit from "@tiptap/starter-kit";
import Collaboration from "@tiptap/extension-collaboration";
// Tiptap 3 renamed this extension: `@tiptap/extension-collaboration-cursor` is
// v2's name and does not exist in the installed tree. The v3 package exports
// `CollaborationCaret` both by name and as default — see
// node_modules/@tiptap/extension-collaboration-caret/dist/index.d.ts.
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";

/**
 * The collaborative note, and an honest account of whether it is being saved.
 *
 * A CRDT editor fails quietly by design: when the socket dies the document
 * keeps accepting keystrokes and merges them later, which is the right
 * behaviour and the wrong thing to say nothing about. Someone typing into a
 * disconnected tab has written a paragraph that exists in exactly one place,
 * and a reload will take it. So the connection state is a first-class part of
 * this component rather than a detail of the provider — every state the socket
 * can be in has a label, and the one that can lose work has a banner.
 */

/** The socket, as the person typing experiences it. */
type LinkState = "connecting" | "live" | "reconnecting" | "offline";

/**
 * How many failed attempts before we stop calling it "reconnecting".
 *
 * A refused upgrade and an unreachable server are the same event in the
 * browser — both surface as close code 1006 with no body — so the only signal
 * available is that it keeps happening. Three is enough to have ridden out a
 * deploy or a sleeping laptop's first retry, and few enough that a user whose
 * access was revoked is not watching a spinner lie for a minute.
 */
const OFFLINE_AFTER_FAILURES = 3;

export type NotesUser = { id: string; name: string; color: string };

type Peer = { clientId: number; name: string; color: string };

type Session = { doc: Y.Doc; provider: WebsocketProvider };

export function NotesEditor({
  meetingId,
  user,
  head,
}: {
  meetingId: string;
  user: NotesUser;
  /**
   * Replaces the "Notes" label in the header row.
   *
   * Exists so a page that puts the notes behind a tab can put the tabs in this
   * row instead of stacking a second 40px header above it. The presence avatars
   * and the connection chip stay here either way — they report on the notes,
   * and a reader who cannot see that the document has stopped saving is the one
   * failure this component must never allow.
   */
  head?: ReactNode;
}) {
  const [session, setSession] = useState<Session | null>(null);
  const [link, setLink] = useState<LinkState>("connecting");
  const [peers, setPeers] = useState<Peer[]>([]);

  // Counted here rather than read off `provider.wsUnsuccessfulReconnects` so
  // that the manual retry below can reset it. The provider's counter drives its
  // own backoff and resetting it would also reset the backoff.
  const failures = useRef(0);
  const opened = useRef(false);

  useEffect(() => {
    // Guards the deferred peer update below: StrictMode tears this effect down
    // and rebuilds it, and a microtask queued by the first pass must not write
    // state belonging to a session that has already been destroyed.
    let cancelled = false;
    const doc = new Y.Doc();

    // Deliberately no `field`/`fragment` override anywhere in this file: the
    // server's snapshot projection is pinned to the `default` XmlFragment
    // (apps/api/src/collab/persistence.ts, NOTE_ROOT), which is also what
    // y-prosemirror binds by default. Naming a root on one side only would
    // leave the note editable and permanently unsearchable.
    const provider = new WebsocketProvider(collabUrl(), meetingId, doc);

    failures.current = 0;
    opened.current = false;
    setLink("connecting");
    setSession({ doc, provider });

    const settle = () => {
      if (provider.wsconnected) {
        failures.current = 0;
        opened.current = true;
        // Connected is not saved: the document is only round-tripped once the
        // sync handshake completes, and calling that "live" a beat early is the
        // exact lie this component exists to avoid.
        setLink(provider.synced ? "live" : "connecting");
        return;
      }
      if (failures.current >= OFFLINE_AFTER_FAILURES) setLink("offline");
      else setLink(opened.current ? "reconnecting" : "connecting");
    };

    const onFailure = () => {
      failures.current += 1;
      settle();
    };

    provider.on("status", settle);
    provider.on("sync", settle);
    provider.on("connection-close", onFailure);
    provider.on("connection-error", onFailure);
    // Emitted when the provider has given up for good — a close code the
    // library treats as permanent. There is no retry after this one.
    provider.on("closed", () => {
      failures.current = OFFLINE_AFTER_FAILURES;
      settle();
    });

    const readPeers = () => {
      const local = provider.awareness.clientID;
      const seen: Peer[] = [];
      for (const [clientId, state] of provider.awareness.getStates()) {
        if (clientId === local) continue;
        const identity = (state as { user?: Record<string, unknown> } | undefined)?.user;
        seen.push({
          clientId,
          // Awareness state is written by the other browsers in the room, so
          // both fields are untrusted input. The colour goes into a style
          // attribute and the name into a caret label; neither is echoed back
          // without being narrowed to something that cannot carry markup.
          name: safeName(identity?.["name"]),
          color: safeColor(identity?.["color"]),
        });
      }
      // Deferred out of the synchronous awareness callback on purpose.
      // CollaborationCaret writes this client's own awareness state while the
      // editor is being constructed — which happens during the child's render —
      // and awareness fires "change" synchronously. Setting parent state from
      // there is a setState-during-render of a different component, which React
      // reports as an error. A microtask puts it after the commit.
      queueMicrotask(() => {
        if (cancelled) return;
        setPeers(seen);
      });
    };
    provider.awareness.on("change", readPeers);

    return () => {
      cancelled = true;
      provider.awareness.off("change", readPeers);
      // destroy() disconnects first, which broadcasts the removal of this
      // client's awareness state — otherwise the caret sits in everyone else's
      // editor until awareness times it out thirty seconds later.
      provider.destroy();
      provider.awareness.destroy();
      doc.destroy();
    };
  }, [meetingId]);

  const retry = useCallback(() => {
    if (!session) return;
    // Reconnect the existing provider rather than rebuilding the session. The
    // Y.Doc holds every edit made while the socket was down, and those only
    // reach the server if this document is the one that reconnects.
    failures.current = 0;
    setLink("connecting");
    session.provider.connect();
  }, [session]);

  return (
    <>
      <div className="pane-head">
        {head ? (
          <>
            {head}
            <div className="grow" />
          </>
        ) : (
          <span className="grow">Notes</span>
        )}
        {peers.length > 0 && <Presence peers={peers} />}
        <LinkChip state={link} />
      </div>

      {link === "offline" && (
        <div className="banner error">
          Not saving. Your edits are in this tab only and a reload will lose them.{" "}
          <button className="btn sm" style={{ marginLeft: 8 }} onClick={retry}>
            Reconnect
          </button>
        </div>
      )}

      {session ? (
        // Keyed on the document's own identity, not the meeting id. StrictMode
        // runs the effect above twice and the second session is the live one;
        // keying on the meeting would leave the editor bound to the doc the
        // first teardown already destroyed.
        <Surface key={session.doc.guid} session={session} user={user} />
      ) : (
        <div className="pane-body">
          <div className="skeleton" />
          <div className="skeleton" />
        </div>
      )}
    </>
  );
}

/* -------------------------------------------------------------------------
 * The editor itself
 * ---------------------------------------------------------------------- */

/**
 * Split from the component above because `useEditor` is a hook and the document
 * it binds to only exists after an effect has run. Mounting the editor beneath
 * a guard keeps the provider's lifecycle out of the editor's, which matters
 * under StrictMode: the double-invoked effect builds and tears down a session
 * before the real one, and an editor built against the first would be bound to
 * a destroyed doc.
 */
function Surface({ session, user }: { session: Session; user: NotesUser }) {
  const editor = useEditor({
    extensions: [
      // Collaboration replaces history with the Yjs undo manager. Leaving
      // StarterKit's in would let ctrl+Z rewind whatever a colleague typed,
      // because a local undo stack has no notion of whose change it is.
      StarterKit.configure({ undoRedo: false }),
      Collaboration.configure({ document: session.doc }),
      CollaborationCaret.configure({
        provider: session.provider,
        user: { name: user.name, color: user.color },
        render: renderCaret,
        selectionRender: renderSelection,
      }),
    ],
    editorProps: {
      attributes: {
        class: "doc-body",
        // The two rules ProseMirror cannot do without and one the caret needs:
        // prosemirror-view ships them in a stylesheet this app does not load,
        // and without pre-wrap every run of spaces a user types collapses.
        style:
          "white-space: pre-wrap; word-wrap: break-word; position: relative; outline: none; min-height: 100%;",
      },
    },
  });

  return <EditorContent editor={editor} className="pane-body scroll" />;
}

/* -------------------------------------------------------------------------
 * Presence
 * ---------------------------------------------------------------------- */

function Presence({ peers }: { peers: Peer[] }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      {peers.slice(0, 4).map((peer) => (
        <span
          key={peer.clientId}
          title={peer.name}
          style={{
            width: 18,
            height: 18,
            borderRadius: "50%",
            background: peer.color,
            color: "#fff",
            fontSize: 9,
            fontWeight: 600,
            display: "inline-grid",
            placeItems: "center",
          }}
        >
          {initials(peer.name)}
        </span>
      ))}
      {peers.length > 4 && <span className="mono">+{peers.length - 4}</span>}
    </span>
  );
}

const LINK_CHIP: Record<LinkState, { tone: string; label: string; pulse: boolean }> = {
  connecting: { tone: "working", label: "Connecting", pulse: true },
  live: { tone: "ready", label: "Saving live", pulse: false },
  reconnecting: { tone: "working", label: "Reconnecting", pulse: true },
  offline: { tone: "error", label: "Not saving", pulse: false },
};

function LinkChip({ state }: { state: LinkState }) {
  const chip = LINK_CHIP[state];
  return (
    <span className={`chip ${chip.tone}`}>
      <span className={`dot${chip.pulse ? " pulse" : ""}`} />
      {chip.label}
    </span>
  );
}

/* -------------------------------------------------------------------------
 * Carets
 * ---------------------------------------------------------------------- */

/**
 * The extension's stock render targets `.collaboration-carets__caret` and
 * `.collaboration-carets__label`, which this app's stylesheet does not define —
 * the default would draw an invisible caret. Inline styles keep the carets
 * working without a stylesheet change; see the report if those two rules land.
 */
function renderCaret(user: Record<string, unknown>): HTMLElement {
  const color = safeColor(user["color"]);

  const caret = document.createElement("span");
  caret.setAttribute(
    "style",
    `position: relative; margin-left: -1px; margin-right: -1px; border-left: 1.5px solid ${color};` +
      " pointer-events: none; word-break: normal;",
  );

  const label = document.createElement("div");
  label.setAttribute(
    "style",
    `position: absolute; top: -1.35em; left: -1.5px; padding: 1px 5px; border-radius: 3px 3px 3px 0;` +
      ` background: ${color}; color: #fff; font-size: 10px; font-weight: 600; line-height: 1.4;` +
      " white-space: nowrap; user-select: none;",
  );
  // textContent, never innerHTML: the name came off the wire from another
  // client and is about to be inserted into this document.
  label.textContent = safeName(user["name"]);

  caret.appendChild(label);
  return caret;
}

function renderSelection(user: Record<string, unknown>): DecorationAttrs {
  return {
    nodeName: "span",
    // Two hex digits of alpha — a selection you can read through.
    style: `background-color: ${safeColor(user["color"])}29;`,
  };
}

/* -------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------- */

/**
 * The collab socket is same-origin: the API serves the SPA in production and
 * Vite proxies `/api` in development, so deriving the URL from the page keeps
 * one code path across both.
 */
function collabUrl(): string {
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${window.location.host}/api/v1/collab`;
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

function safeColor(value: unknown): string {
  return typeof value === "string" && HEX_COLOR.test(value) ? value : "#9698a0";
}

function safeName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  return name.length > 0 ? name.slice(0, 60) : "Someone";
}

function initials(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "?";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase();
}

/**
 * A stable colour per person rather than a random one per session, so a
 * colleague's caret is the same colour tomorrow. Fixed palette rather than a
 * generated hue: every entry here is dark enough for white label text.
 */
const CARET_PALETTE = ["#ff7a1a", "#2857c4", "#147a45", "#b3261e", "#7a3ff2", "#0d7d8c", "#c2185b", "#8a6a00"];

export function caretColor(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i += 1) hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
  return CARET_PALETTE[hash % CARET_PALETTE.length] ?? "#ff7a1a";
}
