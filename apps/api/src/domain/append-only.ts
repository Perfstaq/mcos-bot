/**
 * APPEND-ONLY MEMORY, enforced rather than agreed.
 *
 * Invariant 3 says a brief_versions row is never updated or deleted and that
 * new state is a new version. Until now that was a convention: `mergeApprovedClaims`
 * only ever inserted, and everyone downstream was expected to keep it that way.
 * A convention is exactly the wrong shape for this particular rule, because the
 * failure it prevents is silent — a version quietly rewritten still reads like a
 * version, and the provenance it was keeping is gone with no trace that anything
 * happened.
 *
 * So the client itself refuses. Every write through `db.ts`'s extended client
 * passes through `assertAppendOnly`, which allows inserts and reads and turns
 * anything else on the two brief tables into a thrown error before it reaches
 * Postgres. A future route cannot add a rewrite path by accident, and a test
 * (tests/brief.test.ts) proves both halves: that the guard fires, and that no
 * module in src/ is trying to get past it.
 *
 * One narrow exception, and only one: the meeting purge redacts evidence in
 * place. Deleting a merged claim's row instead would make positioning memory
 * silently lose content, which is the other half of the same invariant — so the
 * purge scrubs `verbatimQuote` and raises `evidenceRedacted` while leaving the
 * claim and its version intact. Those two columns are the entire allowance;
 * a write touching anything else is refused however it is dressed up.
 */

/** The tables that only ever grow. */
export const APPEND_ONLY_MODELS = new Set(["BriefVersion", "BriefClaim"]);

/** Operations that add rows. Always fine — growth is the point. */
const INSERT_OPS = new Set(["create", "createMany", "createManyAndReturn"]);

/**
 * The only columns the purge may rewrite on a published brief row, and only on
 * BriefClaim. See routes/meetings.ts — the claim survives, the evidence does not.
 */
const REDACTION_FIELDS = new Set(["evidenceRedacted", "verbatimQuote"]);

const REDACTABLE_MODEL = "BriefClaim";
const REDACTION_OPS = new Set(["update", "updateMany"]);

export class AppendOnlyViolationError extends Error {
  constructor(
    readonly model: string,
    readonly operation: string,
  ) {
    super(
      `${model} is append-only: ${operation} is not a thing that may happen to it. ` +
        "A brief version records what the workspace believed at a moment in time; " +
        "changing that record is not an update, it is a forgery. Merge a new version instead.",
    );
    this.name = "AppendOnlyViolationError";
  }
}

/**
 * Throw unless this operation is one an append-only table permits.
 *
 * Deliberately reads `data` rather than trusting the call site: the redaction
 * allowance is about which COLUMNS move, not about who is asking.
 */
export function assertAppendOnly(model: string, operation: string, args: unknown): void {
  if (!APPEND_ONLY_MODELS.has(model)) return;
  if (INSERT_OPS.has(operation)) return;
  if (isReadOperation(operation)) return;

  if (model === REDACTABLE_MODEL && REDACTION_OPS.has(operation) && isRedaction(args)) return;

  throw new AppendOnlyViolationError(model, operation);
}

const READ_OPS = new Set([
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "findUnique",
  "findUniqueOrThrow",
  "count",
  "aggregate",
  "groupBy",
]);

function isReadOperation(operation: string): boolean {
  return READ_OPS.has(operation);
}

/** True only when every column the write touches is one the purge may scrub. */
function isRedaction(args: unknown): boolean {
  const data = (args as { data?: unknown } | undefined)?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;

  const keys = Object.keys(data as Record<string, unknown>);
  return keys.length > 0 && keys.every((key) => REDACTION_FIELDS.has(key));
}
