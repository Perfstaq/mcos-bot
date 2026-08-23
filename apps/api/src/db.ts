import { PrismaClient } from "@prisma/client";
import { currentContext } from "./context.js";

/**
 * Row-level tenancy.
 *
 * Every tenant-scoped model gets `tenantId` merged into its `where` (reads,
 * updates, deletes) and into its `data` (creates) from AsyncLocalStorage. A
 * query that escapes its tenant is therefore not expressible through this
 * client — you would have to reach for `$queryRaw` on purpose.
 *
 * Three models are exempt, each for a structural reason:
 *   Tenant        — it *is* the tenant; scoping it to itself is circular.
 *   ClaimSegment  — pure join table, tenancy is inherited from both sides.
 *   WebhookEvent  — written before the tenant is known (the payload has to be
 *                   parsed first), so it scopes itself explicitly.
 */
const UNSCOPED = new Set(["Tenant", "ClaimSegment", "WebhookEvent"]);

const WHERE_OPS = new Set([
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "findUnique",
  "findUniqueOrThrow",
  "count",
  "aggregate",
  "groupBy",
  "updateMany",
  "deleteMany",
]);

// Operations carrying both a filter and a payload.
const WHERE_AND_DATA_OPS = new Set(["update", "delete", "upsert"]);
const DATA_OPS = new Set(["create", "createMany", "createManyAndReturn"]);

type AnyArgs = Record<string, unknown>;

function withTenant<T extends AnyArgs | undefined>(obj: T, tenantId: string): AnyArgs {
  return { ...(obj ?? {}), tenantId };
}

const base = new PrismaClient({
  log: process.env.PRISMA_LOG === "query" ? ["query", "warn", "error"] : ["warn", "error"],
});

export const prisma = base.$extends({
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        const ctx = currentContext();
        if (!ctx || UNSCOPED.has(model)) return query(args);

        const a = args as AnyArgs;

        if (WHERE_OPS.has(operation) || WHERE_AND_DATA_OPS.has(operation)) {
          a["where"] = withTenant(a["where"] as AnyArgs | undefined, ctx.tenantId);
        }

        if (operation === "upsert") {
          a["create"] = withTenant(a["create"] as AnyArgs | undefined, ctx.tenantId);
        }

        if (DATA_OPS.has(operation)) {
          const data = a["data"];
          a["data"] = Array.isArray(data)
            ? data.map((row) => withTenant(row as AnyArgs, ctx.tenantId))
            : withTenant(data as AnyArgs | undefined, ctx.tenantId);
        }

        return query(a);
      },
    },
  },
});

export type Db = typeof prisma;

/** The unextended client, for the two places that legitimately cross tenants:
 *  tenant lookup at the edge, and the webhook log before the payload is parsed. */
export const rawPrisma = base;

export async function disconnect(): Promise<void> {
  await base.$disconnect();
}
