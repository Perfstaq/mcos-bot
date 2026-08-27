import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { api, type MeetingDetail } from "../api.js";
import { authErrorMessage, useSession } from "../auth-client.js";
import { AgendaPanel, type WorkspaceMember } from "../components/AgendaPanel.js";
import { ActionItemsPanel } from "../components/ActionItemsPanel.js";
import { NotesEditor, caretColor, type NotesUser } from "../components/NotesEditor.js";
import { RecordingPlayer, readPlaybackDeepLink } from "../components/RecordingPlayer.js";
import { StatusChip } from "../components/StatusChip.js";
import { IconChevron } from "../components/Icons.js";

/**
 * One meeting, as the people in it work on it.
 *
 * The notes take the wide pane because prose is the thing being written; the
 * agenda and the action items sit beside it because they are what the prose
 * keeps referring to. Splitting them across screens would mean the person
 * taking notes cannot see what the meeting was supposed to cover, which is the
 * only reason to have an agenda at all.
 *
 * The three panels fetch their own data. They are independent resources on the
 * server and a slow transcript should not hold up the agenda; what this page
 * owns is the two things all three need — who the workspace's members are, and
 * who the reader is.
 *
 * The wide pane is tabbed, because the recording and the notes want the same
 * space and only one of them is being read at a time. What the tabs must not do
 * is stop the audio: a listener who switches to the notes to check something is
 * still listening. So the player is mounted lazily on first use and then kept
 * mounted, hidden rather than unmounted — see `playerMounted` below.
 */
