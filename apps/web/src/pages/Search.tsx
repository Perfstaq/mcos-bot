import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api.js";
import { playbackDeepLink } from "../components/RecordingPlayer.js";

/** The corpora the API searches, in the order they are worth reading. */
const KIND_ORDER = ["transcript", "note", "action_item", "claim", "meeting"] as const;
type SearchKind = (typeof KIND_ORDER)[number];

const KIND_LABEL: Record<SearchKind, string> = {
  transcript: "Transcript",
  note: "Notes",
  action_item: "Action items",
  claim: "Claims",
  meeting: "Meetings",
};

type SearchHit = {
  kind: SearchKind;
  id: string;
  /** HTML-escaped by the API, with `<mark>` around what matched. */
  snippet: string;
  score: number;
  meeting: { id: string | null; title: string | null; occurred_at: string | null };
  location: {
    segment_id: string | null;
    start_ms: number | null;
    end_ms: number | null;
    speaker: string | null;
    timestamp_label: string | null;
  };
  evidence_redacted: boolean;
};

type SearchResponse = { query: string; kinds: SearchKind[]; total: number; results: SearchHit[] };

/** The API's ceiling. Asking for less would drop hits it already ranked. */
const LIMIT = 50;

/**
 * Long enough that a typed word is one request, short enough that the results
 * arrive while the reader is still looking at the box.
 */
const DEBOUNCE_MS = 220;

/** A single character matches everything or nothing; neither is worth a query. */
const MIN_QUERY = 2;

/**
 * One box over everything the workspace has said.
 *
 * Results are grouped by corpus rather than interleaved by score, because "was
 * this in a call or in someone's notes" is the first thing a reader wants to
 * know and a mixed list makes them read every row to find out. Ranking still
 * decides the order inside each group, and the rail is a filter over what came
 * back — not a second query, so its counts are always the counts on screen.
 */
