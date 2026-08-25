import { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";
import { hasRole, useSession, WORKSPACE_ROLES, type WorkspaceRole } from "../auth-client.js";
import { IconPlus, IconTrash } from "../components/Icons.js";

type Workspace = {
  id: string;
  name: string;
  slug: string;
  logo: string | null;
  created_at: string;
  tenant_id: string;
  member_count: number;
  pending_invitation_count: number;
  role: string;
};

type Member = {
  member_id: string;
  user_id: string;
  name: string;
  email: string;
  image: string | null;
  role: string;
  joined_at: string;
};

type Invitation = {
  id: string;
  email: string;
  role: string;
  status: string;
  expires_at: string;
  invited_by_user_id: string;
};

/**
 * Who is in this workspace, and what they may do in it.
 *
 * Everything here goes through the API's /workspace routes rather than through
 * the Better Auth client directly, even though the client could reach the same
 * plugin endpoints. Those routes are where the product's rules live — role
 * changes are owner-only, a workspace may not be left ownerless, and removing
 * someone revokes the per-meeting grants that Better Auth knows nothing about.
 * A UI that called the plugin straight past them would enforce none of it.
 */
export function WorkspaceSettings() {
  const session = useSession();
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [invitations, setInvitations] = useState<Invitation[] | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<WorkspaceRole>("member");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [ws, ms, invs] = await Promise.all([
        api.get<{ workspace: Workspace }>("/workspace"),
        api.get<{ members: Member[]; total: number }>("/workspace/members"),
        api.get<{ invitations: Invitation[] }>("/workspace/invitations"),
      ]);
      setWorkspace(ws.workspace);
      setMembers(ms.members);
      setInvitations(invs.invitations);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (key: string, fn: () => Promise<string | null>) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      const done = await fn();
      setNotice(done);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const me = session.data?.user.id ?? null;
  const canInvite = hasRole(workspace?.role, "admin");
  const canChangeRole = hasRole(workspace?.role, "owner");
  const canRemove = hasRole(workspace?.role, "admin");

  // The API returns every invitation the workspace has ever issued. Accepted
  // and cancelled ones are history, and history is not what this screen is
  // for — only the ones still capable of letting somebody in are actionable.
  const pending = (invitations ?? []).filter((i) => i.status === "pending");

  const invite = async (event: React.FormEvent) => {
    event.preventDefault();
    const address = email.trim().toLowerCase();
    await act("invite", async () => {
      const created = await api.post<{ invitation: Invitation }>("/workspace/invitations", {
        email: address,
        role,
      });
      setEmail("");
      // Nothing emails the invitation — the API mints it and hands back the
      // id precisely because there is no transport yet, so the link has to be
      // put somewhere a human can copy it or the invitation never arrives.
      return `Invited ${created.invitation.email}. Send them ${invitationLink(created.invitation.id)} — nothing is emailed.`;
    });
  };

  const revoke = async (invitation: Invitation) => {
    if (!window.confirm(`Revoke the invitation for ${invitation.email}? The link they were sent stops working.`)) return;
    await act(invitation.id, async () => {
      await api.del(`/workspace/invitations/${invitation.id}`);
      return `Invitation for ${invitation.email} revoked.`;
    });
  };

  const changeRole = async (member: Member, next: WorkspaceRole) => {
    if (member.role === next) return;
    // Demoting yourself is the one role change that can cost you the ability
    // to undo it, so it is the one that asks.
    if (member.user_id === me && !window.confirm(`Change your own role to ${next}? You may not be able to change it back.`)) {
      return;
    }
    await act(member.user_id, async () => {
      await api.patch(`/workspace/members/${member.user_id}`, { role: next });
      return `${member.name} is now ${next}.`;
    });
  };

  const remove = async (member: Member) => {
    if (
      !window.confirm(
        `Remove ${member.name} (${member.email}) from this workspace? They lose access immediately, and any meetings shared with them individually are revoked. Meetings they created stay.`,
      )
    ) {
      return;
    }
    await act(member.user_id, async () => {
      await api.del(`/workspace/members/${member.user_id}`);
      return `${member.name} removed.`;
    });
  };

  return (
    <div className="screen">
      <header className="screen-head">
        <h1>Workspace</h1>
        <span className="sub">Members, roles and invitations</span>
        <div className="grow" />
        {workspace && (
          <span className="chip">
            <span className="dot" />
            you are {workspace.role}
          </span>
        )}
      </header>

      <div className="panes">
        <div className="pane detail">
          <div className="pane-head">
            <span className="grow">{workspace?.name ?? "Settings"}</span>
            {workspace && <span>{workspace.slug}</span>}
          </div>

          {error && <div className="banner error">{error}</div>}
          {notice && <div className="banner info">{notice}</div>}

          {/* An error already says what went wrong in the banner above; the
              empty state is for the case where nothing went wrong and there is
              genuinely no workspace. */}
          {!workspace && !error && members === null && (
            <>
              <div className="skeleton" />
              <div className="skeleton" />
            </>
          )}

          {!workspace && !error && members !== null && (
            <div className="empty" style={{ marginTop: 40 }}>
              <h3>No workspace</h3>
              <p>This session is not acting in a workspace yet.</p>
            </div>
          )}

          {workspace && (
            <div className="pane-body scroll">
              <div className="detail-body">
                <div className="section">
                  <h3>Identity</h3>
                  <dl className="kv">
                    <dt>Name</dt>
                    <dd>{workspace.name}</dd>
                    <dt>Slug</dt>
                    <dd className="mono">{workspace.slug}</dd>
                    {/* The id every scoped query in the product keys off. It is
                        here so a tenancy problem can be diagnosed without a
                        database session. */}
                    <dt>Tenant</dt>
                    <dd className="mono">{workspace.tenant_id}</dd>
                    <dt>Created</dt>
                    <dd>{new Date(workspace.created_at).toLocaleDateString()}</dd>
                  </dl>
                </div>

                <div className="section">
                  <h3>Members — {workspace.member_count}</h3>

                  {members?.map((member) => {
                    const settled = busy === member.user_id;
                    return (
                      <div
                        key={member.member_id}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                          padding: "9px 0",
                          borderTop: "1px solid var(--line-soft)",
                          opacity: settled ? 0.5 : 1,
                        }}
                      >
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 600, fontSize: 13 }}>
                            {member.name}
                            {member.user_id === me && (
                              <span className="mono" style={{ color: "var(--faint)" }}> — you</span>
                            )}
                          </div>
                          <div className="mono" style={{ color: "var(--faint)", wordBreak: "break-all" }}>
                            {member.email}
                          </div>
                        </div>

                        <RolePicker
                          role={member.role}
                          disabled={!canChangeRole || busy !== null}
                          onChange={(next) => void changeRole(member, next)}
                        />

                        <button
                          className="btn sm reject"
                          title={
                            member.user_id === me
                              ? "Removing yourself is not done from here"
                              : `Remove ${member.name}`
                          }
                          disabled={!canRemove || busy !== null || member.user_id === me}
                          onClick={() => void remove(member)}
                        >
                          <IconTrash />
                        </button>
                      </div>
                    );
                  })}
                </div>

                <div className="section">
                  <h3>Pending invitations — {pending.length}</h3>

                  {canInvite ? (
                    <form
                      onSubmit={invite}
                      style={{ display: "flex", gap: 8, padding: "10px 0", flexWrap: "wrap" }}
                    >
                      <input
                        className="input"
                        style={{ flex: 1, minWidth: 200 }}
                        type="email"
                        required
                        aria-label="Email address to invite"
                        placeholder="name@company.com"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        disabled={busy !== null}
                      />
                      <select
                        className="select"
                        value={role}
                        onChange={(e) => setRole(e.target.value as WorkspaceRole)}
                        disabled={busy !== null}
                      >
                        {WORKSPACE_ROLES.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                      <button className="btn primary" type="submit" disabled={busy !== null || !email.trim()}>
                        <IconPlus /> {busy === "invite" ? "Inviting…" : "Invite"}
                      </button>
                    </form>
                  ) : (
                    <p style={{ color: "var(--faint)", fontSize: 12, margin: "8px 0 0" }}>
                      Admins and owners can invite people to this workspace.
                    </p>
                  )}

                  {pending.length === 0 && invitations !== null && (
                    <p style={{ color: "var(--faint)", fontSize: 12, margin: "10px 0 0" }}>
                      Nobody is waiting on an invitation.
                    </p>
                  )}

                  {pending.map((invitation) => (
                    <div
                      key={invitation.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        padding: "9px 0",
                        borderTop: "1px solid var(--line-soft)",
                        opacity: busy === invitation.id ? 0.5 : 1,
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: 13, wordBreak: "break-all" }}>
                          {invitation.email}
                        </div>
                        <div className="mono" style={{ color: "var(--faint)" }}>
                          {invitation.role} — expires {new Date(invitation.expires_at).toLocaleDateString()}
                        </div>
                      </div>
                      <span className="mono" style={{ color: "var(--faint)", wordBreak: "break-all", maxWidth: 260 }}>
                        {invitationLink(invitation.id)}
                      </span>
                      <button
                        className="btn sm reject"
                        disabled={!canInvite || busy !== null}
                        onClick={() => void revoke(invitation)}
                      >
                        Revoke
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * A select for the three roles, and plain text for anything else.
 *
 * The plugin stores multiple roles comma-joined, so a value like "owner,admin"
 * matches no option and a select would silently render blank — which reads as
 * "no role" rather than "two". Showing it is honest; offering to overwrite it
 * from a three-item list is not.
 */
function RolePicker({
  role,
  disabled,
  onChange,
}: {
  role: string;
  disabled: boolean;
  onChange: (next: WorkspaceRole) => void;
}) {
  const known = WORKSPACE_ROLES.find((r) => r === role);
  if (!known) {
    return (
      <span className="chip" title="Multiple roles — change them where they were granted">
        {role}
      </span>
    );
  }

  return (
    <select
      className="select"
      value={known}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as WorkspaceRole)}
      aria-label="Role"
    >
      {WORKSPACE_ROLES.map((r) => (
        <option key={r} value={r}>
          {r}
        </option>
      ))}
    </select>
  );
}

/** Where an invited person has to land for the id to be accepted. */
function invitationLink(invitationId: string): string {
  return `${window.location.origin}/onboarding?invitation=${invitationId}`;
}