export function MeetingWorkspace() {
  const { id = "" } = useParams<{ id: string }>();
  const location = useLocation();
  const session = useSession();
  const [meeting, setMeeting] = useState<MeetingDetail | null>(null);
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [error, setError] = useState<string | null>(null);

  // A link from a search hit, a claim citation or a share carries the point in
  // the recording it means. Arriving on the notes and making the reader find
  // the tab would throw that away, so the deep link picks the tab.
  const arrival = useMemo(() => readPlaybackDeepLink(location.search), [location.search]);
  // Presence of the parameter, not its value. `?t=0` means "open at the start
  // of the recording", which is exactly what a library card links to; keying on
  // `startMs > 0` would send that link to the notes instead.
  const arrivesAtRecording = useMemo(() => {
    const params = new URLSearchParams(location.search);
    return params.has("t") || params.has("segment");
  }, [location.search]);
  const [tab, setTab] = useState<"notes" | "transcript">(
    arrivesAtRecording ? "transcript" : "notes",
  );

  /**
   * Whether the player has ever been opened.
   *
   * Mounting it costs a request that loads every segment of the meeting, which
   * is not worth paying for a reader who only wants the notes. Mounting it once
   * and hiding it thereafter is what keeps playback running across a tab
   * switch — unmounting would silence the audio and lose the listener's place.
   */
  const [playerMounted, setPlayerMounted] = useState(tab === "transcript");
  useEffect(() => {
    if (tab === "transcript") setPlayerMounted(true);
  }, [tab]);

  useEffect(() => {
    if (!id) return;
    void (async () => {
      try {
        const data = await api.get<{ meeting: MeetingDetail }>(`/meetings/${id}`);
        setMeeting(data.meeting);
        setError(null);
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  }, [id]);

  useEffect(() => {
    void (async () => {
      try {
        const data = await api.get<{ members: WorkspaceMember[] }>("/workspace/members");
        setMembers(data.members);
      } catch (e) {
        // A missing member list costs the owner and assignee pickers their
        // options; it must not take the notes down with it.
        setError((e as Error).message);
      }
    })();
  }, []);

  const account = session.data?.user ?? null;
  const user = useMemo<NotesUser | null>(
    () =>
      account
        ? {
            id: account.id,
            // Falling back to the address rather than to "Anonymous": an
            // unlabelled caret in someone else's document is worse than a
            // slightly ugly one.
            name: account.name || account.email,
            color: caretColor(account.id),
          }
        : null,
    [account],
  );

  /**
   * One element, rendered into whichever header is currently visible. Building
   * it twice is how the two copies drift apart in wording or order.
   */
  const tabs = (
    <div style={{ display: "flex", gap: 6 }} role="group" aria-label="Meeting view">
      <button
        className={`btn sm${tab === "notes" ? " primary" : ""}`}
        aria-pressed={tab === "notes"}
        onClick={() => setTab("notes")}
      >
        Notes
      </button>
      <button
        className={`btn sm${tab === "transcript" ? " primary" : ""}`}
        aria-pressed={tab === "transcript"}
        onClick={() => setTab("transcript")}
      >
        Transcript
      </button>
    </div>
  );

  return (
    <div className="screen">
      <header className="screen-head">
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--faint)" }}>
          <Link to="/meetings" className="mono" style={{ color: "inherit", textDecoration: "none" }}>
            Meetings
          </Link>
          <IconChevron size={13} />
        </span>
        <h1>{meeting?.title ?? "Meeting"}</h1>
        {meeting && <StatusChip status={meeting.status} />}
        <span className="sub">
          {meeting?.started_at ? new Date(meeting.started_at).toLocaleString() : "Not started"}
        </span>
        <div className="grow" />
        {meeting && meeting.claim_counts.proposed > 0 && (
          <Link to="/review" className="btn sm">
            {meeting.claim_counts.proposed} to review
          </Link>
        )}
      </header>

      {error && <div className="banner error">{error}</div>}

      {/* Same one-line failure surface the meetings list shows: which stage
          died, and the reason the worker recorded. */}
      {meeting?.status === "failed" && meeting.failure_reason && (
        <div className="banner error">
          <strong>{meeting.failed_stage ?? "failed"}</strong> — {meeting.failure_reason}
        </div>
      )}

      <div className="panes">
        <div className="pane doc">
          {/* Hidden rather than unmounted, so that switching to the recording
              does not tear down the collaborative session and rebuild it. */}
          <div
            style={{
              display: tab === "notes" ? "flex" : "none",
              flexDirection: "column",
              flex: 1,
              minHeight: 0,
            }}
          >
          {/* Held back until the identity is known: the caret's label and colour
              are fixed when the editor is constructed, so mounting early would
              put an anonymous cursor in front of everyone else in the room. */}
          {user ? (
            <NotesEditor meetingId={id} user={user} head={tabs} />
          ) : (
            <>
              <div className="pane-head">
                {tabs}
                <div className="grow" />
              </div>
              {session.isPending ? (
                <div className="pane-body">
                  <div className="skeleton" />
                  <div className="skeleton" />
                </div>
              ) : (
                // The collab socket authenticates on the upgrade, so without a
                // session it is refused rather than opened read-only. Rendering
                // an editor that cannot save is the one thing this screen must
                // not do.
                <div className="empty">
                  <h3>Notes are unavailable</h3>
                  <p>{session.error ? authErrorMessage(session.error) : "Sign in to open the shared document."}</p>
                </div>
              )}
            </>
          )}
          </div>

          {playerMounted && (
            <div
              style={{
                display: tab === "transcript" ? "flex" : "none",
                flexDirection: "column",
                flex: 1,
                minHeight: 0,
              }}
            >
              <div className="pane-head">
                {tabs}
                <div className="grow" />
                {meeting?.transcript?.segmentCount != null && (
                  <span className="mono">{meeting.transcript.segmentCount} segments</span>
                )}
              </div>
              {/* The player and the transcript are one component on purpose:
                  the highlighted turn has to be the turn you are hearing. */}
              <RecordingPlayer
                meetingId={id}
                initialPositionMs={arrival.startMs}
                focusSegmentId={arrival.segmentId}
              />
            </div>
          )}
        </div>

        <div className="pane list" style={{ width: 392 }}>
          <AgendaPanel meetingId={id} members={members} />
          <ActionItemsPanel meetingId={id} members={members} />
        </div>
      </div>
    </div>
  );
}
