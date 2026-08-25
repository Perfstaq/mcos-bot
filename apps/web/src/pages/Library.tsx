import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, type MeetingStatus } from "../api.js";
import { MeetingCard, type LibraryMeeting } from "../components/MeetingCard.js";
import { STATUS_LABEL } from "../components/StatusChip.js";
import { NotesList } from "./NotesList.js";

/**
 * The library: everything the workspace has recorded, as a shelf.
 *
 * Deliberately not a second Meetings screen. Meetings is about *state* — what
 * is in flight, what failed, what needs retrying — and its list is a pipeline.
 * This one is about what survives: a card per meeting, showing at a glance
 * whether there is something to listen to, something to read and something
 * still waiting on a human. The two screens share an API and nothing else.
 *
 * The rail chooses whose shelf; the filters narrow it; the box searches meeting
 * titles. All four are query parameters on one endpoint rather than client-side
 * predicates, because the shelf is paged with a keyset cursor and filtering
 * after the fact would quietly drop rows out of the middle of a page.
 */

const RAILS = [
  { key: "all", label: "All meetings" },
  { key: "mine", label: "My meetings" },
  { key: "shared_with_me", label: "Shared with me" },
  { key: "notes", label: "Notes" },
] as const;

type Rail = (typeof RAILS)[number]["key"];

/**
 * Declared in pipeline order in StatusChip, so reading the select top to bottom
 * is reading the state machine. Taking the order from there rather than
 * restating it means a new state cannot appear in one place and not the other.
 */
const STATUS_ORDER = Object.keys(STATUS_LABEL) as MeetingStatus[];

/**
 * Presets rather than two date pickers.
 *
 * Each one sets `from` and leaves `to` open. The shelf is ordered by recency
 * and nothing on it is in the future, so "up to now" is the only upper bound a
 * preset can mean; a genuine two-ended range is a different control for a
 * different question, and this screen does not yet have that question.
 */
const RANGES = [
  { key: "any", label: "Any time", days: 0 },
  { key: "7d", label: "Last 7 days", days: 7 },
  { key: "30d", label: "Last 30 days", days: 30 },
  { key: "90d", label: "Last 90 days", days: 90 },
  { key: "365d", label: "Last year", days: 365 },
] as const;

type RangeKey = (typeof RANGES)[number]["key"];

/** Matches the API's default page, which is sized to fill a screen of cards. */
const PAGE = 24;

/** Long enough that a typed word is one request, short enough to feel live. */
const DEBOUNCE_MS = 220;

type LibraryResponse = { scope: string; meetings: LibraryMeeting[]; next_cursor: string | null };

