import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { IconLink, IconX } from "./Icons.js";
import {
  browserTimeZone,
  isHappeningNow,
  sameDay,
  timeLabel,
  zoneOffsetLabel,
  type CalendarAttendee,
  type CalendarEvent,
} from "./CalendarGrid.js";

/**
 * One event, and the only two decisions this screen can make about it: whether
 * a bot should join when it starts, and whether one should join right now.
 *
 * The controls are deliberately conditional rather than disabled. A greyed-out
 * "Record" on an event with no conferencing link implies the recording is one
 * permission away; it is not, and never will be, because there is no address to
 * send a bot to. Saying so in a sentence is the honest version.
 */

const dateFmt = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  day: "numeric",
  month: "long",
});

/**
 * RSVP values come straight off the provider, so both vocabularies are mapped.
 *
 * Google `attendees[].responseStatus`: `needsAction`, `declined`, `tentative`,
 * `accepted`.
 * https://developers.google.com/workspace/calendar/api/v3/reference/events
 *
 * Microsoft Graph `attendee.status.response`: `none`, `organizer`,
 * `tentativelyAccepted`, `accepted`, `declined`, `notResponded` — and the docs
 * state clients may treat `notResponded` as `none`, which is why both land on
 * the same label here.
 * https://learn.microsoft.com/en-us/graph/api/resources/responsestatus
 */
const RSVP: Record<string, { label: string; color: string }> = {
  accepted: { label: "yes", color: "var(--green)" },
  declined: { label: "no", color: "var(--red)" },
  tentative: { label: "maybe", color: "var(--blue)" },
  tentativelyAccepted: { label: "maybe", color: "var(--blue)" },
  organizer: { label: "host", color: "var(--muted)" },
  needsAction: { label: "no reply", color: "var(--faint)" },
  notResponded: { label: "no reply", color: "var(--faint)" },
  none: { label: "no reply", color: "var(--faint)" },
};

const WIDTH = 348;
const MARGIN = 10;

