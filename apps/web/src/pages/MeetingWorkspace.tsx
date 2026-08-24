import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type MeetingDetail } from "../api.js";
import { authErrorMessage, useSession } from "../auth-client.js";
import { AgendaPanel, type WorkspaceMember } from "../components/AgendaPanel.js";
import { ActionItemsPanel } from "../components/ActionItemsPanel.js";
import { NotesEditor, caretColor, type NotesUser } from "../components/NotesEditor.js";
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
 */
export function MeetingWorkspace() {
  const { id = "" } = useParams<{ id: string }>();
  const session = useSession();
  const [meeting, setMeeting] = useState<MeetingDetail | null>(null);
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [error, setError] = useState<string | null>(null);

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

      <div className="panes">
        <div className="pane doc">
          {/* Held back until the identity is known: the caret's label and colour
              are fixed when the editor is constructed, so mounting early would
              put an anonymous cursor in front of everyone else in the room. */}
          {user ? (
            <NotesEditor meetingId={id} user={user} />
          ) : (
            <>
              <div className="pane-head">
                <span className="grow">Notes</span>
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

        <div className="pane list" style={{ width: 392 }}>
          <AgendaPanel meetingId={id} members={members} />
          <ActionItemsPanel meetingId={id} members={members} />
        </div>
      </div>
    </div>
  );
}
