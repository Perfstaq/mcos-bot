import type { FastifyInstance } from "fastify";
import { APIError } from "better-auth/api";
import { fromNodeHeaders } from "better-auth/node";
import { z } from "zod";
import { auth } from "../auth.js";
import { requireActor, requireRole, type Actor } from "../authz.js";
import { prisma, rawPrisma } from "../db.js";
import { ApiError, requireCtx } from "../http.js";

/**
 * Workspace administration.
 *
 * Better Auth's organization plugin owns `member`, `invitation` and
 * `organization`. Every write here goes through `auth.api.*` rather than
 * touching those tables, because the plugin's rules — who may grant which role,
 * what an invitation's expiry means, what happens to a session when its owner
 * is removed — live inside those endpoints. Writing the rows directly would
 * reimplement them, badly, and drift the day the library changes.
 *
 * What this file adds on top is the product's own policy, which is stricter
 * than the plugin's defaults in one place and expressed in domain terms in
 * another.
 */

const ROLES = ["owner", "admin", "member"] as const;

const roleSchema = z.object({ role: z.enum(ROLES) });

const inviteSchema = z.object({
  email: z.string().email("email must be an address an invite can reach").transform((v) => v.toLowerCase()),
  role: z.enum(ROLES).default("member"),
  /** Re-send an invitation that is already pending rather than being refused it. */
  resend: z.boolean().optional(),
});

const membersQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});

export async function workspaceRoutes(app: FastifyInstance): Promise<void> {
  /**
   * The workspace the request is acting in, and the actor's standing in it.
   *
   * Read through the plugin rather than off the organization row: the endpoint
   * re-checks membership and clears a stale active organization from the
   * session when it finds one, which a direct select would silently skip.
   */
  app.get("/workspace", async (request) => {
    const actor = requireActor(request);

    const organization = await viaAuth(() =>
      auth.api.getFullOrganization({
        query: { organizationId: actor.organizationId },
        headers: fromNodeHeaders(request.headers),
      }),
    );
    if (!organization) throw ApiError.notFound("No active workspace");

    const invitations = organization.invitations ?? [];
    return {
      workspace: {
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
        logo: organization.logo ?? null,
        created_at: new Date(organization.createdAt).toISOString(),
        // The domain's tenant id, not the organization id. Every scoped query
        // in this codebase keys off it, so a client debugging a tenancy problem
        // should be able to see it.
        tenant_id: actor.tenantId,
        member_count: organization.members?.length ?? 0,
        pending_invitation_count: invitations.filter((i) => i.status === "pending").length,
        role: actor.role,
      },
    };
  });

  app.get("/workspace/members", async (request) => {
    const actor = requireActor(request);
    const parsed = membersQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) throw ApiError.badRequest("Invalid query", parsed.error.flatten().fieldErrors);

    const result = await viaAuth(() =>
      auth.api.listMembers({
        query: {
          organizationId: actor.organizationId,
          limit: parsed.data.limit,
          offset: parsed.data.offset,
          sortBy: "createdAt",
          sortDirection: "asc",
        },
        headers: fromNodeHeaders(request.headers),
      }),
    );

    return {
      members: result.members.map(serializeMember),
      total: result.total,
    };
  });

  /**
   * Change a member's role.
   *
   * Owner-only, which is stricter than the plugin (it lets an admin hand out
   * admin). Who can grant privilege is a product decision, so it is made here
   * and not inherited from a library default that may change.
   */
  app.patch("/workspace/members/:userId", async (request) => {
    const actor = requireActor(request);
    requireRole(actor, "owner");

    const { userId } = request.params as { userId: string };
    const parsed = roleSchema.safeParse(request.body);
    if (!parsed.success) throw ApiError.badRequest("Invalid role", parsed.error.flatten().fieldErrors);

    const member = await memberFor(actor, userId);
    const wasOwner = rolesOf(member.role).includes("owner");
    const staysOwner = rolesOf(parsed.data.role).includes("owner");

    // The plugin refuses this only when an owner demotes *themselves*. An owner
    // demoting the workspace's other and only remaining owner reaches the same
    // ownerless state through a path it does not check, so the invariant is
    // enforced here where it is ours and testable, rather than left resting on
    // the shape of somebody else's guard clause.
    if (wasOwner && !staysOwner && (await ownerCount(actor.organizationId)) <= 1) {
      throw ApiError.conflict("A workspace must keep at least one owner");
    }

    await viaAuth(() =>
      auth.api.updateMemberRole({
        body: {
          memberId: member.id,
          role: parsed.data.role,
          organizationId: actor.organizationId,
        },
        headers: fromNodeHeaders(request.headers),
      }),
    );

    return { member: serializeMember(await memberFor(actor, userId)) };
  });

  /**
   * Remove a member.
   *
   * Permission and the last-owner guard both already live in the plugin for
   * removal, and it is the plugin's row being deleted, so this maps the user id
   * the API is addressed by onto the member id the plugin expects and delegates
   * the rest.
   */
  app.delete("/workspace/members/:userId", async (request, reply) => {
    const actor = requireActor(request);
    requireCtx(request);
    const { userId } = request.params as { userId: string };

    const member = await memberFor(actor, userId);
    await viaAuth(() =>
      auth.api.removeMember({
        body: { memberIdOrEmail: member.id, organizationId: actor.organizationId },
        headers: fromNodeHeaders(request.headers),
      }),
    );

    // Per-meeting grants are ours, not the plugin's, and nothing else would
    // ever clear them. They are harmless while the user has no membership —
    // `resolveActor` refuses a user with no member row — but they would come
    // back to life the moment the same person is re-invited, silently restoring
    // access to meetings nobody has re-granted.
    const orphaned = await prisma.meetingCollaborator.deleteMany({ where: { userId } });

    return reply.status(200).send({
      removed: { user_id: userId, member_id: member.id },
      revoked_collaborations: orphaned.count,
    });
  });

  app.get("/workspace/invitations", async (request) => {
    const actor = requireActor(request);
    const invitations = await viaAuth(() =>
      auth.api.listInvitations({
        query: { organizationId: actor.organizationId },
        headers: fromNodeHeaders(request.headers),
      }),
    );
    return { invitations: invitations.map(serializeInvitation) };
  });

  /**
   * Invite someone.
   *
   * No `sendInvitationEmail` is configured on the organization plugin, so this
   * mints the invitation and returns its id — nothing is emailed. That is why
   * the id is in the response: until a transport exists, the only way the
   * invitation reaches a human is the caller handing them the link.
   */
  app.post("/workspace/invitations", async (request, reply) => {
    const actor = requireActor(request);
    requireRole(actor, "admin");

    const parsed = inviteSchema.safeParse(request.body);
    if (!parsed.success) throw ApiError.badRequest("Invalid invitation", parsed.error.flatten().fieldErrors);

    const invitation = await viaAuth(() =>
      auth.api.createInvitation({
        body: {
          email: parsed.data.email,
          role: parsed.data.role,
          organizationId: actor.organizationId,
          ...(parsed.data.resend === undefined ? {} : { resend: parsed.data.resend }),
        },
        headers: fromNodeHeaders(request.headers),
      }),
    );

    return reply.status(201).send({ invitation: serializeInvitation(invitation) });
  });

  app.delete("/workspace/invitations/:id", async (request, reply) => {
    const actor = requireActor(request);
    requireRole(actor, "admin");
    const { id } = request.params as { id: string };

    // Scoped before the call: `cancelInvitation` takes only an invitation id,
    // so without this an admin of one workspace could cancel an invitation
    // belonging to another by guessing its id.
    const invitation = await rawPrisma.invitation.findFirst({
      where: { id, organizationId: actor.organizationId },
      select: { id: true },
    });
    if (!invitation) throw ApiError.notFound(`Invitation ${id} not found`);

    await viaAuth(() =>
      auth.api.cancelInvitation({
        body: { invitationId: invitation.id },
        headers: fromNodeHeaders(request.headers),
      }),
    );

    return reply.status(204).send();
  });
}

