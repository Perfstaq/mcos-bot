import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError } from "../api.js";
import type { WorkspaceMember } from "./AgendaPanel.js";
import {
  ACTION_STATUS_LABEL,
  ACTION_STATUS_ORDER,
  DueInput,
  isOverdue,
  overdueLabel,
  type ActionItemStatus,
} from "./ActionItemsPanel.js";
import { IconQuote } from "./Icons.js";

/**
 * One line of somebody's plan.
 *
 * The row is deliberately dumb: it renders and it emits patches. Every list
 * that shows action items owns the optimistic update and the rollback itself,
 * because the rollback needs the whole list — an item that fails to move has to
 * go back where it was, and only the list knows where that was.
 */

/**
 * The shape `serializeItem` in apps/api/src/routes/action-items-v2.ts returns.
 *
 * Spelled out rather than derived from the older panel's `ActionItem`: the v2
 * serialiser carries the suggestion fields and, more importantly, the *text* of
 * the cited transcript line. It stays structurally compatible with the older
 * type so the controls that already exist (`DueInput`, `isOverdue`) work on it
 * unchanged.
 */
export type CitedSource = {
  segment_id: string;
  idx: number;
  speaker: string;
  start_ms: number;
  text: string;
};

export type ActionItemV2 = {
  id: string;
  meeting_id: string | null;
  title: string;
  description: string | null;
  status: ActionItemStatus;
  due_at: string | null;
  origin: "manual" | "ai_suggested";
  group_name: string | null;
  /** `group_name` with null resolved to the inbox sentinel, by the server. */
  group_key: string;
  accepted_at: string | null;
  dismissed_at: string | null;
  /** True only for the undecided-suggestion state, so no screen re-derives it. */
  pending: boolean;
  assignee_user_id: string | null;
  assignee: { id: string; name: string; email: string } | null;
  created_by_user_id: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  meeting: { id: string; title: string | null; started_at: string | null } | null;
  source: CitedSource | null;
};

/** The four fields PATCH /action-items/:id accepts. Anything else about an item
 *  is a statement about the meeting, not about the plan. */
export type ActionItemPatch = {
  status?: ActionItemStatus;
  assignee_user_id?: string | null;
  due_at?: string | null;
  group_name?: string | null;
};

/** The API's sentinel for "no group". A query string cannot carry null. */
export const INBOX_KEY = "inbox";

/** One datalist serves the whole screen; a copy per row would be a few thousand
 *  option nodes for a list of two hundred items. */
export const GROUP_DATALIST_ID = "action-item-group-names";

/**
 * A 404 because the route is not mounted, rather than because the record is
 * gone.
 *
 * These are the same status code and read identically to a user, and telling
 * somebody "not found" for a screen that is simply not wired up yet sends them
 * hunting for the wrong problem. The API's not-found handler is the only thing
 * that phrases a 404 this way (see `setNotFoundHandler` in src/http.ts), which
 * is what makes it distinguishable at all.
 */
export function isRouteMissing(error: unknown): boolean {
  return (
    error instanceof ApiError && error.status === 404 && error.message.startsWith("No route for")
  );
}

