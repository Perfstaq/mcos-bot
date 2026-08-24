import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.js";
import {
  DueInput,
  StatusSelect,
  isOverdue,
  overdueLabel,
  type ActionItem,
} from "../components/ActionItemsPanel.js";
import { IconQuote } from "../components/Icons.js";

/**
 * Everything one person is on the hook for, across every meeting.
 *
 * Grouped by when it is due rather than by which meeting produced it. The
 * meeting is how the commitment came about and is kept as a link, but nobody
 * plans their week by meeting — the question this screen answers is "what is
 * late and what is next", and any other grouping buries it.
 *
 * The list deliberately spans meetings the reader may not otherwise be able to
 * open: the API does not re-filter an assignee's own items by meeting
 * visibility, because assigning someone an item *was* the decision to tell them
 * about it (see apps/api/src/routes/action-items.ts).
 */

type InboxItem = ActionItem & {
  meeting: { id: string; title: string | null; started_at: string | null } | null;
};

type BucketKey = "overdue" | "today" | "tomorrow" | "week" | "later" | "none" | "closed";

const BUCKET_ORDER: BucketKey[] = ["overdue", "today", "tomorrow", "week", "later", "none", "closed"];

const BUCKET_LABEL: Record<BucketKey, string> = {
  overdue: "Overdue",
  today: "Today",
  tomorrow: "Tomorrow",
  week: "This week",
  later: "Later",
  none: "No due date",
  closed: "Closed",
};

export function MyActionItems() {
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      // No `assignee_user_id`: the API defaults to the caller, and asking for
      // somebody else's list needs the admin role. Letting the server decide
      // who "me" is means this screen never has to learn a user id first.
      const data = await api.get<{ assignee_user_id: string; action_items: InboxItem[] }>(
        "/action-items?limit=200",
      );
      setItems(data.action_items);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = (item: InboxItem, body: Partial<ActionItem>) => {
    if (!items) return;
    const before = items;
    setItems(items.map((i) => (i.id === item.id ? { ...i, ...body } : i)));

    void (async () => {
      try {
        const { item: saved } = await api.patch<{ item: ActionItem }>(
          `/action-items/${item.id}`,
          body,
        );
        setItems((current) =>
          (current ?? []).map((i) => (i.id === item.id ? { ...saved, meeting: i.meeting } : i)),
        );
        setError(null);
      } catch (e) {
        setItems(before);
        setError((e as Error).message);
      }
    })();
  };

  const visible = (items ?? []).filter((item) => showClosed || isLive(item));
  const groups = BUCKET_ORDER.map((key) => ({
    key,
    items: visible.filter((item) => bucketOf(item) === key).sort(byDue),
  })).filter((group) => group.items.length > 0);

  const late = (items ?? []).filter((item) => isOverdue(item)).length;
  const open = (items ?? []).filter(isLive).length;

  return (
    <div className="screen">
      <header className="screen-head">
        <h1>My action items</h1>
        <span className="sub">What this workspace's meetings put on you</span>
        <div className="grow" />
        {items && (
          <span className="mono" style={{ color: late > 0 ? "var(--red)" : "var(--faint)" }}>
            {open} open{late > 0 ? ` · ${late} overdue` : ""}
          </span>
        )}
      </header>

      <div className="panes">
        <div className="pane doc">
          <div className="pane-head">
            <span className="grow">{showClosed ? "Everything" : "Open work"}</span>
            <button className="btn sm" onClick={() => setShowClosed((v) => !v)}>
              {showClosed ? "Hide closed" : "Show closed"}
            </button>
          </div>

          {error && <div className="banner error">{error}</div>}

          <div className="pane-body scroll">
            {items === null && (
              <>
                <div className="skeleton" />
                <div className="skeleton" />
                <div className="skeleton" />
              </>
            )}

            {items?.length === 0 && (
              <div className="empty" style={{ marginTop: 40 }}>
                <h3>Nothing assigned to you</h3>
                <p>Action items land here when someone assigns you one in a meeting workspace.</p>
              </div>
            )}

            {items !== null && items.length > 0 && groups.length === 0 && (
              <div className="empty" style={{ marginTop: 40 }}>
                <h3>All clear</h3>
                <p>Everything assigned to you is done or cancelled. Show closed to see it.</p>
              </div>
            )}

            <div className="detail-body" style={{ maxWidth: 820 }}>
              {groups.map((group) => (
                <div className="section" key={group.key}>
                  <h3 style={group.key === "overdue" ? { color: "var(--red)" } : undefined}>
                    {BUCKET_LABEL[group.key]} <span className="mono">{group.items.length}</span>
                  </h3>

                  {group.items.map((item) => {
                    const overdue = isOverdue(item);
                    return (
                      <div
                        key={item.id}
                        className="row"
                        style={{
                          cursor: "default",
                          borderLeftColor: overdue ? "var(--red)" : "transparent",
                          opacity: isLive(item) ? 1 : 0.55,
                        }}
                      >
                        <div className="row-top">
                          <span
                            className="grow"
                            style={{
                              fontSize: 14,
                              fontWeight: 600,
                              textDecoration: item.status === "done" ? "line-through" : "none",
                            }}
                          >
                            {item.title}
                          </span>
                          {overdue && <span className="chip error">{overdueLabel(item.due_at)}</span>}
                        </div>

                        {item.description && <div className="row-text">{item.description}</div>}

                        <div className="row-meta" style={{ alignItems: "center", flexWrap: "wrap" }}>
                          <StatusSelect item={item} onChange={(status) => patch(item, { status })} />
                          <DueInput item={item} onChange={(due_at) => patch(item, { due_at })} />

                          {item.meeting ? (
                            <Link
                              to={`/meetings/${item.meeting.id}/workspace`}
                              className="mono"
                              style={{ color: "var(--muted)" }}
                            >
                              {item.meeting.title ?? "Untitled meeting"}
                            </Link>
                          ) : (
                            <span className="mono">No meeting</span>
                          )}

                          {item.source && (
                            <span className="mono" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                              <IconQuote size={11} />
                              {item.source.speaker}
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------- */

function isLive(item: ActionItem): boolean {
  return item.status === "open" || item.status === "in_progress";
}

function bucketOf(item: InboxItem): BucketKey {
  if (!isLive(item)) return "closed";
  if (!item.due_at) return "none";
  if (isOverdue(item)) return "overdue";

  const days = calendarDaysAway(item.due_at);
  if (days <= 0) return "today";
  if (days === 1) return "tomorrow";
  if (days <= 7) return "week";
  return "later";
}

/**
 * Whole days between today and a due date, counted on the calendar rather than
 * by dividing a duration: a week containing a daylight-saving change is 167 or
 * 169 hours long, and "in 7 days" would drift by one bucket twice a year.
 * Projecting both dates onto UTC midnight makes the subtraction exact.
 */
function calendarDaysAway(iso: string): number {
  const due = new Date(iso);
  const now = new Date();
  const a = Date.UTC(due.getFullYear(), due.getMonth(), due.getDate());
  const b = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((a - b) / 86_400_000);
}

/** Undated work sorts last within its group; everything else by when it is due. */
function byDue(a: InboxItem, b: InboxItem): number {
  if (a.due_at && b.due_at) return Date.parse(a.due_at) - Date.parse(b.due_at);
  if (a.due_at) return -1;
  if (b.due_at) return 1;
  return Date.parse(a.created_at) - Date.parse(b.created_at);
}
