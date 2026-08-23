import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, CLAIM_TYPE_LABEL, CLAIM_TYPE_ORDER, type Claim, type ClaimType } from "../api.js";
import { IconCheck, IconPencil, IconQuote, IconX } from "../components/Icons.js";

type QueueResponse = { claims: Claim[]; counts_by_type: Partial<Record<ClaimType, number>>; total: number };

/**
 * The review gate — a triage workspace, not a feed.
 *
 * Three panes: types, queue, claim. The list is the reviewer's position and it
 * does not move when something loads; the detail pane is where the whole
 * decision is made, with the quote and its surrounding turns both on screen.
 * Every claim here is a proposal. Nothing has entered the brief, and nothing
 * will until someone on this screen decides it should.
 */
export function ReviewQueue({ onCountChange }: { onCountChange: (n: number) => void }) {
  const [claims, setClaims] = useState<Claim[] | null>(null);
  const [counts, setCounts] = useState<Partial<Record<ClaimType, number>>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [filter, setFilter] = useState<ClaimType | "all">("all");
  const [focus, setFocus] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [settled, setSettled] = useState<Record<string, "approve" | "reject">>({});
  const [showHelp, setShowHelp] = useState(false);
  const [merging, setMerging] = useState(false);

  const rowRefs = useRef(new Map<string, HTMLElement>());
  const editRef = useRef<HTMLTextAreaElement>(null);

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

  useEffect(() => { void load(); }, [load]);

  // Reported from an effect, never from inside a state updater — updaters run
  // during render, and setting parent state there is a React error.
  useEffect(() => {
    if (claims) onCountChange(claims.length);
  }, [claims, onCountChange]);

  const visible = useMemo(
    () => (claims ?? []).filter((c) => filter === "all" || c.type === filter),
    [claims, filter],
  );

  const current = visible[Math.min(focus, Math.max(visible.length - 1, 0))];

  useEffect(() => {
    if (current) rowRefs.current.get(current.id)?.scrollIntoView({ block: "nearest" });
  }, [current]);

  const decide = useCallback(
    async (claim: Claim, action: "approve" | "reject", text?: string) => {
      setBusy(claim.id);
      try {
        if (action === "approve" && text !== undefined && text !== claim.text) {
          await api.patch(`/claims/${claim.id}`, { text });
        } else {
          await api.post(`/claims/${claim.id}/${action}`);
        }
        setSettled((s) => ({ ...s, [claim.id]: action }));
        setEditing(null);
        setError(null);
        // Hold the row briefly so the decision registers, then drop it. Yanking
        // rows out from under a fast reviewer loses their place.
        window.setTimeout(() => {
          setClaims((cs) => (cs ?? []).filter((c) => c.id !== claim.id));
          setCounts((c) => ({ ...c, [claim.type]: Math.max(0, (c[claim.type] ?? 1) - 1) }));
        }, 380);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  const startEdit = useCallback((claim: Claim) => {
    setEditing(claim.id);
    setDraft(claim.text);
    window.setTimeout(() => editRef.current?.focus(), 0);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "?") { setShowHelp((v) => !v); return; }
      if (event.key === "Escape") { setEditing(null); setShowHelp(false); return; }

      const inField = event.target instanceof HTMLElement && ["INPUT", "TEXTAREA"].includes(event.target.tagName);
      if (inField || event.metaKey || event.ctrlKey || event.altKey) return;
      if (!current) return;

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
  }, [current, visible.length, decide, startEdit]);

  const merge = async () => {
    setMerging(true);
    try {
      const r = await api.post<{ version: { version: number; added: number; edited: number; removed: number } }>("/brief/versions");
      setNotice(`Brief v${r.version.version} created — ${r.version.added} added, ${r.version.edited} edited, ${r.version.removed} removed.`);
      setError(null);
    } catch (e) {
      setNotice(null);
      setError((e as Error).message);
    } finally {
      setMerging(false);
    }
  };

  return (
    <div className="screen">
      <header className="screen-head">
        <h1>Review queue</h1>
        <span className="sub">
          {claims === null ? "loading…" : `${visible.length} proposal${visible.length === 1 ? "" : "s"} awaiting a decision`}
        </span>
        <div className="grow" />
        <button className="btn primary" onClick={() => void merge()} disabled={merging}>
          {merging ? "Merging…" : "Merge approved → brief"}
        </button>
      </header>

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

            {claims !== null && visible.length === 0 && (
              <div className="empty">
                <h3>Nothing waiting</h3>
                <p>No claims are proposed right now. Add a meeting; once its transcript is extracted, proposals land here.</p>
              </div>
            )}

            {visible.map((claim, i) => (
              <button
                key={claim.id}
                ref={(el) => { if (el) rowRefs.current.set(claim.id, el); }}
                className={`row${current?.id === claim.id ? " selected" : ""}${settled[claim.id] ? " settled" : ""}`}
                onClick={() => setFocus(i)}
              >
                <div className="row-top">
                  <span className="type-tag">{CLAIM_TYPE_LABEL[claim.type]}</span>
                  <span className="grow" />
                  {settled[claim.id] ? (
                    <span className={`chip ${settled[claim.id] === "approve" ? "ready" : "error"}`}>
                      <span className="dot" />{settled[claim.id] === "approve" ? "kept" : "dropped"}
                    </span>
                  ) : (
                    <span className="meter"><i style={{ width: `${Math.round(claim.confidence * 100)}%` }} /></span>
                  )}
                </div>
                <div className="row-text">{claim.text}</div>
                <div className="row-meta mono">
                  <span>{claim.evidence.speaker}</span>
                  <span>{claim.evidence.timestamp_label}</span>
                </div>
              </button>
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
            <div className="empty" style={{ marginTop: 40 }}>
              <h3>No claim selected</h3>
              <p>Pick a proposal from the queue, or clear the type filter.</p>
            </div>
          ) : (
            <>
              <div className="pane-body scroll">
                <div className="detail-body">
                  {editing === current.id ? (
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
                  ) : (
                    <p className="detail-claim">{current.text}</p>
                  )}

                  <div className="evidence">
                    <div className="eyebrow mono"><IconQuote size={13} /> Evidence</div>
                    <blockquote>“{current.evidence.verbatim_quote}”</blockquote>
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
                  <span className={`chip ${settled[current.id] === "approve" ? "ready" : "error"}`}>
                    <span className="dot" />{settled[current.id] === "approve" ? "Approved" : "Rejected"}
                  </span>
                ) : editing === current.id ? (
                  <>
                    <button className="btn approve" disabled={busy === current.id || draft.trim().length < 3} onClick={() => void decide(current, "approve", draft.trim())}>
                      <IconCheck /> Save &amp; approve <span className="key">⌘⏎</span>
                    </button>
                    <button className="btn" onClick={() => setEditing(null)}>Cancel <span className="key">esc</span></button>
                  </>
                ) : (
                  <>
                    <button className="btn approve" disabled={busy === current.id} onClick={() => void decide(current, "approve")}>
                      <IconCheck /> Approve <span className="key">a</span>
                    </button>
                    <button className="btn reject" disabled={busy === current.id} onClick={() => void decide(current, "reject")}>
                      <IconX /> Reject <span className="key">r</span>
                    </button>
                    <button className="btn" onClick={() => startEdit(current)}>
                      <IconPencil /> Edit <span className="key">e</span>
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
      </div>

      {showHelp && (
        <div className="scrim" onClick={() => setShowHelp(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Keyboard</h3>
            <dl>
              <dt>a</dt><dd>Approve the selected claim</dd>
              <dt>r</dt><dd>Reject it</dd>
              <dt>e</dt><dd>Edit, then approve in one action</dd>
              <dt>j / k</dt><dd>Move down / up the queue</dd>
              <dt>⌘⏎</dt><dd>Save an edit and approve</dd>
              <dt>esc</dt><dd>Cancel an edit</dd>
              <dt>?</dt><dd>Toggle this panel</dd>
            </dl>
          </div>
        </div>
      )}
    </div>
  );
}
