import { useEffect, useState } from "react";
import { organizationClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { api } from "./api.js";

/**
 * The browser half of Better Auth.
 *
 * `baseURL` is put through `new URL()` before it is used, so the bare path the
 * API mounts on — "/api/auth" — is rejected at construction with "Invalid base
 * URL: /api/auth". Origin plus `basePath` resolves to exactly that path and
 * needs no environment branch: Vite proxies /api to the API in dev, and in
 * production one origin serves the SPA and the API together.
 */
export const authClient = createAuthClient({
  baseURL: window.location.origin,
  basePath: "/api/auth",
  // A workspace is part of identity here, not a screen. The API reads the
  // active organization off the session, so switching one is a session write
  // rather than a parameter a request could carry — and this plugin is what
  // gives the client the same view of membership the server has.
  plugins: [organizationClient()],
});

export const {
  useSession,
  useListOrganizations,
  useActiveOrganization,
  signIn,
  signUp,
  signOut,
  organization,
} = authClient;

export type Session = typeof authClient.$Infer.Session;

/** The roles the organization plugin issues, most privileged first. */
export const WORKSPACE_ROLES = ["owner", "admin", "member"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

const ROLE_RANK: Record<string, number> = { owner: 3, admin: 2, member: 1 };

/**
 * The plugin stores multiple roles comma-joined in a single column, so a bare
 * `role === "owner"` quietly fails for anyone holding two of them. The API's
 * workspace routes split on the same comma; a UI that did not would offer
 * controls the server then refuses, which reads to the user as a broken button
 * rather than as a permission they do not have.
 */
export function hasRole(role: string | null | undefined, atLeast: WorkspaceRole): boolean {
  const held = (role ?? "").split(",").map((r) => r.trim());
  const best = held.reduce((max, r) => Math.max(max, ROLE_RANK[r] ?? 0), 0);
  return best >= (ROLE_RANK[atLeast] ?? 0);
}

/**
 * Better Auth answers with `{ data, error }` instead of throwing, which makes
 * an unread `error` a silently swallowed failure rather than a crash somebody
 * would notice. Every call in this app routes its error through here and puts
 * the result on screen.
 */
export function authErrorMessage(
  error:
    | { code?: string | undefined; message?: string | undefined; status?: number; statusText?: string }
    | null
    | undefined,
): string {
  if (!error) return "Something went wrong. Try again.";

  const message = error.message?.trim();
  if (message) return message;

  // Codes arrive SCREAMING_SNAKE. Left raw they read like a stack trace leaked
  // into the interface.
  if (error.code) {
    const words = error.code.replace(/_/g, " ").toLowerCase();
    return words.charAt(0).toUpperCase() + words.slice(1);
  }

  return error.statusText || `Request failed with status ${error.status ?? "unknown"}`;
}

/* --------------------------------------------------------- social providers */

export const SOCIAL_PROVIDERS = ["google", "microsoft"] as const;
export type SocialProvider = (typeof SOCIAL_PROVIDERS)[number];

export const SOCIAL_PROVIDER_LABEL: Record<SocialProvider, string> = {
  google: "Google",
  microsoft: "Microsoft",
};

export type ProviderDiscovery = {
  providers: SocialProvider[];
  loading: boolean;
  /** Why single sign-on is not on offer, when it is not. Never swallowed. */
  error: string | null;
};

/**
 * Which social providers the API actually holds credentials for.
 *
 * The buttons are driven by the server's answer rather than rendered
 * unconditionally: signing in with an unconfigured provider costs a full
 * redirect before the auth handler returns PROVIDER_NOT_FOUND, which is a
 * worse failure than never having offered it. A failed probe degrades to
 * email-only so nobody is locked out of a working sign-in by a broken
 * side-quest — but it reports why, because a provider that silently vanishes
 * is indistinguishable from one that was never configured.
 */
export function useAuthProviders(): ProviderDiscovery {
  const [state, setState] = useState<ProviderDiscovery>({ providers: [], loading: true, error: null });

  useEffect(() => {
    let live = true;

    void (async () => {
      try {
        const data = await api.get<{ providers: string[] }>("/auth/providers");
        if (!live) return;
        // Filtered against what this build has a button for, rather than
        // trusted: the response decides availability, not the UI's shape.
        const providers = SOCIAL_PROVIDERS.filter((p) => data.providers?.includes(p));
        setState({ providers, loading: false, error: null });
      } catch (e) {
        if (!live) return;
        setState({ providers: [], loading: false, error: (e as Error).message });
      }
    })();

    return () => {
      live = false;
    };
  }, []);

  return state;
}
