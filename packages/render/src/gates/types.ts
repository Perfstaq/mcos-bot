/**
 * Shared shape for every quality gate result (07_QUALITY_GATES §1).
 *
 * Lives in packages/render (not scripts/qc-render.ts) alongside gateG1a so
 * that BOTH call sites — the QC script and, later, Agent M's `plan.build`
 * job inside apps/api — import the exact same type, not two copies that
 * quietly drift.
 */
/**
 * A gate that does not APPLY to the artifact in front of it — as distinct from
 * one that applies and cannot be measured (`computable: false` on its own).
 *
 * The distinction is load-bearing and was paid for once already. G1b scores a
 * plan's cut times against pixel-detected scene cuts; a plan that plays footage
 * continuously has no content discontinuities for a detector to find, so the
 * gate reported a hard red on every template and every render (ARCHITECTURE
 * §12.3). A permanently red gate is a dead gate: reviewers learn to skip it, and
 * the day it fails for a REAL reason nobody notices. But silently dropping it is
 * worse — an unmeasured gate that reads as green is exactly the shape of the
 * defects this milestone kept finding.
 *
 * So an inapplicable gate says so, in a form a caller can branch on:
 *
 *   - `code` is stable and machine-readable — switch on this, not on prose.
 *   - `see` names the ruling that decided it, so the exclusion can be argued
 *     with rather than merely obeyed.
 *
 * Applicability is derived per-artifact, never hardcoded per-gate: the same
 * gate must score the moment an artifact appears that it can measure. See
 * ARCHITECTURE §12.37.
 */
export type GateNotApplicable = {
  code: string;
  see: string;
};

export type GateResult = {
  id: string;
  name: string;
  hard: boolean; // counts toward overall pass/fail when computable
  computable: boolean;
  pass: boolean | null; // null only when computable === false
  measured: unknown;
  target: string;
  note?: string;
  /** Present ⇒ this gate does not apply to this artifact and was excluded from
   *  the pass/fail rollup. Absent ⇒ it applies; `pass`/`computable` mean what
   *  they always meant. Never set alongside a `pass` of true or false. */
  notApplicable?: GateNotApplicable;
};
