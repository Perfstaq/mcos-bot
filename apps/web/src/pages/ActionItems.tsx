import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api.js";
import { useSession } from "../auth-client.js";
import type { WorkspaceMember } from "../components/AgendaPanel.js";
import { isOverdue } from "../components/ActionItemsPanel.js";
import {
  ActionItemRow,
  GROUP_DATALIST_ID,
  INBOX_KEY,
  isRouteMissing,
  type ActionItemPatch,
  type ActionItemV2,
} from "../components/ActionItemRow.js";
import { SuggestionsPanel } from "../components/SuggestionsPanel.js";
import { IconPlus } from "../components/Icons.js";

/**
 * Everything the workspace's meetings have committed people to.
 *
 * Two questions, and they are different enough to be tabs rather than a filter:
 * "what am I on the hook for" is a plan, and "what did I hand to somebody else"
 * is a follow-up list. The API draws the same line — `scope=mine` against
 * `scope=assigned_by_me` — and deliberately refuses to be pointed at an
 * arbitrary person, so this screen has no way to ask one either.
 *
 * Within a tab the grouping is the user's own: `groupName` is free text, null
 * means the inbox, and the named buckets are whatever people have called them.
 * Nothing here sorts by meeting. The meeting is how a commitment came about and
 * is kept as a link on every row, but nobody plans their week by meeting.
 */

const SCOPES = ["mine", "assigned_by_me"] as const;
type Scope = (typeof SCOPES)[number];

const SCOPE_LABEL: Record<Scope, string> = {
  mine: "My items",
  assigned_by_me: "Assigned to others",
};

type GroupCount = { group_name: string | null; key: string; count: number };

