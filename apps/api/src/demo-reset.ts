import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { disconnect, rawPrisma } from "./db.js";
import { env } from "./env.js";

/** The one tenant this command deletes by default. */
export const DEMO_SLUG = "freshworks-demo";

/**
 * Two independent gates, both required, neither a formality — this is a
 * command that deletes an organization and everything cascaded under it.
 *
 * 1. NODE_ENV is an ALLOWLIST, not `seed-golden.ts`'s shared
 *    `assertNotProduction` denylist. That denylist only refuses literal
 *    NODE_ENV=production, which lets anything else — including a staging
 *    deployment that (like many Node setups) runs with NODE_ENV=development
 *    or unset for reasons unrelated to whether it is safe to delete
 *    workspaces on — through untouched. A destructive command earns a
 *    narrower gate than a seed script: only `development` and `test` pass.
 * 2. The delete target must be `DEMO_SLUG` — REFUSED otherwise, never
 *    silently redirected to it. A `.env` that has drifted
 *    `DEFAULT_TENANT_SLUG` to point at a real tenant (or simply a typo)
 *    must not turn "reset the demo" into either "delete whatever slug is
 *    configured right now" (too dangerous) or "delete the demo tenant
 *    anyway, ignoring what was asked for" (silently surprising — and it
 *    would still leave the reseed step, which also reads
 *    `DEFAULT_TENANT_SLUG`, creating a workspace under a slug this command
 *    just told the operator it would not touch). Refusing is the only
 *    option that cannot go wrong quietly. `DEMO_RESET_CONFIRM` is the one
 *    way past this specific refusal — set it to the exact slug you mean,
 *    and only then does this command touch anything other than
 *    `DEMO_SLUG`.
 */
export function assertSafeToReset(nodeEnv: string, targetSlug: string): void {
  const ALLOWED_ENVS = new Set(["development", "test"]);
  if (!ALLOWED_ENVS.has(nodeEnv)) {
    throw new Error(
      `Refusing to run demo-reset outside development/test (NODE_ENV=${nodeEnv}). ` +
        "This is a destructive, tenant-deleting command; it does not use the " +
        "shared assertNotProduction denylist because that allows anything other " +
        "than literal NODE_ENV=production through, including a staging deployment.",
    );
  }

  if (targetSlug !== DEMO_SLUG && process.env.DEMO_RESET_CONFIRM !== targetSlug) {
    throw new Error(
      `Refusing to reset workspace "${targetSlug}" — demo-reset only targets ` +
        `"${DEMO_SLUG}" by default (DEFAULT_TENANT_SLUG is currently ` +
        `"${targetSlug}"). If you deliberately mean to reset a differently-slugged ` +
        `demo workspace, set DEMO_RESET_CONFIRM="${targetSlug}" to confirm it.`,
    );
  }
}

/**
 * DEV-ONLY. Resets the demo tenant to its pre-demo state by deleting it
 * outright and reseeding — never patches or deletes individual rows.
 *
 * `review_decisions` and `brief_versions` are append-only (invariant 3): a
 * script that went row-by-row un-deciding claims or deleting merged versions
 * to "rewind" a demo would be exactly the kind of write path this system is
 * built to forbid, applied to itself. The honest reset is the tenant does
 * not survive between demos. Deleting `organization` cascades through
 * `tenants` to every domain table (meetings, candidate_claims,
 * review_decisions, brief_versions, brief_claims — see the `onDelete:
 * Cascade` on each model's `tenant` relation in prisma/schema.prisma), so
 * this is one delete, not a bespoke wipe list to keep in sync by hand.
 *
 * This throws away real audit history for the freshworks-demo tenant. That is
 * fine for a tenant that exists purely to be reset before every demo, and it
 * is exactly why `assertSafeToReset` above is not a formality — this command
 * must never run anywhere a real tenant could share that slug, and never
 * against a different slug without an explicit, matching confirmation.
 */
export async function main(): Promise<void> {
  assertSafeToReset(env.NODE_ENV, env.DEFAULT_TENANT_SLUG);

  const org = await rawPrisma.organization.findUnique({ where: { slug: env.DEFAULT_TENANT_SLUG } });
  if (org) {
    console.log(`deleting workspace "${org.slug}" (${org.id}) and everything under it…`);
    await rawPrisma.organization.delete({ where: { id: org.id } });
  } else {
    console.log(`no existing "${env.DEFAULT_TENANT_SLUG}" workspace — first run, nothing to delete`);
  }
  await disconnect();

  const here = path.dirname(fileURLToPath(import.meta.url));
  console.log("reseeding the demo workspace and its meeting…");
  // The exact same CLI entrypoint `npm run db:seed:demo` uses — a reset that
  // reseeds any other way could drift from what a fresh clone actually gets.
  // An absolute path, not a bare "seed.ts" relative to `cwd`: tsx's own
  // module resolution resolves a relative CLI entry argument one directory
  // above the given `cwd`, which is surprising enough to be worth avoiding
  // rather than working around.
  const seedScript = path.resolve(here, "seed.ts");
  execFileSync("npx", ["tsx", seedScript, "--demo"], { cwd: here, stdio: "inherit", env: process.env });

  console.log(`"${env.DEFAULT_TENANT_SLUG}" is back to its pre-demo state.`);
}

// Not runnable through a test import: matches seed.ts / seed-golden.ts / the
// e2e stack's own global-setup.ts convention of guarding `main()` behind a
// direct-run check, so vitest can import `assertSafeToReset` (and, here,
// `main` itself for an integration-style refusal test) without executing a
// real delete as a side effect of the import.
const isDirectRun =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
