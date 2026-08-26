import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { disconnect, rawPrisma } from "./db.js";
import { env } from "./env.js";
import { assertNotProduction } from "./seed-golden.js";

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
 * is exactly why `assertNotProduction` below is not a formality — this
 * command must never run anywhere a real tenant could share that slug.
 */
async function main(): Promise<void> {
  assertNotProduction(env.NODE_ENV);

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

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
