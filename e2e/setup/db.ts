import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { e2eAdminDatabaseUrl, e2eDatabaseUrl } from "../env.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(here, "../../apps/api");

/**
 * Brings `mcos_e2e` into existence and up to the current migration, then
 * wipes it — a clean ring every run, the same reasoning as
 * `apps/api/tests/helpers.ts#resetDb` but for a database no test file shares
 * with anything else. Uses a plain `PrismaClient`, not `apps/api/src/db.ts`'s
 * tenancy-scoped export: there is no tenant context yet, and creating a
 * database is not a tenant-scoped operation to begin with.
 */
export async function resetE2eDatabase(): Promise<void> {
  const admin = new PrismaClient({ datasourceUrl: e2eAdminDatabaseUrl() });
  try {
    const dbName = new URL(e2eDatabaseUrl()).pathname.replace(/^\//, "");
    await admin.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`);
  } catch (error) {
    const message = (error as Error).message;
    if (!message.includes("already exists")) throw error;
  } finally {
    await admin.$disconnect();
  }

  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    cwd: apiDir,
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: e2eDatabaseUrl() },
  });

  const db = new PrismaClient({ datasourceUrl: e2eDatabaseUrl() });
  try {
    // Better Auth's own tables cascade from "organization" and "user"; every
    // domain table cascades from "tenants". One statement, so nothing can
    // observe the database half-truncated.
    await db.$executeRawUnsafe(
      `TRUNCATE TABLE "tenants", "organization", "user", "verification" CASCADE`,
    );
  } finally {
    await db.$disconnect();
  }
}
