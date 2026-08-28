import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, type Meeting, type MeetingDetail, type MeetingStatus } from "../api.js";
import { IconLink, IconPlus, IconRetry, IconTrash } from "../components/Icons.js";
import { playbackDeepLink } from "../components/RecordingPlayer.js";
import { ACTIVE_STATUSES, StatusChip, STATUS_LABEL } from "../components/StatusChip.js";

/**
 * Two panes: the pipeline, and one meeting's passage through it.
 *
 * The detail pane is deliberately about *state*, not content — transitions,
 * artifacts, extraction counts. There is no transcript reader here: reading a
 * meeting back is a notes surface, and the only place transcript text belongs
 * is next to a claim that cites it, in the review queue.
 */
export function Meetings() {
  const [meetings, setMeetings] = useState<Meeting[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MeetingDetail | null>(null);
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number>();
  const navigate = useNavigate();

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ meetings: Meeting[] }>("/meetings");
      setMeetings(data.meetings);
      setSelectedId((id) => id ?? data.meetings[0]?.id ?? null);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const loadDetail = useCallback(async (id: string) => {
    try {
      const data = await api.get<{ meeting: MeetingDetail }>(`/meetings/${id}`);
      setDetail(data.meeting);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
    else setDetail(null);
  }, [selectedId, loadDetail]);

  // Poll only while something is genuinely in flight. A settled list needs no
  // heartbeat — the pipeline is webhook-driven, not polled.
  useEffect(() => {
    const inFlight = (meetings ?? []).some((m) => ACTIVE_STATUSES.includes(m.status));
    window.clearInterval(timer.current);
    if (inFlight) {
      timer.current = window.setInterval(() => {
        void load();
        if (selectedId) void loadDetail(selectedId);
      }, 5000);
    }
    return () => window.clearInterval(timer.current);
  }, [meetings, selectedId, load, loadDetail]);

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!url.trim()) return;
    setSubmitting(true);
    try {
      const created = await api.post<{ meeting: Meeting }>("/meetings", {
        meeting_url: url.trim(),
        ...(title.trim() ? { title: title.trim() } : {}),
      });
      setUrl(""); setTitle(""); setError(null);
      setSelectedId(created.meeting.id);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await load();
      if (selectedId) await loadDetail(selectedId);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const openArtifact = async (id: string, kind: string) => {
    try {
      const r = await api.get<{ url: string }>(`/meetings/${id}/artifacts/${kind}/url`);
      window.open(r.url, "_blank", "noopener");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="screen">
      <header className="screen-head">
        <h1>Meetings</h1>
        <span className="sub">Evidence ingestion — stage one of the ring</span>
        <div className="grow" />
        {meetings && <span className="mono" style={{ color: "var(--faint)" }}>{meetings.length} total</span>}
      </header>

      <div className="panes">
        <div className="pane list">
          <form className="compose" onSubmit={create}>
            <input className="input" placeholder="Paste a meeting URL" value={url} onChange={(e) => setUrl(e.target.value)} disabled={submitting} />
            <button className="btn primary" type="submit" disabled={submitting || !url.trim()}>
              <IconPlus /> {submitting ? "Sending…" : "Send bot"}
            </button>
          </form>
          {url.trim() && (
            <div style={{ padding: "0 14px 12px" }}>
              <input className="input" placeholder="Title (optional)" value={title} onChange={(e) => setTitle(e.target.value)} disabled={submitting} />
            </div>
          )}

          <div className="pane-body scroll">
            {meetings === null && <><div className="skeleton row-lg" /><div className="skeleton row-lg" /></>}

            {meetings?.length === 0 && (
              <div className="empty">
                <h3>No meetings yet</h3>
                <p>Paste a meeting URL above. The bot joins, records, and everything after that is automatic until a human is needed in the review queue.</p>
              </div>
            )}

            {meetings?.map((meeting) => (
              <button
                key={meeting.id}
                className={`row${selectedId === meeting.id ? " selected" : ""}`}
                onClick={() => setSelectedId(meeting.id)}
              >
                <div className="row-top">
                  <span className="grow" style={{ fontWeight: 600, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {meeting.title ?? hostOf(meeting.meeting_url)}
                  </span>
                  <StatusChip status={meeting.status} />
                </div>
                <div className="row-meta mono">
                  <span>{new Date(meeting.created_at).toLocaleDateString()}</span>
                  {meeting.claim_counts.proposed > 0 && <span style={{ color: "var(--orange)" }}>{meeting.claim_counts.proposed} to review</span>}
                  {meeting.claim_counts.total > 0 && meeting.claim_counts.proposed === 0 && <span>{meeting.claim_counts.total} claims</span>}
                </div>
                {/* Always rendered, never conditionally omitted: the digest
                    arrives on the same fetch as everything else here, but a
                    background digest job can also fill it in on a meeting the
                    list is already showing (the 5s poll re-fetches while a
                    meeting is in flight). A row whose height changed by
                    itself, later, for a reason the reviewer took no action on,
                    is a layout shift either way — reserving the line always
                    keeps every row's height the same whether or not it has
                    one yet. */}
                <div className="row-digest" style={{ color: "var(--faint)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {meeting.digest ?? ""}
                </div>
              </button>
            ))}
          </div>
        </div>

        <div className="pane detail">
          <div className="pane-head">
            <span className="grow">{detail ? STATUS_LABEL[detail.status] : "Meeting"}</span>
            {detail?.platform && <span>{detail.platform.replace("_", " ")}</span>}
          </div>

          {error && <div className="banner error">{error}</div>}

          {!detail ? (
            <div className="empty" style={{ marginTop: 40 }}>
              <h3>No meeting selected</h3>
              <p>Pick a meeting to see how far through the pipeline it got.</p>
            </div>
          ) : (
            <div className="pane-body scroll">
              <div className="detail-body">
                <h2 style={{ margin: "6px 0 4px", fontSize: 20, fontWeight: 600, letterSpacing: "-0.02em" }}>
                  {detail.title ?? hostOf(detail.meeting_url)}
                </h2>
                <div className="mono" style={{ color: "var(--faint)", marginBottom: 8, wordBreak: "break-all" }}>
                  {detail.meeting_url}
                </div>

                {detail.digest && (
                  <p style={{ color: "var(--muted)", marginBottom: 20, maxWidth: 640 }}>{detail.digest}</p>
                )}

                {detail.status === "failed" && detail.failure_reason && (
                  <div className="banner error" style={{ margin: "0 0 18px" }}>
                    <strong>{detail.failed_stage ?? "failed"}</strong> — {detail.failure_reason}
                  </div>
                )}

                <div className="stat-grid">
                  <div className="stat"><div className="v">{detail.claim_counts.proposed}</div><div className="k">Proposed</div></div>
                  <div className="stat"><div className="v">{detail.claim_counts.approved + detail.claim_counts.edited}</div><div className="k">Approved</div></div>
                  <div className="stat"><div className="v">{detail.claim_counts.rejected}</div><div className="k">Rejected</div></div>
                  <div className="stat"><div className="v">{detail.transcript?.segmentCount ?? "—"}</div><div className="k">Segments</div></div>
                </div>

                <div style={{ display: "flex", gap: 8, marginBottom: 24, flexWrap: "wrap" }}>
                  {/* This screen is the pipeline's own view of a meeting — what
                      happened to it, and what to do when it broke. The meeting
                      as a person reads it, with the recording and the
                      transcript, is the workspace; without this link there is
                      no way to reach it from here at all. */}
                  <Link to={playbackDeepLink(detail.id, { startMs: 0 })} className="btn sm">
                    Open transcript
                  </Link>
                  {detail.claim_counts.proposed > 0 && (
                    <button className="btn primary sm" onClick={() => navigate("/review")}>
                      Review {detail.claim_counts.proposed} proposal{detail.claim_counts.proposed === 1 ? "" : "s"}
                    </button>
                  )}
                  {detail.status === "failed" && (
                    <button className="btn sm" onClick={() => void act(() => api.post(`/meetings/${detail.id}/retry`))}>
                      <IconRetry /> Retry from {detail.failed_stage ?? "start"}
                    </button>
                  )}
                  <button
                    className="btn sm reject"
                    onClick={() => {
                      if (!window.confirm("Purge this meeting's recording, transcript and unreviewed claims? Claims already merged into the brief are kept, with their evidence redacted. This cannot be undone.")) return;
                      void act(async () => {
                        await api.del(`/meetings/${detail.id}`);
                        setSelectedId(null);
                      });
                    }}
                  >
                    <IconTrash /> Purge
                  </button>
                </div>

                {detail.artifacts.length > 0 && (
                  <div className="section">
                    <h3>Artifacts in R2</h3>
                    {detail.artifacts.map((a) => (
                      <div key={a.kind} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 0", borderTop: "1px solid var(--line-soft)" }}>
                        <span style={{ fontWeight: 600, fontSize: 13 }}>{a.kind.replace(/_/g, " ")}</span>
                        <span className="mono" style={{ color: "var(--faint)" }}>{formatBytes(a.bytes)}</span>
                        <div style={{ flex: 1 }} />
                        {a.purged ? (
                          <span className="chip error"><span className="dot" />purged</span>
                        ) : (
                          <button className="btn sm" onClick={() => void openArtifact(detail.id, a.kind)}>
                            <IconLink /> Open
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {detail.extraction && (
                  <div className="section">
                    <h3>Extraction</h3>
                    <dl className="kv">
                      <dt>Model</dt><dd className="mono">{detail.extraction.model}</dd>
                      <dt>Chunks</dt><dd>{detail.extraction.chunks}</dd>
                      <dt>Proposed</dt><dd>{detail.extraction.proposed}</dd>
                      <dt>Dropped</dt><dd>{detail.extraction.dropped} <span style={{ color: "var(--faint)" }}>— failed the evidence gate</span></dd>
                      <dt>Duplicates</dt><dd>{detail.extraction.duplicates}</dd>
                      <dt>Persisted</dt><dd>{detail.extraction.persisted}</dd>
                      {detail.extraction.error && <><dt>Error</dt><dd style={{ color: "var(--red)" }}>{detail.extraction.error}</dd></>}
                    </dl>
                  </div>
                )}

                <div className="section">
                  <h3>State transitions</h3>
                  <ul className="timeline" style={{ margin: 0, padding: "0 0 0 18px" }}>
                    {detail.transitions.map((t, i) => (
                      <li key={`${t.at}-${i}`} className={i === detail.transitions.length - 1 ? "last" : ""}>
                        <div className="what">{STATUS_LABEL[t.to as MeetingStatus] ?? t.to}</div>
                        <div className="when mono">{new Date(t.at).toLocaleString()}</div>
                        {t.reason && <div className="why">{t.reason}</div>}
                      </li>
                    ))}
                    {detail.transitions.length === 0 && <li className="last"><div className="what">Created</div></li>}
                  </ul>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function hostOf(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}
