import type { ReactNode } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { authErrorMessage, useListOrganizations, useSession } from "../auth-client.js";

/**
 * The gate in front of the workspace shell.
 *
 * Two questions, in order: is there a session, and is there a workspace to act
 * in. They are separate because the API's `resolveActor` treats them
 * separately — a signed-in user with no membership is not half-authenticated,
 * it is a user who has not finished onboarding, and sending them to /signin
 * would loop them through a form they have already completed.
 *
 * Usable either as a wrapper (`<RequireAuth><App /></RequireAuth>`) or as a
 * layout route (`<Route element={<RequireAuth />}>`), because where the shell
 * is mounted is the integrator's call, not this component's.
 */
export function RequireAuth({ children }: { children?: ReactNode }) {
  const session = useSession();
  const organizations = useListOrganizations();
  const location = useLocation();

  // Nothing at all, deliberately. A spinner and a flash of the shell both
  // assert the user is signed in before that is known, and the second one
  // shows the workspace layout to someone about to be bounced to /signin.
  if (session.isPending) return null;

  // A failed session fetch is not the same as no session. Redirecting on it
  // would turn "the API is down" into "your password is wrong", so it stays on
  // screen as what it is.
  if (session.error) {
    return (
      <Blocked
        title="Could not check your session"
        detail={authErrorMessage(session.error)}
        onRetry={() => void session.refetch()}
      />
    );
  }

  if (!session.data) {
    // `from` is carried so sign-in can return the user to what they asked for
    // rather than dropping them on the default screen.
    return <Navigate to="/signin" replace state={{ from: location.pathname + location.search }} />;
  }

  if (organizations.isPending) return null;

  if (organizations.error) {
    return (
      <Blocked
        title="Could not load your workspaces"
        detail={authErrorMessage(organizations.error)}
        onRetry={() => void organizations.refetch()}
      />
    );
  }

  const workspaces = organizations.data ?? [];
  const active = session.data.session.activeOrganizationId ?? null;

  // Mirrors `resolveActor` on the API exactly: it selects a lone membership
  // implicitly and refuses to guess between several. Those are therefore the
  // only two states a person still has to resolve — nothing to act in, or more
  // than one and nothing chosen. Anything else here would either send a
  // perfectly settled single-workspace user to onboarding forever, or let a
  // multi-workspace user into a shell where every request 401s.
  if (workspaces.length === 0 || (workspaces.length > 1 && !active)) {
    return <Navigate to="/onboarding" replace state={{ from: location.pathname + location.search }} />;
  }

  return <>{children ?? <Outlet />}</>;
}

/**
 * A dead end the user can act on. Deliberately not a redirect: both callers
 * are transport failures, and pretending they are a permissions outcome hides
 * the one piece of information that would help.
 */
function Blocked({ title, detail, onRetry }: { title: string; detail: string; onRetry: () => void }) {
  // Centred rather than headed: this renders both inside the shell and above
  // it, and a screen header would be a second, conflicting one in the first case.
  return (
    <div className="screen scroll" style={{ padding: 24 }}>
      <div className="empty" style={{ margin: "auto" }}>
        <h3>{title}</h3>
        <p>{detail}</p>
        <button className="btn" style={{ marginTop: 16 }} onClick={onRetry}>
          Try again
        </button>
      </div>
    </div>
  );
}
