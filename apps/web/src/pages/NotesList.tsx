import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError, api } from "../api.js";

/**
 * One row of GET /library/notes (apps/api/src/routes/library.ts). The excerpt
 * arrives as plain text, not as a marked-up snippet — see the note on
 * `excerpt()` there — so it is rendered as text and the escaping question never
 * comes up on this screen.
 */
export type LibraryNote = {
  meeting_id: string;
  title: string | null;
  started_at: string | null;
  created_at: string;
  note: {
    id: string;
    excerpt: string;
    revision: number;
    updated_at: string;
    last_editor: {
      user_id: string;
      name: string | null;
      email: string | null;
      image: string | null;
    } | null;
  };
};

type NotesResponse = { notes: LibraryNote[]; next_cursor: string | null };

/** The API's page size for the shelf; asking for a different one just churns. */
const PAGE = 24;

/**
 * The Notes rail of the library: meetings somebody actually wrote in.
 *
 * A pane rather than a screen, because it is one of two things the library's
 * detail column can be — the shelf of cards is the other, and both sit beside
 * the same rail and answer to the same search box. Only `q` crosses the
 * boundary: the recording and status filters are properties of a meeting, and
 * applying them to a list of documents would silently hide notes somebody wrote
 * in a meeting that was never recorded, which is most of them.
 *
 * Ordered the way the shelf is ordered — by when the meeting happened, not by
 * when the note was last touched. Note recency reshuffles the list under a
 * reader while somebody else is still typing in one of them.
 */
export function NotesList({ q = "" }: { q?: string }) {
  const [notes, setNotes] = useState<LibraryNote[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const navigate = useNavigate();
  /** Guards against a slow early response landing on top of a newer one. */
  const issued = useRef(0);

  const load = useCallback(
    async (after: string | null) => {
      const seq = ++issued.current;
      if (after) setLoadingMore(true);
      else setNotes(null);

      try {
        const params = new URLSearchParams({ limit: String(PAGE) });
        if (q) params.set("q", q);
        if (after) params.set("cursor", after);

        const data = await api.get<NotesResponse>(`/library/notes?${params}`);
        if (seq !== issued.current) return;
        setNotes((current) => (after ? [...(current ?? []), ...data.notes] : data.notes));
        setCursor(data.next_cursor);
        setUnavailable(false);
        setError(null);
      } catch (e) {
        if (seq !== issued.current) return;
        // The route is registered separately from this screen. Until it is,
        // a 404 is "there is nothing here yet", not a failure worth an error
        // wall — the same answer an empty workspace gets.
        if (e instanceof ApiError && e.status === 404) {
          setNotes([]);
          setCursor(null);
          setUnavailable(true);
          setError(null);
          return;
        }
        setError((e as Error).message);
        if (!after) setNotes([]);
      } finally {
        if (seq === issued.current) setLoadingMore(false);
      }
    },
    [q],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  return (
    <div className="pane detail">
      <div className="pane-head">
        <span className="grow">Notes</span>
        {notes && (
          <span>
            {notes.length}
            {cursor ? "+" : ""}
          </span>
        )}
      </div>

      {error && <div className="banner error">{error}</div>}

      <div className="pane-body scroll">
        {notes === null && (
          <>
            <div className="skeleton" />
            <div className="skeleton" />
            <div className="skeleton" />
          </>
        )}

        {notes?.length === 0 && (
          <div className="empty" style={{ marginTop: 40 }}>
            <h3>{unavailable ? "Notes are not on the shelf yet" : q ? "No note mentions that" : "Nobody has written anything down"}</h3>
            <p>
              {unavailable
                ? "Once the library endpoint is serving, every meeting somebody typed in appears here with its opening lines, who touched it last and when."
                : q
                  ? `Nothing in the workspace's notes matches “${q}”. The search covers meeting titles; try a word from the title rather than from the body.`
                  : "Open a meeting and start typing in the notes pane. Anything written there — by you or by anyone else in the room — shows up on this shelf with its first few lines."}
            </p>
          </div>
        )}

        {notes?.map((row) => {
          const editor = row.note.last_editor;
          const who = editor?.name || editor?.email || null;
          return (
            <button
              key={row.meeting_id}
              className="row"
              onClick={() => navigate(`/meetings/${row.meeting_id}`)}
            >
              <div className="row-top">
                <span className="grow" style={{ fontWeight: 600, fontSize: 13 }}>
                  {row.title ?? "Untitled meeting"}
                </span>
                <span className="mono" style={{ color: "var(--faint)" }}>
                  {shelfDate(row.started_at ?? row.created_at)}
                </span>
              </div>

              <div className="row-text">{row.note.excerpt}</div>

              <div className="row-meta mono">
                {/* `updated_by_user_id` is nullable: a CRDT flush can land
                    without an identified writer, and inventing a name for one
                    would be worse than admitting there isn't one. */}
                <span>{who ? `Last edited by ${who}` : "Last edited by someone unattributed"}</span>
                {/* The exact stamp on hover, because "2 days ago" is the right
                    answer for skimming and the wrong one for citing. */}
                <span title={new Date(row.note.updated_at).toLocaleString()}>
                  {relativeTime(row.note.updated_at)}
                </span>
              </div>
            </button>
          );
        })}

        {cursor && (
          <div style={{ display: "flex", justifyContent: "center", padding: "14px 0 24px" }}>
            <button className="btn sm" disabled={loadingMore} onClick={() => void load(cursor)}>
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------- */

function shelfDate(iso: string): string {
  const date = new Date(iso);
  const thisYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(thisYear ? {} : { year: "numeric" }),
  });
}

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/** Coarsest unit that still has a whole number in it — "3 days", not "72 hours". */
const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 31_536_000_000],
  ["month", 2_592_000_000],
  ["week", 604_800_000],
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

function relativeTime(iso: string): string {
  const delta = Date.parse(iso) - Date.now();
  if (Number.isNaN(delta)) return "";
  const size = Math.abs(delta);
  for (const [unit, ms] of UNITS) {
    if (size >= ms) return RELATIVE.format(Math.round(delta / ms), unit);
  }
  return "just now";
}
