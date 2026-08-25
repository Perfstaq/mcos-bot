import { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";
import { IconPlus, IconQuote, IconTrash, IconX } from "../components/Icons.js";
import type { WorkspaceMember } from "./AgendaPanel.js";

/**
 * What a meeting produced that somebody still has to do.
 *
 * The rule this panel exists to honour is provenance. An item pulled out of the
 * transcript carries `source_segment_id` back to the words it came from and the
 * citation is shown on the row, because the first argument about an action item
 * is always whether it was ever agreed. The API declares that distinction with
 * an explicit `origin` rather than inferring it from a present segment id, so
 * this form sends it explicitly too — see apps/api/src/routes/action-items.ts.
 */

export type ActionItemStatus = "open" | "in_progress" | "done" | "cancelled";

export type ActionItemSource = {
  segment_id: string;
  idx: number;
  speaker: string;
  start_ms: number;
};

export type ActionItem = {
  id: string;
  meeting_id: string | null;
  title: string;
  description: string | null;
  status: ActionItemStatus;
  due_at: string | null;
  assignee_user_id: string | null;
  created_by_user_id: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  source: ActionItemSource | null;
};

export const ACTION_STATUS_ORDER: ActionItemStatus[] = ["open", "in_progress", "done", "cancelled"];

export const ACTION_STATUS_LABEL: Record<ActionItemStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  done: "Done",
  cancelled: "Cancelled",
};

/** Only work that is still live can be late; a cancelled item is not overdue. */
export function isOverdue(item: ActionItem, now = Date.now()): boolean {
  if (item.status !== "open" && item.status !== "in_progress") return false;
  return item.due_at !== null && Date.parse(item.due_at) < now;
}

type TranscriptSegment = {
  id: string;
  idx: number;
  speaker: string;
  start_ms: number;
  text: string;
  timestamp_label: string;
};

const PENDING = "pending:";

