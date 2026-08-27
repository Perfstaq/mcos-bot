/**
 * Shared shape for every quality gate result (07_QUALITY_GATES §1).
 *
 * Lives in packages/render (not scripts/qc-render.ts) alongside gateG1a so
 * that BOTH call sites — the QC script and, later, Agent M's `plan.build`
 * job inside apps/api — import the exact same type, not two copies that
 * quietly drift.
 */
export type GateResult = {
  id: string;
  name: string;
  hard: boolean; // counts toward overall pass/fail when computable
  computable: boolean;
  pass: boolean | null; // null only when computable === false
  measured: unknown;
  target: string;
  note?: string;
};
