import { useCallback, useEffect, useState } from "react";
import { api, PLAN_FAILURE_LABEL, type PlanAttempt, type PlanAttemptStatus } from "../api.js";
import { IconRetry } from "./Icons.js";

/**
 * Plan builds — the Studio's view of `plan.build`
 * (ARCHITECTURE.md §12.25, §12.38).
 *
 * `03 §7` requires every failure state to be surfaced and retryable. Until
 * this existed, a plan build that hit `plan_infeasible` wrote nothing durable:
 * `RenderPlan` is append-only and a failure creates no row, no `Render` exists
 * yet, and there was no `GET /content/plans/:id`. A user who clicked build and
 * hit an infeasible plan saw a queued handle and then silence, forever.
 *
 * **Why a strip under the header and not a rail section.** The first version of
 * this lived in `.pane.rail-types`, and looking at it in a browser is what
 * caught the problem: `styles.css` hides that rail entirely below 1240px
 * (`@media (max-width: 1240px) { .pane.rail-types { display: none } }`). A
 * failure surface that disappears on a narrow window is a silent failure with
 * extra steps — which is the exact thing §12.25 exists to prevent. The strip
 * sits in normal flow under the screen header, which no breakpoint removes.
 *
 * It renders NOTHING when there is nothing to say. A permanent widget reporting
 * "0 failures" is the UI version of a permanently green gate: it stops being
 * read, and then it stops being noticed when it changes.
 *
 * Two more things it does deliberately:
 *
 *  - **Opens itself on a failure.** Discovery is half of "surfaced" — a reason
 *    nobody navigates to is not a surface.
 *  - **Shows the reason, not a code.** `failure_message` is the sentence the job
 *    wrote; the code sits beside it in mono for whoever is going to grep for
 *    it. A UI showing only `plan_infeasible` teaches nobody what to do next,
 *    which is the failure mode 03 §7 is written against.
 */

const STATUS_CHIP: Record<PlanAttemptStatus, string> = {
  queued: "working",
  built: "ready",
  infeasible: "error",
  failed: "error",
};

const STATUS_LABEL: Record<PlanAttemptStatus, string> = {
  queued: "building",
  built: "built",
  infeasible: "infeasible",
  failed: "failed",
};

/** Poll while anything is in flight. A build is seconds of pure computation
 *  (03 §3: `plan.build`, 60s timeout), so this settles quickly and then stops
 *  — no interval is left running against a list that cannot change. */
const POLL_MS = 2_000;

export function PlanBuilds() {
  const [plans, setPlans] = useState<PlanAttempt[] | null>(null);
  const [open, setOpen] = useState(false);
  const [touchedOpen, setTouchedOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ plans: PlanAttempt[]; total: number }>("/content/plans?limit=25");
      setPlans(data.plans);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const all = plans ?? [];
  const failed = all.filter((p) => p.status === "infeasible" || p.status === "failed");
  const building = all.filter((p) => p.status === "queued");

  useEffect(() => {
    if (!building.length) return;
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [building.length, load]);

  // Open the first time a failure appears. `touchedOpen` means a user who
  // deliberately collapsed it is not fought with on every poll.
  useEffect(() => {
    if (failed.length > 0 && !touchedOpen) setOpen(true);
  }, [failed.length, touchedOpen]);

  async function retry(plan: PlanAttempt) {
    setBusy(plan.id);
    setError(null);
    try {
      await api.post(`/content/plans/${plan.id}/retry`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  // Nothing in flight and nothing broken ⇒ nothing to say.
  if (!failed.length && !building.length) return null;

  const tone = failed.length ? "error" : "info";
  const summary = failed.length
    ? `${failed.length} plan build${failed.length === 1 ? "" : "s"} failed`
    : `Building ${building.length} plan${building.length === 1 ? "" : "s"}…`;
  const shown = failed.length ? failed : building;

  return (
    <div style={{ padding: "0 16px" }}>
      <div className={`banner ${tone}`} style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span>{summary}</span>
        <span style={{ flex: 1 }} />
        <button
          className="btn sm"
          onClick={() => {
            setTouchedOpen(true);
            setOpen((o) => !o);
          }}
        >
          {open ? "Hide" : "Show why"}
        </button>
      </div>

      {open && (
        <div
          className="pane"
          style={{ border: "1px solid var(--line)", borderRadius: 8, marginBottom: 12, padding: "2px 12px" }}
        >
          {error && <div className="banner error">{error}</div>}
          {shown.map((plan) => (
            <div
              key={plan.id}
              style={{
                padding: "10px 0",
                borderTop: "1px solid var(--line-soft)",
                display: "flex",
                alignItems: "flex-start",
                gap: 12,
                flexWrap: "wrap",
              }}
            >
              <span className={`chip ${STATUS_CHIP[plan.status]}`}>
                <span className={`dot${plan.status === "queued" ? " pulse" : ""}`} />
                {STATUS_LABEL[plan.status]}
              </span>

              <div style={{ flex: 1, minWidth: 220, display: "flex", flexDirection: "column", gap: 4 }}>
                {plan.failure_code ? (
                  <>
                    <div style={{ fontSize: 13, color: "var(--ink)", fontWeight: 600 }}>
                      {PLAN_FAILURE_LABEL[plan.failure_code] ?? plan.failure_code}
                    </div>
                    {/* The sentence the job wrote. This is the whole point of
                        the strip — 03 §7 asks for a reason, not a verdict. */}
                    {plan.failure_message && (
                      <div style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.5 }}>
                        {plan.failure_message}
                      </div>
                    )}
                    <div className="mono" style={{ fontSize: 11, color: "var(--faint)" }}>
                      {plan.failure_code} · plan {plan.id.slice(0, 8)}
                    </div>
                  </>
                ) : (
                  <div className="mono" style={{ fontSize: 12, color: "var(--muted)" }}>
                    plan {plan.id.slice(0, 8)}
                  </div>
                )}
              </div>

              {plan.retryable && (
                <button className="btn sm" disabled={busy === plan.id} onClick={() => void retry(plan)}>
                  <IconRetry size={13} /> {busy === plan.id ? "Retrying…" : "Retry"}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