/* ---------------------------------------------------------------------- */

/**
 * Better Auth throws its own `APIError`, which Fastify's handler would render
 * as a bare 500 with the message hidden. Translating at the boundary keeps the
 * plugin's refusals — "you are not allowed to update this member" — legible to
 * the client, which is the whole reason for delegating to it.
 */
async function viaAuth<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (!(error instanceof APIError)) throw error;
    const body = error.body as { code?: string; message?: string } | undefined;
    throw new ApiError(
      error.statusCode ?? 400,
      body?.code?.toLowerCase() ?? "organization_error",
      body?.message ?? error.message,
    );
  }
}

/**
 * The API addresses members by user id; the plugin addresses them by member id.
 * Reads of the auth tables go through `rawPrisma` for the same reason authz.ts
 * does: they carry no tenant_id, so routing them through the scoped client
 * would only make it look as though they were being filtered.
 */
async function memberFor(actor: Actor, userId: string) {
  const member = await rawPrisma.member.findFirst({
    where: { organizationId: actor.organizationId, userId },
    include: { user: { select: { id: true, name: true, email: true, image: true } } },
  });
  if (!member) throw ApiError.notFound(`No member ${userId} in this workspace`);
  return member;
}

/** The plugin stores multiple roles comma-joined in one column. */
function rolesOf(role: string): string[] {
  return role
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
}

async function ownerCount(organizationId: string): Promise<number> {
  const members = await rawPrisma.member.findMany({
    where: { organizationId },
    select: { role: true },
  });
  return members.filter((m) => rolesOf(m.role).includes("owner")).length;
}

function serializeMember(member: {
  id: string;
  userId: string;
  role: string;
  createdAt: Date | string;
  user: { id: string; name: string; email: string; image?: string | null };
}) {
  return {
    member_id: member.id,
    user_id: member.userId,
    name: member.user.name,
    email: member.user.email,
    image: member.user.image ?? null,
    role: member.role,
    joined_at: new Date(member.createdAt).toISOString(),
  };
}

function serializeInvitation(invitation: {
  id: string;
  email: string;
  role?: string | null;
  status: string;
  expiresAt: Date | string;
  inviterId: string;
}) {
  return {
    id: invitation.id,
    email: invitation.email,
    role: invitation.role ?? "member",
    status: invitation.status,
    expires_at: new Date(invitation.expiresAt).toISOString(),
    invited_by_user_id: invitation.inviterId,
  };
}
