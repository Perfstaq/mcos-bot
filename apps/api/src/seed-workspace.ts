import { rawPrisma } from "./db.js";
import { auth } from "./auth.js";
import { env } from "./env.js";

/**
 * Extracted from seed.ts so both the demo seed and the golden-fixtures seed
 * (seed-golden.ts) create the exact same demo tenant the exact same way,
 * instead of two scripts drifting apart on how a workspace gets provisioned.
 *
 * The default is documented in the README, so it is not a secret. SEED_PASSWORD
 * may well be, which is why neither is ever printed: a seed script's output
 * lands in terminal history, CI logs and log aggregators, and a script that
 * decides case-by-case whether a credential is "safe enough to echo" gets it
 * wrong eventually. It reports which source was used and nothing more.
 */
const DEFAULT_DEMO_PASSWORD = "perfstaq-demo-password";
const DEMO_PASSWORD = process.env.SEED_PASSWORD ?? DEFAULT_DEMO_PASSWORD;
const PASSWORD_SOURCE = process.env.SEED_PASSWORD
  ? "the value of SEED_PASSWORD"
  : "the default documented in the README";

export function passwordSourceMessage(email: string): string {
  return `sign in as ${email} — password is ${PASSWORD_SOURCE}`;
}

/**
 * Create the demo account through Better Auth rather than by inserting rows.
 *
 * Writing a user and a member row directly would produce an account that cannot
 * sign in — the password would be unhashed, the `issuer` unset, and the
 * organization's tenant never provisioned, because all three happen inside the
 * auth layer. Going through the public API means the seeded workspace is
 * identical to one a real signup produces.
 */
export async function seedWorkspace(): Promise<{ tenantId: string; email: string }> {
  const email = env.DEFAULT_REVIEWER_EMAIL;

  const existing = await rawPrisma.user.findUnique({ where: { email }, select: { id: true } });
  if (!existing) {
    await auth.api.signUpEmail({
      body: { email, password: DEMO_PASSWORD, name: "Demo Reviewer" },
    });
    console.log(`user ${email} created`);
  }

  const user = await rawPrisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } });

  const org = await rawPrisma.organization.findUnique({
    where: { slug: env.DEFAULT_TENANT_SLUG },
    include: { tenant: { select: { id: true } } },
  });

  if (org?.tenant) return { tenantId: org.tenant.id, email };

  // createOrganization runs afterCreateOrganization, which provisions the
  // tenant. Calling it with the user's headers is what makes them the owner.
  const created = await auth.api.createOrganization({
    body: { name: "Freshworks (demo)", slug: env.DEFAULT_TENANT_SLUG, userId: user.id },
  });
  if (!created) throw new Error("Better Auth declined to create the demo organization");

  const tenant = await rawPrisma.tenant.findUniqueOrThrow({
    where: { organizationId: created.id },
    select: { id: true, slug: true },
  });
  console.log(`workspace ${tenant.slug} -> tenant ${tenant.id}`);
  return { tenantId: tenant.id, email };
}