export function Library() {
  const [rail, setRail] = useState<Rail>("all");
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [status, setStatus] = useState<MeetingStatus | "">("");
  const [hasRecording, setHasRecording] = useState<"" | "true" | "false">("");
  const [range, setRange] = useState<RangeKey>("any");

  const [meetings, setMeetings] = useState<LibraryMeeting[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Guards against a slow early response landing on top of a newer one. */
  const issued = useRef(0);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query.trim()), DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  const filtered = status !== "" || hasRecording !== "" || range !== "any" || debounced !== "";

  const load = useCallback(
    async (after: string | null) => {
      const seq = ++issued.current;
      if (after) setLoadingMore(true);
      else setMeetings(null);

      try {
        const params = new URLSearchParams({ scope: rail, limit: String(PAGE) });
        if (debounced) params.set("q", debounced);
        if (status) params.set("status", status);
        if (hasRecording) params.set("has_recording", hasRecording);
        const from = rangeStart(range);
        if (from) params.set("from", from);
        if (after) params.set("cursor", after);

        const data = await api.get<LibraryResponse>(`/library/meetings?${params}`);
        if (seq !== issued.current) return;
        setMeetings((current) => (after ? [...(current ?? []), ...data.meetings] : data.meetings));
        setCursor(data.next_cursor);
        setUnavailable(false);
        setError(null);
      } catch (e) {
        if (seq !== issued.current) return;
        // The route is registered separately from this screen, so until it is
        // mounted the shelf is empty rather than broken. An error wall over a
        // feature that simply is not serving yet trains people to ignore the
        // wall when it means something.
        if (e instanceof ApiError && e.status === 404) {
          setMeetings([]);
          setCursor(null);
          setUnavailable(true);
          setError(null);
          return;
        }
        setError((e as Error).message);
        if (!after) setMeetings([]);
      } finally {
        if (seq === issued.current) setLoadingMore(false);
      }
    },
    // `rail` is in here as the scope parameter; the Notes rail never gets this
    // far, and the guard below is what keeps it from firing a meetings query.
    [rail, debounced, status, hasRecording, range],
  );

  useEffect(() => {
    if (rail === "notes") return;
    void load(null);
  }, [rail, load]);

  const clearFilters = () => {
    setQuery("");
    setDebounced("");
    setStatus("");
    setHasRecording("");
    setRange("any");
  };

  const empty = emptyState(rail, { unavailable, filtered });

  return (
    <div className="screen">
      <header className="screen-head">
        <h1>Library</h1>

        {/* The rail is display:none below 1120px, so on a narrow window this is
            the only way to reach the other shelves. It lives in the screen head
            rather than in the pane head because the Notes rail replaces that
            pane wholesale, and a switcher you can switch away from but not back
            to is a trap. */}
        <select
          className="select only-narrow"
          value={rail}
          onChange={(e) => setRail(e.target.value as Rail)}
          aria-label="Shelf"
        >
          {RAILS.map((r) => (
            <option key={r.key} value={r.key}>
              {r.label}
            </option>
          ))}
        </select>

        <input
          className="input"
          style={{ maxWidth: 340 }}
          placeholder="Search meeting titles…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search the library"
        />

        <div className="grow" />

        {rail !== "notes" && meetings && (
          <span className="mono" style={{ color: "var(--faint)" }}>
            {meetings.length}
            {cursor ? "+" : ""} meeting{meetings.length === 1 && !cursor ? "" : "s"}
          </span>
        )}
      </header>

      <div className="panes">
        <nav className="pane rail-types">
          <div className="pane-head">Shelf</div>
          <div className="pane-body scroll">
            {/* No counts beside the labels: each one is a separate query, and a
                number that is one page stale is worse than no number. */}
            {RAILS.map((r) => (
              <button
                key={r.key}
                className={`type-item${rail === r.key ? " active" : ""}`}
                onClick={() => setRail(r.key)}
              >
                <span className="grow">{r.label}</span>
              </button>
            ))}
          </div>
        </nav>

        {rail === "notes" ? (
          <NotesList q={debounced} />
        ) : (
          <div className="pane detail">
            {/* Four controls, not a label: the head has to wrap rather than push
                the last select off the edge of a narrow pane. */}
            <div className="pane-head" style={{ flexWrap: "wrap", height: "auto", minHeight: 40, padding: "6px 14px" }}>
              <span>Filter</span>

              <select
                className="select"
                value={hasRecording}
                onChange={(e) => setHasRecording(e.target.value as "" | "true" | "false")}
                aria-label="Recording"
              >
                <option value="">Any recording</option>
                <option value="true">Has a recording</option>
                <option value="false">No recording</option>
              </select>

              <select
                className="select"
                value={status}
                onChange={(e) => setStatus(e.target.value as MeetingStatus | "")}
                aria-label="Status"
              >
                <option value="">Any status</option>
                {STATUS_ORDER.map((key) => (
                  <option key={key} value={key}>
                    {STATUS_LABEL[key]}
                  </option>
                ))}
              </select>

              <select
                className="select"
                value={range}
                onChange={(e) => setRange(e.target.value as RangeKey)}
                aria-label="Date range"
              >
                {RANGES.map((r) => (
                  <option key={r.key} value={r.key}>
                    {r.label}
                  </option>
                ))}
              </select>

              <div className="grow" />

              {filtered && (
                <button className="btn sm" onClick={clearFilters}>
                  Clear
                </button>
              )}
            </div>

            {error && <div className="banner error">{error}</div>}

            <div className="pane-body scroll">
              {/* Skipped entirely when the shelf is empty: a grid's padding
                  would otherwise push the empty state down by a phantom row. */}
              {(meetings === null || meetings.length > 0) && (
                <div style={GRID}>
                  {meetings === null
                    ? Array.from({ length: 6 }, (_, i) => (
                        <div key={i} className="skeleton" style={{ height: 216, margin: 0 }} />
                      ))
                    : meetings.map((meeting) => <MeetingCard key={meeting.id} meeting={meeting} />)}
                </div>
              )}

              {meetings?.length === 0 && (
                <div className="empty" style={{ marginTop: 32 }}>
                  <h3>{empty.title}</h3>
                  <p>{empty.body}</p>
                  {filtered && !unavailable && (
                    <button className="btn sm" style={{ marginTop: 14 }} onClick={clearFilters}>
                      Clear filters
                    </button>
                  )}
                </div>
              )}

              {cursor && (
                <div style={{ display: "flex", justifyContent: "center", padding: "4px 0 28px" }}>
                  <button className="btn sm" disabled={loadingMore} onClick={() => void load(cursor)}>
                    {loadingMore ? "Loading…" : "Load more"}
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------- */

/**
 * Anchored on local midnight rather than on the current instant.
 *
 * A window measured from `Date.now()` moves between two renders, so the same
 * filter would send a different `from` on every refetch and the keyset cursor
 * would be paging a shelf that had shifted underneath it.
 */
function rangeStart(key: RangeKey): string | null {
  const range = RANGES.find((r) => r.key === key);
  if (!range || range.days === 0) return null;
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - range.days);
  return start.toISOString();
}

/**
 * An empty shelf should say what would fill it. "No results" tells a new
 * workspace nothing about how to stop being one, and tells someone with three
 * filters on nothing about which of them is the problem.
 */
function emptyState(
  rail: Rail,
  state: { unavailable: boolean; filtered: boolean },
): { title: string; body: string } {
  if (state.unavailable) {
    return {
      title: "The shelf is not serving yet",
      body: "Recorded meetings will appear here as cards once the library endpoint is mounted. Nothing has been lost in the meantime — every meeting is still on the Meetings screen.",
    };
  }
  if (state.filtered) {
    return {
      title: "No meeting matches",
      body: "Nothing on this shelf fits all of the filters at once. Widening the date range is usually the one that did it.",
    };
  }
  switch (rail) {
    case "mine":
      return {
        title: "You have not recorded anything",
        body: "Meetings you send a bot to, and meetings auto-recorded from your own calendar, land on this shelf with their recording, transcript and notes.",
      };
    case "shared_with_me":
      return {
        title: "Nothing has been shared with you",
        body: "A meeting appears here when its owner adds you as a collaborator. Workspace-visible meetings are on the All meetings shelf instead — they were never shared with you in particular.",
      };
    default:
      return {
        title: "Nothing recorded yet",
        body: "Paste a call link on the Meetings screen, or turn on auto-record for a connected calendar. Every recorded meeting arrives here as a card you can play, read and search.",
      };
  }
}

/**
 * `auto-fill`, not `auto-fit`: with `auto-fit` a shelf holding one card
 * stretches it across the whole pane, and a single 900-pixel-wide tile does not
 * read as a card.
 */
const GRID: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(248px, 1fr))",
  gap: 14,
  padding: 16,
  alignItems: "start",
};