export function CalendarEventPopover({
  event,
  anchor,
  now,
  onClose,
  onToggleRecord,
  onRecordNow,
}: {
  event: CalendarEvent;
  anchor: HTMLElement;
  now: Date;
  onClose: () => void;
  /** Rejects rather than reports: the failure text belongs next to the control
   *  that failed, and the page above has already refreshed on success. */
  onToggleRecord: (event: CalendarEvent, next: boolean) => Promise<void>;
  onRecordNow: (event: CalendarEvent) => Promise<void>;
}) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [busy, setBusy] = useState<"toggle" | "now" | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * Anchored to the block that opened it, and re-anchored as the grid scrolls.
   *
   * The listener is registered in the capture phase because the scroll that
   * moves the anchor happens inside a pane, and a scroll event on an element
   * does not bubble to the window.
   */
  useLayoutEffect(() => {
    const place = () => {
      const box = anchor.getBoundingClientRect();
      const height = cardRef.current?.offsetHeight ?? 320;

      // Beside the event by preference, flipped to the other side when it would
      // run off the edge, and finally clamped — a popover half off-screen is
      // the same as no popover.
      let left = box.right + MARGIN;
      if (left + WIDTH > window.innerWidth - MARGIN) left = box.left - WIDTH - MARGIN;
      left = Math.max(MARGIN, Math.min(left, window.innerWidth - WIDTH - MARGIN));

      let top = box.top;
      if (top + height > window.innerHeight - MARGIN) top = window.innerHeight - height - MARGIN;
      top = Math.max(MARGIN, top);

      setPos({ top, left });
    };

    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    // The card grows when an error banner appears or the attendee list loads,
    // and a card that grew downwards past the viewport has to be pulled back up.
    const observer = new ResizeObserver(place);
    if (cardRef.current) observer.observe(cardRef.current);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
      observer.disconnect();
    };
  }, [anchor, event.id]);

  useEffect(() => {
    cardRef.current?.focus();
  }, []);

  // Dismissed by clicking away, but without a scrim: a full-screen overlay
  // would take the wheel events the grid underneath still needs in order to
  // scroll, and scrolling with the popover open is exactly what re-anchoring
  // above was built for.
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (cardRef.current?.contains(target) || anchor.contains(target)) return;
      onClose();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [anchor, onClose]);

  const start = new Date(event.starts_at);
  const end = new Date(event.ends_at);
  const live = isHappeningNow(event, now);
  const people = event.attendees.filter((a) => !a.resource);
  const rooms = event.attendees.filter((a) => a.resource);

  const act = async (kind: "toggle" | "now", fn: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      ref={cardRef}
      className="card"
      role="dialog"
      aria-label={event.title ?? "Untitled event"}
      tabIndex={-1}
      style={{
        position: "fixed",
        top: pos?.top ?? 0,
        left: pos?.left ?? 0,
        width: WIDTH,
        maxHeight: `calc(100vh - ${MARGIN * 2}px)`,
        overflowY: "auto",
        padding: "16px 18px 18px",
        zIndex: 50,
        boxShadow: "0 18px 50px rgba(0, 0, 0, 0.25)",
        outline: "none",
        // Placed by a layout effect, so the first paint already has the right
        // coordinates; this only guards the frame before measurement.
        visibility: pos ? "visible" : "hidden",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 10 }}>
        <h2
          style={{
            flex: 1,
            margin: 0,
            fontSize: 16,
            fontWeight: 600,
            letterSpacing: "-0.01em",
            lineHeight: 1.35,
            textDecoration: event.cancelled ? "line-through" : "none",
          }}
        >
          {event.title ?? "Untitled event"}
        </h2>
        <button
          className="btn sm"
          aria-label="Close"
          onClick={onClose}
          style={{ border: "none", background: "none", padding: 2 }}
        >
          <IconX size={14} />
        </button>
      </div>

      <div style={{ color: "var(--ink-2)", fontSize: 13, marginBottom: 2 }}>
        {dateFmt.format(start)} · {timeLabel(start)} – {timeLabel(end)}
        {!sameDay(start, end) && <span style={{ color: "var(--faint)" }}> (+1 day)</span>}
      </div>
      <div className="mono" style={{ color: "var(--faint)", marginBottom: 12 }}>
        {zoneOffsetLabel(start)}
        {/* The organiser's zone is only worth naming when it is not the
            reader's — otherwise it is noise restating the line above. */}
        {event.timezone &&
          event.timezone !== browserTimeZone() &&
          ` · scheduled in ${event.timezone}`}
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14 }}>
        {live && (
          <span className="chip live">
            <span className="dot pulse" />
            happening now
          </span>
        )}
        {event.is_recurring && (
          <span className="chip">
            <span className="dot" />
            repeats
          </span>
        )}
        {event.cancelled && (
          <span className="chip error">
            <span className="dot" />
            cancelled
          </span>
        )}
        {event.platform && <span className="type-tag">{event.platform.replace(/_/g, " ")}</span>}
      </div>

      {error && (
        <div className="banner error" style={{ margin: "0 0 14px" }}>
          {error}
        </div>
      )}

      {event.meeting_url && !event.cancelled && (
        <a
          className="btn sm"
          href={event.meeting_url}
          target="_blank"
          rel="noopener noreferrer"
          style={{ marginBottom: 16, textDecoration: "none", color: "inherit" }}
        >
          <IconLink /> Join the call
        </a>
      )}

      <div className="section" style={{ marginBottom: 16 }}>
        <h3>Organiser</h3>
        <div style={{ fontSize: 13, color: "var(--ink-2)", wordBreak: "break-word" }}>
          {event.organizer_email ?? "Not recorded by the provider"}
        </div>
      </div>

      <div className="section" style={{ marginBottom: 16 }}>
        {/* Counted from the list being drawn rather than from `attendee_count`.
            The API derives that field the same way, but a heading that can
            disagree with the rows underneath it eventually does. */}
        <h3>
          {people.length} attendee{people.length === 1 ? "" : "s"}
        </h3>
        {people.length === 0 && (
          <div style={{ fontSize: 13, color: "var(--muted)" }}>Nobody else is invited.</div>
        )}
        <div className="scroll" style={{ maxHeight: 168, marginRight: -4, paddingRight: 4 }}>
          {people.map((attendee) => (
            <AttendeeRow key={attendee.email} attendee={attendee} />
          ))}
        </div>
        {rooms.length > 0 && (
          <div className="mono" style={{ color: "var(--faint)", marginTop: 8 }}>
            plus {rooms.length} room{rooms.length === 1 ? "" : "s"} or resource
            {rooms.length === 1 ? "" : "s"}
          </div>
        )}
      </div>

      <div className="section" style={{ marginBottom: 0 }}>
        <h3>Recording</h3>
        <RecordingControls
          event={event}
          live={live}
          busy={busy}
          onToggle={(next) => void act("toggle", () => onToggleRecord(event, next))}
          onRecordNow={() => void act("now", () => onRecordNow(event))}
        />
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------- */