export function Search() {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [results, setResults] = useState<SearchHit[] | null>(null);
  const [filter, setFilter] = useState<SearchKind | "all">("all");
  const [focus, setFocus] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef(new Map<string, HTMLElement>());
  /** Guards against a slow early response landing on top of a newer one. */
  const issued = useRef(0);
  const navigate = useNavigate();

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query.trim()), DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (debounced.length < MIN_QUERY) {
      setResults(null);
      setError(null);
      setLoading(false);
      return;
    }

    const seq = ++issued.current;
    setLoading(true);
    void (async () => {
      try {
        const params = new URLSearchParams({ q: debounced, limit: String(LIMIT) });
        const data = await api.get<SearchResponse>(`/search?${params}`);
        // The shared client has no abort, so ordering is enforced here instead:
        // anything but the latest request is a result nobody is waiting for.
        if (seq !== issued.current) return;
        setResults(data.results);
        setError(null);
        setFocus(0);
      } catch (e) {
        if (seq !== issued.current) return;
        setResults([]);
        setError((e as Error).message);
      } finally {
        if (seq === issued.current) setLoading(false);
      }
    })();
  }, [debounced]);

  const counts = useMemo(() => {
    const tally: Partial<Record<SearchKind, number>> = {};
    for (const hit of results ?? []) tally[hit.kind] = (tally[hit.kind] ?? 0) + 1;
    return tally;
  }, [results]);

  /** Flattened in reading order, so arrow keys cross group boundaries. */
  const ordered = useMemo(() => {
    const visible = (results ?? []).filter((hit) => filter === "all" || hit.kind === filter);
    return KIND_ORDER.flatMap((kind) => visible.filter((hit) => hit.kind === kind));
  }, [results, filter]);

  const current = ordered[Math.min(focus, Math.max(ordered.length - 1, 0))];

  useEffect(() => {
    if (current) rowRefs.current.get(current.id)?.scrollIntoView({ block: "nearest" });
  }, [current]);

  const open = useCallback(
    (hit: SearchHit) => {
      // A meeting hit *is* the meeting; everything else points at one. A hit
      // with no meeting behind it has nowhere to go and is left inert rather
      // than navigating somewhere plausible-looking.
      const meetingId = hit.kind === "meeting" ? hit.id : hit.meeting.id;
      if (!meetingId) return;
      navigate(
        playbackDeepLink(meetingId, {
          startMs: hit.location.start_ms,
          segmentId: hit.location.segment_id,
        }),
      );
    },
    [navigate],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const inField =
        event.target instanceof HTMLElement && ["INPUT", "TEXTAREA"].includes(event.target.tagName);

      // "/" is the search key everywhere else; inside the box it is a slash.
      if (event.key === "/" && !inField) {
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
        return;
      }
      if (event.key === "Escape") {
        inputRef.current?.blur();
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          setFocus((f) => Math.min(f + 1, ordered.length - 1));
          break;
        case "ArrowUp":
          event.preventDefault();
          setFocus((f) => Math.max(f - 1, 0));
          break;
        case "Enter":
          // Enter works from the box as well as from the list: typing then
          // reaching for the mouse to open the top hit is the slow path.
          if (current) {
            event.preventDefault();
            open(current);
          }
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ordered.length, current, open]);

  const groups = KIND_ORDER.map((kind) => ({
    kind,
    hits: ordered.filter((hit) => hit.kind === kind),
  })).filter((group) => group.hits.length > 0);

  return (
    <div className="screen">
      <header className="screen-head">
        <h1>Search</h1>
        <input
          ref={inputRef}
          className="input"
          style={{ maxWidth: 480 }}
          placeholder="Search transcripts, notes, action items, claims…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search"
        />
        <div className="grow" />
        <span className="mono" style={{ color: "var(--faint)" }}>
          {loading ? "searching…" : results ? `${ordered.length} of ${results.length}` : "press /"}
        </span>
      </header>

      <div className="panes">
        <nav className="pane rail-types">
          <div className="pane-head">Where</div>
          <div className="pane-body scroll">
            <button
              className={`type-item${filter === "all" ? " active" : ""}`}
              onClick={() => { setFilter("all"); setFocus(0); }}
            >
              <span className="grow">Everywhere</span>
              <span className="n">{results?.length ?? 0}</span>
            </button>
            {KIND_ORDER.map((kind) => (
              <button
                key={kind}
                className={`type-item${filter === kind ? " active" : ""}`}
                onClick={() => { setFilter(kind); setFocus(0); }}
              >
                <span className="grow">{KIND_LABEL[kind]}</span>
                <span className="n">{counts[kind] ?? 0}</span>
              </button>
            ))}
          </div>
        </nav>

        <div className="pane detail">
          <div className="pane-head">
            <span className="grow">Results</span>
            <select
              className="select only-narrow"
              value={filter}
              onChange={(e) => { setFilter(e.target.value as SearchKind | "all"); setFocus(0); }}
            >
              <option value="all">Everywhere ({results?.length ?? 0})</option>
              {KIND_ORDER.map((kind) => (
                <option key={kind} value={kind}>{KIND_LABEL[kind]} ({counts[kind] ?? 0})</option>
              ))}
            </select>
            <span>↑ ↓ ⏎</span>
          </div>

          {error && <div className="banner error">{error}</div>}

          <div className="pane-body scroll">
            {results === null && (
              <div className="empty" style={{ marginTop: 40 }}>
                <h3>Search the workspace</h3>
                <p>
                  Every transcript, note, action item, claim and meeting title. “Quoted phrases”,
                  <span className="mono"> or </span> between words, and a leading
                  <span className="mono"> - </span> to exclude, all work.
                </p>
              </div>
            )}

            {results !== null && ordered.length === 0 && !loading && (
              <div className="empty" style={{ marginTop: 40 }}>
                <h3>Nothing matched</h3>
                <p>No hit for “{debounced}”{filter === "all" ? "" : ` in ${KIND_LABEL[filter].toLowerCase()}`}.</p>
              </div>
            )}

            {groups.map((group) => (
              <Fragment key={group.kind}>
                <h3
                  className="mono"
                  style={{
                    margin: 0,
                    padding: "14px 14px 6px",
                    color: "var(--faint)",
                    fontSize: 10,
                    fontWeight: 500,
                    letterSpacing: "0.11em",
                    textTransform: "uppercase",
                  }}
                >
                  {KIND_LABEL[group.kind]} · {group.hits.length}
                </h3>

                {group.hits.map((hit) => {
                  const meetingId = hit.kind === "meeting" ? hit.id : hit.meeting.id;
                  return (
                    <button
                      key={hit.id}
                      ref={(el) => { if (el) rowRefs.current.set(hit.id, el); }}
                      className={`row${current?.id === hit.id ? " selected" : ""}`}
                      // An action item can exist without a meeting behind it.
                      // Nothing to open, so nothing pretends to be openable.
                      disabled={!meetingId}
                      style={meetingId ? undefined : { opacity: 0.5, cursor: "default" }}
                      onClick={() => { setFocus(ordered.indexOf(hit)); open(hit); }}
                    >
                      <div className="row-top">
                        <span className="type-tag">{KIND_LABEL[hit.kind]}</span>
                        <span className="grow" />
                        {hit.evidence_redacted && (
                          <span className="chip error"><span className="dot" />evidence redacted</span>
                        )}
                      </div>
                      <div className="row-text">{renderSnippet(hit.snippet)}</div>
                      <div className="row-meta mono">
                        <span>{hit.meeting.title ?? "Untitled meeting"}</span>
                        {hit.location.speaker && <span>{hit.location.speaker}</span>}
                        {hit.location.timestamp_label && <span>{hit.location.timestamp_label}</span>}
                        {hit.meeting.occurred_at && (
                          <span>{new Date(hit.meeting.occurred_at).toLocaleDateString()}</span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </Fragment>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------- */

const HIGHLIGHT = {
  background: "var(--orange-soft)",
  color: "inherit",
  borderRadius: 2,
  padding: "0 1px",
} as const;

/**
 * Turn the API's snippet into elements rather than into innerHTML.
 *
 * The snippet is escaped server-side and only `<mark>` survives, so
 * `dangerouslySetInnerHTML` would probably be safe — "probably safe" is not the
 * standard for a string assembled out of whatever anybody said on a call, and
 * one regression in the escaping upstream would make every meeting a stored-XSS
 * vector. Parsing it back into text nodes also lets the highlight take the
 * theme's colours, which a browser's default yellow `mark` does not.
 */
export function renderSnippet(snippet: string): React.ReactNode[] {
  return snippet.split(/(<mark>[\s\S]*?<\/mark>)/g).flatMap((part, i) => {
    if (part.length === 0) return [];
    const marked = part.startsWith("<mark>") && part.endsWith("</mark>");
    const text = unescapeHtml(marked ? part.slice(6, -7) : part);
    return [
      marked ? (
        <mark key={i} style={HIGHLIGHT}>{text}</mark>
      ) : (
        <Fragment key={i}>{text}</Fragment>
      ),
    ];
  });
}

/** Reverses the API's escaping, ampersand last so `&amp;lt;` stays literal. */
function unescapeHtml(value: string): string {
  return value.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}