export function ActionItemRow({
  item,
  members,
  disabled,
  onPatch,
}: {
  item: ActionItemV2;
  members: WorkspaceMember[];
  disabled: boolean;
  onPatch: (patch: ActionItemPatch) => void;
}) {
  const overdue = isOverdue(item);
  const closed = item.status === "done" || item.status === "cancelled";

  return (
    <div
      className="row"
      style={{
        cursor: "default",
        borderLeftColor: overdue ? "var(--red)" : "transparent",
        background: overdue ? "var(--red-soft)" : undefined,
        opacity: item.status === "cancelled" ? 0.55 : 1,
      }}
    >
      <div className="row-top" style={{ alignItems: "flex-start" }}>
        <input
          type="checkbox"
          aria-label={`Mark "${item.title}" done`}
          checked={item.status === "done"}
          disabled={disabled}
          onChange={(e) => onPatch({ status: e.target.checked ? "done" : "open" })}
          style={{ flex: "none", marginTop: 2, accentColor: "var(--orange)", cursor: "pointer" }}
        />
        <span
          className="grow"
          style={{
            fontSize: 14,
            fontWeight: 600,
            lineHeight: 1.35,
            textDecoration: item.status === "done" ? "line-through" : "none",
            color: closed ? "var(--faint)" : "var(--ink)",
          }}
        >
          {item.title}
        </span>
        {overdue && <span className="chip error">{overdueLabel(item.due_at)}</span>}
      </div>

      {item.description && (
        <div className="row-text" style={{ paddingLeft: INDENT }}>
          {item.description}
        </div>
      )}

      {/* Provenance travels with the item. The first argument about an action
          item is always whether it was ever agreed, and the answer is these
          words rather than the fact that a model produced them. */}
      {item.source && (
        <div
          className="mono"
          style={{
            paddingLeft: INDENT,
            marginTop: 4,
            color: "var(--faint)",
            display: "flex",
            gap: 5,
            alignItems: "baseline",
          }}
        >
          <IconQuote size={11} />
          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {item.source.speaker} at {clock(item.source.start_ms)} — “{item.source.text}”
          </span>
        </div>
      )}

      <div
        className="row-meta"
        style={{ paddingLeft: INDENT, alignItems: "center", flexWrap: "wrap", rowGap: 6 }}
      >
        <select
          className="select"
          aria-label="Assignee"
          style={SMALL_CONTROL}
          value={item.assignee_user_id ?? ""}
          disabled={disabled}
          onChange={(e) => onPatch({ assignee_user_id: e.target.value || null })}
        >
          <option value="">Unassigned</option>
          {/* An assignee who has since left the workspace is not in `members`,
              and a select whose value matches no option renders blank — which
              reads as "nobody" rather than as "someone who is gone". */}
          {item.assignee && !members.some((m) => m.user_id === item.assignee_user_id) && (
            <option value={item.assignee.id}>{item.assignee.name} (former member)</option>
          )}
          {members.map((member) => (
            <option key={member.user_id} value={member.user_id}>
              {member.name}
            </option>
          ))}
        </select>

        <DueInput item={item} onChange={(due_at) => onPatch({ due_at })} />

        <GroupInput
          value={item.group_name}
          disabled={disabled}
          onCommit={(group_name) => onPatch({ group_name })}
        />

        {/* Redundant with the checkbox for the common case, and kept anyway:
            `in_progress` and `cancelled` are real states, and a checkbox that
            silently collapsed them into done/not-done would misreport the row
            it is sitting on. */}
        <select
          className="select"
          aria-label="Status"
          style={SMALL_CONTROL}
          value={item.status}
          disabled={disabled}
          onChange={(e) => onPatch({ status: e.target.value as ActionItemStatus })}
        >
          {ACTION_STATUS_ORDER.map((status) => (
            <option key={status} value={status}>
              {ACTION_STATUS_LABEL[status]}
            </option>
          ))}
        </select>

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
      </div>
    </div>
  );
}

/**
 * The group is free text with suggestions, not a fixed list.
 *
 * `groupName` is a free-text column on purpose, so the control has to let
 * somebody name a bucket that does not exist yet — a select could only ever
 * offer the groups that already have items in them, which makes the first item
 * in a new group impossible to file. The datalist gives the existing names
 * without closing the set.
 *
 * It commits on blur rather than on change because every commit is a PATCH, and
 * a request per keystroke would mean a dozen half-typed group names racing each
 * other to be the final value.
 */
function GroupInput({
  value,
  disabled,
  onCommit,
}: {
  value: string | null;
  disabled: boolean;
  onCommit: (group: string | null) => void;
}) {
  const [draft, setDraft] = useState(value ?? "");

  // A failed patch rolls the item back in the list above, and the input has to
  // follow it or the row shows a group it does not have.
  useEffect(() => setDraft(value ?? ""), [value]);

  const commit = () => {
    const next = draft.trim() || null;
    if (next === value) return;
    onCommit(next);
  };

  return (
    <input
      className="input"
      aria-label="Group"
      list={GROUP_DATALIST_ID}
      placeholder="Inbox"
      style={{ ...SMALL_CONTROL, width: 132 }}
      value={draft}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") setDraft(value ?? "");
      }}
    />
  );
}

/* ---------------------------------------------------------------------- */

export function clock(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${`${total % 60}`.padStart(2, "0")}`;
}

/** Lines up the metadata under the title rather than under the checkbox. */
const INDENT = 22;

const SMALL_CONTROL: React.CSSProperties = {
  padding: "2px 6px",
  fontSize: 11,
  fontWeight: 500,
  width: "auto",
};
