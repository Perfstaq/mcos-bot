import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  api,
  CLAIM_TYPE_LABEL,
  CLAIM_TYPE_ORDER,
  type BulkApproveResult,
  type Claim,
  type ClaimType,
  type ReviewDecision,
} from "../api.js";
import { IconCheck, IconPencil, IconQuote, IconRetry, IconX } from "../components/Icons.js";

type QueueResponse = { claims: Claim[]; counts_by_type: Partial<Record<ClaimType, number>>; total: number };
type DecisionsResponse = { decisions: ReviewDecision[] };

type Outcome = "kept" | "edited" | "tossed";

/** How long a reviewer gets to take a decision back. */
const UNDO_WINDOW_MS = 5_000;
/** How long a decided card stays on screen before the queue closes over it. */
const SETTLE_MS = 380;

const OUTCOME_LABEL: Record<Outcome, string> = { kept: "Kept", edited: "Edited", tossed: "Tossed" };

const ACTION_LABEL: Record<ReviewDecision["action"], string> = {
  approve: "kept",
  reject: "tossed",
  edit_approve: "edited",
  undo: "undone",
};

/**
 * The review gate — a triage workspace, not a feed.
 *
 * Four panes: types, queue, claim, audit. The list is the reviewer's position
 * and it does not move when something loads; the detail pane is where the whole
 * decision is made, with the quote and its surrounding turns both on screen;
 * the right rail shows the decisions piling up behind them, because the audit
 * log is the artefact this screen exists to produce.
 *
 * Every claim here is a proposal. Nothing has entered the brief, and nothing
 * will until someone on this screen decides it should.
 */
