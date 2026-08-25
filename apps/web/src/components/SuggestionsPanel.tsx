import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../api.js";
import type { WorkspaceMember } from "./AgendaPanel.js";
import { dueFromInput, dueToInput } from "./ActionItemsPanel.js";
import { clock, isRouteMissing, type ActionItemV2 } from "./ActionItemRow.js";
import { IconCheck, IconQuote, IconX } from "./Icons.js";

/**
 * What the model thinks somebody agreed to, and the words it thinks so from.
 *
 * A suggestion is a proposal, not a commitment: the API keeps `origin:
 * ai_suggested` with neither `acceptedAt` nor `dismissedAt` out of every
 * working list until a person decides. This panel is the only place that state
 * is visible, which makes it the review gate for work the same way the review
 * queue is the review gate for claims.
 *
 * Because it is a gate, the transcript line is rendered in full, at the top of
 * every suggestion, before the title. Not a tooltip, not a disclosure: a
 * suggestion you cannot check is a suggestion you cannot responsibly accept,
 * and hiding the evidence one interaction away is how a review gate turns into
 * a rubber stamp. A suggestion that arrives with no citation is called out
 * rather than quietly rendered like the rest — that is the one a human should
 * be *more* careful with, not less.
 */

type Draft = { assignee: string; due: string };

export function SuggestionsPanel({
  meetingId,
  members,
  onDecided,
}: {
  /** Narrows the inbox to one meeting. Absent means everything visible. */
  meetingId?: string;
  members: WorkspaceMember[];
  /** Fired after any decision lands, so the lists behind this can catch up. */
  onDecided: () => void;
}) {
  const [suggestions, setSuggestions] = useState<ActionItemV2[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [collapsed, setCollapsed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const query = meetingId ? `?meeting_id=${encodeURIComponent(meetingId)}` : "";
      const data = await api.get<{ suggestions: ActionItemV2[] }>(
        `/action-items/suggestions${query}`,
      );
      setSuggestions(data.suggestions);
      setUnavailable(false);
      setError(null);
    } catch (e) {
      if (isRouteMissing(e)) {
        setSuggestions([]);
        setUnavailable(true);
        return;
      }
      setSuggestions([]);
      setError((e as Error).message);
    }
  }, [meetingId]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Every decision drops the row before the server answers and puts it back if
   * the server refuses. The optimism is worth it here: triage is a rhythm, and
   * a list that pauses on each click is a list people stop working through.
   */
  const decide = async (suggestion: ActionItemV2, verb: "accept" | "dismiss") => {
    if (!suggestions || busy) return;
    const before = suggestions;
    const draft = drafts[suggestion.id];

    setBusy(suggestion.id);
    setSuggestions(suggestions.filter((s) => s.id !== suggestion.id));

    try {
      await api.post(
        `/action-items/suggestions/${suggestion.id}/${verb}`,
        // A draft exists only once the reviewer has touched a control, and it
        // is seeded with what the model proposed — so when there is one, both
        // fields are sent, empty included. Skipping an emptied field would let
        // the server keep an assignee the screen is showing as cleared, which
        // is the one outcome a review gate must never produce.
        verb === "accept" && draft
          ? {
              assignee_user_id: draft.assignee || null,
              due_at: dueFromInput(draft.due),
            }
          : {},
      );
      setError(null);
      onDecided();
    } catch (e) {
      // A 409 means somebody else already decided this one. The row is gone for
      // a good reason, so it stays gone — restoring it would invite a second
      // click on a decision that has already been made.
      if (e instanceof ApiError && e.status === 409) {
        setError(`${(e as Error).message} — somebody else got there first.`);
        onDecided();
      } else {
        setSuggestions(before);
        setError((e as Error).message);
      }
    } finally {
      setBusy(null);
    }
  };

  const decideAll = async (verb: "accept-all" | "dismiss-all") => {
    if (!suggestions || suggestions.length === 0 || busy) return;
    const count = suggestions.length;
    const accepting = verb === "accept-all";

    if (
      !window.confirm(
        accepting
          ? `Accept all ${count} suggestions? Each one becomes work on somebody's list, and the citations are not reviewed again.`
          : `Dismiss all ${count} suggestions? They leave every list and are not offered again.`,
      )
    ) {
      return;
    }

    const before = suggestions;
    setBusy(verb);
    setSuggestions([]);

    try {
      // The ids go with the request rather than letting the server decide what
      // "all" means: the user is agreeing to the rows in front of them, and an
      // unscoped bulk write would also swallow anything that arrived while
      // they were reading.
      const ids = before.map((s) => s.id);
      await api.post(`/action-items/suggestions/${verb}`, {
        ids,
        ...(meetingId ? { meeting_id: meetingId } : {}),
      });
      setError(null);
      onDecided();
    } catch (e) {
      setSuggestions(before);
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  /** Seeded from the suggestion, not from blank: the draft is the whole
   *  intended state, so a reviewer who only changed the date has not thereby
   *  said anything about the assignee. */
  const setDraft = (suggestion: ActionItemV2, patch: Partial<Draft>) =>
    setDrafts((current) => ({
      ...current,
      [suggestion.id]: {
        assignee: suggestion.assignee_user_id ?? "",
        due: dueToInput(suggestion.due_at),
        ...current[suggestion.id],
        ...patch,
      },
    }));

  if (unavailable) {
    return (
      <div className="banner info">
        Suggestions are not available in this build — nothing is proposing action
        items yet. Everything below was put there by a person.
      </div>
    );
  }

  // Nothing pending is the normal, good state, and it needs no furniture: an
  // empty review gate is not a thing to look at.
  if (suggestions !== null && suggestions.length === 0 && !error) return null;

  return (
    <section
      style={{
        margin: "12px 14px 4px",
        border: "1px solid var(--orange-line)",
        borderRadius: "var(--r)",
        background: "var(--orange-soft)",
        overflow: "hidden",
      }}
    >
      <div className="pane-head" style={{ borderBottom: "1px solid var(--orange-line)" }}>
        <span className="grow">
          AI suggestions{suggestions ? ` — ${suggestions.length}` : ""}
        </span>
        {suggestions && suggestions.length > 0 && (
          <>
            <button
              className="btn sm approve"
              disabled={busy !== null}
              onClick={() => void decideAll("accept-all")}
            >
              <IconCheck size={13} /> Accept all
            </button>
            <button
              className="btn sm reject"
              disabled={busy !== null}
              onClick={() => void decideAll("dismiss-all")}
            >
              <IconX size={13} /> Dismiss all
            </button>
          </>
        )}
        <button className="btn sm" onClick={() => setCollapsed((v) => !v)}>
          {collapsed ? "Show" : "Hide"}
        </button>
      </div>

      {error && <div className="banner error">{error}</div>}

      {suggestions === null && <div className="skeleton" style={{ margin: 12 }} />}

      {!collapsed &&
        suggestions?.map((suggestion) => {
          const draft = drafts[suggestion.id];
          const settled = busy === suggestion.id;

          return (
            <article
              key={suggestion.id}
              style={{
                padding: "14px 16px",
                borderTop: "1px solid var(--orange-line)",
                background: "var(--pane)",
                opacity: settled ? 0.5 : 1,
              }}
            >
              <Citation suggestion={suggestion} />

              <div style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.4, margin: "0 0 4px" }}>
                {suggestion.title}
              </div>
              {suggestion.description && (
                <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 6 }}>
                  {suggestion.description}
                </div>
              )}

              <div
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                  flexWrap: "wrap",
                  rowGap: 8,
                  marginTop: 10,
                }}
              >
                {/* Assignee and due date are part of accepting, not a follow-up
                    edit: the accept route takes them, and a suggestion accepted
                    onto nobody's list on no date is work that has been agreed
                    and then lost. */}
                <select
                  className="select"
                  aria-label="Assign to"
                  style={SMALL_CONTROL}
                  value={draft?.assignee ?? suggestion.assignee_user_id ?? ""}
                  disabled={settled}
                  onChange={(e) => setDraft(suggestion, { assignee: e.target.value })}
                >
                  <option value="">Assign to…</option>
                  {members.map((member) => (
                    <option key={member.user_id} value={member.user_id}>
                      {member.name}
                    </option>
                  ))}
                </select>

                <input
                  className="input"
                  type="date"
                  aria-label="Due date"
                  style={{ ...SMALL_CONTROL, width: 128 }}
                  value={draft?.due ?? dueToInput(suggestion.due_at)}
                  disabled={settled}
                  onChange={(e) => setDraft(suggestion, { due: e.target.value })}
                />

                <div style={{ flex: 1 }} />

                <button
                  className="btn sm reject"
                  disabled={busy !== null}
                  onClick={() => void decide(suggestion, "dismiss")}
                >
                  <IconX size={13} /> Dismiss
                </button>
                <button
                  className="btn sm approve"
                  disabled={busy !== null}
                  onClick={() => void decide(suggestion, "accept")}
                >
                  <IconCheck size={13} /> Accept
                </button>
              </div>
            </article>
          );
        })}
    </section>
  );
}