function RecordingControls({
  event,
  live,
  busy,
  onToggle,
  onRecordNow,
}: {
  event: CalendarEvent;
  live: boolean;
  busy: "toggle" | "now" | null;
  onToggle: (next: boolean) => void;
  onRecordNow: () => void;
}) {
  if (event.cancelled) {
    return (
      <div style={{ fontSize: 13, color: "var(--muted)" }}>
        This event is cancelled, so nothing will be recorded. If it comes back, the toggle comes
        back with it.
      </div>
    );
  }

  // Requirement, not a nicety: offering a control that cannot work is a lie the
  // user only discovers after trusting it.
  if (!event.meeting_url) {
    return (
      <div style={{ fontSize: 13, color: "var(--muted)" }}>
        No conferencing link on this event. A bot joins by dialling a URL, so there is nothing here
        to record — add a Meet, Zoom or Teams link to the invitation and it will appear after the
        next sync.
      </div>
    );
  }

  if (event.bot_dispatched) {
    return (
      <div style={{ fontSize: 13 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 6 }}>
          <span className="chip ready">
            <span className="dot" />
            bot booked
          </span>
        </div>
        <div style={{ color: "var(--muted)" }}>
          A recorder is already booked for this call. Stopping it means cancelling the meeting
          rather than flipping this switch back — the booking lives with the bot, not with the
          calendar row.
        </div>
        {event.meeting_id && (
          <Link
            to={`/meetings/${event.meeting_id}`}
            className="btn sm"
            style={{ marginTop: 10, textDecoration: "none", color: "inherit" }}
          >
            Open the meeting
          </Link>
        )}
      </div>
    );
  }

  return (
    <>
      <label style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer" }}>
        <input
          type="checkbox"
          checked={event.auto_record}
          disabled={busy !== null}
          onChange={(e) => onToggle(e.target.checked)}
          style={{ marginTop: 3, accentColor: "var(--orange)" }}
        />
        <span>
          <span style={{ fontWeight: 600 }}>Send a bot when this starts</span>
          <RecordingReason event={event} />
        </span>
      </label>

      {/* Only while the call is actually running. "Record now" on something
          starting in two hours would either schedule a bot to sit in an empty
          room or silently mean something other than what it says. */}
      {live && (
        <button
          className="btn primary sm"
          style={{ marginTop: 12 }}
          disabled={busy !== null}
          onClick={onRecordNow}
        >
          {busy === "now" ? "Sending…" : "Record now"}
        </button>
      )}
    </>
  );
}

/**
 * The sentence under the toggle, and the one case where it must not be printed.
 *
 * `auto_record_decision` is the rule ladder re-run for display, and the API
 * computes it with no per-event override — there is no column to hold one yet,
 * so a freshly toggled event comes back with `auto_record: true` beside a
 * reason that still reads "auto-record is off in your settings". Printing both
 * would have the screen contradict itself in two adjacent lines. When they
 * disagree, the stored flag is what governs this event and the ladder is only
 * describing the default it departed from, so that is what gets said.
 */
function RecordingReason({ event }: { event: CalendarEvent }) {
  const decision = event.auto_record_decision;
  if (!decision) return null;

  if (decision.record !== event.auto_record) {
    return (
      <div style={{ color: "var(--muted)", fontSize: 13 }}>
        Set for this event, overriding{" "}
        <Link to="/calendar/settings" style={{ color: "var(--muted)" }}>
          the calendar's rule
        </Link>
        .
      </div>
    );
  }

  const fromRule = decision.decidedBy === "connection" || decision.decidedBy === "preference";
  return (
    <div style={{ color: "var(--muted)", fontSize: 13 }}>
      {decision.reason}
      {fromRule && (
        <>
          {" — "}
          <Link to="/calendar/settings" style={{ color: "var(--muted)" }}>
            change the rule
          </Link>
        </>
      )}
    </div>
  );
}

function AttendeeRow({ attendee }: { attendee: CalendarAttendee }) {
  const rsvp = attendee.response ? RSVP[attendee.response] : undefined;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: 8,
        padding: "3px 0",
        fontSize: 13,
      }}
    >
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          color: "var(--ink-2)",
        }}
        title={attendee.email}
      >
        {attendee.name ?? attendee.email}
        {attendee.optional && (
          <span className="mono" style={{ color: "var(--faint)" }}>
            {" "}
            optional
          </span>
        )}
      </span>
      {/* An unrecognised value is shown as it arrived rather than dropped:
          providers add response types, and a blank cell reads as "no reply". */}
      <span className="mono" style={{ color: rsvp?.color ?? "var(--faint)", flex: "none" }}>
        {rsvp?.label ?? attendee.response ?? ""}
      </span>
    </div>
  );
}
