import { useState } from "react";
import { Link, Navigate, useLocation, useSearchParams } from "react-router-dom";
import {
  authClient,
  authErrorMessage,
  SOCIAL_PROVIDER_LABEL,
  useAuthProviders,
  useSession,
  type SocialProvider,
} from "../auth-client.js";
import { PerfstaqLogo } from "../components/PerfstaqLogo.js";

/**
 * Sign in.
 *
 * The redirect is driven by the session, not by the response to the sign-in
 * call. Better Auth refreshes its session atom on a timer a tick after the
 * call resolves, so navigating on the response races that refresh and can land
 * on a guarded route that still sees no session and bounces straight back
 * here. Refetching and letting the render decide has no such window.
 */
export function SignIn() {
  const session = useSession();
  const providers = useAuthProviders();
  const location = useLocation();
  const [params] = useSearchParams();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<"email" | SocialProvider | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  // Where the gate turned them away from, so sign-in returns them to the thing
  // they asked for rather than to the default screen.
  const from = (location.state as { from?: string } | null)?.from ?? "/";

  // An OAuth round trip that fails comes back as a redirect, not as a rejected
  // promise — the only trace is on the query string, and unread it would leave
  // the user staring at a form that gave no reason.
  const code = params.get("error");
  const redirectFailure = code
    ? authErrorMessage({ code, message: params.get("error_description") ?? undefined })
    : null;

  if (session.isPending) return null;
  if (session.data) return <Navigate to={from} replace />;

  const message =
    failure ?? redirectFailure ?? (session.error ? authErrorMessage(session.error) : null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy("email");
    setFailure(null);

    const { data, error } = await authClient.signIn.email({
      email: email.trim().toLowerCase(),
      password,
    });

    if (error || !data) {
      setFailure(authErrorMessage(error));
      setBusy(null);
      return;
    }

    await session.refetch();
    setBusy(null);
  };

  const startSocial = async (provider: SocialProvider) => {
    setBusy(provider);
    setFailure(null);

    // On success the client navigates the browser to the provider, so this
    // only resolves at all when there is something to report.
    const { error } = await authClient.signIn.social({
      provider,
      callbackURL: `${window.location.origin}${from}`,
      errorCallbackURL: `${window.location.origin}/signin`,
    });

    if (error) {
      setFailure(authErrorMessage(error));
      setBusy(null);
    }
  };

  return (
    <div className="screen scroll" style={{ padding: 24 }}>
      <div style={{ width: "min(380px, 100%)", margin: "auto" }}>
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 26 }}>
          <PerfstaqLogo height={22} animate />
        </div>

        <div className="modal" style={{ width: "auto" }}>
          <h2 style={{ margin: "2px 0 16px", fontSize: 20, fontWeight: 600, letterSpacing: "-0.02em" }}>
            Sign in
          </h2>

          {message && (
            <div className="banner error" style={{ margin: "0 0 14px" }}>
              {message}
            </div>
          )}

          <form onSubmit={submit}>
            <label className="mono" htmlFor="signin-email" style={{ color: "var(--faint)", display: "block", marginBottom: 5 }}>
              EMAIL
            </label>
            <input
              className="input"
              id="signin-email"
              type="email"
              autoComplete="email"
              autoFocus
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={busy !== null}
              style={{ marginBottom: 12 }}
            />

            <label className="mono" htmlFor="signin-password" style={{ color: "var(--faint)", display: "block", marginBottom: 5 }}>
              PASSWORD
            </label>
            <input
              className="input"
              id="signin-password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy !== null}
              style={{ marginBottom: 16 }}
            />

            <button
              className="btn primary"
              type="submit"
              style={{ width: "100%", justifyContent: "center" }}
              disabled={busy !== null || !email.trim() || !password}
            >
              {busy === "email" ? "Signing in…" : "Sign in"}
            </button>
          </form>

          {providers.providers.length > 0 && (
            <>
              <div
                className="mono"
                style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--faint)", margin: "16px 0" }}
              >
                <span style={{ flex: 1, height: 1, background: "var(--line)" }} />
                OR
                <span style={{ flex: 1, height: 1, background: "var(--line)" }} />
              </div>

              {providers.providers.map((provider) => (
                <button
                  key={provider}
                  className="btn"
                  style={{ width: "100%", justifyContent: "center", marginBottom: 8 }}
                  disabled={busy !== null}
                  onClick={() => void startSocial(provider)}
                >
                  {busy === provider
                    ? `Redirecting to ${SOCIAL_PROVIDER_LABEL[provider]}…`
                    : `Continue with ${SOCIAL_PROVIDER_LABEL[provider]}`}
                </button>
              ))}
            </>
          )}

          {/* Not an error banner: email sign-in still works, and shouting about
              a failed side-quest would bury the form that does. */}
          {providers.error && (
            <p style={{ margin: "14px 0 0", color: "var(--faint)", fontSize: 12 }}>
              Single sign-on is unavailable — the provider list could not be read ({providers.error}).
            </p>
          )}
        </div>

        <p style={{ textAlign: "center", marginTop: 16, color: "var(--muted)" }}>
          No account yet? <Link to="/signup" style={{ color: "var(--orange)" }}>Create one</Link>
        </p>
      </div>
    </div>
  );
}
