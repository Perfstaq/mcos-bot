import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  api,
  CLAIM_TYPE_LABEL,
  CLAIM_TYPE_ORDER,
  type BriefClaim,
  type BriefDiff,
  type BriefEdit,
  type BriefVersion,
  type BriefVersionSummary,
  type ClaimType,
} from "../api.js";

/**
 * The Living Positioning Brief, rendered as a document rather than a feed.
 *
 * Two things this screen has to make visible, because they are the product:
 *
 * Compounding. The right rail is the whole history — v1 to vN, each labelled
 * with the call it was merged from and what it changed. Clicking one renders
 * the brief AS OF then, not the current brief with old claims struck out.
 * Version 3 shows exactly what version 3 said, including claims later edited
 * into something else, because that is what "append-only" is for.
 *
 * Delta. A reviewer arriving straight from a merge wants to see what their
 * session did, so the diff is ON by default on that arrival (`?diff=1` from
 * the review queue) and off otherwise. It marks up the document in place —
 * new lines tinted, dropped lines struck through, rewrites shown from → to —
 * rather than opening a separate compare view, so the delta is read in the
 * context of the document it changed.
 */
export function Brief() {
  const [params, setParams] = useSearchParams();

  const [versions, setVersions] = useState<BriefVersionSummary[] | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [showDiff, setShowDiff] = useState(params.get("diff") === "1");
  const [doc, setDoc] = useState<BriefVersion | null>(null);
  const [diff, setDiff] = useState<BriefDiff | null>(null);
  const [error, setError] = useState<string | null>(null);

  const requested = Number.parseInt(params.get("v") ?? "", 10);

  const loadVersions = useCallback(async () => {
    try {
      const data = await api.get<{ versions: BriefVersionSummary[] }>("/brief/versions");
      setVersions(data.versions);
      setSelected((s) => {
        if (s !== null) return s;
        // A merge sends the reviewer here pointed at the version it just wrote.
        if (Number.isInteger(requested) && data.versions.some((v) => v.version === requested)) {
          return requested;
        }
        return data.versions[0]?.version ?? null;
      });
    } catch (e) {
      setError((e as Error).message);
    }
  }, [requested]);

  useEffect(() => {
    void loadVersions();
  }, [loadVersions]);

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

  // What this version changed: always against the one before it, so the marks
  // in the document answer "what did the merge that produced this do". v1 is
  // diffed against 0 — the empty brief — which the API takes as "against
  // nothing" rather than a missing version.
  useEffect(() => {
    if (!showDiff || selected === null) {
      setDiff(null);
      return;
    }
    void (async () => {
      try {
        setDiff(await api.get<BriefDiff>(`/brief/versions/${selected - 1}/diff/${selected}`));
      } catch (e) {
        // Clear first: a failed fetch that left the previous version's diff in
        // place would paint this version's document with the last one's marks,
        // labelling claims "+ NEW" that this merge never touched. Showing no
        // marks is honest; showing the wrong ones is not.
        setDiff(null);
        setError((e as Error).message);
      }
    })();
  }, [showDiff, selected]);

  const summary = versions?.find((v) => v.version === selected);
  const marks = useMemo(() => buildMarks(diff), [diff]);

  const choose = (version: number) => {
    setSelected(version);
    setParams((p) => {
      const next = new URLSearchParams(p);
      next.set("v", String(version));
      return next;
    });
  };

  const toggleDiff = () => {
    const next = !showDiff;
    setShowDiff(next);
    setParams((p) => {
      const updated = new URLSearchParams(p);
      if (next) updated.set("diff", "1");
      else updated.delete("diff");
      return updated;
    });
  };

  if (versions !== null && versions.length === 0) {
    return (
      <div className="screen">
        <header className="screen-head">
          <h1>Living Positioning Brief</h1>
        </header>
        <div className="empty" style={{ marginTop: 60 }}>
          <h3>The brief builds itself from your first approved call.</h3>
          <p>
            Nothing is written here except by the review gate. Keep some claims in the review
            queue and merge them; version 1 appears the moment you do.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="screen">
      <header className="screen-head">
        <h1>Living Positioning Brief</h1>
        <span className="sub">Append-only — every version is kept exactly as it was merged</span>
        <div className="grow" />

        <select
          className="select"
          aria-label="Brief version"
          value={selected ?? ""}
          onChange={(e) => choose(Number(e.target.value))}
        >
          {versions?.map((v) => (
            <option key={v.version} value={v.version}>
              v{v.version} · {shortDate(v.created_at)}
            </option>
          ))}
        </select>

        <button
          type="button"
          className={`btn${showDiff ? " primary" : ""}`}
          aria-pressed={showDiff}
          onClick={toggleDiff}
        >
          Diff
        </button>
      </header>

      <div className="panes">
        <div className="pane doc">
          {error && <div className="banner error">{error}</div>}
          <div className="pane-body scroll">
            <div className="doc-body">
              <h2 className="doc-title">Living Positioning Brief</h2>
              <div className="doc-sub">
                Version {selected} · {doc?.total ?? 0} approved claims
              </div>
              {summary && (
                <div className="doc-meta mono">
                  <span>merged by {summary.created_by}</span>
                  <span>{new Date(summary.created_at).toLocaleString()}</span>
                  {summary.source_meeting && <span>from {summary.source_meeting.title}</span>}
                  {summary.note && <span>“{summary.note}”</span>}
                </div>
              )}

              {showDiff && diff && <DiffSummary diff={diff} version={selected} />}

              <Document doc={doc} marks={marks} showDiff={showDiff} />
            </div>
          </div>
        </div>

        <nav className="pane versions" aria-label="Version history">
          <div className="pane-head">History</div>
          <div className="pane-body scroll">
            {versions === null && (
              <>
                <div className="skeleton" />
                <div className="skeleton" />
              </>
            )}
            {versions?.map((v) => (
              <button
                key={v.version}
                type="button"
                className={`version-item${selected === v.version ? " active" : ""}`}
                onClick={() => choose(v.version)}
              >
                <div className="vn">
                  v{v.version} · {shortDate(v.created_at)}
                </div>
                <div className="vsource">
                  {v.source_meeting?.title
                    ? `merged from ${v.source_meeting.title}`
                    : "merged from several calls"}
                </div>
                <div className="vmeta mono">
                  <span className="plus">+{v.counts.added}</span>
                  <span className="minus">−{v.counts.removed}</span>
                  <span className="tilde">~{v.counts.edited}</span>
                  <span className="grow" />
                  <span>{v.total} claims</span>
                </div>
              </button>
            ))}
          </div>
        </nav>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- the document */

type Marks = {
  added: Set<string>;
  edited: Map<string, BriefEdit>;
  removedByType: Map<ClaimType, BriefClaim[]>;
};

const EMPTY_MARKS: Marks = { added: new Set(), edited: new Map(), removedByType: new Map() };

function buildMarks(diff: BriefDiff | null): Marks {
  if (!diff) return EMPTY_MARKS;

  const removedByType = new Map<ClaimType, BriefClaim[]>();
  for (const claim of diff.removed) {
    const list = removedByType.get(claim.type);
    if (list) list.push(claim);
    else removedByType.set(claim.type, [claim]);
  }

  return {
    added: new Set(diff.added.map((c) => c.claim_id)),
    edited: new Map(diff.edited.map((e) => [e.claim_id, e])),
    removedByType,
  };
}

function Document({
  doc,
  marks,
  showDiff,
}: {
  doc: BriefVersion | null;
  marks: Marks;
  showDiff: boolean;
}) {
  if (!doc) return <div className="skeleton" style={{ height: 200 }} />;

  const present = new Map(doc.claims_by_type.map((g) => [g.type, g]));

  // A type whose every claim was dropped has no group in the document any
  // more, but the reader still needs to see that it emptied out — so the
  // section order is the union, walked in the document's own fixed order.
  const types = CLAIM_TYPE_ORDER.filter(
    (t) => present.has(t) || (showDiff && marks.removedByType.has(t)),
  );

  if (types.length === 0) {
    return (
      <div className="empty">
        <h3>Nothing in this version</h3>
        <p>Every claim that was here has since been withdrawn.</p>
      </div>
    );
  }

  return (
    <>
      {types.map((type) => {
        const group = present.get(type);
        const gone = showDiff ? (marks.removedByType.get(type) ?? []) : [];
        return (
          <section className="doc-section" key={type}>
            <h2>{group?.label ?? CLAIM_TYPE_LABEL[type]}</h2>
            {group?.claims.map((claim, i) => (
              <ClaimRow
                key={claim.claim_id}
                claim={claim}
                index={i}
                edit={showDiff ? marks.edited.get(claim.claim_id) : undefined}
                isNew={showDiff && marks.added.has(claim.claim_id)}
              />
            ))}
            {gone.map((claim) => (
              <ClaimRow key={`gone-${claim.claim_id}`} claim={claim} isGone />
            ))}
          </section>
        );
      })}
    </>
  );
}

function ClaimRow({
  claim,
  index,
  edit,
  isNew,
  isGone,
}: {
  claim: BriefClaim;
  index?: number;
  edit?: BriefEdit;
  isNew?: boolean;
  isGone?: boolean;
}) {
  const classes = [
    "doc-claim",
    claim.evidence.redacted ? "redacted" : "",
    isNew ? "is-new" : "",
    edit ? "is-edited" : "",
    isGone ? "is-gone" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    /* Focusable so the quote below is reachable without a mouse: it is the
       evidence a reviewer vouched for, not decoration. */
    <article className={classes} tabIndex={0}>
      <div className="num">{isGone ? "−" : String((index ?? 0) + 1).padStart(2, "0")}</div>
      <div className="body">
        {isNew && <span className="mark new">+ NEW</span>}
        {isGone && <span className="mark gone">− GONE</span>}
        {edit && <span className="mark changed">~ EDITED</span>}

        {edit ? (
          <>
            <div className="was">{edit.from}</div>
            <div className="assertion now">{edit.to}</div>
          </>
        ) : (
          <div className="assertion">{claim.text}</div>
        )}

        <div className="cite mono">
          <span className="src-chip">
            {claim.source?.meeting_title ?? "Purged call"}
            {claim.source?.meeting_date ? ` · ${shortDate(claim.source.meeting_date)}` : ""}
          </span>
          {!isGone && <span>since v{claim.introduced_in_version}</span>}
        </div>

        <div className="quote-reveal">
          <q>{claim.evidence.verbatim_quote}</q>
          {!claim.evidence.redacted && (
            <span className="mono">
              {claim.evidence.speaker} · {claim.evidence.timestamp_label}
            </span>
          )}
        </div>
      </div>
    </article>
  );
}

function DiffSummary({ diff, version }: { diff: BriefDiff; version: number | null }) {
  const nothing = diff.added.length === 0 && diff.removed.length === 0 && diff.edited.length === 0;

  return (
    <div className="banner info" style={{ margin: "0 0 22px" }}>
      {nothing ? (
        <>Version {version} contains the same claims as the one before it.</>
      ) : (
        <>
          What v{diff.to} changed: <b>{diff.added.length}</b> added, <b>{diff.edited.length}</b>{" "}
          edited, <b>{diff.removed.length}</b> removed, {diff.unchanged} carried forward.
        </>
      )}
    </div>
  );
}

/** "Aug 26" — the form the version rail and the source chips both read in. */
function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
