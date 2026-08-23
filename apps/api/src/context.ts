import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The tenant a unit of work belongs to. Set once at the edge (HTTP request or
 * job start) and read by the Prisma extension in db.ts, so no query body has to
 * remember to filter by tenant.
 *
 * Milestone 1 has no auth: `tenantId` is resolved from a header. Swapping in
 * real authentication means changing where this store is populated — nothing
 * downstream cares.
 */
export type RequestContext = {
  tenantId: string;
  tenantSlug: string;
  reviewer: string;
};

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

export function requireContext(): RequestContext {
  const ctx = storage.getStore();
  if (!ctx) throw new Error("No tenant context — this query would escape row-level tenancy");
  return ctx;
}