export function ActionItems() {
  const session = useSession();
  const [scope, setScope] = useState<Scope>("mine");
  const [selected, setSelected] = useState<string | null>(null);
  const [items, setItems] = useState<ActionItemV2[] | null>(null);
  const [groups, setGroups] = useState<GroupCount[]>([]);
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [showClosed, setShowClosed] = useState(false);
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [listMissing, setListMissing] = useState(false);
  const [createMissing, setCreateMissing] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ scope?: Scope; action_items: ActionItemV2[] }>(
        `/action-items?scope=${scope}&limit=200`,
      );
      // The older /action-items route answers on the same path and knows
      // nothing about `scope` — zod strips it and returns the caller's own
      // items whichever tab is selected. Silently showing "my items" under
      // "assigned to others" is worse than saying so.
      setStale(data.scope !== scope);
      setItems(data.action_items);
      setListMissing(false);
      setError(null);
    } catch (e) {
      setItems([]);
      if (isRouteMissing(e)) {
        setListMissing(true);
        return;
      }
      setError((e as Error).message);
    }
  }, [scope]);

  const loadGroups = useCallback(async () => {
    try {
      const data = await api.get<{ groups: GroupCount[] }>(`/action-items/groups?scope=${scope}`);
      setGroups(data.groups);
    } catch {
      // The rail is a convenience over a list this screen already holds. When
      // the counts endpoint is not there, the sections below still render from
      // the items themselves — a missing rail is not worth an error banner.
      setGroups([]);
    }
  }, [scope]);

  useEffect(() => {
    void load();
    void loadGroups();
  }, [load, loadGroups]);

  useEffect(() => {
    void (async () => {
      try {
        const data = await api.get<{ members: WorkspaceMember[] }>("/workspace/members");
        setMembers(data.members);
      } catch {
        // Without the roster the assignee selects offer only "Unassigned",
        // which is a degraded row rather than a broken screen.
        setMembers([]);
      }
    })();
  }, []);

  /**
   * Status, assignee, due date and group all move before the server agrees, and
   * exactly one row snaps back when it does not.
   *
   * The rollback unit is the row rather than the list: somebody ticking through
   * a backlog will have three patches in flight at once, and restoring a
   * whole-list snapshot would silently undo the two that succeeded. The
   * server's row replaces the optimistic guess rather than merging into it,
   * because `completedAt` is derived — the item is only true once the server
   * has spoken.
   */
  const patch = (item: ActionItemV2, body: ActionItemPatch) => {
    if (!items || saving[item.id]) return;
    const before = item;
    setItems(items.map((i) => (i.id === item.id ? { ...i, ...body } : i)));
    setSaving((current) => ({ ...current, [item.id]: true }));

    void (async () => {
      try {
        const { item: saved } = await api.patch<{ item: ActionItemV2 }>(
          `/action-items/${item.id}`,
          body,
        );
        setItems((current) => (current ?? []).map((i) => (i.id === item.id ? saved : i)));
        setError(null);
        if (body.group_name !== undefined) void loadGroups();
      } catch (e) {
        setItems((current) => (current ?? []).map((i) => (i.id === item.id ? before : i)));
        setError(
          isRouteMissing(e)
            ? "Nothing saved — PATCH /action-items/:id is not mounted in this build."
            : `Could not save “${item.title}”: ${(e as Error).message}`,
        );
      } finally {
        setSaving((current) => {
          const next = { ...current };
          delete next[item.id];
          return next;
        });
      }
    })();
  };

  /**
   * Created against the server rather than optimistically, unlike every other
   * write on this screen. A new item may or may not match the tab and group
   * that is showing — it depends on who it was assigned to — and a row that
   * appears and then vanishes on the next load is worse than a moment's wait.
   */
  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    const text = title.trim();
    if (!text || creating) return;

    setCreating(true);
    try {
      await api.post("/action-items", {
        title: text,
        // Filing into the bucket you are looking at: creating an item while
        // "Top priority" is selected and having it land in the inbox is the
        // kind of small lie that makes people stop trusting the grouping.
        group_name: selected === null || selected === INBOX_KEY ? null : selected,
        // "My items" means assigned to me. Creating one here and having it not
        // appear would read as a failure.
        ...(scope === "mine" && session.data?.user.id
          ? { assignee_user_id: session.data.user.id }
          : {}),
      });
      setTitle("");
      setCreateMissing(false);
      setError(null);
      await Promise.all([load(), loadGroups()]);
    } catch (e) {
      if (isRouteMissing(e)) {
        setCreateMissing(true);
      } else {
        setError((e as Error).message);
      }
    } finally {
      setCreating(false);
    }
  };

  const live = (items ?? []).filter((i) => i.status === "open" || i.status === "in_progress");
  const late = live.filter((i) => isOverdue(i)).length;

  const visible = useMemo(
    () =>
      (items ?? []).filter(
        (item) =>
          (showClosed || item.status === "open" || item.status === "in_progress") &&
          (selected === null || item.group_key === selected),
      ),
    [items, showClosed, selected],
  );

  // The rail's counts come from the server, which sees past this screen's
  // 200-item ceiling. Groups only present in the loaded page are folded in so a
  // bucket never appears in the list without appearing in the rail.
  const railGroups = useMemo(() => {
    const counts = new Map<string, GroupCount>();
    for (const group of groups) counts.set(group.key, group);
    for (const item of items ?? []) {
      if (!counts.has(item.group_key)) {
        counts.set(item.group_key, { group_name: item.group_name, key: item.group_key, count: 0 });
      }
    }
    return [...counts.values()].sort(byGroup);
  }, [groups, items]);

  const sections = useMemo(() => {
    const byKey = new Map<string, ActionItemV2[]>();
    for (const item of visible) {
      const bucket = byKey.get(item.group_key);
      if (bucket) bucket.push(item);
      else byKey.set(item.group_key, [item]);
    }
    return [...byKey.entries()]
      .map(([key, bucket]) => ({
        key,
        label: key === INBOX_KEY ? "Inbox" : (bucket[0]?.group_name ?? key),
        items: bucket.sort(byDue),
      }))
      .sort((a, b) => byGroup({ key: a.key }, { key: b.key }));
  }, [visible]);

  const groupNames = railGroups.map((g) => g.group_name).filter((n): n is string => n !== null);

  return (
    <div className="screen">
      <header className="screen-head">
        <h1>Action items</h1>
        <span className="sub">What the meetings put on somebody</span>

        {SCOPES.map((value) => (
          <button
            key={value}
            className={`btn sm${scope === value ? " primary" : ""}`}
            onClick={() => {
              setScope(value);
              setSelected(null);
              setItems(null);
            }}
          >
            {SCOPE_LABEL[value]}
          </button>
        ))}

        <div className="grow" />
        {items && (
          <span className="mono" style={{ color: late > 0 ? "var(--red)" : "var(--faint)" }}>
            {live.length} open{late > 0 ? ` · ${late} overdue` : ""}
          </span>
        )}
      </header>

      <div className="panes">
        <nav className="pane rail-types">
          <div className="pane-head">Group</div>
          <div className="pane-body scroll">
            <button
              className={`type-item${selected === null ? " active" : ""}`}
              onClick={() => setSelected(null)}
            >
              <span className="grow">Everything</span>
              <span className="n">{items?.length ?? 0}</span>
            </button>

            {railGroups.map((group) => (
              <button
                key={group.key}
                className={`type-item${selected === group.key ? " active" : ""}`}
                onClick={() => setSelected(group.key)}
              >
                <span className="grow">{group.group_name ?? "Inbox"}</span>
                <span className="n">{group.count}</span>
              </button>
            ))}
          </div>
        </nav>

        <div className="pane doc">
          <div className="pane-head">
            <span className="grow">
              {SCOPE_LABEL[scope]}
              {selected !== null && ` — ${selected === INBOX_KEY ? "Inbox" : selected}`}
            </span>
            <button className="btn sm" onClick={() => setShowClosed((v) => !v)}>
              {showClosed ? "Hide closed" : "Show closed"}
            </button>
          </div>

          <form className="compose" onSubmit={create}>
            <input
              className="input"
              placeholder={
                selected === null || selected === INBOX_KEY
                  ? "Add an action item"
                  : `Add to ${selected}`
              }
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={creating}
            />
            <button className="btn sm" type="submit" disabled={creating || !title.trim()}>
              <IconPlus />
            </button>
          </form>

          {createMissing && (
            <div className="banner info">
              Creating an item outside a meeting needs <span className="mono">POST
              /action-items</span>, which this build does not serve. Items can still be
              added from a meeting's workspace.
            </div>
          )}
          {stale && (
            <div className="banner info">
              The API answering <span className="mono">/action-items</span> does not
              understand tabs, so both show the same list.
            </div>
          )}
          {error && <div className="banner error">{error}</div>}

          <div className="pane-body scroll">
            {/* Above the list on purpose. A proposal that has not been decided
                on is the most perishable thing on this screen, and burying it
                under committed work is how a review gate stops being one. */}
            <SuggestionsPanel
              members={members}
              onDecided={() => {
                void load();
                void loadGroups();
              }}
            />

            {items === null && (
              <div style={{ padding: 14 }}>
                <div className="skeleton" />
                <div className="skeleton" />
                <div className="skeleton" />
              </div>
            )}

            {listMissing && (
              <div className="empty" style={{ marginTop: 40 }}>
                <h3>Action items are not wired up</h3>
                <p>
                  This build does not serve <span className="mono">GET /action-items</span>.
                  Nothing is lost — the route just is not mounted yet.
                </p>
              </div>
            )}

            {!listMissing && items !== null && sections.length === 0 && (
              <div className="empty" style={{ marginTop: 40 }}>
                <h3>{scope === "mine" ? "Nothing on you" : "You have not assigned anything"}</h3>
                <p>
                  {scope === "mine"
                    ? "Items land here when someone assigns you one, or when you accept a suggestion above."
                    : "Work you hand to somebody else shows up here so you can follow it up without asking them."}
                </p>
              </div>
            )}

            {sections.map((section) => (
              <div key={section.key}>
                <div
                  className="pane-head"
                  style={{ position: "sticky", top: 0, background: "var(--pane)", zIndex: 1 }}
                >
                  <span className="grow">{section.label}</span>
                  <span className="mono">{section.items.length}</span>
                </div>

                {section.items.map((item) => (
                  <ActionItemRow
                    key={item.id}
                    item={item}
                    members={members}
                    disabled={saving[item.id] ?? false}
                    onPatch={(body) => patch(item, body)}
                  />
                ))}
              </div>
            ))}
          </div>

          {/* One list for every group control on the screen. */}
          <datalist id={GROUP_DATALIST_ID}>
            {groupNames.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------- */

/** The inbox is where unfiled work sits, so it leads; named buckets follow in
 *  the order a person would look for them. */
function byGroup(a: { key: string }, b: { key: string }): number {
  if (a.key === INBOX_KEY) return b.key === INBOX_KEY ? 0 : -1;
  if (b.key === INBOX_KEY) return 1;
  return a.key.localeCompare(b.key);
}

/** Overdue first, then by date, then undated. Within a group the question is
 *  always "what is late and what is next". */
function byDue(a: ActionItemV2, b: ActionItemV2): number {
  if (a.due_at && b.due_at) return Date.parse(a.due_at) - Date.parse(b.due_at);
  if (a.due_at) return -1;
  if (b.due_at) return 1;
  return Date.parse(a.created_at) - Date.parse(b.created_at);
}
