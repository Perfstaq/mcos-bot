import type { CSSProperties } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { MeetingStatus } from "../api.js";
import { playbackDeepLink, type PlaybackUnavailable } from "./RecordingPlayer.js";
import { StatusChip } from "./StatusChip.js";

/**
 * One row of GET /library/meetings, as the API spells it
 * (apps/api/src/routes/library.ts). Declared beside the component that consumes
 * it rather than in api.ts: that file is shared and this shape belongs to one
 * screen, the same split ActionItemsPanel makes with its `ActionItem`.
 */
export type LibraryMeeting = {
  id: string;
  title: string | null;
  status: MeetingStatus;
  platform: string | null;
  started_at: string | null;
  /** The fallback date for a meeting that was scheduled and never ran. */
  created_at: string;
  duration_ms: number | null;
  /** Null when neither the media nor the calendar knows how long it ran. */
  duration_label: string | null;
  /** Who actually spoke, ordered by turns taken and capped by the API at 8. */
  participants: string[];
  participant_count: number;
  recording: {
    playable: boolean;
    unavailable_reason: PlaybackUnavailable | null;
    content_type: string | null;
    bytes: number | null;
  };
  transcript: { available: boolean; segment_count: number };
  claim_counts: { proposed: number; approved: number; rejected: number; edited: number; total: number };
  action_item_counts: {
    open: number;
    in_progress: number;
    done: number;
    cancelled: number;
    total: number;
    /** Proposed by a model and not yet accepted or dismissed by anyone. */
    suggested: number;
  };
  has_notes: boolean;
};

/**
 * A recorded meeting on the shelf.
 *
 * Two destinations, not one. The card opens the workspace; the play affordance
 * opens the workspace *at the recording*, through the same `playbackDeepLink`
 * the search results use, so the two screens cannot disagree about what a
 * timestamped link looks like. The whole surface is clickable for the mouse,
 * and the title and the play button are the two real links — a card that were
 * itself a button could not contain either of them without producing nested
 * interactive elements.
 *
 * The poster carries the recording's state and the marker row carries
 * everything else. Repeating "has a recording" as a chip under a play button
 * the reader is already looking at buys nothing and costs a line.
 */
export function MeetingCard({ meeting }: { meeting: LibraryMeeting }) {
  const navigate = useNavigate();

  const title = meeting.title ?? "Untitled meeting";
  const occurredAt = meeting.started_at ?? meeting.created_at;
  const shown = meeting.participants.slice(0, 3);
  const unnamed = meeting.participant_count - shown.length;

  return (
    <article className="card" style={CARD} onClick={() => navigate(`/meetings/${meeting.id}`)}>
      <div style={POSTER}>
        <span style={{ position: "absolute", top: 8, left: 8 }}>
          <StatusChip status={meeting.status} />
        </span>

        {meeting.recording.playable ? (
          <Link
            to={playbackDeepLink(meeting.id, { startMs: 0 })}
            className="btn primary"
            style={PLAY}
            aria-label={`Play the recording of ${title}`}
            // Both this link and the card navigate; without this the card's
            // handler runs afterwards and lands on the workspace with no `t`.
            onClick={(event) => event.stopPropagation()}
          >
            <IconPlay />
          </Link>
        ) : (
          // Nothing to press. A play button that resolves to a missing object
          // reads as a broken product rather than as a recording somebody
          // deliberately deleted, so the card says which of the two it is.
          <span className="chip">
            {meeting.recording.unavailable_reason === "purged" ? "Recording deleted" : "Not recorded"}
          </span>
        )}

        {meeting.duration_label && (
          <span className="mono" style={DURATION}>
            {meeting.duration_label}
          </span>
        )}
      </div>

      <div style={BODY}>
        <Link
          to={`/meetings/${meeting.id}`}
          style={TITLE}
          onClick={(event) => event.stopPropagation()}
        >
          {title}
        </Link>

        <div className="row-meta mono" style={{ marginTop: 0, flexWrap: "wrap" }}>
          <span>{shelfDate(occurredAt)}</span>
          {meeting.platform && <span>{meeting.platform.replace(/_/g, " ")}</span>}
        </div>

        {shown.length > 0 && (
          <div style={PARTICIPANTS} title={meeting.participants.join(", ")}>
            {shown.join(", ")}
            {unnamed > 0 && <span style={{ color: "var(--faint)" }}> +{unnamed}</span>}
          </div>
        )}

        <div style={MARKERS}>
          {meeting.transcript.available && <span className="chip">Transcript</span>}
          {meeting.has_notes && <span className="chip">Notes</span>}
          {/* Orange is the "your turn" signal everywhere else in the product,
              and both of these are proposals waiting on a human decision. */}
          {meeting.claim_counts.proposed > 0 && (
            <span className="chip live">
              <span className="dot" />
              {meeting.claim_counts.proposed} to review
            </span>
          )}
          {meeting.action_item_counts.suggested > 0 && (
            <span className="chip live">
              <span className="dot" />
              {meeting.action_item_counts.suggested} suggested
            </span>
          )}
        </div>
      </div>
    </article>
  );
}

/* ---------------------------------------------------------------------- */

/**
 * The year only when it is not this one.
 *
 * A shelf is mostly recent, so stamping 2026 on every card is four characters
 * of noise per card that stop being noise exactly when they start being news.
 */
function shelfDate(iso: string): string {
  const date = new Date(iso);
  const thisYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(thisYear ? {} : { year: "numeric" }),
  });
}

/* Layout the stylesheet cannot express: a card grid's proportions are computed
   from the tile, not from the document. Everything with a colour in it is still
   a token, so both themes follow. */

const CARD: CSSProperties = {
  padding: 0,
  overflow: "hidden",
  cursor: "pointer",
  display: "flex",
  flexDirection: "column",
};

/** 16:9 so a page of cards keeps one rhythm however long the titles run. */
const POSTER: CSSProperties = {
  position: "relative",
  aspectRatio: "16 / 9",
  display: "grid",
  placeItems: "center",
  background: "var(--pane-2)",
  borderBottom: "1px solid var(--line)",
};

const PLAY: CSSProperties = {
  width: 46,
  height: 46,
  padding: 0,
  borderRadius: "50%",
  justifyContent: "center",
  textDecoration: "none",
};

const DURATION: CSSProperties = {
  position: "absolute",
  right: 8,
  bottom: 8,
  padding: "1px 6px",
  borderRadius: 4,
  border: "1px solid var(--line)",
  background: "var(--pane)",
  color: "var(--muted)",
};

const BODY: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  padding: "11px 13px 13px",
};

const TITLE: CSSProperties = {
  color: "var(--ink)",
  textDecoration: "none",
  fontSize: 14,
  fontWeight: 600,
  letterSpacing: "-0.01em",
  lineHeight: 1.35,
  // Two lines, then an ellipsis: a long title must not push the marker row of
  // one card out of line with its neighbours'.
  display: "-webkit-box",
  WebkitLineClamp: 2,
  WebkitBoxOrient: "vertical",
  overflow: "hidden",
};

const PARTICIPANTS: CSSProperties = {
  fontSize: 12,
  color: "var(--muted)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const MARKERS: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 5,
  marginTop: 2,
};

/* Local rather than in Icons.tsx, for the reason RecordingPlayer.tsx gives:
   that file is shared and two people adding glyphs to it in the same week is a
   conflict for no benefit. */
const IconPlay = () => (
  <svg width={17} height={17} viewBox="0 0 20 20" fill="currentColor" aria-hidden>
    <path d="M6.5 3.5 16.5 10 6.5 16.5Z" />
  </svg>
);