/**
 * The line this suggestion was lifted from, rendered above the suggestion.
 *
 * `.evidence` is the same block the review queue puts in front of a claim, and
 * that is the point — the two gates are the same decision made about different
 * things, so they should not look like different products.
 */
function Citation({ suggestion }: { suggestion: ActionItemV2 }) {
  if (!suggestion.source) {
    return (
      <div
        className="evidence"
        style={{ borderLeftColor: "var(--red)", background: "var(--red-soft)", marginBottom: 12 }}
      >
        <div className="eyebrow mono">
          <IconQuote size={12} /> no transcript line
        </div>
        <div style={{ fontSize: 13, color: "var(--ink)" }}>
          Nothing links this to anything anyone said. Open the meeting and check
          before you put it on someone's list.
        </div>
      </div>
    );
  }

  const { speaker, start_ms, text } = suggestion.source;

  return (
    <div className="evidence" style={{ marginBottom: 12 }}>
      <div className="eyebrow mono">
        <IconQuote size={12} /> transcript · {clock(start_ms)}
      </div>
      <blockquote>“{text}”</blockquote>
      <div className="attribution mono">
        <span className="speaker">{speaker}</span>
        {suggestion.meeting && (
          <Link
            to={`/meetings/${suggestion.meeting.id}/workspace`}
            style={{ color: "var(--muted)" }}
          >
            {suggestion.meeting.title ?? "Untitled meeting"}
          </Link>
        )}
      </div>
    </div>
  );
}

const SMALL_CONTROL: React.CSSProperties = {
  padding: "3px 7px",
  fontSize: 11,
  fontWeight: 500,
  width: "auto",
};
