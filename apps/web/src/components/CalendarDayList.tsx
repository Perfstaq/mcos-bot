import {
  isHappeningNow,
  overlapsDay,
  sameDay,
  timeLabel,
  type CalendarEvent,
} from "./CalendarGrid.js";

/**
 * The selected day as a vertical agenda.
 *
 * The grid answers "when is my day busy"; this answers "what is actually on".
 * They are two readings of one selection, never two selections — clicking a day
 * here moves the grid's column and clicking a column there moves this list, so
 * there is no state in which the two panes disagree about which day is being
 * looked at.
 */

const fullDayFmt = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  day: "numeric",
  month: "long",
});
/** "Mon", not "M": a narrow weekday repeats letters (T/T, S/S) and the strip
 *  is wide enough not to need the ambiguity. */
const stripWeekdayFmt = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const stripDayFmt = new Intl.DateTimeFormat(undefined, { day: "numeric" });

export function CalendarDayList({
  days,
  events,
  selectedDay,
  selectedEventId,
  now,
  onSelectDay,
  onOpenEvent,
}: {
  days: Date[];
  events: CalendarEvent[];
  selectedDay: Date;
  selectedEventId: string | null;
  now: Date;
  onSelectDay: (day: Date) => void;
  onOpenEvent: (event: CalendarEvent, anchor: HTMLElement) => void;
}) {
  const dayEvents = events
    .filter((event) => overlapsDay(event, selectedDay))
    .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at) || a.id.localeCompare(b.id));

  return (
    <div className="pane list">
      <div className="pane-head">
        <span className="grow">{fullDayFmt.format(selectedDay)}</span>
        <span>{dayEvents.length}</span>
      </div>

      {/* Only in week view: in day view the header is already the day, and a
          strip of one button is a control that cannot do anything. */}
      {days.length > 1 && (
        <div
          style={{
            display: "flex",
            gap: 4,
            padding: "10px 12px",
            borderBottom: "1px solid var(--line-soft)",
          }}
        >
          {days.map((day) => {
            const selected = sameDay(day, selectedDay);
            const today = sameDay(day, now);
            const count = events.filter((event) => overlapsDay(event, day)).length;
            return (
              <button
                key={day.getTime()}
                onClick={() => onSelectDay(day)}
                aria-current={selected ? "date" : undefined}
                title={`${count} event${count === 1 ? "" : "s"}`}
                style={{
                  flex: 1,
                  minWidth: 0,
                  padding: "5px 0 6px",
                  border: `1px solid ${selected ? "var(--orange)" : "transparent"}`,
                  borderRadius: "var(--r-sm)",
                  background: selected ? "var(--orange-soft)" : "transparent",
                  color: today ? "var(--orange)" : "var(--ink-2)",
                  cursor: "pointer",
                  textAlign: "center",
                }}
              >
                <div className="mono" style={{ color: "var(--faint)" }}>
                  {stripWeekdayFmt.format(day)}
                </div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{stripDayFmt.format(day)}</div>
                {/* A count would not fit and would not be read; presence is the
                    only thing this strip needs to convey. */}
                <div
                  aria-hidden
                  style={{
                    width: 4,
                    height: 4,
                    margin: "3px auto 0",
                    borderRadius: "50%",
                    background: count > 0 ? "var(--faint)" : "transparent",
                  }}
                />
              </button>
            );
          })}
        </div>
      )}

      <div className="pane-body scroll">
        {dayEvents.length === 0 && (
          <div className="empty">
            <h3>Nothing scheduled</h3>
            <p>
              {sameDay(selectedDay, now)
                ? "The rest of today is clear."
                : "This day is clear on every connected calendar."}
            </p>
          </div>
        )}

        {dayEvents.map((event) => (
          <AgendaRow
            key={event.id}
            event={event}
            day={selectedDay}
            now={now}
            selected={event.id === selectedEventId}
            onOpen={onOpenEvent}
          />
        ))}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------- */

function AgendaRow({
  event,
  day,
  now,
  selected,
  onOpen,
}: {
  event: CalendarEvent;
  day: Date;
  now: Date;
  selected: boolean;
  onOpen: (event: CalendarEvent, anchor: HTMLElement) => void;
}) {
  const start = new Date(event.starts_at);
  const end = new Date(event.ends_at);
  const live = isHappeningNow(event, now);
  const past = Date.parse(event.ends_at) < now.getTime();

  // A call that began yesterday and runs into this day should not claim to
  // start at its own start time on this row.
  const startsToday = sameDay(start, day);
  const endsToday = sameDay(end, day);

  return (
    <button
      className={`row${selected ? " selected" : ""}`}
      onClick={(e) => onOpen(event, e.currentTarget)}
      style={{ opacity: past && !live ? 0.55 : 1 }}
    >
      <div className="row-top">
        <span
          className="grow"
          style={{
            fontWeight: 600,
            fontSize: 13,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            textDecoration: event.cancelled ? "line-through" : "none",
            color: event.meeting_url ? "var(--ink)" : "var(--muted)",
          }}
        >
          {event.title ?? "Untitled event"}
        </span>
        {live && (
          <span className="chip live">
            <span className="dot pulse" />
            now
          </span>
        )}
        {event.bot_dispatched && (
          <span className="chip ready">
            <span className="dot" />
            recording
          </span>
        )}
        {!event.bot_dispatched && event.auto_record && (
          <span className="chip">
            <span className="dot" />
            will record
          </span>
        )}
      </div>

      <div className="row-meta mono">
        <span style={{ color: "var(--ink-2)" }}>
          {startsToday ? timeLabel(start) : "from midnight"} –{" "}
          {endsToday ? timeLabel(end) : "past midnight"}
        </span>
        {event.is_recurring && <span>repeats</span>}
        <span>
          {event.attendee_count} {event.attendee_count === 1 ? "person" : "people"}
        </span>
        {/* Said plainly rather than implied by a missing icon: the reason there
            is no record button on this row is that there is nothing to join. */}
        {!event.meeting_url && !event.cancelled && <span>no link</span>}
        {event.cancelled && <span>cancelled</span>}
      </div>
    </button>
  );
}
