import { useLayoutEffect, useRef } from "react";

/**
 * The time grid — days across, hours down — and the time primitives the rest of
 * the calendar screen shares.
 *
 * Every calculation here goes through `Date` and its local getters. Events
 * arrive as ISO strings and are parsed exactly once, at the boundary: a grid
 * that reads the hour out of "2026-08-24T09:00:00Z" by slicing renders the
 * right answer only for a reader sitting on the prime meridian, and renders it
 * confidently wrong for everyone else.
 *
 * Positioning is by *wall clock* — `getHours()`, not elapsed milliseconds — so
 * a 14:00 call sits on the 14:00 rule on the day the clocks change too. The
 * cost is that a DST-crossing event's drawn height is its wall-clock length
 * rather than its true length, which is the reading a person wants from a
 * calendar and the wrong one for a duration report.
 */

/** 48px an hour: an hour stays comfortably clickable and the whole day is
 *  about two screens, so the evening is one flick away rather than a journey. */
const HOUR_HEIGHT = 48;
/** Wide enough for "12 PM" in the widest common locale rendering. */
const GUTTER = 56;
const MINUTES_PER_DAY = 1440;
const DAY_HEIGHT = (MINUTES_PER_DAY / 60) * HOUR_HEIGHT;

/** A 5-minute call still needs a hit target and a legible title. */
const MIN_BLOCK_HEIGHT = 18;

/** Fixed rather than measured: the day headings scroll-stick over the grid, and
 *  the opening scroll position has to account for the height they cover. */
const HEAD_HEIGHT = 38;

/** Where the grid opens when nothing earlier needs showing, and the floor it
 *  will not scroll past however early the first meeting is. */
const DEFAULT_SCROLL_MINUTE = 8 * 60;
const EARLIEST_SCROLL_MINUTE = 6 * 60;

/* ------------------------------------------------------------------ types */

/**
 * One event, exactly as `serializeEvent` writes it in
 * `apps/api/src/routes/calendar-events.ts`. Kept in this module rather than in
 * `api.ts` because that file is the integrator's; the field names are copied
 * from the serialiser, not guessed.
 */
export type CalendarAttendee = {
  email: string;
  name: string | null;
  optional: boolean;
  resource: boolean;
  response: string | null;
};

export type CalendarEvent = {
  id: string;
  connection_id: string;
  provider: "google" | "microsoft";
  calendar_email: string;
  external_id: string;
  title: string | null;
  starts_at: string;
  ends_at: string;
  timezone: string | null;
  organizer_email: string | null;
  attendees: CalendarAttendee[];
  attendee_count: number;
  is_recurring: boolean;
  cancelled: boolean;
  meeting_url: string | null;
  platform: string | null;
  auto_record: boolean;
  bot_dispatched: boolean;
  /** Null for a colleague's calendar — the reasons are phrased about *your*
   *  settings, so the API withholds them rather than mislabel whose they are. */
  auto_record_decision: { record: boolean; decidedBy: string; reason: string } | null;
  meeting_id: string | null;
  meeting: { id: string; status: string; recall_bot_id: string | null } | null;
};

/** An event clipped to one day and given a share of that day's width. */
export type PlacedEvent = {
  event: CalendarEvent;
  startMin: number;
  endMin: number;
  column: number;
  columns: number;
};

/* ------------------------------------------------------------ date maths */

export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/**
 * Built from calendar components rather than by adding 86,400,000ms, so the
 * day after a clocks-change is still the same wall-clock midnight instead of
 * 23:00 the previous evening.
 */
export function addDays(date: Date, count: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + count);
}

export function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** `firstDay` is the ISO numbering this module uses throughout: 1 = Monday … 7 = Sunday. */
export function startOfWeek(date: Date, firstDay: number): Date {
  const isoDay = date.getDay() === 0 ? 7 : date.getDay();
  return addDays(startOfDay(date), -((isoDay - firstDay + 7) % 7));
}

