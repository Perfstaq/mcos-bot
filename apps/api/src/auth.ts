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
    defaultCookieAttributes: {
      sameSite: env.NODE_ENV === "production" ? "lax" : "none",
      secure: env.NODE_ENV === "production" || authBaseUrl.startsWith("https"),
      httpOnly: true,
    },
  },

  plugins: [
    organization({
      allowUserToCreateOrganization: true,
      organizationLimit: 5,
      membershipLimit: 200,
      creatorRole: "owner",
      invitationExpiresIn: 60 * 60 * 48,
    }),
    admin({ defaultRole: "user", adminRoles: ["admin"] }),
  ],
});

export type Auth = typeof auth;
export type Session = Auth["$Infer"]["Session"];
