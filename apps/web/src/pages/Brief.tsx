import { useCallback, useEffect, useState } from "react";
import { api, type BriefDiff, type BriefVersion, type BriefVersionSummary } from "../api.js";

/**
 * The Living Positioning Brief, rendered as a document rather than a feed.
 *
 * Versions run down the left as a history; the document on the right is
 * immutable — reading v3 shows exactly what v3 said, not what its claims were
 * later edited to say. That is the whole reason the versions are kept, so the
 * diff is a first-class mode rather than a hidden option.
 */
export function Brief() {
  const [versions, setVersions] = useState<BriefVersionSummary[] | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [compare, setCompare] = useState<number | "off">("off");
  const [doc, setDoc] = useState<BriefVersion | null>(null);
  const [diff, setDiff] = useState<BriefDiff | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadVersions = useCallback(async () => {
    try {
      const data = await api.get<{ versions: BriefVersionSummary[] }>("/brief/versions");
      setVersions(data.versions);
      setSelected((s) => s ?? data.versions[0]?.version ?? null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => { void loadVersions(); }, [loadVersions]);

  useEffect(() => {
    if (selected === null) return;
    void (async () => {
      try {
        setDoc(await api.get<BriefVersion>(`/brief/versions/${selected}`));
        setError(null);
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  }, [selected]);

  useEffect(() => {
    if (compare === "off" || selected === null) { setDiff(null); return; }
    void (async () => {
      try {
        setDiff(await api.get<BriefDiff>(`/brief/versions/${compare}/diff/${selected}`));
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  }, [compare, selected]);

  const summary = versions?.find((v) => v.version === selected);
  const earlier = versions?.filter((v) => selected !== null && v.version < selected) ?? [];

  if (versions !== null && versions.length === 0) {
    return (
      <div className="screen">
        <header className="screen-head"><h1>Living Positioning Brief</h1></header>
        <div className="empty" style={{ marginTop: 60 }}>
          <h3>No versions yet</h3>
          <p>The brief is written only by the review gate. Approve claims in the review queue and merge them; version 1 appears here.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="screen">
      <header className="screen-head">
        <h1>Living Positioning Brief</h1>
        <span className="sub">Append-only context memory — stage four</span>
        <div className="grow" />
        <span className="mono" style={{ color: "var(--faint)" }}>compare with</span>
        <select
          className="select"
          value={compare}
          onChange={(e) => setCompare(e.target.value === "off" ? "off" : Number(e.target.value))}
        >
          <option value="off">— off —</option>
          <option value={0}>Nothing (v0)</option>
          {earlier.map((v) => <option key={v.version} value={v.version}>Version {v.version}</option>)}
        </select>
      </header>

      <div className="panes">
        <nav className="pane versions">
          <div className="pane-head">History</div>
          <div className="pane-body scroll">
            {versions === null && <><div className="skeleton" /><div className="skeleton" /></>}
            {versions?.map((v) => (
              <button
                key={v.version}
                className={`version-item${selected === v.version ? " active" : ""}`}
                onClick={() => setSelected(v.version)}
              >
                <div className="vn">Version {v.version}</div>
                <div className="vmeta mono">
                  <span>{new Date(v.created_at).toLocaleDateString()}</span>
                  <span>{v.total} claims</span>
                </div>
                <div className="vmeta mono">
                  {v.added > 0 && <span className="plus">+{v.added}</span>}
                  {v.edited > 0 && <span className="tilde">~{v.edited}</span>}
                  {v.removed > 0 && <span className="minus">−{v.removed}</span>}
                </div>
              </button>
            ))}
          </div>
        </nav>

        <div className="pane doc">
          {error && <div className="banner error">{error}</div>}
          <div className="pane-body scroll">
            <div className="doc-body">
              <h2 className="doc-title">Living Positioning Brief</h2>
              <div className="doc-sub">Version {selected} · {doc?.total ?? 0} approved claims</div>
              {summary && (
                <div className="doc-meta mono">
                  <span>merged by {summary.created_by}</span>
                  <span>{new Date(summary.created_at).toLocaleString()}</span>
                  <span className="plus" style={{ color: "var(--green)" }}>+{summary.added}</span>
                  <span style={{ color: "var(--orange)" }}>~{summary.edited}</span>
                  <span style={{ color: "var(--red)" }}>−{summary.removed}</span>
                  {summary.note && <span>“{summary.note}”</span>}
                </div>
              )}

              {diff ? <DiffView diff={diff} /> : (
                doc?.claims_by_type.map((group) => (
                  <section className="doc-section" key={group.type}>
                    <h2>{group.label}</h2>
                    {group.claims.map((claim, i) => (
                      <article className={`doc-claim${claim.evidence.redacted ? " redacted" : ""}`} key={claim.claim_id}>
                        <div className="num">{String(i + 1).padStart(2, "0")}</div>
                        <div className="body">
                          <div className="assertion">{claim.text}</div>
                          <div className="cite mono">
                            <q>{claim.evidence.verbatim_quote}</q>
                            {!claim.evidence.redacted && (
                              <>
                                <span>{claim.evidence.speaker}</span>
                                <span>{claim.evidence.timestamp_label}</span>
                              </>
                            )}
                            <span>since v{claim.introduced_in_version}</span>
                          </div>
                        </div>
                      </article>
                    ))}
                  </section>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function DiffView({ diff }: { diff: BriefDiff }) {
  const nothing = diff.added.length === 0 && diff.removed.length === 0 && diff.edited.length === 0;

  return (
    <>
      <div className="banner info" style={{ margin: "0 0 22px" }}>
        Version {diff.from} → {diff.to}: {diff.added.length} added, {diff.edited.length} edited,{" "}
        {diff.removed.length} removed, {diff.unchanged} unchanged.
      </div>

      {nothing && (
        <div className="empty"><h3>No difference</h3><p>These two versions contain the same claims.</p></div>
      )}

      {diff.added.length > 0 && (
        <section className="doc-section">
          <h2 style={{ color: "var(--green)" }}>Added</h2>
          {diff.added.map((c) => (
            <div className="diff-block added" key={c.claim_id}>
              <span className="type-tag">{c.type_label}</span>
              <div className="assertion">{c.text}</div>
            </div>
          ))}
        </section>
      )}

      {diff.edited.length > 0 && (
        <section className="doc-section">
          <h2>Edited</h2>
          {diff.edited.map((c) => (
            <div className="diff-block edited" key={c.claim_id}>
              <span className="type-tag">{c.type_label}</span>
              <div className="was">{c.before}</div>
              <div className="now">{c.after}</div>
            </div>
          ))}
        </section>
      )}

      {diff.removed.length > 0 && (
        <section className="doc-section">
          <h2 style={{ color: "var(--red)" }}>Removed</h2>
          {diff.removed.map((c) => (
            <div className="diff-block removed" key={c.claim_id}>
              <span className="type-tag">{c.type_label}</span>
              <div className="assertion">{c.text}</div>
            </div>
          ))}
        </section>
      )}
    </>
  );
}
