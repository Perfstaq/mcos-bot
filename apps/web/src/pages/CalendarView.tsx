import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, api } from "../api.js";
import { CalendarDayList } from "../components/CalendarDayList.js";
import { CalendarEventPopover } from "../components/CalendarEventPopover.js";
import {
  CalendarGrid,
  addDays,
  browserTimeZone,
  localeWeekStart,
  startOfDay,
  startOfWeek,
  type CalendarEvent,
} from "../components/CalendarGrid.js";
import { IconChevron } from "../components/Icons.js";

/**
 * The calendar, as a place to work rather than a place to configure.
 *
 * Two readings of one selection: the agenda on the left and the time grid on
 * the right, both driven by a single `selectedDay`. There is no separate
 * "current week" — the visible period is derived from the selected day, so
 * paging forward and picking a day cannot end up disagreeing about what is on
 * screen.
 *
 * Configuration lives at /calendar (CalendarSettings): which accounts are
 * connected, and the standing rules for what gets recorded. This screen only
 * ever makes decisions about a *specific* event, which is why the only writes
 * it performs are the per-event toggle and "record now".
 */

type View = "day" | "week";

type RangeResponse = {
  from: string;
  to: string;
  truncated: boolean;
  events: CalendarEvent[];
};

/** Only the count matters here; the shape of a connection is CalendarSettings' business. */
type ConnectionSummary = { id: string; status: string };

const dayLongFmt = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
});
const dayShortFmt = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
const dayShortYearFmt = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  year: "numeric",
});

