import { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";
import { IconCheck, IconPlus, IconTrash } from "../components/Icons.js";

/**
 * The agenda: the part of a meeting's preparation that is not prose.
 *
 * Order is the whole point of this panel, and order is shared mutable state —
 * two people dragging at once is the normal case, not the edge case. The server
 * takes a complete list of ids rather than a delta and refuses one that no
 * longer matches what it holds (see apps/api/src/routes/agenda.ts), so a stale
 * drag here comes back as a 409 and is reported, never silently applied on top
 * of somebody else's rearrangement.
 */

export type AgendaItem = {
  id: string;
  meeting_id: string;
  position: number;
  title: string;
  description: string | null;
  duration_mins: number | null;
  completed: boolean;
  owner_user_id: string | null;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * A person who can own an agenda item or be assigned an action item.
 *
 * Shaped by `GET /api/v1/workspace/members`. It lives here rather than in
 * api.ts only because api.ts is the integrator's file this round — that is
 * where it belongs, next to the other response types.
 */
export type WorkspaceMember = {
  member_id: string;
  user_id: string;
  name: string;
  email: string;
  image: string | null;
  role: string;
  joined_at: string;
};

/** Local-only rows carry this prefix until the server hands back a real id. */
const PENDING = "pending:";

export function AgendaPanel({
  meetingId,
  members,
}: {
  meetingId: string;
  members: WorkspaceMember[];
}) {
  const [items, setItems] = useState<AgendaItem[] | null>(null);
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ agenda: AgendaItem[] }>(`/meetings/${meetingId}/agenda`);
      setItems(data.agenda);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [meetingId]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Every write in this panel is the same shape: show the result immediately,
   * let the server correct it, and put the old list back when it refuses.
   * Rolling back to a captured snapshot rather than reloading keeps a failed
   * edit from also discarding an unrelated one made a second earlier.
   */
  const optimistic = useCallback(
    async (next: AgendaItem[], commit: () => Promise<AgendaItem[] | null>) => {
      const before = items;
      setItems(next);
      try {
        const settled = await commit();
        if (settled) setItems(settled);
        setError(null);
      } catch (e) {
        setItems(before);
        setError((e as Error).message);
      }
    },
    [items],
  );

  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    const text = title.trim();
    if (!text || !items) return;

    const draft: AgendaItem = {
      id: `${PENDING}${Date.now()}`,
      meeting_id: meetingId,
      position: items.length,
      title: text,
      description: null,
      duration_mins: null,
      completed: false,
      owner_user_id: null,
      created_by_user_id: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    setTitle("");

    const before = items;
    setItems([...items, draft]);
    try {
      const created = await api.post<{ item: AgendaItem }>(`/meetings/${meetingId}/agenda`, {
        title: text,
      });
      setItems((current) => (current ?? []).map((i) => (i.id === draft.id ? created.item : i)));
      setError(null);
    } catch (e) {
      setItems(before);
      // Hand the text back rather than making them retype it — a rejected add
      // is usually a permission problem the user can do nothing about, and
      // losing their sentence on top of that is gratuitous.
      setTitle(text);
      setError((e as Error).message);
    }
  };

  const patch = (item: AgendaItem, body: Partial<AgendaItem>) => {
    if (item.id.startsWith(PENDING) || !items) return;
    const next = items.map((i) => (i.id === item.id ? { ...i, ...body } : i));
    void optimistic(next, async () => {
      const { item: saved } = await api.patch<{ item: AgendaItem }>(`/agenda-items/${item.id}`, body);
      return next.map((i) => (i.id === item.id ? saved : i));
    });
  };

  const remove = (item: AgendaItem) => {
    if (!items) return;
    void optimistic(
      items.filter((i) => i.id !== item.id),
      async () => {
        await api.del(`/agenda-items/${item.id}`);
        // The server compacts positions on delete, so the local list is only
        // right about order, not about `position`. Reread rather than guess.
        const data = await api.get<{ agenda: AgendaItem[] }>(`/meetings/${meetingId}/agenda`);
        return data.agenda;
      },
    );
  };

  const commitOrder = (ids: string[]) => {
    if (!items) return;
    // The reorder route takes the complete set of stored ids and compares it to
    // what it holds. A row still waiting for its id would fail that comparison
    // as a stale-client conflict, which is not what happened and not something
    // reloading would fix — so say the true thing instead.
    if (items.some((i) => i.id.startsWith(PENDING))) {
      setError("Wait for the new item to save before reordering.");
      return;
    }

    const byId = new Map(items.map((i) => [i.id, i]));
    const next = ids.flatMap((id, position) => {
      const item = byId.get(id);
      return item ? [{ ...item, position }] : [];
    });
    void optimistic(next, async () => {
      const data = await api.post<{ agenda: AgendaItem[] }>(
        `/meetings/${meetingId}/agenda/reorder`,
        { item_ids: ids },
      );
      return data.agenda;
    });
  };

  const moveBefore = (fromId: string, toId: string) => {
    if (!items || fromId === toId) return;
    const ids = items.map((i) => i.id);
    const from = ids.indexOf(fromId);
    const to = ids.indexOf(toId);
    if (from < 0 || to < 0) return;

    ids.splice(from, 1);
    // Removing the dragged id shifts everything after it down by one, which is
    // exactly the offset needed to land *after* a target below and *before* a
    // target above. Both cases are the same insert index.
    ids.splice(to, 0, fromId);
    commitOrder(ids);
  };

  const nudge = (item: AgendaItem, delta: number) => {
    if (!items) return;
    const ids = items.map((i) => i.id);
    const from = ids.indexOf(item.id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= ids.length) return;
    ids.splice(from, 1);
    ids.splice(to, 0, item.id);
    commitOrder(ids);
  };

  const planned = (items ?? []).reduce((total, i) => total + (i.duration_mins ?? 0), 0);
  const done = (items ?? []).filter((i) => i.completed).length;

  return (
    <section style={PANEL}>
      <div className="pane-head">
        <span className="grow">Agenda</span>
        {items && items.length > 0 && (
          <span className="mono">
            {done}/{items.length}
            {planned > 0 ? ` · ${planned}m` : ""}
          </span>
        )}
      </div>

      <form className="compose" onSubmit={add}>
        <input
          className="input"
          placeholder="Add an agenda item"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
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
            <h3>No agenda yet</h3>
            <p>Add the points this meeting has to get through. Drag to reorder them.</p>
          </div>
        )}

        <ol style={{ margin: 0, padding: 0, listStyle: "none" }}>
          {items?.map((item, index) => (
            <li
              key={item.id}
              className="row"
              draggable={!item.id.startsWith(PENDING)}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = "move";
                // Firefox ignores a drag that carries no payload.
                e.dataTransfer.setData("text/plain", item.id);
                setDragId(item.id);
              }}
              onDragOver={(e) => {
                if (!dragId || dragId === item.id) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                setOverId(item.id);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragId) moveBefore(dragId, item.id);
                setDragId(null);
                setOverId(null);
              }}
              onDragEnd={() => {
                setDragId(null);
                setOverId(null);
              }}
              style={{
                cursor: "default",
                opacity: dragId === item.id ? 0.4 : 1,
                boxShadow: overId === item.id ? "inset 0 2px 0 var(--orange)" : undefined,
              }}
            >
              <div className="row-top">
                <button
                  className="mono"
                  aria-label={`Reorder ${item.title}`}
                  title="Drag to reorder, or use the arrow keys"
                  onKeyDown={(e) => {
                    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
                    // A drag-only reorder is a reorder some people cannot do.
                    e.preventDefault();
                    nudge(item, e.key === "ArrowDown" ? 1 : -1);
                  }}
                  style={{
                    border: "none",
                    background: "none",
                    color: "var(--faint)",
                    cursor: "grab",
                    padding: 0,
                    width: 16,
                  }}
                >
                  {index + 1}
                </button>

                <button
                  aria-label={item.completed ? "Mark not done" : "Mark done"}
                  onClick={() => patch(item, { completed: !item.completed })}
                  style={{
                    display: "inline-grid",
                    placeItems: "center",
                    width: 16,
                    height: 16,
                    flex: "none",
                    borderRadius: 4,
                    border: `1px solid ${item.completed ? "var(--green)" : "var(--line-strong)"}`,
                    background: item.completed ? "var(--green-soft)" : "var(--pane)",
                    color: "var(--green)",
                    cursor: "pointer",
                    padding: 0,
                  }}
                >
                  {item.completed && <IconCheck size={12} />}
                </button>

                {editing === item.id ? (
                  <input
                    className="input"
                    autoFocus
                    defaultValue={item.title}
                    onBlur={(e) => {
                      const text = e.target.value.trim();
                      setEditing(null);
                      if (text && text !== item.title) patch(item, { title: text });
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur();
                      if (e.key === "Escape") {
                        e.currentTarget.value = item.title;
                        e.currentTarget.blur();
                      }
                    }}
                  />
                ) : (
                  <button
                    className="grow"
                    onClick={() => setEditing(item.id)}
                    style={{
                      border: "none",
                      background: "none",
                      textAlign: "left",
                      cursor: "text",
                      padding: 0,
                      fontSize: 13,
                      fontWeight: 600,
                      color: item.completed ? "var(--faint)" : "var(--ink)",
                      textDecoration: item.completed ? "line-through" : "none",
                    }}
                  >
                    {item.title}
                  </button>
                )}

                <button
                  className="mono"
                  aria-label={`Remove ${item.title}`}
                  onClick={() => remove(item)}
                  style={{ border: "none", background: "none", color: "var(--faint)", cursor: "pointer", padding: 0 }}
                >
                  <IconTrash size={14} />
                </button>
              </div>

              <div className="row-meta" style={{ alignItems: "center" }}>
                <select
                  className="select"
                  style={SMALL_CONTROL}
                  value={item.owner_user_id ?? ""}
                  onChange={(e) => patch(item, { owner_user_id: e.target.value || null })}
                >
                  <option value="">Unowned</option>
                  {members.map((member) => (
                    <option key={member.user_id} value={member.user_id}>
                      {member.name}
                    </option>
                  ))}
                </select>

                <input
                  className="input"
                  type="number"
                  min={0}
                  max={1440}
                  placeholder="min"
                  defaultValue={item.duration_mins ?? ""}
                  onBlur={(e) => {
                    const raw = e.target.value.trim();
                    // Rounded rather than passed through: the API takes whole
                    // minutes, and a "7.5" that comes back as a 400 teaches the
                    // user nothing they can act on.
                    const mins = raw === "" ? null : Math.round(Number(raw));
                    if (mins !== null && !Number.isFinite(mins)) return;
                    if (mins === (item.duration_mins ?? null)) return;
                    patch(item, { duration_mins: mins });
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                  }}
                  style={{ ...SMALL_CONTROL, width: 64 }}
                />
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

/** Stacked panels share the pane's height rather than each taking their own. */
const PANEL: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
  flex: "1 1 50%",
};

const SMALL_CONTROL: React.CSSProperties = {
  padding: "2px 6px",
  fontSize: 11,
  fontWeight: 500,
  width: "auto",
};
