import { useEffect, useState } from "react";
import { Navigate, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import {
  authClient,
  authErrorMessage,
  useListOrganizations,
  useSession,
} from "../auth-client.js";
import { PerfstaqLogo } from "../components/PerfstaqLogo.js";

type PendingInvitation = {
  id: string;
  organizationId: string;
  organizationName: string;
  role: string;
};

/**
 * The slug is not decoration. `provisionTenantForOrganization` copies it onto
 * the Tenant row that every scoped query in the product keys off, and both
 * columns are unique — so a name that slugs to something already taken fails,
 * and it fails on the server where both uniqueness rules actually live. This
 * only has to produce something plausible and let the server be the judge.
 */
function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/**
 * The fork between having a session and having somewhere to use it.
 *
 * Three ways out, and a person can arrive needing any of them: create the
 * first workspace, accept an invitation to someone else's, or pick between
 * several they already belong to. They are all on one screen because which one
 * applies is not something the user should have to know before they get here.
 */
export function Onboarding() {
  const session = useSession();
  const organizations = useListOrganizations();
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();

  const [invitations, setInvitations] = useState<PendingInvitation[] | null>(null);
  const [invitationNote, setInvitationNote] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const from = (location.state as { from?: string } | null)?.from ?? "/";
  const linkedInvitation = params.get("invitation");

  useEffect(() => {
    let live = true;

    void (async () => {
      const found = new Map<string, PendingInvitation>();
      let note: string | null = null;

      const listed = await authClient.organization.listUserInvitations();
      if (listed.error) {
        // Better Auth will not list a user's invitations by email until that
        // email is verified, and in this deployment nothing verifies one —
        // auth.ts has no mail transport, so every password account stays at
        // emailVerified=false. That is a known configuration state rather than
        // a fault, and it does not block anything: accepting a known
        // invitation id has no such gate, which is what the link below is for.
        note =
          listed.error.code === "EMAIL_VERIFICATION_REQUIRED_FOR_INVITATION"
            ? "Invitations sent to you cannot be listed until your email address is verified. Open the invitation link you were sent and it will still work."
            : authErrorMessage(listed.error);
      } else {
        for (const invitation of listed.data ?? []) {
          found.set(invitation.id, {
            id: invitation.id,
            organizationId: invitation.organizationId,
            organizationName: invitation.organizationName,
            role: invitation.role,
          });
        }
      }

      // An invitation reaches a human as a link today, because nothing emails
      // it (see the invitations route in the API). Resolving the id on the URL
      // is therefore the primary path, not a fallback.
      if (linkedInvitation && !found.has(linkedInvitation)) {
        const one = await authClient.organization.getInvitation({ query: { id: linkedInvitation } });
        if (one.error) note = authErrorMessage(one.error);
        else if (one.data) {
          found.set(one.data.id, {
            id: one.data.id,
            organizationId: one.data.organizationId,
            organizationName: one.data.organizationName,
            role: one.data.role,
          });
        }
      }

      if (!live) return;
      setInvitations([...found.values()]);
      setInvitationNote(note);
    })();

    return () => {
      live = false;
    };
  }, [linkedInvitation]);

  if (session.isPending) return null;
  if (!session.data) return <Navigate to="/signin" replace state={{ from: location.pathname + location.search }} />;

  // Held until both answers are in. Rendering early flips the heading from
  // "set up your workspace" to "choose a workspace" a beat later, which
  // tells a returning user their workspaces are gone before it corrects
  // itself.
  if (organizations.isPending || invitations === null) return null;

  const workspaces = organizations.data ?? [];
  const proposedSlug = slugEdited ? slug : slugify(name);
  const message =
    failure ??
    (organizations.error ? authErrorMessage(organizations.error) : null) ??
    (session.error ? authErrorMessage(session.error) : null);

  /**
   * Make a workspace the one this session acts in.
   *
   * Always explicit, even straight after creating one: `/organization/create`
   * only sets the active organization when its middleware has already resolved
   * a session, and the API's `resolveActor` refuses to guess once a user has
   * more than one membership. Setting it here means the next request has an
   * answer regardless of how the user arrived.
   */
  const enter = async (organizationId: string) => {
    const { error } = await authClient.organization.setActive({ organizationId });
    if (error) {
      setFailure(authErrorMessage(error));
      setBusy(null);
      return;
    }
    await session.refetch();
    setBusy(null);
    navigate(from, { replace: true });
  };

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy("create");
    setFailure(null);

    const { data, error } = await authClient.organization.create({
      name: name.trim(),
      slug: proposedSlug,
    });

    if (error || !data) {
      setFailure(authErrorMessage(error));
      setBusy(null);
      return;
    }
    await enter(data.id);
  };

  const accept = async (invitation: PendingInvitation) => {
    setBusy(invitation.id);
    setFailure(null);

    const { data, error } = await authClient.organization.acceptInvitation({
      invitationId: invitation.id,
    });

    if (error || !data) {
      setFailure(authErrorMessage(error));
      setBusy(null);
      return;
    }
    await enter(data.member?.organizationId ?? invitation.organizationId);
  };

  const open = async (organizationId: string) => {
    setBusy(organizationId);
    setFailure(null);
    await enter(organizationId);
  };

  return (
    <div className="screen scroll" style={{ padding: 24 }}>
      <div style={{ width: "min(460px, 100%)", margin: "auto" }}>
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 26 }}>
          <PerfstaqLogo height={22} animate />
        </div>

        <div className="modal" style={{ width: "auto" }}>
          <h2 style={{ margin: "2px 0 16px", fontSize: 20, fontWeight: 600, letterSpacing: "-0.02em" }}>
            {workspaces.length > 0 ? "Choose a workspace" : "Set up your workspace"}
          </h2>

          {message && (
            <div className="banner error" style={{ margin: "0 0 14px" }}>
              {message}
            </div>
          )}

          {invitations.length > 0 && (
            <div style={{ marginBottom: 22 }}>
              <h3>Invitations</h3>
              {invitations.map((invitation) => (
                <div
                  key={invitation.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "9px 0",
                    borderTop: "1px solid var(--line-soft)",
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{invitation.organizationName}</div>
                    <div className="mono" style={{ color: "var(--faint)" }}>as {invitation.role}</div>
                  </div>
                  <button
                    className="btn primary sm"
                    disabled={busy !== null}
                    onClick={() => void accept(invitation)}
                  >
                    {busy === invitation.id ? "Joining…" : "Accept"}
                  </button>
                </div>
              ))}
            </div>
          )}

          {invitationNote && (
            <p style={{ margin: "0 0 18px", color: "var(--faint)", fontSize: 12 }}>{invitationNote}</p>
          )}

          {workspaces.length > 0 && (
            <div style={{ marginBottom: 22 }}>
              <h3>Your workspaces</h3>
              {workspaces.map((workspace) => (
                <button
                  key={workspace.id}
                  className="row"
                  disabled={busy !== null}
                  onClick={() => void open(workspace.id)}
                >
                  <div className="row-top">
                    <span className="grow" style={{ fontWeight: 600, fontSize: 13 }}>{workspace.name}</span>
                    <span className="mono" style={{ color: "var(--faint)" }}>
                      {busy === workspace.id ? "opening…" : workspace.slug}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          )}

          <form onSubmit={create}>
            <h3>{workspaces.length > 0 ? "Or create another" : "Create a workspace"}</h3>

            <label className="mono" htmlFor="workspace-name" style={{ color: "var(--faint)", display: "block", marginBottom: 5 }}>
              NAME
            </label>
            <input
              className="input"
              id="workspace-name"
              placeholder="Acme Marketing"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={busy !== null}
              style={{ marginBottom: 12 }}
            />

            <label className="mono" htmlFor="workspace-slug" style={{ color: "var(--faint)", display: "block", marginBottom: 5 }}>
              SLUG
            </label>
            <input
              className="input mono"
              id="workspace-slug"
              placeholder="acme-marketing"
              value={proposedSlug}
              onChange={(e) => {
                setSlugEdited(true);
                setSlug(slugify(e.target.value));
              }}
              disabled={busy !== null}
              style={{ marginBottom: 6 }}
            />
            <p style={{ margin: "0 0 16px", color: "var(--faint)", fontSize: 12 }}>
              Identifies the workspace everywhere its data is stored. It cannot be reused by another
              workspace.
            </p>

            <button
              className="btn primary"
              type="submit"
              style={{ width: "100%", justifyContent: "center" }}
              disabled={busy !== null || !name.trim() || !proposedSlug}
            >
              {busy === "create" ? "Creating…" : "Create workspace"}
            </button>
          </form>
        </div>

        <p style={{ textAlign: "center", marginTop: 16, color: "var(--muted)" }}>
          Signed in as {session.data.user.email} —{" "}
          <button
            style={{ border: "none", background: "none", padding: 0, color: "var(--orange)", cursor: "pointer", fontWeight: 600 }}
            onClick={() => void authClient.signOut().then(() => session.refetch())}
          >
            sign out
          </button>
        </p>
      </div>
    </div>
  );
}
