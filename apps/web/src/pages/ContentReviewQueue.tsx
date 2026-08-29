import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  CONTENT_ARCHETYPE_LABEL,
  CONTENT_ARCHETYPE_ORDER,
  EXPECTED_METRIC_LABEL,
  type ContentArchetype,
  type ContentBrief,
  type ContentBriefRefusal,
  type ContentChannel,
} from "../api.js";
import { IconCheck, IconPencil, IconQuote, IconRetry, IconX } from "../components/Icons.js";
import { PlanBuilds } from "../components/PlanBuilds.js";

type QueueResponse = { briefs: ContentBrief[]; total: number };
type GenerateResponse = {
  brief_version: number;
  briefs: ContentBrief[];
  refusals: ContentBriefRefusal[];
  generated_count: number;
  refused_count: number;
};

type Outcome = "kept" | "edited" | "tossed";

const UNDO_WINDOW_MS = 5_000;
const SETTLE_MS = 380;
const OUTCOME_LABEL: Record<Outcome, string> = { kept: "Kept", edited: "Edited", tossed: "Tossed" };

const CHANNELS: ContentChannel[] = ["reels", "shorts", "tiktok", "linkedin"];

/**
 * The content-brief queue — a PARALLEL section to ReviewQueue.tsx, not a card
 * type folded into it (ARCHITECTURE.md §11.3: `ReviewQueue.tsx` is
 * claim-typed end to end — response shape, filters, decide/undo/bulk
 * endpoints, counts, and an audit rail that per ADR-6 will never contain a
 * ContentBrief decision). What IS reused: the visual language (`.screen` /
 * `.pane` / `.row` / `.btn` / chip styling from styles.css, the Icon set) and
 * the keyboard pattern — lowercase `a`/`e`/`r` to decide, `u` to undo within
 * a window, matching ReviewQueue's own (not "A/E/R" — §11.3's correction to
 * `05_BRIEF_INTEGRATION.md §3`). There is no bulk "keep all" here: unlike
 * claims, ContentBrief has no bulk-approve endpoint (05 §4 names only
 * approve/reject/edit-approve), so Shift+A is intentionally not wired up.
 *
 * Each row shows hook + archetype; the detail pane is the WHY line
 * (`claim_ids` + framework + `expected_metric`) with source chips built from
 * the frozen `claim_snapshots` — exactly like a claim card's evidence, per
 * 05 §3.
 */