export function ReviewQueue({ onCountChange }: { onCountChange: (n: number) => void }) {
  const navigate = useNavigate();
  const [claims, setClaims] = useState<Claim[] | null>(null);
  const [counts, setCounts] = useState<Partial<Record<ClaimType, number>>>({});
  const [decisions, setDecisions] = useState<ReviewDecision[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [filter, setFilter] = useState<ClaimType | "all">("all");
  const [focus, setFocus] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [settled, setSettled] = useState<Record<string, Outcome>>({});
  const [showHelp, setShowHelp] = useState(false);
  const [merging, setMerging] = useState(false);
  const [showFlagged, setShowFlagged] = useState(false);

  // What this sitting has produced. Reset only by a reload, so the completion
  // panel can report the session rather than the table.
  const [session, setSession] = useState({ kept: 0, edited: 0, tossed: 0 });
  const [undoable, setUndoable] = useState<{ claim: Claim; outcome: Outcome } | null>(null);

  const rowRefs = useRef(new Map<string, HTMLElement>());
  const editRef = useRef<HTMLTextAreaElement>(null);
  const undoTimer = useRef<number | null>(null);
  // The pending "drop this row from the list" timers, by claim. Undo inside
  // that window has to cancel one, or the row leaves the queue and its type
  // count is decremented for a decision that no longer exists.
  const settleTimers = useRef(new Map<string, number>());

  const load = useCallback(async () => {
    try {
      const data = await api.get<QueueResponse>("/review-queue?status=proposed");
      setClaims(data.claims);
      setCounts(data.counts_by_type);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const loadAudit = useCallback(async () => {
    try {
      const data = await api.get<DecisionsResponse>("/review-decisions?limit=60");
      setDecisions(data.decisions);
    } catch {
      // The feed is a witness, not a blocker: a queue that refuses to work
      // because its sidebar failed to load would be the worse failure.
    }
  }, []);

  useEffect(() => { void load(); void loadAudit(); }, [load, loadAudit]);

  // Reported from an effect, never from inside a state updater — updaters run
  // during render, and setting parent state there is a React error.
  useEffect(() => {
    if (claims) onCountChange(claims.length);
  }, [claims, onCountChange]);

  useEffect(() => {
    const timers = settleTimers.current;
    return () => {
      if (undoTimer.current) window.clearTimeout(undoTimer.current);
      for (const timer of timers.values()) window.clearTimeout(timer);
      timers.clear();
    };
  }, []);

  const visible = useMemo(
    () => (claims ?? []).filter((c) => filter === "all" || c.type === filter),
    [claims, filter],
  );

  const current = visible[Math.min(focus, Math.max(visible.length - 1, 0))];

  const flagged = useMemo(() => visible.filter((c) => c.confidence_band !== "high"), [visible]);
  const highConfidence = useMemo(() => visible.filter((c) => c.confidence_band === "high"), [visible]);

  const decided = session.kept + session.edited + session.tossed;
  const total = decided + visible.length;

  useEffect(() => {
    if (current) rowRefs.current.get(current.id)?.scrollIntoView({ block: "nearest" });
  }, [current]);

  /** Offer the decision back for five seconds. The server already has it. */
  const offerUndo = useCallback((claim: Claim, outcome: Outcome) => {
    setUndoable({ claim, outcome });
    if (undoTimer.current) window.clearTimeout(undoTimer.current);
    undoTimer.current = window.setTimeout(() => setUndoable(null), UNDO_WINDOW_MS);
  }, []);

  const decide = useCallback(
    async (claim: Claim, action: "approve" | "reject", text?: string) => {
      setBusy(claim.id);
      const outcome: Outcome = action === "reject" ? "tossed" : text !== undefined ? "edited" : "kept";
      try {
        if (action === "approve" && text !== undefined && text !== claim.text) {
          await api.patch(`/claims/${claim.id}`, { text });
        } else {
          await api.post(`/claims/${claim.id}/${action}`);
        }
        setSettled((s) => ({ ...s, [claim.id]: outcome }));
        setSession((s) => ({ ...s, [outcome]: s[outcome] + 1 }));
        setEditing(null);
        setError(null);
        offerUndo(claim, outcome);
        void loadAudit();
        // Hold the row briefly so the decision registers, then drop it. Yanking
        // rows out from under a fast reviewer loses their place.
        const timer = window.setTimeout(() => {
          settleTimers.current.delete(claim.id);
          setClaims((cs) => (cs ?? []).filter((c) => c.id !== claim.id));
          setCounts((c) => ({ ...c, [claim.type]: Math.max(0, (c[claim.type] ?? 1) - 1) }));
        }, SETTLE_MS);
        settleTimers.current.set(claim.id, timer);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [loadAudit, offerUndo],
  );

  /**
   * Undo issues a compensating decision. It does not delete the first one —
   * the audit log only grows, so "they kept it, then changed their mind" stays
   * readable a year from now.
   */
  const undo = useCallback(async () => {
    if (!undoable) return;
    const { claim, outcome } = undoable;
    setUndoable(null);
    if (undoTimer.current) window.clearTimeout(undoTimer.current);
    // Cancel the row's exit before it happens. Undoing inside the settle window
    // would otherwise still drop the row and still decrement its type count.
    const pendingSettle = settleTimers.current.get(claim.id);
    if (pendingSettle !== undefined) {
      window.clearTimeout(pendingSettle);
      settleTimers.current.delete(claim.id);
    }
    try {
      await api.post(`/claims/${claim.id}/undo`);
      setSession((s) => ({ ...s, [outcome]: Math.max(0, s[outcome] - 1) }));
      setSettled((s) => {
        const next = { ...s };
        delete next[claim.id];
        return next;
      });
      setError(null);
      await Promise.all([load(), loadAudit()]);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [undoable, load, loadAudit]);

  const startEdit = useCallback((claim: Claim) => {
    setEditing(claim.id);
    setDraft(claim.text);
    window.setTimeout(() => editRef.current?.focus(), 0);
  }, []);

  /** Keep every high-confidence proposal at once. The flagged ones stay. */
  const keepAllHighConfidence = useCallback(async () => {
    if (highConfidence.length === 0) return;
    const batch = highConfidence.map((c) => c.id);
    setBusy("bulk");
    try {
      const result = await api.post<BulkApproveResult>("/claims/bulk-approve", { claim_ids: batch });
      const keptIds = new Set(result.approved.map((c) => c.id));
      setSession((s) => ({ ...s, kept: s.kept + result.approved_count }));
      setClaims((cs) => (cs ?? []).filter((c) => !keptIds.has(c.id)));
      setNotice(
        result.error_count === 0
          ? `Kept ${result.approved_count} high-confidence claim${result.approved_count === 1 ? "" : "s"}.`
          : `Kept ${result.approved_count}. ${result.error_count} held back — ${result.errors[0]?.message ?? "read them individually"}.`,
      );
      setError(null);
      await Promise.all([load(), loadAudit()]);
    } catch (e) {
      setNotice(null);
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [highConfidence, load, loadAudit]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "?") { setShowHelp((v) => !v); return; }
      if (event.key === "Escape") { setEditing(null); setShowHelp(false); return; }

      const inField = event.target instanceof HTMLElement && ["INPUT", "TEXTAREA"].includes(event.target.tagName);
      if (inField || event.metaKey || event.ctrlKey || event.altKey) return;

      if (event.key === "u" && undoable) { event.preventDefault(); void undo(); return; }
      // Shift+A is the whole point of the bulk bar for a keyboard reviewer:
      // fourteen claims in under a minute means never reaching for the mouse.
      if (event.key === "A" && event.shiftKey && busy !== "bulk") {
        event.preventDefault();
        void keepAllHighConfidence();
        return;
      }
      if (!current) return;

      // A decided card stays on screen for a beat so the outcome registers.
      // The buttons swap for a status chip during that window, but the keyboard
      // did not — so holding `a` wrote several decisions against the same claim.
      // Harmless to memory (the second approve is a no-op) but it filled the
      // audit log with phantom reviews, and the audit log is the artefact that
      // proves a human made each call.
      if (settled[current.id] || busy === current.id) return;

      switch (event.key) {
        case "j": case "ArrowDown":
          event.preventDefault(); setFocus((f) => Math.min(f + 1, visible.length - 1)); break;
        case "k": case "ArrowUp":
          event.preventDefault(); setFocus((f) => Math.max(f - 1, 0)); break;
        case "a": event.preventDefault(); void decide(current, "approve"); break;
        case "r": event.preventDefault(); void decide(current, "reject"); break;
        case "e": event.preventDefault(); startEdit(current); break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, visible.length, decide, startEdit, settled, busy, undoable, undo, keepAllHighConfidence]);

  /**
   * Merge, then leave.
   *
   * Staying on an emptied queue to read a one-line notice wastes the moment the
   * whole gate exists to produce: the reviewer has just changed the brief and
   * wants to see what they changed. So the merge hands off to the brief with
   * the diff already open on the version it just wrote.
   *
   * No `meeting_id` is sent, deliberately. This screen cannot compute one: a
   * decided claim is dropped from `claims` as soon as it settles, so by the time
   * merge runs that state holds what the reviewer has NOT decided — the
   * complement of what is about to be merged. A queue holding meetings A and B
   * with all of A approved would name B as the source of a version whose every
   * claim came from A, and the server treats the caller's answer as
   * authoritative and writes it into a row that can never be corrected.
   *
   * The server infers it instead, from the claims actually being merged. That
   * is the only set with the right answer in it.
   */
  const merge = async () => {
    setMerging(true);
    try {
      const r = await api.post<{
        version: { version: number; added: number; edited: number; removed: number };
      }>("/brief/versions");

      setError(null);
      navigate(`/brief?v=${r.version.version}&diff=1`);
    } catch (e) {
      setNotice(null);
      setError((e as Error).message);
    } finally {
      setMerging(false);
    }
  };

  const nothingLeft = claims !== null && visible.length === 0;

  return (
    <div className="screen">
      <header className="screen-head">
        <h1>Review queue</h1>
        <span className="sub">
          {claims === null
            ? "loading…"
            : total === 0
              ? "nothing awaiting a decision"
              : `${decided} of ${total} decided`}
        </span>
        {total > 0 && (
          <span className="progress" aria-hidden>
            <i style={{ width: `${Math.round((decided / total) * 100)}%` }} />
          </span>
        )}
        <div className="grow" />
        <button className="btn primary" onClick={() => void merge()} disabled={merging}>
          {merging ? "Merging…" : "Merge approved → brief"}
        </button>
      </header>

      {highConfidence.length > 0 && (
        <div className="bulk-bar">
          <button
            className="btn approve"
            disabled={busy === "bulk"}
            onClick={() => void keepAllHighConfidence()}
          >
            <IconCheck /> {busy === "bulk" ? "Keeping…" : `Keep all ${highConfidence.length} high-confidence`}
          </button>
          {flagged.length > 0 && (
            <>
              <button className="bulk-flagged-toggle" onClick={() => setShowFlagged((v) => !v)}>
                {flagged.length} flagged for a read {showFlagged ? "▴" : "▾"}
              </button>
              {showFlagged && (
                <ul className="bulk-flagged">
                  {flagged.map((claim) => (
                    <li key={claim.id}>
                      <span className="pct mono">{Math.round(claim.confidence * 100)}%</span>
                      <span className="what">{claim.text}</span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}

      <div className="panes">
        <nav className="pane rail-types">
          <div className="pane-head">Claim type</div>
          <div className="pane-body scroll">
            <button className={`type-item${filter === "all" ? " active" : ""}`} onClick={() => { setFilter("all"); setFocus(0); }}>
              <span className="grow">All types</span>
              <span className="n">{claims?.length ?? 0}</span>
            </button>
            {CLAIM_TYPE_ORDER.map((type) => (
              <button
                key={type}
                className={`type-item${filter === type ? " active" : ""}`}
                onClick={() => { setFilter(type); setFocus(0); }}
              >
                <span className="grow">{CLAIM_TYPE_LABEL[type]}</span>
                <span className="n">{counts[type] ?? 0}</span>
              </button>
            ))}
          </div>
        </nav>

        <div className="pane list">
          <div className="pane-head">
            <span className="grow">Queue</span>
            {/* Stands in for the type rail once it collapses. */}
            <select
              className="select only-narrow"
              value={filter}
              onChange={(e) => { setFilter(e.target.value as ClaimType | "all"); setFocus(0); }}
            >
              <option value="all">All types ({claims?.length ?? 0})</option>
              {CLAIM_TYPE_ORDER.map((type) => (
                <option key={type} value={type}>{CLAIM_TYPE_LABEL[type]} ({counts[type] ?? 0})</option>
              ))}
            </select>
            <span>j / k</span>
          </div>
          <div className="pane-body scroll">
            {claims === null && <><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /></>}

            {nothingLeft && decided === 0 && (
              <div className="empty">
                <h3>Nothing waiting</h3>
                <p>PerfStaq will ping you after your next call.</p>
              </div>
            )}

            {nothingLeft && decided > 0 && (
              <div className="empty">
                <h3>Queue clear</h3>
                <p>{session.kept} kept · {session.edited} edited · {session.tossed} tossed.</p>
              </div>
            )}

            {visible.map((claim, i) => (
              <div key={claim.id}>
              {/* The queue arrives ordered by type, so a header wherever the
                  type changes groups it without a second pass. Reviewing six
                  positioning statements in a row is a different task from
                  bouncing between a pain point and an objection. */}
              {filter === "all" && visible[i - 1]?.type !== claim.type && (
                <div className="group-head mono">
                  {CLAIM_TYPE_LABEL[claim.type]}
                  <span className="n">{visible.filter((c) => c.type === claim.type).length}</span>
                </div>
              )}
              <button
                ref={(el) => { if (el) rowRefs.current.set(claim.id, el); }}
                className={`row${current?.id === claim.id ? " selected" : ""}${settled[claim.id] ? " settled" : ""}`}
                onClick={() => setFocus(i)}
              >
                <div className="row-top">
                  <span className="type-tag">{CLAIM_TYPE_LABEL[claim.type]}</span>
                  <span className="grow" />
                  {settled[claim.id] ? (
                    <span className={`chip ${settled[claim.id] === "tossed" ? "error" : "ready"}`}>
                      <span className="dot" />{OUTCOME_LABEL[settled[claim.id]!].toLowerCase()}
                    </span>
                  ) : (
                    <span className={`conf-chip ${claim.confidence_band}`}>
                      <span className="meter"><i style={{ width: `${Math.round(claim.confidence * 100)}%` }} /></span>
                      {claim.confidence_band}
                    </span>
                  )}
                </div>
                <div className="row-text">{claim.text}</div>
                <div className="row-meta mono">
                  <span>{claim.evidence.speaker}</span>
                  <span>{claim.evidence.timestamp_label}</span>
                </div>
              </button>
              </div>
            ))}
          </div>
        </div>

        <div className="pane detail" style={{ position: "relative" }}>
          <div className="pane-head">
            <span className="grow">{current ? CLAIM_TYPE_LABEL[current.type] : "Claim"}</span>
            {current && <span>{Math.round(current.confidence * 100)}% confidence</span>}
          </div>

          {error && <div className="banner error">{error}</div>}
          {notice && <div className="banner info">{notice}</div>}

          {!current ? (
            <div className="pane-body scroll">
              {nothingLeft && decided > 0 ? (
                <div className="completion">
                  <h3>That is the queue.</h3>
                  <p className="tally">
                    <b>{session.kept}</b> kept · <b>{session.edited}</b> edited · <b>{session.tossed}</b> tossed
                  </p>
                  <p>
                    Nothing has reached the brief yet. Merging writes a new, immutable version
                    from everything you kept.
                  </p>
                  <button className="btn primary lg" onClick={() => void merge()} disabled={merging}>
                    {merging ? "Merging…" : "Merge into Brief"}
                  </button>
                </div>
              ) : (
                <div className="empty" style={{ marginTop: 40 }}>
                  <h3>{claims === null ? "Loading" : "Nothing waiting"}</h3>
                  <p>
                    {claims === null
                      ? "Fetching the queue."
                      : filter === "all"
                        ? "PerfStaq will ping you after your next call."
                        : "No proposals of this type. Clear the filter to see the rest."}
                  </p>
                </div>
              )}
            </div>
          ) : (
            <>
              <div className="pane-body scroll">
                <div className="detail-body">
                  {editing === current.id ? (
                    <>
                      {/* What the model proposed stays on screen while it is
                          rewritten. An edit you cannot compare is a retype. */}
                      <p className="edit-original">{current.text}</p>
                      <textarea
                        ref={editRef}
                        className="edit-area"
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                            e.preventDefault();
                            void decide(current, "approve", draft.trim());
                          }
                        }}
                      />
                    </>
                  ) : (
                    <p className="detail-claim">{current.text}</p>
                  )}

                  <div className="evidence">
                    <div className="eyebrow mono"><IconQuote size={13} /> Evidence</div>
                    <blockquote className="mono">“{current.evidence.verbatim_quote}”</blockquote>
                    <div className="attribution mono">
                      <span className="speaker">{current.evidence.speaker}</span>
                      <span>{current.evidence.timestamp_label}</span>
                      <span>{current.meeting.title ?? "Untitled meeting"}</span>
                    </div>
                  </div>

                  {current.evidence.segments.length > 0 && (
                    <div className="context">
                      <h4>Cited in context</h4>
                      {current.evidence.segments.map((segment) => (
                        <div className="turn cited" key={segment.id}>
                          <span className="who">{segment.speaker}</span>
                          <span className="said">{segment.text}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="section">
                    <h3>Provenance</h3>
                    <dl className="kv">
                      <dt>Meeting</dt><dd>{current.meeting.title ?? current.meeting.meeting_url}</dd>
                      <dt>Speaker</dt><dd>{current.evidence.speaker}</dd>
                      <dt>Timestamp</dt><dd>{current.evidence.timestamp_label} into the recording</dd>
                      <dt>Segments</dt><dd className="mono">{current.evidence.segments.map((s) => `s${String(s.idx).padStart(4, "0")}`).join(", ") || "—"}</dd>
                      <dt>Proposed</dt><dd>{new Date(current.created_at).toLocaleString()}</dd>
                    </dl>
                  </div>
                </div>
              </div>

              <div className="actionbar">
                {settled[current.id] ? (
                  <span className={`chip ${settled[current.id] === "tossed" ? "error" : "ready"}`}>
                    <span className="dot" />{OUTCOME_LABEL[settled[current.id]!]}
                  </span>
                ) : editing === current.id ? (
                  <>
                    <button className="btn approve" disabled={busy === current.id || draft.trim().length < 3} onClick={() => void decide(current, "approve", draft.trim())}>
                      <IconCheck /> Save &amp; keep <span className="key">⌘⏎</span>
                    </button>
                    <button className="btn" onClick={() => setEditing(null)}>Cancel <span className="key">esc</span></button>
                  </>
                ) : (
                  <>
                    <button className="btn approve" disabled={busy === current.id} onClick={() => void decide(current, "approve")}>
                      <IconCheck /> Keep <span className="key">a</span>
                    </button>
                    <button className="btn" onClick={() => startEdit(current)}>
                      <IconPencil /> Edit <span className="key">e</span>
                    </button>
                    <button className="btn reject" disabled={busy === current.id} onClick={() => void decide(current, "reject")}>
                      <IconX /> Toss <span className="key">r</span>
                    </button>
                  </>
                )}
                <div className="grow" />
                <span className="mono" style={{ color: "var(--faint)" }}>
                  {visible.indexOf(current) + 1} of {visible.length}
                </span>
              </div>
            </>
          )}

          <button className="hint mono" onClick={() => setShowHelp(true)}>? shortcuts</button>
        </div>

        {/* The audit log, as it happens. Every row here is a human decision that
            already reached the server — this is the record, not a preview. */}
        <aside className="pane rail-audit">
          <div className="pane-head">
            <span className="grow">This session</span>
            <span className="mono">{decisions.length}</span>
          </div>
          <div className="pane-body scroll">
            {decisions.length === 0 ? (
              <p className="audit-empty">No decisions yet. Every one you make lands here, permanently.</p>
            ) : (
              decisions.map((decision) => (
                <div className={`audit-row ${decision.action}`} key={decision.id}>
                  <div className="audit-top mono">
                    <span className="what">{ACTION_LABEL[decision.action]}</span>
                    <span className="grow" />
                    <span className="when">{new Date(decision.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                  </div>
                  <div className="audit-text">{decision.edited_text ?? decision.claim.text}</div>
                  <div className="audit-who mono">{decision.reviewer}</div>
                </div>
              ))
            )}
          </div>
        </aside>
      </div>

      {undoable && (
        <div className="toast" role="status">
          <span className="what">
            {OUTCOME_LABEL[undoable.outcome]} “{truncate(undoable.claim.text)}”
          </span>
          <button className="toast-undo" onClick={() => void undo()}>
            <IconRetry size={14} /> Undo <span className="key">u</span>
          </button>
        </div>
      )}

      {showHelp && (
        <div className="scrim" onClick={() => setShowHelp(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Keyboard</h3>
            <dl>
              <dt>a</dt><dd>Keep the selected claim</dd>
              <dt>e</dt><dd>Edit, then keep in one action</dd>
              <dt>r</dt><dd>Toss it</dd>
              <dt>⇧A</dt><dd>Keep every high-confidence claim in view</dd>
              <dt>u</dt><dd>Undo the last decision, within five seconds</dd>
              <dt>j / k</dt><dd>Move down / up the queue</dd>
              <dt>⌘⏎</dt><dd>Save an edit and keep</dd>
              <dt>esc</dt><dd>Cancel an edit</dd>
              <dt>?</dt><dd>Toggle this panel</dd>
            </dl>
          </div>
        </div>
      )}
    </div>
  );
}

function truncate(text: string, max = 64): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}
