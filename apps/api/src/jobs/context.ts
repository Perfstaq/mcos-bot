import { rawPrisma } from "../db.js";
import { runWithContext } from "../context.js";

/**
 * Jobs carry a tenant id, not a request. This resolves it into the same
 * context the HTTP edge installs, so every query a job makes is tenant-scoped
 * by exactly the same mechanism.
 */
export async function withTenantContext<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  const tenant = await rawPrisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) throw new Error(`Unknown tenant ${tenantId}`);
  return runWithContext(
    { tenantId: tenant.id, tenantSlug: tenant.slug, reviewer: "system:worker" },
    fn,
  );
}
