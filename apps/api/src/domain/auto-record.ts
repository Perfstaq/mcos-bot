import { AutoRecordMode } from "@prisma/client";
import {
  parseAutoRecordRules,
  passesAutoRecordRules,
  type SyncAttendee,
} from "../jobs/calendar-sync.js";

/**
 * Whether a bot walks into someone's meeting.
 *
 * Three places can have an opinion and they are consulted most-specific first:
 * the per-event toggle on the calendar grid, then the connection's own opt-in
 * and narrowing rules, then the person's default recording mode from settings.
 * The first layer with an opinion decides; the rest are not consulted.
 *
 * A layer *abstaining* is the interesting part. An event nobody has touched
 * abstains (`override: null`). A connection abstains only when it is untouched
 * — not opted in and carrying no rules — because the moment a user flips either
 * one, they have said something about that specific calendar that a global
 * default has no business overruling. That is what "a per-connection rule
 * always wins" means at decision time, and it is why a personal mode of `all`
 * cannot drag an opted-out calendar into recording.
 *
 * Everything fails closed. An event this cannot judge is not recorded, because
 * the cost of a recorder joining a call it had no business joining is much
 * higher than the cost of missing one — the same trade-off `passesAutoRecordRules`
 * already makes for the narrowing rules, applied one level up.
 *
 * Pure on purpose: no database, no clock. The sync loop and the calendar screen
 * must reach the same answer for the same event, and the only way to guarantee
 * that is for both to call this.
 */

/** Which layer of the ladder produced the answer. Surfaced so the calendar can
 *  explain a toggle the user did not set, and so a support question about "why
 *  did it record that?" has an answer that is not a re-derivation. */
export type AutoRecordLayer = "ineligible" | "event_override" | "connection" | "preference";

export type AutoRecordDecision = {
  record: boolean;
  decidedBy: AutoRecordLayer;
  reason: string;
};

export type AutoRecordConnectionInput = {
  autoRecord: boolean;
  /** The raw Json column, handed over unparsed — see `hasStoredRules`. */
  autoRecordRules: unknown;
  /** The connected mailbox. "External" and "owned" are judged against it. */
  email: string;
};

export type AutoRecordEventInput = {
  title: string | null;
  organizerEmail: string | null;
  attendees: SyncAttendee[];
  meetingUrl: string | null;
  cancelled: boolean;
  /** All-day blocks have no join time, so there is never a call to join. */
  allDay: boolean;
  /** The per-event toggle. `null` means no human has touched this event. */
  override: boolean | null;
};

export type AutoRecordInput = {
  /** Null when the person has never opened settings; read as the enum default. */
  preference: { autoRecordMode: AutoRecordMode } | null;
  connection: AutoRecordConnectionInput;
  event: AutoRecordEventInput;
};

export function decideAutoRecord(input: AutoRecordInput): AutoRecordDecision {
  const { connection, event } = input;

  // Physics, not policy: these are not preferences anyone can override, because
  // there is nothing for a bot to join. Deliberately above the per-event
  // toggle — a user who switched recording on for an event that was later
  // cancelled has not consented to a bot dialling a dead link.
  if (event.cancelled) return decided(false, "ineligible", "event is cancelled");
  if (event.allDay) return decided(false, "ineligible", "all-day event has no call to join");
  if (!event.meetingUrl) return decided(false, "ineligible", "event has no joinable link");

  if (event.override !== null) {
    return decided(
      event.override,
      "event_override",
      event.override ? "recording was switched on for this event" : "recording was switched off for this event",
    );
  }

  if (connection.autoRecord || hasStoredRules(connection.autoRecordRules)) {
    if (!connection.autoRecord) {
      return decided(false, "connection", "auto-record is off for this calendar");
    }
    const passes = passesAutoRecordRules({
      rules: parseAutoRecordRules(connection.autoRecordRules),
      title: event.title,
      attendees: event.attendees,
      connectionEmail: connection.email,
    });
    return decided(
      passes,
      "connection",
      passes
        ? "calendar is opted in and the event passes its rules"
        : "event does not pass this calendar's rules",
    );
  }

  return fromMode(input.preference?.autoRecordMode ?? AutoRecordMode.none, input);
}

/**
 * The personal default, for calendars that have expressed nothing of their own.
 *
 * `external` reuses the connection rule of the same name rather than restating
 * it: two implementations of "is anyone here from outside our domain" is two
 * places for the answer to drift, and the drift would only ever be discovered
 * by someone being recorded who should not have been.
 */
function fromMode(mode: AutoRecordMode, input: AutoRecordInput): AutoRecordDecision {
  const { connection, event } = input;

  switch (mode) {
    case AutoRecordMode.none:
      return decided(false, "preference", "auto-record is off in your settings");

    case AutoRecordMode.all:
      return decided(true, "preference", "your settings record every meeting with a link");

    case AutoRecordMode.external: {
      const passes = passesAutoRecordRules({
        rules: { externalOnly: true },
        title: event.title,
        attendees: event.attendees,
        connectionEmail: connection.email,
      });
      return decided(
        passes,
        "preference",
        passes
          ? "your settings record external meetings, and this one has an outside attendee"
          : "your settings record external meetings only",
      );
    }

    case AutoRecordMode.owned: {
      const organizer = event.organizerEmail?.toLowerCase() ?? null;
      const owner = connection.email.toLowerCase();
      // No organiser on the event means we cannot tell whose meeting it is, and
      // guessing "probably mine" is the wrong way to be wrong.
      const owned = organizer !== null && organizer === owner;
      return decided(
        owned,
        "preference",
        owned
          ? "your settings record meetings you organise"
          : "your settings record meetings you organise, and this is not one",
      );
    }

    default:
      // A mode added to the enum without being handled here records nothing
      // until someone decides what it means. The `never` makes that a compile
      // error rather than a surprise in production.
      return unhandledMode(mode);
  }
}

function unhandledMode(mode: never): AutoRecordDecision {
  return decided(false, "preference", `unrecognised recording mode ${String(mode)}`);
}

/**
 * Does the connection carry narrowing rules at all?
 *
 * Asked of the raw column rather than the parsed result on purpose. A rules
 * blob that fails validation still means someone configured this calendar, so
 * it keeps the connection authoritative instead of quietly demoting it to
 * "untouched" and handing the decision to a global default that might say yes.
 */
function hasStoredRules(raw: unknown): boolean {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) && Object.keys(raw).length > 0;
}

function decided(record: boolean, decidedBy: AutoRecordLayer, reason: string): AutoRecordDecision {
  return { record, decidedBy, reason };
}
