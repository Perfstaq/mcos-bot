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
 * `emailAndPassword.minPasswordLength` in the API's auth.ts. Duplicated rather
 * than fetched because the alternative is letting someone type a password,
 * submit it, and be told by the server what the rule was.
 */
const MIN_PASSWORD = 12;

/**
 * Create an account.
 *
 * Sign-up ends here, not at a workspace: the API creates the session (auth.ts
 * sets `autoSignIn`) but nobody has a workspace yet, and choosing or accepting
 * one is a decision of its own. RequireAuth routes the new session to
 * /onboarding on the next render, which is why this only has to get the
 * session right.
 */
export function SignUp() {
  const session = useSession();
  const providers = useAuthProviders();
  const location = useLocation();
  const [params] = useSearchParams();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<"email" | SocialProvider | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const from = (location.state as { from?: string } | null)?.from ?? "/";

  const code = params.get("error");
  const redirectFailure = code
    ? authErrorMessage({ code, message: params.get("error_description") ?? undefined })
    : null;

  if (session.isPending) return null;
  if (session.data) return <Navigate to={from} replace />;

  const message =
    failure ?? redirectFailure ?? (session.error ? authErrorMessage(session.error) : null);
  const tooShort = password.length > 0 && password.length < MIN_PASSWORD;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy("email");
    setFailure(null);

    const { data, error } = await authClient.signUp.email({
      name: name.trim(),
      email: email.trim().toLowerCase(),
      password,
    });

    if (error || !data) {
      setFailure(authErrorMessage(error));
      setBusy(null);
      return;
    }

    // Same reason as SignIn: the session atom refreshes on its own a tick
    // later, and navigating before it does races the guard.
    await session.refetch();
    setBusy(null);
  };

  const startSocial = async (provider: SocialProvider) => {
    setBusy(provider);
    setFailure(null);

    const { error } = await authClient.signIn.social({
      provider,
      callbackURL: `${window.location.origin}${from}`,
      errorCallbackURL: `${window.location.origin}/signup`,
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
            Create an account
          </h2>

          {message && (
            <div className="banner error" style={{ margin: "0 0 14px" }}>
              {message}
            </div>
          )}

          <form onSubmit={submit}>
            <label className="mono" htmlFor="signup-name" style={{ color: "var(--faint)", display: "block", marginBottom: 5 }}>
              NAME
            </label>
            <input
              className="input"
              id="signup-name"
              autoComplete="name"
              autoFocus
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={busy !== null}
              style={{ marginBottom: 12 }}
            />

            <label className="mono" htmlFor="signup-email" style={{ color: "var(--faint)", display: "block", marginBottom: 5 }}>
              EMAIL
            </label>
            <input
              className="input"
              id="signup-email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={busy !== null}
              style={{ marginBottom: 12 }}
            />

            <label className="mono" htmlFor="signup-password" style={{ color: "var(--faint)", display: "block", marginBottom: 5 }}>
              PASSWORD
            </label>
            <input
              className="input"
              id="signup-password"
              type="password"
              autoComplete="new-password"
              required
              minLength={MIN_PASSWORD}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy !== null}
              style={{ marginBottom: 6 }}
            />
            <p
              style={{
                margin: "0 0 16px",
                fontSize: 12,
                color: tooShort ? "var(--red)" : "var(--faint)",
              }}
            >
              At least {MIN_PASSWORD} characters.
            </p>

            <button
              className="btn primary"
              type="submit"
              style={{ width: "100%", justifyContent: "center" }}
              disabled={busy !== null || !name.trim() || !email.trim() || password.length < MIN_PASSWORD}
            >
              {busy === "email" ? "Creating…" : "Create account"}
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

              {/* The same grant carries calendar scopes (see auth.ts), so the
                  consent screen asks for more than a name and an email. Being
                  told that after the redirect is how people abandon it. */}
              <p style={{ margin: "10px 0 0", color: "var(--faint)", fontSize: 12 }}>
                Continuing with a provider also asks for read-only calendar access, so meetings can be
                picked up automatically.
              </p>
            </>
          )}

          {providers.error && (
            <p style={{ margin: "14px 0 0", color: "var(--faint)", fontSize: 12 }}>
              Single sign-on is unavailable — the provider list could not be read ({providers.error}).
            </p>
          )}
        </div>

        <p style={{ textAlign: "center", marginTop: 16, color: "var(--muted)" }}>
          Already have an account? <Link to="/signin" style={{ color: "var(--orange)" }}>Sign in</Link>
        </p>
      </div>
    </div>
  );
}