export function ContentReviewQueue() {
  const [briefs, setBriefs] = useState<ContentBrief[] | null>(null);
  const [archetypeFilter, setArchetypeFilter] = useState<ContentArchetype | "all">("all");
  const [focus, setFocus] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [settled, setSettled] = useState<Record<string, Outcome>>({});
  const [undoable, setUndoable] = useState<{ brief: ContentBrief; outcome: Outcome } | null>(null);
  const [showHelp, setShowHelp] = useState(false);

  const [channel, setChannel] = useState<ContentChannel>("reels");
  const [count, setCount] = useState(3);
  const [generating, setGenerating] = useState(false);

  const editRef = useRef<HTMLTextAreaElement>(null);
  const undoTimer = useRef<number | null>(null);
  const settleTimers = useRef(new Map<string, number>());

  const load = useCallback(async () => {
    try {
      const data = await api.get<QueueResponse>("/content/briefs?status=proposed");
      setBriefs(data.briefs);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const timers = settleTimers.current;
    return () => {
      if (undoTimer.current) window.clearTimeout(undoTimer.current);
      for (const timer of timers.values()) window.clearTimeout(timer);
      timers.clear();
    };
  }, []);

  const visible = useMemo(
    () => (briefs ?? []).filter((b) => archetypeFilter === "all" || b.archetype === archetypeFilter),
    [briefs, archetypeFilter],
  );
  const current = visible[Math.min(focus, Math.max(visible.length - 1, 0))];

  useEffect(() => {
    if (current) setFocus(visible.indexOf(current));
  }, [visible, current]);

  const offerUndo = useCallback((brief: ContentBrief, outcome: Outcome) => {
    setUndoable({ brief, outcome });
    if (undoTimer.current) window.clearTimeout(undoTimer.current);
    undoTimer.current = window.setTimeout(() => setUndoable(null), UNDO_WINDOW_MS);
  }, []);

  const drop = useCallback((id: string) => {
    const timer = window.setTimeout(() => {
      settleTimers.current.delete(id);
      setBriefs((bs) => (bs ?? []).filter((b) => b.id !== id));
    }, SETTLE_MS);
    settleTimers.current.set(id, timer);
  }, []);

  const decide = useCallback(
    async (brief: ContentBrief, action: "approve" | "reject", editedHook?: string) => {
      setBusy(brief.id);
      // Actually changed, not merely "the edit box was open" — pressing
      // "Save & approve" without touching the text is a keep, not an edit,
      // and must match the branch below that decides whether to PATCH at all.
      const hookChanged = editedHook !== undefined && editedHook !== brief.hook_text;
      const outcome: Outcome = action === "reject" ? "tossed" : hookChanged ? "edited" : "kept";
      try {
        if (action === "approve" && hookChanged) {
          await api.patch(`/content/briefs/${brief.id}`, { hook_text: editedHook });
        } else {
          await api.post(`/content/briefs/${brief.id}/${action}`);
        }
        setSettled((s) => ({ ...s, [brief.id]: outcome }));
        setEditing(null);
        setError(null);
        offerUndo(brief, outcome);
        drop(brief.id);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [offerUndo, drop],
  );

  const undo = useCallback(async () => {
    if (!undoable) return;
    const { brief } = undoable;
    setUndoable(null);
    if (undoTimer.current) window.clearTimeout(undoTimer.current);
    const pending = settleTimers.current.get(brief.id);
    if (pending !== undefined) {
      window.clearTimeout(pending);
      settleTimers.current.delete(brief.id);
    }
    try {
      await api.post(`/content/briefs/${brief.id}/undo`);
      setSettled((s) => {
        const next = { ...s };
        delete next[brief.id];
        return next;
      });
      setError(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }, [undoable, load]);

  const startEdit = useCallback((brief: ContentBrief) => {
    setEditing(brief.id);
    setDraft(brief.hook_text);
    window.setTimeout(() => editRef.current?.focus(), 0);
  }, []);

  const generate = useCallback(async () => {
    setGenerating(true);
    try {
      const result = await api.post<GenerateResponse>("/content/briefs", { channel, count });
      setNotice(
        result.refused_count === 0
          ? `Generated ${result.generated_count} brief${result.generated_count === 1 ? "" : "s"} from brief v${result.brief_version}.`
          : `Generated ${result.generated_count}. ${result.refused_count} refused — ${result.refusals[0]?.reason ?? "not enough claim signal"}.`,
      );
      setError(null);
      await load();
    } catch (e) {
      setNotice(null);
      setError((e as Error).message);
    } finally {
      setGenerating(false);
    }
  }, [channel, count, load]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "?") { setShowHelp((v) => !v); return; }
      if (event.key === "Escape") { setEditing(null); setShowHelp(false); return; }
      const inField = event.target instanceof HTMLElement && ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName);
      if (inField || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "u" && undoable) { event.preventDefault(); void undo(); return; }
      if (!current || settled[current.id] || busy === current.id) return;

      switch (event.key) {
        case "j": case "ArrowDown": event.preventDefault(); setFocus((f) => Math.min(f + 1, visible.length - 1)); break;
        case "k": case "ArrowUp": event.preventDefault(); setFocus((f) => Math.max(f - 1, 0)); break;
        case "a": event.preventDefault(); void decide(current, "approve"); break;
        case "r": event.preventDefault(); void decide(current, "reject"); break;
        case "e": event.preventDefault(); startEdit(current); break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, visible.length, decide, startEdit, settled, busy, undoable, undo]);

  const nothingLeft = briefs !== null && visible.length === 0;

  return (
    <div className="screen">
      <header className="screen-head">
        <h1>Content briefs</h1>
        <span className="sub">
          {briefs === null ? "loading…" : visible.length === 0 ? "nothing awaiting a decision" : `${visible.length} awaiting decision`}
        </span>
        <div className="grow" />
        <select className="select" value={channel} onChange={(e) => setChannel(e.target.value as ContentChannel)}>
          {CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <input
          className="input"
          type="number"
          min={1}
          max={10}
          value={count}
          onChange={(e) => setCount(Math.min(10, Math.max(1, Number(e.target.value) || 1)))}
          style={{ width: 56 }}
        />
        <button className="btn primary" onClick={() => void generate()} disabled={generating}>
          {generating ? "Generating…" : "Generate from current brief"}
        </button>
      </header>

      {/* ARCHITECTURE §12.25/§12.38 — a failed plan build used to vanish
          entirely. It surfaces here, in normal flow under the header, because
          no breakpoint removes this position: the rail it first lived in is
          `display: none` below 1240px, which would have hidden the failure
          surface on exactly the windows a user is most likely to have open. */}
      <PlanBuilds />

      <div className="panes">
        <nav className="pane rail-types">
          <div className="pane-head">Archetype</div>
          <div className="pane-body scroll">
            <button className={`type-item${archetypeFilter === "all" ? " active" : ""}`} onClick={() => { setArchetypeFilter("all"); setFocus(0); }}>
              <span className="grow">All archetypes</span>
              <span className="n">{briefs?.length ?? 0}</span>
            </button>
            {CONTENT_ARCHETYPE_ORDER.map((archetype) => {
              const n = (briefs ?? []).filter((b) => b.archetype === archetype).length;
              if (n === 0) return null;
              return (
                <button
                  key={archetype}
                  className={`type-item${archetypeFilter === archetype ? " active" : ""}`}
                  onClick={() => { setArchetypeFilter(archetype); setFocus(0); }}
                >
                  <span className="grow">{CONTENT_ARCHETYPE_LABEL[archetype]}</span>
                  <span className="n">{n}</span>
                </button>
              );
            })}
          </div>
        </nav>

        <div className="pane list">
          <div className="pane-head"><span className="grow">Queue</span><span>j / k</span></div>
          <div className="pane-body scroll">
            {briefs === null && <><div className="skeleton row-lg" /><div className="skeleton row-lg" /></>}
            {nothingLeft && (
              <div className="empty">
                <h3>Nothing waiting</h3>
                <p>Generate a batch from the current brief to fill this queue.</p>
              </div>
            )}
            {visible.map((brief) => (
              <button
                key={brief.id}
                className={`row${current?.id === brief.id ? " selected" : ""}${settled[brief.id] ? " settled" : ""}`}
                onClick={() => setFocus(visible.indexOf(brief))}
              >
                <div className="row-top">
                  <span className="type-tag">{CONTENT_ARCHETYPE_LABEL[brief.archetype]}</span>
                  <span className="grow" />
                  {settled[brief.id] ? (
                    <span className={`chip ${settled[brief.id] === "tossed" ? "error" : "ready"}`}>
                      <span className="dot" />{OUTCOME_LABEL[settled[brief.id]!].toLowerCase()}
                    </span>
                  ) : (
                    <span className="chip">{brief.framework.evidence_tier} · {brief.channel}</span>
                  )}
                </div>
                <div className="row-text">{brief.hook_text}</div>
                <div className="row-meta mono">
                  <span>{brief.framework.name}</span>
                  <span>{EXPECTED_METRIC_LABEL[brief.expected_metric]}</span>
                </div>
              </button>
            ))}
          </div>
        </div>

        <div className="pane detail" style={{ position: "relative" }}>
          <div className="pane-head">
            <span className="grow">{current ? CONTENT_ARCHETYPE_LABEL[current.archetype] : "Content brief"}</span>
            {current && <span>{current.channel}</span>}
          </div>

          {error && <div className="banner error">{error}</div>}
          {notice && <div className="banner info">{notice}</div>}

          {!current ? (
            <div className="pane-body scroll">
              <div className="empty" style={{ marginTop: 40 }}>
                <h3>{briefs === null ? "Loading" : "Nothing waiting"}</h3>
                <p>{briefs === null ? "Fetching the queue." : "Generate a batch above, or clear the archetype filter."}</p>
              </div>
            </div>
          ) : (
            <>
              <div className="pane-body scroll">
                <div className="detail-body">
                  {editing === current.id ? (
                    <>
                      <p className="edit-original">{current.hook_text}</p>
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
                    <p className="detail-claim">
                      {current.hook_text}
                      {current.emphasis_word && (
                        <>
                          {" "}
                          <strong style={{ color: "var(--orange)" }}>[{current.emphasis_word}]</strong>
                        </>
                      )}
                    </p>
                  )}

                  <div className="context">
                    <h4>Beats</h4>
                    {current.beats.map((beat, i) => (
                      <div className="turn cited" key={i}>
                        <span className="who">{beat.role}</span>
                        <span className="said">{beat.script}</span>
                      </div>
                    ))}
                  </div>

                  <div className="evidence">
                    <div className="eyebrow mono"><IconQuote size={13} /> Why this brief</div>
                    <blockquote className="mono">
                      {current.framework.name} ({current.framework.evidence_tier}) → {EXPECTED_METRIC_LABEL[current.expected_metric]}
                    </blockquote>
                    {current.framework.when_to_use && <p style={{ color: "var(--muted)", fontSize: 13 }}>{current.framework.when_to_use}</p>}
                  </div>

                  <div className="section">
                    <h3>Source claims</h3>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {current.claim_snapshots.map((snap) => (
                        <span className="chip" key={snap.claim_id} title={`${snap.speaker} — "${snap.verbatim_quote}"`}>
                          {snap.text.length > 40 ? `${snap.text.slice(0, 39)}…` : snap.text}
                        </span>
                      ))}
                    </div>
                  </div>

                  <div className="section">
                    <h3>Provenance</h3>
                    <dl className="kv">
                      <dt>Framework</dt><dd>{current.framework.name}</dd>
                      <dt>Evidence tier</dt><dd>{current.framework.evidence_tier}</dd>
                      <dt>Expected metric</dt><dd>{EXPECTED_METRIC_LABEL[current.expected_metric]}</dd>
                      <dt>Mix slot</dt><dd>{current.content_mix_slot}</dd>
                      <dt>Generated by</dt><dd className="mono">{current.generated_by_model}</dd>
                      <dt>Created</dt><dd>{new Date(current.created_at).toLocaleString()}</dd>
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
                      <IconCheck /> Save &amp; approve <span className="key">⌘⏎</span>
                    </button>
                    <button className="btn" onClick={() => setEditing(null)}>Cancel <span className="key">esc</span></button>
                  </>
                ) : (
                  <>
                    <button className="btn approve" disabled={busy === current.id} onClick={() => void decide(current, "approve")}>
                      <IconCheck /> Approve <span className="key">a</span>
                    </button>
                    <button className="btn" onClick={() => startEdit(current)}>
                      <IconPencil /> Edit <span className="key">e</span>
                    </button>
                    <button className="btn reject" disabled={busy === current.id} onClick={() => void decide(current, "reject")}>
                      <IconX /> Reject <span className="key">r</span>
                    </button>
                  </>
                )}
                <div className="grow" />
                <span className="mono" style={{ color: "var(--faint)" }}>{visible.indexOf(current) + 1} of {visible.length}</span>
              </div>
            </>
          )}

          <button className="hint mono" onClick={() => setShowHelp(true)}>? shortcuts</button>
        </div>
      </div>

      {undoable && (
        <div className="toast" role="status">
          <span className="what">{OUTCOME_LABEL[undoable.outcome]} “{truncate(undoable.brief.hook_text)}”</span>
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
              <dt>a</dt><dd>Approve the selected brief</dd>
              <dt>e</dt><dd>Edit the hook, then approve in one action</dd>
              <dt>r</dt><dd>Reject it</dd>
              <dt>u</dt><dd>Undo the last decision, within five seconds</dd>
              <dt>j / k</dt><dd>Move down / up the queue</dd>
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