export function minutesOfDay(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

/**
 * Where the week begins, per the reader's locale — a Monday grid in Berlin and
 * a Sunday grid in Chicago, without either being configured.
 *
 * MDN: `Intl.Locale.prototype.getWeekInfo()` returns `{ firstDay, weekend,
 * minimalDays }` with `firstDay` in 1–7 (Monday–Sunday). It only reached
 * Baseline in July 2026, and shipped before that as a `weekInfo` accessor
 * property, so both spellings are probed and neither is required.
 * https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/Locale/getWeekInfo
 */
export function localeWeekStart(): number {
  type WeekInfo = { firstDay?: unknown };
  type MaybeWeekInfo = Intl.Locale & { getWeekInfo?: () => WeekInfo; weekInfo?: WeekInfo };
  try {
    const locale = new Intl.Locale(
      new Intl.DateTimeFormat().resolvedOptions().locale,
    ) as MaybeWeekInfo;
    const info = typeof locale.getWeekInfo === "function" ? locale.getWeekInfo() : locale.weekInfo;
    const first = info?.firstDay;
    if (typeof first === "number" && first >= 1 && first <= 7) return first;
  } catch {
    // An engine without Intl.Locale, or a locale tag it will not accept. A
    // guessed week start is a cosmetic miss; a screen that fails to mount
    // because of one is not.
  }
  return 1;
}

/* ------------------------------------------------------------ formatting */

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const hourFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric" });
const weekdayShortFmt = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const dayNumberFmt = new Intl.DateTimeFormat(undefined, { day: "numeric" });
const offsetFmt = new Intl.DateTimeFormat(undefined, { timeZoneName: "shortOffset" });

export function timeLabel(date: Date): string {
  return timeFmt.format(date);
}

/** "GMT+1" — the offset in force *on the day being looked at*, which is not
 *  always the offset in force today. */
export function zoneOffsetLabel(on: Date): string {
  const part = offsetFmt.formatToParts(on).find((p) => p.type === "timeZoneName");
  return part?.value ?? "";
}

export function browserTimeZone(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/* --------------------------------------------------------------- layout */

/**
 * Clip a day's events to that day and give each one a column.
 *
 * Overlapping events are collected into clusters of transitively-overlapping
 * blocks, and every block in a cluster gets an equal share of the width. Two
 * calls at 10:00 therefore sit side by side at half width rather than one
 * hiding the other — a calendar whose whole job is to show a double-booking
 * must not be the thing that conceals it.
 */
export function layoutDay(events: CalendarEvent[], day: Date): PlacedEvent[] {
  const dayStart = startOfDay(day);
  const dayEnd = addDays(dayStart, 1);

  type Span = { event: CalendarEvent; startMin: number; endMin: number };

  const spans: Span[] = [];
  for (const event of events) {
    const start = new Date(event.starts_at);
    const end = new Date(event.ends_at);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
    if (end <= dayStart || start >= dayEnd) continue;

    // A call that runs past midnight is drawn on both days, clipped to each.
    const startMin = start <= dayStart ? 0 : minutesOfDay(start);
    const endMin = end >= dayEnd ? MINUTES_PER_DAY : minutesOfDay(end);
    // Clipping is what keeps the ordering honest; the minimum *height* is
    // applied at render so a zero-length event cannot fake an overlap here.
    spans.push({ event, startMin, endMin: Math.max(endMin, startMin) });
  }

  spans.sort(
    (a, b) =>
      a.startMin - b.startMin || b.endMin - a.endMin || a.event.id.localeCompare(b.event.id),
  );

  const placed: PlacedEvent[] = [];
  let cluster: Span[] = [];
  let clusterEnd = -1;

  const flush = () => {
    if (cluster.length === 0) return;
    // Greedy first-fit: the earliest column whose last event has already
    // finished. Spans are start-ordered, so this is stable across reloads.
    const columnEnds: number[] = [];
    const assigned = cluster.map((span) => {
      let column = columnEnds.findIndex((end) => end <= span.startMin);
      if (column === -1) {
        column = columnEnds.length;
        columnEnds.push(span.endMin);
      } else {
        columnEnds[column] = span.endMin;
      }
      return { span, column };
    });
    for (const { span, column } of assigned) {
      placed.push({ ...span, column, columns: columnEnds.length });
    }
    cluster = [];
    clusterEnd = -1;
  };

  for (const span of spans) {
    if (cluster.length > 0 && span.startMin >= clusterEnd) flush();
    cluster.push(span);
    clusterEnd = Math.max(clusterEnd, span.endMin);
  }
  flush();

  return placed;
}

/** A bot can only be sent into a call that is happening now. */
export function isHappeningNow(event: CalendarEvent, now: Date): boolean {
  const start = Date.parse(event.starts_at);
  const end = Date.parse(event.ends_at);
  return (
    Number.isFinite(start) && Number.isFinite(end) && start <= now.getTime() && now.getTime() < end
  );
}

export function overlapsDay(event: CalendarEvent, day: Date): boolean {
  const dayStart = startOfDay(day);
  const dayEnd = addDays(dayStart, 1);
  const start = Date.parse(event.starts_at);
  const end = Date.parse(event.ends_at);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  return start < dayEnd.getTime() && end > dayStart.getTime();
}

/* ------------------------------------------------------------- component */

export function CalendarGrid({
  days,
  events,
  now,
  selectedDay,
  selectedEventId,
  onSelectDay,
  onOpenEvent,
}: {
  days: Date[];
  events: CalendarEvent[];
  now: Date;
  selectedDay: Date;
  selectedEventId: string | null;
  onSelectDay: (day: Date) => void;
  onOpenEvent: (event: CalendarEvent, anchor: HTMLElement) => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const scrolledFor = useRef<string | null>(null);

  const first = days[0] ?? startOfDay(now);
  const columns = `${GUTTER}px repeat(${days.length}, minmax(0, 1fr))`;

  /**
   * Land near the working day, not at midnight.
   *
   * Opening a calendar on 00:00 puts eight empty hours between the reader and
   * everything they came for. The anchor is the earliest event that actually
   * *begins* in view, backed off half an hour — and it is deliberately read
   * from the events rather than from `layoutDay`, because a call that started
   * yesterday and runs past midnight is clipped to 00:00 on this day, and one
   * of those would otherwise drag the whole week back to midnight.
   *
   * Clamped at both ends. Below 06:00 the anchor stops being informative and
   * starts being a pre-dawn empty grid; above 08:00 the morning would be
   * scrolled off for a week whose first meeting happens to be after lunch.
   */
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    // Keyed on the visible period: re-running on every refetch would yank the
    // viewport back to the morning while someone is reading the afternoon.
    const key = `${first.getTime()}:${days.length}`;
    if (scrolledFor.current === key) return;
    scrolledFor.current = key;

    let earliest = DEFAULT_SCROLL_MINUTE;
    for (const event of events) {
      const start = new Date(event.starts_at);
      if (Number.isNaN(start.getTime())) continue;
      if (!days.some((day) => sameDay(day, start))) continue;
      earliest = Math.min(earliest, minutesOfDay(start) - 30);
    }
    const target = Math.min(Math.max(earliest, EARLIEST_SCROLL_MINUTE), DEFAULT_SCROLL_MINUTE);

    // No allowance for the headings: they are `sticky`, so they still occupy
    // their own place in the flow above the grid. Adding their height here
    // scrolls the target hour up *behind* them, which is exactly the eight
    // empty hours this effect exists to avoid, one screen further on.
    node.scrollTop = (target / 60) * HOUR_HEIGHT;
  }, [days, events, first]);

  return (
    <div className="pane detail" style={{ minWidth: 0 }}>
      <div className="pane-head">
        <span className="grow">{days.length === 1 ? "Day" : "Week"}</span>
        <span title="All times shown in the browser's time zone">{zoneOffsetLabel(first)}</span>
      </div>

      <div className="pane-body scroll" ref={scrollRef}>
        {/* The headings live inside the scroller and stick to its top. Putting
            them in the pane head instead would mean two flex containers being
            trusted to compute the same column widths as the grid below, and
            they would drift the moment a scrollbar took up space. */}
        <div
          style={{
            position: "sticky",
            top: 0,
            zIndex: 4,
            display: "grid",
            gridTemplateColumns: columns,
            height: HEAD_HEIGHT,
            background: "var(--pane)",
            borderBottom: "1px solid var(--line)",
          }}
        >
          <div style={{ borderRight: "1px solid var(--line)" }} />
          {days.map((day) => (
            <DayHeading
              key={day.getTime()}
              day={day}
              today={sameDay(day, now)}
              selected={sameDay(day, selectedDay)}
              count={events.filter((e) => overlapsDay(e, day)).length}
              onSelect={() => onSelectDay(day)}
            />
          ))}
        </div>

        <div style={{ position: "relative" }}>
          {/* Hour rules sit under everything and swallow no clicks: dragging a
              new event is not a thing this screen does, so the lines are
              decoration and the columns below own the pointer. */}
          <div aria-hidden style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
            {Array.from({ length: 24 }, (_, hour) => (
              <div
                key={hour}
                style={{
                  position: "absolute",
                  top: hour * HOUR_HEIGHT,
                  left: hour === 0 ? 0 : GUTTER,
                  right: 0,
                  borderTop: `1px solid ${hour === 0 ? "transparent" : "var(--line-soft)"}`,
                }}
              />
            ))}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: columns, height: DAY_HEIGHT }}>
            <div style={{ position: "relative", borderRight: "1px solid var(--line)" }}>
              {Array.from({ length: 23 }, (_, index) => {
                const hour = index + 1;
                return (
                  <div
                    key={hour}
                    className="mono"
                    style={{
                      position: "absolute",
                      top: hour * HOUR_HEIGHT - 6,
                      right: 8,
                      color: "var(--faint)",
                    }}
                  >
                    {hourFmt.format(new Date(2000, 0, 1, hour))}
                  </div>
                );
              })}
            </div>

            {days.map((day) => (
              <DayColumn
                key={day.getTime()}
                day={day}
                placed={layoutDay(events, day)}
                now={now}
                selected={sameDay(day, selectedDay)}
                selectedEventId={selectedEventId}
                onSelectDay={onSelectDay}
                onOpenEvent={onOpenEvent}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------- */

function DayHeading({
  day,
  today,
  selected,
  count,
  onSelect,
}: {
  day: Date;
  today: boolean;
  selected: boolean;
  count: number;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      aria-current={selected ? "date" : undefined}
      title={`${count} event${count === 1 ? "" : "s"}`}
      style={{
        minWidth: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        height: "100%",
        border: "none",
        // A rule under the selected day rather than a filled header: the tint
        // running down the column already carries the selection, and two
        // signals for one state is one of them shouting. Drawn as an inset
        // shadow so the border stays a single shorthand — see EventBlock.
        boxShadow: selected ? "inset 0 -2px 0 var(--orange)" : "none",
        background: "none",
        cursor: "pointer",
      }}
    >
      <span
        className="mono"
        style={{ textTransform: "uppercase", color: today ? "var(--orange)" : "var(--faint)" }}
      >
        {weekdayShortFmt.format(day)}
      </span>
      <span
        style={{
          fontSize: 14,
          fontWeight: 600,
          color: today ? "var(--orange)" : selected ? "var(--ink)" : "var(--ink-2)",
        }}
      >
        {dayNumberFmt.format(day)}
      </span>
    </button>
  );
}

function DayColumn({
  day,
  placed,
  now,
  selected,
  selectedEventId,
  onSelectDay,
  onOpenEvent,
}: {
  day: Date;
  placed: PlacedEvent[];
  now: Date;
  selected: boolean;
  selectedEventId: string | null;
  onSelectDay: (day: Date) => void;
  onOpenEvent: (event: CalendarEvent, anchor: HTMLElement) => void;
}) {
  const today = sameDay(day, now);

  return (
    <div
      onClick={() => onSelectDay(day)}
      style={{
        position: "relative",
        borderRight: "1px solid var(--line-soft)",
        // A whisper, not a highlight. The selected day has to be findable
        // without competing with the events drawn on top of it.
        background: selected ? "color-mix(in srgb, var(--orange) 4%, transparent)" : undefined,
      }}
    >
      {placed.map((item) => (
        <EventBlock
          key={item.event.id}
          placed={item}
          selected={item.event.id === selectedEventId}
          onOpen={onOpenEvent}
        />
      ))}

      {today && <NowLine minutes={minutesOfDay(now)} />}
    </div>
  );
}

function NowLine({ minutes }: { minutes: number }) {
  return (
    <div
      aria-hidden
      style={{
        position: "absolute",
        top: (minutes / 60) * HOUR_HEIGHT,
        left: 0,
        right: 0,
        height: 0,
        borderTop: "2px solid var(--orange)",
        // Above every block: the one line that must never be covered is the
        // one that says where "now" is.
        zIndex: 3,
        pointerEvents: "none",
      }}
    >
      <span
        style={{
          position: "absolute",
          left: -3,
          top: -5,
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: "var(--orange)",
        }}
      />
    </div>
  );
}

function EventBlock({
  placed,
  selected,
  onOpen,
}: {
  placed: PlacedEvent;
  selected: boolean;
  onOpen: (event: CalendarEvent, anchor: HTMLElement) => void;
}) {
  const { event, startMin, endMin, column, columns } = placed;
  const height = Math.max(((endMin - startMin) / 60) * HOUR_HEIGHT, MIN_BLOCK_HEIGHT);
  const width = 100 / columns;
  const skin = blockSkin(event);
  const compact = height < 34;

  return (
    <button
      onClick={(e) => {
        // The column underneath changes the selected day; opening an event
        // should not also move the agenda out from under the popover.
        e.stopPropagation();
        onOpen(event, e.currentTarget);
      }}
      aria-label={`${event.title ?? "Untitled event"}, ${timeLabel(new Date(event.starts_at))}`}
      style={{
        position: "absolute",
        top: (startMin / 60) * HOUR_HEIGHT,
        height,
        left: `calc(${column * width}% + 2px)`,
        width: `calc(${width}% - 4px)`,
        display: "flex",
        flexDirection: compact ? "row" : "column",
        alignItems: compact ? "center" : "stretch",
        gap: compact ? 5 : 1,
        overflow: "hidden",
        padding: compact ? "0 6px" : "3px 6px",
        borderRadius: 5,
        // The border stays uniform on all four sides and the dispatched-bot bar
        // is an inset shadow instead. A per-side override would mean handing
        // React both `borderWidth` and `borderLeftWidth` for the same element,
        // and it warns about that for a real reason: the two overwrite each
        // other unpredictably across re-renders, which is every re-render for a
        // block whose bar tracks the recording state.
        borderStyle: skin.borderStyle,
        borderWidth: 1,
        borderColor: skin.border,
        background: skin.background,
        color: skin.color,
        textAlign: "left",
        cursor: "pointer",
        zIndex: selected ? 2 : 1,
        boxShadow:
          [
            skin.bar ? `inset 3px 0 0 ${skin.bar}` : "",
            selected ? "0 0 0 2px var(--orange), 0 4px 14px rgba(0,0,0,0.14)" : "",
          ]
            .filter(Boolean)
            .join(", ") || "none",
      }}
    >
      <span
        style={{
          fontSize: 12,
          fontWeight: 600,
          lineHeight: 1.25,
          minWidth: 0,
          flex: compact ? 1 : "none",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: compact ? "nowrap" : "normal",
          display: compact ? "block" : "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
          textDecoration: event.cancelled ? "line-through" : "none",
        }}
      >
        {event.title ?? "Untitled event"}
      </span>
      <span className="mono" style={{ opacity: 0.75, whiteSpace: "nowrap" }}>
        {timeLabel(new Date(event.starts_at))}
        {!compact && event.bot_dispatched && " · recording"}
      </span>
    </button>
  );
}

/**
 * What a block looks like, and why.
 *
 * The distinction that carries real weight is joinable versus not: an event
 * with no conferencing link can never be recorded, and it is drawn as an
 * outline rather than a filled block so that absence is visible at a glance
 * instead of only in the popover.
 */
function blockSkin(event: CalendarEvent): {
  background: string;
  border: string;
  borderStyle: string;
  color: string;
  bar?: string;
} {
  if (event.cancelled) {
    return {
      background: "transparent",
      border: "var(--line-strong)",
      borderStyle: "dashed",
      color: "var(--faint)",
    };
  }
  if (!event.meeting_url) {
    return {
      background: "var(--pane-2)",
      border: "var(--line-strong)",
      borderStyle: "dashed",
      color: "var(--muted)",
    };
  }
  if (event.bot_dispatched) {
    return {
      background: "var(--orange-soft)",
      border: "var(--orange-line)",
      borderStyle: "solid",
      color: "var(--ink)",
      bar: "var(--orange)",
    };
  }
  if (event.auto_record) {
    return {
      background: "var(--orange-soft)",
      border: "var(--orange-line)",
      borderStyle: "solid",
      color: "var(--ink)",
    };
  }
  return {
    background: "var(--blue-soft)",
    border: "color-mix(in srgb, var(--blue) 26%, var(--line))",
    borderStyle: "solid",
    color: "var(--ink)",
  };
}