export function CalendarView() {
  const [view, setView] = useState<View>("week");
  const [selectedDay, setSelectedDay] = useState<Date>(() => startOfDay(new Date()));
  const [events, setEvents] = useState<CalendarEvent[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connections, setConnections] = useState<ConnectionSummary[] | null>(null);
  const [feedMissing, setFeedMissing] = useState(false);
  const [popover, setPopover] = useState<{ id: string; anchor: HTMLElement } | null>(null);

  // One clock for the whole screen. The now-line, the "happening now" chip and
  // whether "Record now" is offered are three readings of the same instant, and
  // three independent timers is three chances for them to disagree.
  const [now, setNow] = useState<Date>(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  // Read once: the locale cannot change under a mounted screen, and probing it
  // per render would rebuild the whole week on every keystroke elsewhere.
  const weekStart = useMemo(() => localeWeekStart(), []);
  const timeZone = useMemo(() => browserTimeZone(), []);

  const days = useMemo(() => {
    if (view === "day") return [startOfDay(selectedDay)];
    const first = startOfWeek(selectedDay, weekStart);
    return Array.from({ length: 7 }, (_, index) => addDays(first, index));
  }, [view, selectedDay, weekStart]);

  const first = days[0] ?? startOfDay(selectedDay);
  const last = days[days.length - 1] ?? first;
  const fromIso = first.toISOString();
  const toIso = addDays(last, 1).toISOString();

  /* ------------------------------------------------------------ loading */

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await api.get<{ connections: ConnectionSummary[] }>("/calendar/connections");
        if (!cancelled) setConnections(data.connections);
      } catch {
        // Not fatal, and deliberately silent: the range request below is the
        // one that decides whether this screen has anything to show. All this
        // read does is let the empty state name the actual reason.
        if (!cancelled) setConnections([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await api.get<RangeResponse>(
          `/calendar/events/range?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`,
        );
        if (cancelled) return;
        setEvents(data.events);
        setTruncated(data.truncated);
        setFeedMissing(false);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        // The range route is not mounted in every build yet. A screen-filling
        // error for a route that simply is not there teaches the reader that
        // the product is broken; an empty grid with a sentence explaining it
        // is both true and recoverable.
        if (e instanceof ApiError && e.status === 404) {
          setFeedMissing(true);
          setEvents([]);
          setTruncated(false);
          setError(null);
          return;
        }
        setError((e as Error).message);
        setEvents([]);
        // Cleared with the events it described: a "too many events" banner
        // hanging over a failed load is a claim about data we no longer have.
        setTruncated(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fromIso, toIso]);

  // A popover anchored to a block in last week's grid is pointing at nothing.
  useEffect(() => setPopover(null), [fromIso, toIso]);

  /* --------------------------------------------------------- navigation */

  const step = useCallback(
    (direction: -1 | 1) => {
      setSelectedDay((day) => addDays(day, direction * (view === "day" ? 1 : 7)));
    },
    [view],
  );

  const goToday = useCallback(() => setSelectedDay(startOfDay(new Date())), []);

  const openEvent = useCallback((event: CalendarEvent, anchor: HTMLElement) => {
    setPopover({ id: event.id, anchor });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const inField =
        e.target instanceof HTMLElement &&
        (["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName) || e.target.isContentEditable);
      if (inField || e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === "Escape") {
        setPopover(null);
        return;
      }
      // While a card is open it owns the screen. Paging the week underneath it
      // would leave it anchored to a block that now means a different event.
      if (popover) return;

      switch (e.key) {
        case "t":
        case "T":
          e.preventDefault();
          goToday();
          break;
        case "d":
        case "D":
          e.preventDefault();
          setView("day");
          break;
        case "w":
        case "W":
          e.preventDefault();
          setView("week");
          break;
        case "ArrowLeft":
          e.preventDefault();
          step(-1);
          break;
        case "ArrowRight":
          e.preventDefault();
          step(1);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, goToday, popover]);

  /* -------------------------------------------------------------- writes */

  /**
   * Both writes replace the row from the server's response rather than patching
   * it locally. `record-now` in particular changes four fields at once —
   * dispatch flag, toggle, meeting id, meeting status — and a screen that
   * guessed even one of them would be showing a state the database never held.
   */
  const toggleRecord = useCallback(async (event: CalendarEvent, next: boolean) => {
    const { event: updated } = await api.patch<{ event: CalendarEvent }>(
      `/calendar/events/${event.id}`,
      { auto_record: next },
    );
    setEvents((list) => (list ?? []).map((e) => (e.id === updated.id ? updated : e)));
  }, []);

  const recordNow = useCallback(async (event: CalendarEvent) => {
    const { event: updated } = await api.post<{ event: CalendarEvent }>(
      `/calendar/events/${event.id}/record-now`,
    );
    setEvents((list) => (list ?? []).map((e) => (e.id === updated.id ? updated : e)));
  }, []);

  /* -------------------------------------------------------------- render */

  const openedEvent = popover ? (events ?? []).find((e) => e.id === popover.id) ?? null : null;
  const booting = connections === null || events === null;
  const noCalendar = connections !== null && connections.length === 0;

  const periodLabel =
    view === "day"
      ? dayLongFmt.format(first)
      : `${dayShortFmt.format(first)} – ${dayShortYearFmt.format(last)}`;

  return (
    <div className="screen">
      <header className="screen-head">
        <h1>Calendar</h1>
        <span className="sub">{periodLabel}</span>
        <div className="grow" />

        <div style={{ display: "flex", gap: 6 }}>
          <button className="btn sm" onClick={() => step(-1)} aria-label={`Previous ${view}`}>
            <span style={{ display: "inline-flex", transform: "rotate(180deg)" }}>
              <IconChevron size={14} />
            </span>
          </button>
          <button className="btn sm" onClick={goToday}>
            Today <span className="key">T</span>
          </button>
          <button className="btn sm" onClick={() => step(1)} aria-label={`Next ${view}`}>
            <IconChevron size={14} />
          </button>
        </div>

        <div style={{ display: "flex", gap: 6 }} role="group" aria-label="Calendar view">
          <button
            className={`btn sm${view === "day" ? " primary" : ""}`}
            aria-pressed={view === "day"}
            onClick={() => setView("day")}
          >
            Day <span className="key">D</span>
          </button>
          <button
            className={`btn sm${view === "week" ? " primary" : ""}`}
            aria-pressed={view === "week"}
            onClick={() => setView("week")}
          >
            Week <span className="key">W</span>
          </button>
        </div>

        {/* Every time on this screen is rendered in the browser's zone, so the
            zone is named rather than left to be inferred from times that happen
            to look plausible. */}
        <span className="mono" style={{ color: "var(--faint)" }} title="All times shown in this zone">
          {timeZone}
        </span>
      </header>

      {error && <div className="banner error">{error}</div>}
      {truncated && (
        <div className="banner info">
          This range holds more events than the grid will draw. Narrow to a single day, or use the
          calendar settings screen to check what is being synced.
        </div>
      )}

      {noCalendar ? (
        <NoCalendarConnected />
      ) : feedMissing ? (
        <FeedUnavailable />
      ) : booting ? (
        <div className="panes">
          <div className="pane list">
            <div className="skeleton" />
            <div className="skeleton" />
            <div className="skeleton" />
          </div>
          <div className="pane detail">
            <div className="skeleton" style={{ height: 200 }} />
          </div>
        </div>
      ) : (
        <div className="panes">
          <CalendarDayList
            days={days}
            events={events ?? []}
            selectedDay={selectedDay}
            selectedEventId={popover?.id ?? null}
            now={now}
            onSelectDay={setSelectedDay}
            onOpenEvent={openEvent}
          />
          <CalendarGrid
            days={days}
            events={events ?? []}
            now={now}
            selectedDay={selectedDay}
            selectedEventId={popover?.id ?? null}
            onSelectDay={setSelectedDay}
            onOpenEvent={openEvent}
          />
        </div>
      )}

      {popover && openedEvent && (
        <CalendarEventPopover
          key={openedEvent.id}
          event={openedEvent}
          anchor={popover.anchor}
          now={now}
          onClose={() => setPopover(null)}
          onToggleRecord={toggleRecord}
          onRecordNow={recordNow}
        />
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------- */

function NoCalendarConnected() {
  return (
    <div className="empty" style={{ marginTop: 64 }}>
      <h3>No calendar connected</h3>
      <p>
        This screen is a view of your calendar, so connecting one is what fills it. Connecting reads
        your events; it records nothing on its own — what gets recorded is a separate, opt-in
        decision you make per calendar or per event.
      </p>
      <div style={{ marginTop: 16 }}>
        <Link className="btn sm" to="/calendar/settings" style={{ textDecoration: "none", color: "inherit" }}>
          Connect a calendar
        </Link>
      </div>
    </div>
  );
}

/**
 * The range endpoint answered 404. That is a deployment fact, not a user error,
 * and the difference matters: their calendar is connected and syncing, and
 * nothing they do on this screen will change the outcome.
 */
function FeedUnavailable() {
  return (
    <div className="empty" style={{ marginTop: 64 }}>
      <h3>The calendar feed is not available in this build</h3>
      <p>
        Your calendars are connected, but this deployment does not answer for the event range this
        grid reads. The connections themselves, their sync state and their recording rules are all
        still on the calendar settings screen.
      </p>
      <div style={{ marginTop: 16 }}>
        <Link className="btn sm" to="/calendar/settings" style={{ textDecoration: "none", color: "inherit" }}>
          Open calendar settings
        </Link>
      </div>
    </div>
  );
}