export function ActionItemsPanel({
  meetingId,
  members,
}: {
  meetingId: string;
  members: WorkspaceMember[];
}) {
  const [items, setItems] = useState<ActionItem[] | null>(null);
  const [title, setTitle] = useState("");
  const [cited, setCited] = useState<TranscriptSegment | null>(null);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ action_items: ActionItem[] }>(
        `/meetings/${meetingId}/action-items`,
      );
      setItems(data.action_items);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [meetingId]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    const text = title.trim();
    if (!text || !items) return;

    const draft: ActionItem = {
      id: `${PENDING}${Date.now()}`,
      meeting_id: meetingId,
      title: text,
      description: null,
      status: "open",
      due_at: null,
      assignee_user_id: null,
      created_by_user_id: null,
      completed_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      source: cited
        ? { segment_id: cited.id, idx: cited.idx, speaker: cited.speaker, start_ms: cited.start_ms }
        : null,
    };

    const before = items;
    const citation = cited;
    setItems([draft, ...items]);
    setTitle("");
    setCited(null);

    try {
      const created = await api.post<{ item: ActionItem }>(`/meetings/${meetingId}/action-items`, {
        title: text,
        // `origin` is the caller's claim about where this came from. Sending
        // "transcript" without a segment is refused rather than downgraded,
        // which is the point: a citation that quietly goes missing is worse
        // than one that was never claimed.
        origin: citation ? "transcript" : "manual",
        ...(citation ? { source_segment_id: citation.id } : {}),
      });
      setItems((current) => (current ?? []).map((i) => (i.id === draft.id ? created.item : i)));
      setError(null);
    } catch (e) {
      setItems(before);
      setTitle(text);
      setCited(citation);
      setError((e as Error).message);
    }
  };

  const patch = (item: ActionItem, body: Partial<ActionItem>) => {
    if (item.id.startsWith(PENDING) || !items) return;
    const before = items;
    const next = items.map((i) => (i.id === item.id ? { ...i, ...body } : i));
    setItems(next);

    void (async () => {
      try {
        const { item: saved } = await api.patch<{ item: ActionItem }>(
          `/action-items/${item.id}`,
          body,
        );
        // `completed_at` is derived server-side, so the row only becomes true
        // once the server has spoken. Replacing rather than merging is what
        // keeps the optimistic guess from outliving it.
        setItems((current) => (current ?? []).map((i) => (i.id === item.id ? saved : i)));
        setError(null);
      } catch (e) {
        setItems(before);
        setError((e as Error).message);
      }
    })();
  };

  const remove = (item: ActionItem) => {
    if (!items) return;
    const before = items;
    setItems(items.filter((i) => i.id !== item.id));
    void (async () => {
      try {
        await api.del(`/action-items/${item.id}`);
        setError(null);
      } catch (e) {
        setItems(before);
        setError((e as Error).message);
      }
    })();
  };

  const open = (items ?? []).filter((i) => i.status === "open" || i.status === "in_progress");
  const late = open.filter((i) => isOverdue(i)).length;

  return (
    <section style={PANEL}>
      <div className="pane-head">
        <span className="grow">Action items</span>
        {late > 0 && <span className="chip error">{late} overdue</span>}
        {items && <span className="mono">{open.length} open</span>}
      </div>

      <form className="compose" style={{ flexWrap: "wrap" }} onSubmit={create}>
        {cited && (
          <div
            className="mono"
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "5px 8px",
              borderRadius: "var(--r-sm)",
              background: "var(--orange-soft)",
              color: "var(--muted)",
            }}
          >
            <IconQuote size={12} />
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {cited.speaker} · {cited.timestamp_label}
            </span>
            <button
              type="button"
              aria-label="Drop the citation"
              onClick={() => setCited(null)}
              style={{ border: "none", background: "none", color: "inherit", cursor: "pointer", padding: 0 }}
            >
              <IconX size={12} />
            </button>
          </div>
        )}
        <input
          className="input"
          placeholder="Add an action item"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <button
          className="btn sm"
          type="button"
          title="Cite a line from the transcript"
          onClick={() => setPicking(true)}
        >
          <IconQuote size={14} />
        </button>
        <button className="btn sm" type="submit" disabled={!title.trim()}>
          <IconPlus />
        </button>
      </form>

      {error && <div className="banner error">{error}</div>}

      <div className="pane-body scroll">
        {items === null && (
          <>
            <div className="skeleton" />
            <div className="skeleton" />
          </>
        )}

        {items?.length === 0 && (
          <div className="empty">
            <h3>Nothing to do yet</h3>
            <p>Add what this meeting committed someone to. Cite a transcript line and the item keeps the words it came from.</p>
          </div>
        )}

        {items?.map((item) => {
          const overdue = isOverdue(item);
          return (
            <div
              key={item.id}
              className="row"
              style={{
                cursor: "default",
                borderLeftColor: overdue ? "var(--red)" : "transparent",
                background: overdue ? "var(--red-soft)" : undefined,
                opacity: item.status === "cancelled" ? 0.5 : 1,
              }}
            >
              <div className="row-top">
                <span
                  className="grow"
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    textDecoration: item.status === "done" ? "line-through" : "none",
                    color: item.status === "done" ? "var(--faint)" : "var(--ink)",
                  }}
                >
                  {item.title}
                </span>
                <button
                  aria-label={`Remove ${item.title}`}
                  onClick={() => remove(item)}
                  style={{ border: "none", background: "none", color: "var(--faint)", cursor: "pointer", padding: 0 }}
                >
                  <IconTrash size={14} />
                </button>
              </div>

              {item.source && (
                <div className="mono" style={{ color: "var(--faint)", display: "flex", gap: 5, alignItems: "center" }}>
                  <IconQuote size={11} />
                  from {item.source.speaker} at {clock(item.source.start_ms)}
                </div>
              )}

              <div className="row-meta" style={{ alignItems: "center", flexWrap: "wrap" }}>
                <StatusSelect item={item} onChange={(status) => patch(item, { status })} />

                <select
                  className="select"
                  style={SMALL_CONTROL}
                  value={item.assignee_user_id ?? ""}
                  onChange={(e) => patch(item, { assignee_user_id: e.target.value || null })}
                >
                  <option value="">Unassigned</option>
                  {members.map((member) => (
                    <option key={member.user_id} value={member.user_id}>
                      {member.name}
                    </option>
                  ))}
                </select>

                <DueInput item={item} onChange={(due_at) => patch(item, { due_at })} />

                {overdue && <span className="chip error">{overdueLabel(item.due_at)}</span>}
              </div>
            </div>
          );
        })}
      </div>

      {picking && (
        <SegmentPicker
          meetingId={meetingId}
          onPick={(segment) => {
            setCited(segment);
            // Prefill rather than replace: the line that prompted the item is
            // rarely a well-formed sentence, so it is a starting point the user
            // is expected to edit before saving.
            setTitle((current) => (current.trim() ? current : segment.text.slice(0, 300)));
            setPicking(false);
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------
 * Shared controls — MyActionItems renders the same two.
 * ---------------------------------------------------------------------- */

export function StatusSelect({
  item,
  onChange,
}: {
  item: ActionItem;
  onChange: (status: ActionItemStatus) => void;
}) {
  return (
    <select
      className="select"
      aria-label="Status"
      style={SMALL_CONTROL}
      value={item.status}
      onChange={(e) => onChange(e.target.value as ActionItemStatus)}
    >
      {ACTION_STATUS_ORDER.map((status) => (
        <option key={status} value={status}>
          {ACTION_STATUS_LABEL[status]}
        </option>
      ))}
    </select>
  );
}

export function DueInput({
  item,
  onChange,
}: {
  item: ActionItem;
  onChange: (dueAt: string | null) => void;
}) {
  return (
    <input
      className="input"
      type="date"
      aria-label="Due date"
      style={{ ...SMALL_CONTROL, width: 124 }}
      value={dueToInput(item.due_at)}
      onChange={(e) => onChange(dueFromInput(e.target.value))}
    />
  );
}

/* -------------------------------------------------------------------------
 * Transcript citation
 * ---------------------------------------------------------------------- */

/**
 * Picking the line an action item came from.
 *
 * The whole transcript arrives in one response — the playback route does not
 * paginate, on the reasoning that a two-hour meeting is on the order of 1,500
 * rows — so the filter below is local and instant rather than a search round
 * trip per keystroke.
 */
function SegmentPicker({
  meetingId,
  onPick,
  onClose,
}: {
  meetingId: string;
  onPick: (segment: TranscriptSegment) => void;
  onClose: () => void;
}) {
  const [segments, setSegments] = useState<TranscriptSegment[] | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const data = await api.get<{ transcript: { segments: TranscriptSegment[] } }>(
          `/meetings/${meetingId}/playback`,
        );
        setSegments(data.transcript.segments);
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  }, [meetingId]);

  const needle = query.trim().toLowerCase();
  const shown = (segments ?? []).filter(
    (s) => !needle || s.text.toLowerCase().includes(needle) || s.speaker.toLowerCase().includes(needle),
  );

  return (
    <div className="scrim" onClick={onClose}>
      <div
        className="modal"
        style={{ width: "min(620px, 92vw)", display: "flex", flexDirection: "column", maxHeight: "72vh" }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3>Cite a transcript line</h3>

        <input
          className="input"
          autoFocus
          placeholder="Filter by words or speaker"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        {error && <div className="banner error">{error}</div>}

        <div className="scroll" style={{ marginTop: 12, minHeight: 0 }}>
          {segments === null && !error && <div className="skeleton" />}

          {segments !== null && shown.length === 0 && (
            <div className="empty" style={{ padding: 24 }}>
              <h3>{segments.length === 0 ? "No transcript yet" : "Nothing matches"}</h3>
              <p>
                {segments.length === 0
                  ? "This meeting has not been transcribed, so there is nothing to cite. The item can still be created without one."
                  : "Try fewer words."}
              </p>
            </div>
          )}

          {shown.slice(0, 200).map((segment) => (
            <button
              key={segment.id}
              className="turn"
              style={{ width: "100%", border: "none", background: "none", cursor: "pointer" }}
              onClick={() => onPick(segment)}
            >
              <span className="who">{segment.speaker}</span>
              <span className="said" style={{ textAlign: "left" }}>{segment.text}</span>
              <span className="mono" style={{ color: "var(--faint)" }}>{segment.timestamp_label}</span>
            </button>
          ))}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 14 }}>
          <button className="btn sm" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------
 * Dates
 * ---------------------------------------------------------------------- */

/**
 * A `<input type="date">` speaks local calendar days; the API speaks RFC 3339
 * instants. Anchoring the day at its last minute rather than its first is what
 * stops an item due "today" from being overdue for the whole of today.
 */
export function dueFromInput(value: string): string | null {
  if (!value) return null;
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day, 23, 59, 0, 0).toISOString();
}

export function dueToInput(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function overdueLabel(iso: string | null): string {
  if (!iso) return "overdue";
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  if (days < 1) return "due today";
  if (days === 1) return "1 day late";
  return `${days} days late`;
}

function clock(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${`${total % 60}`.padStart(2, "0")}`;
}

const PANEL: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
  flex: "1 1 50%",
  borderTop: "1px solid var(--line)",
};

const SMALL_CONTROL: React.CSSProperties = {
  padding: "2px 6px",
  fontSize: 11,
  fontWeight: 500,
  width: "auto",
};
