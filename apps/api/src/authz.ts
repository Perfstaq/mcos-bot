import { MeetingVisibility, type CollaboratorRole } from "@prisma/client";
import { fromNodeHeaders } from "better-auth/node";
import type { FastifyRequest } from "fastify";
import { auth } from "./auth.js";
import { prisma, rawPrisma } from "./db.js";
import { ApiError } from "./http.js";

/**
 * Who is asking, and what they are allowed to see.
 *
 * Authentication answers the first question and lives in auth.ts. This file
 * answers the second. The split matters: Better Auth knows about users,
 * sessions and organization membership; it knows nothing about meetings,
 * visibility or share links, and it should not.
 */

export type Actor = {
  userId: string;
  email: string;
  name: string;
  /** The workspace this request is acting in. */
  organizationId: string;
  tenantId: string;
  role: string;
};

/** Roles the organization plugin issues, most privileged first. */
const ROLE_RANK: Record<string, number> = { owner: 3, admin: 2, member: 1 };

export function hasRole(actor: Actor, atLeast: "owner" | "admin" | "member"): boolean {
  return (ROLE_RANK[actor.role] ?? 0) >= (ROLE_RANK[atLeast] ?? 0);
}

export function requireRole(actor: Actor, atLeast: "owner" | "admin" | "member"): void {
  if (!hasRole(actor, atLeast)) {
    throw new ApiError(403, "forbidden", `Requires the ${atLeast} role or higher`);
  }
}

/**
 * Resolve the session into an actor, or null when unauthenticated.
 *
 * The active organization comes from the session, so switching workspace is a
 * session update rather than a query parameter the client can lie about. A user
 * with exactly one membership gets it selected implicitly — making people pick
 * from a list of one is a worse experience for no security gain.
 */
export async function resolveActor(request: FastifyRequest): Promise<Actor | null> {
  const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
  if (!session?.user) return null;

  const activeId = session.session.activeOrganizationId ?? null;
  const memberships = await rawPrisma.member.findMany({
    where: { userId: session.user.id },
    include: { organization: { include: { tenant: true } } },
    orderBy: { createdAt: "asc" },
  });
  if (memberships.length === 0) return null;

  const membership =
    memberships.find((m) => m.organizationId === activeId) ??
    (memberships.length === 1 ? memberships[0] : undefined);
  if (!membership) return null;

  const tenant = membership.organization.tenant;
  if (!tenant) {
    // A workspace without its tenant row is a broken invariant, not a 404 —
    // every organization gets one in the same transaction that creates it.
    throw new ApiError(500, "workspace_not_provisioned", "Workspace has no tenant");
  }

  return {
    userId: session.user.id,
    email: session.user.email,
    name: session.user.name,
    organizationId: membership.organizationId,
    tenantId: tenant.id,
    role: membership.role,
  };
}

export function requireActor(request: FastifyRequest): Actor {
  const actor = request.actor;
  if (!actor) throw new ApiError(401, "unauthenticated", "Sign in to continue");
  return actor;
}

/* -------------------------------------------------------------------------
 * Meeting access
 * ---------------------------------------------------------------------- */

export type MeetingAccess = { canRead: boolean; canWrite: boolean; reason: string };

/**
 * Tenancy is already enforced by the Prisma extension, so this only decides
 * visibility *within* a workspace. A meeting is readable when it is a workspace
 * meeting, when you created it, or when you were named a collaborator.
 */
export async function meetingAccess(actor: Actor, meetingId: string): Promise<MeetingAccess> {
  const meeting = await prisma.meeting.findUnique({
    where: { id: meetingId },
    select: { id: true, visibility: true, createdByUserId: true },
  });
  if (!meeting) throw ApiError.notFound(`Meeting ${meetingId} not found`);

  if (meeting.createdByUserId === actor.userId) {
    return { canRead: true, canWrite: true, reason: "creator" };
  }
  if (hasRole(actor, "admin")) {
    return { canRead: true, canWrite: true, reason: "workspace admin" };
  }

  const collaborator = await prisma.meetingCollaborator.findUnique({
    where: { meetingId_userId: { meetingId, userId: actor.userId } },
    select: { role: true },
  });
  if (collaborator) {
    return {
      canRead: true,
      canWrite: collaborator.role === ("editor" satisfies CollaboratorRole),
      reason: `collaborator:${collaborator.role}`,
    };
  }

  if (meeting.visibility === MeetingVisibility.workspace) {
    return { canRead: true, canWrite: true, reason: "workspace-visible" };
  }

  return { canRead: false, canWrite: false, reason: "private" };
}

export async function requireMeetingRead(actor: Actor, meetingId: string): Promise<void> {
  const access = await meetingAccess(actor, meetingId);
  // 404 rather than 403: confirming a private meeting exists is itself a leak.
  if (!access.canRead) throw ApiError.notFound(`Meeting ${meetingId} not found`);
}

export async function requireMeetingWrite(actor: Actor, meetingId: string): Promise<void> {
  const access = await meetingAccess(actor, meetingId);
  if (!access.canRead) throw ApiError.notFound(`Meeting ${meetingId} not found`);
  if (!access.canWrite) throw new ApiError(403, "forbidden", "Read-only access to this meeting");
}

/**
 * Provision a tenant for a newly created organization. Called from the
 * organization lifecycle hook; the 1:1 is created eagerly so no later code path
 * has to cope with a workspace that has no tenant.
 */
export async function provisionTenantForOrganization(args: {
  organizationId: string;
  slug: string;
  name: string;
}): Promise<string> {
  const existing = await rawPrisma.tenant.findUnique({
    where: { organizationId: args.organizationId },
    select: { id: true },
  });
  if (existing) return existing.id;

  const tenant = await rawPrisma.tenant.create({
    data: {
      slug: args.slug,
      name: args.name,
      organizationId: args.organizationId,
    },
  });
  return tenant.id;
}
