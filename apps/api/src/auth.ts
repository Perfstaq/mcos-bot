import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { admin, organization } from "better-auth/plugins";
import { rawPrisma } from "./db.js";
import { authBaseUrl, env, allowedOrigins, googleConfigured, microsoftConfigured } from "./env.js";

/**
 * Authentication and workspace membership.
 *
 * Better Auth owns identity: users, sessions, credentials, OAuth accounts,
 * organizations, members and invitations. It uses `rawPrisma` deliberately —
 * the tenancy extension keys off a resolved tenant, and resolving the tenant is
 * exactly what this layer does. It is the one place that legitimately runs
 * before a tenant exists.
 *
 * Calendar access rides on the same OAuth grant as sign-in rather than a second
 * consent screen, which is why the Google and Microsoft scopes below include
 * calendar reads. `accessType: "offline"` plus `prompt: "consent"` is what makes
 * Google return a refresh token — without both, the grant silently expires in an
 * hour and calendar sync dies a week later with no obvious cause.
 */
export const auth = betterAuth({
  appName: "MCOS",
  baseURL: authBaseUrl,
  basePath: "/api/auth",
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins: allowedOrigins,

  database: prismaAdapter(rawPrisma, { provider: "postgresql" }),

  emailAndPassword: {
    enabled: true,
    minPasswordLength: 12,
    autoSignIn: true,
    // Left off until an email transport is configured — turning it on without
    // one locks every new account out rather than securing anything.
    requireEmailVerification: false,
  },

  socialProviders: {
    ...(googleConfigured
      ? {
          google: {
            clientId: env.GOOGLE_CLIENT_ID!,
            clientSecret: env.GOOGLE_CLIENT_SECRET!,
            accessType: "offline",
            prompt: "consent",
            scope: [
              "https://www.googleapis.com/auth/calendar.readonly",
              "https://www.googleapis.com/auth/calendar.events.readonly",
            ],
          },
        }
      : {}),
    ...(microsoftConfigured
      ? {
          microsoft: {
            clientId: env.MICROSOFT_CLIENT_ID!,
            clientSecret: env.MICROSOFT_CLIENT_SECRET!,
            tenantId: env.MICROSOFT_TENANT_ID,
            scope: ["Calendars.Read", "offline_access", "User.Read"],
          },
        }
      : {}),
  },

  session: {
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
    cookieCache: { enabled: true, maxAge: 5 * 60 },
  },

  account: {
    accountLinking: { enabled: true, trustedProviders: ["google", "microsoft"] },
  },

  advanced: {
    // Cross-site cookies are required when the SPA is served from a different
    // origin than the API, which is the case in local development.
    // `secure` follows the transport, not the build mode. Forcing it on in
    // production is the obvious rule and the wrong one: a production stack
    // reachable over plain HTTP — a load balancer with no certificate yet —
    // would set cookies the browser silently refuses, and sign-in would appear
    // to succeed and then not stick, with nothing in any log to explain it.
    //
    // Running production over HTTP is a real posture, not a mistake to be
    // defended against by breaking it. It is announced loudly at boot instead;
    // see the warning in server.ts.
    defaultCookieAttributes: {
      sameSite: env.NODE_ENV === "production" ? "lax" : "none",
      secure: authBaseUrl.startsWith("https"),
      httpOnly: true,
    },
  },

  databaseHooks: {
    account: {
      create: {
        // A linked Google or Microsoft account with calendar scope becomes a
        // calendar connection. Failures are logged and swallowed on purpose:
        // this is a convenience, and a broken calendar provisioning step must
        // never be the reason a user cannot sign in.
        after: async (account) => {
          try {
            const { syncCalendarConnectionsForUser } = await import("./domain/calendar-connections.js");
            await syncCalendarConnectionsForUser(account.userId);
          } catch (error) {
            const { logger } = await import("./logger.js");
            logger.error(
              { err: (error as Error).message, userId: account.userId },
              "could not provision calendar connection after account link",
            );
          }
        },
      },
    },
  },

  plugins: [
    organization({
      allowUserToCreateOrganization: true,
      organizationLimit: 5,
      membershipLimit: 200,
      creatorRole: "owner",
      invitationExpiresIn: 60 * 60 * 48,
      organizationHooks: {
        // The domain's tenant is created with the workspace, not lazily on
        // first use. Eager provisioning means no downstream code path ever has
        // to handle a workspace whose tenant does not exist yet — the 1:1 is
        // true from the moment the organization row is written.
        afterCreateOrganization: async ({ organization, user }) => {
          const { provisionTenantForOrganization } = await import("./authz.js");
          await provisionTenantForOrganization({
            organizationId: organization.id,
            slug: organization.slug,
            name: organization.name,
          });
          // Accounts linked before the workspace existed could not become
          // calendar connections at link time. Backfill them now.
          try {
            const { syncCalendarConnectionsForUser } = await import(
              "./domain/calendar-connections.js"
            );
            await syncCalendarConnectionsForUser(user.id);
          } catch {
            // Non-fatal; see the account hook above.
          }
        },
      },
    }),
    admin({ defaultRole: "user", adminRoles: ["admin"] }),
  ],
});

export type Auth = typeof auth;
export type Session = Auth["$Infer"]["Session"];
