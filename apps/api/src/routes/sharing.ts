import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { ArtifactKind, CollaboratorRole, MeetingVisibility } from "@prisma/client";
import { z } from "zod";
import { requireActor, requireMeetingRead, requireMeetingWrite, hasRole, type Actor } from "../authz.js";
import { runWithContext } from "../context.js";
import { prisma, rawPrisma } from "../db.js";
import { env } from "../env.js";
import { ApiError, noStore, requireCtx } from "../http.js";
import { CLAIM_TYPE_LABEL } from "../domain/claims.js";
import { formatTimestamp } from "../domain/transcript.js";
import { presignGet } from "../integrations/r2.js";

/**
 * Sharing: who inside the workspace can reach a meeting, and the one way its
 * contents leave the workspace at all.
 *
 * A share link is a bearer credential. Everything in this file is written on
 * that assumption — the token is minted like one, refused like one, and the
 * public route it unlocks reads strictly less than the authenticated API does.
 */

/**
 * 32 bytes from the CSPRNG, base64url-encoded: 256 bits, which puts guessing a
 * live link out of reach no matter how many are outstanding. `randomBytes`
 * rather than `Math.random`, and not a uuid — a v4 uuid carries 122 bits and a
 * recognisable shape, and a value whose sole possession grants access should be
 * neither predictable nor advertisable as a uuid.
 */
const TOKEN_BYTES = 32;

function mintToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString("base64url");
}

const shareSchema = z
  .object({
    expires_at: z.string().datetime({ offset: true }).optional(),
    include_recording: z.boolean().default(false),
  })
  .default({});

const visibilitySchema = z.object({ visibility: z.nativeEnum(MeetingVisibility) });

const collaboratorSchema = z.object({
  user_id: z.string().min(1),
  role: z.nativeEnum(CollaboratorRole).default(CollaboratorRole.viewer),
});

export async function sharingRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Mint a share link.
   *
   * Gated on creator-or-admin rather than on write access, because those are
   * different acts. A workspace-visible meeting hands every member write
   * access so they can edit the notes; publishing the meeting to anyone holding
   * a URL is a category beyond editing it, and should not come free with it.
   */
  app.post("/meetings/:id/share", async (request, reply) => {
    const ctx = requireCtx(request);
    const actor = requireActor(request);
    const { id } = request.params as { id: string };
    await requireMeetingOwner(actor, id);

    const parsed = shareSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw ApiError.badRequest("Invalid share", parsed.error.flatten().fieldErrors);

    const expiresAt = parsed.data.expires_at ? new Date(parsed.data.expires_at) : null;
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      throw ApiError.badRequest("expires_at is already in the past");
    }

    const share = await prisma.meetingShare.create({
      data: {
        tenantId: ctx.tenantId,
        meetingId: id,
        token: mintToken(),
        expiresAt,
        includeRecording: parsed.data.include_recording,
        createdByUserId: actor.userId,
      },
    });

    return reply.status(201).send({ share: serializeShare(share) });
  });

  app.get("/meetings/:id/shares", async (request) => {
    const actor = requireActor(request);
    const { id } = request.params as { id: string };
    await requireMeetingRead(actor, id);

    const shares = await prisma.meetingShare.findMany({
      where: { meetingId: id },
      orderBy: { createdAt: "desc" },
    });
    return { shares: shares.map(serializeShare) };
  });

  /**
   * Revoke a link.
   *
   * Revocation is deliberately more permissive than creation — anyone who can
   * write the meeting can pull a link, because the cost of a false revoke is a
   * regenerated URL and the cost of hesitating is an exposure that outlives the
   * decision to end it.
   *
   * The row is kept and stamped, never deleted. After a link leaks, the thing
   * you want is exactly what a delete would destroy: who created it, when, how
   * many times it was opened before anyone noticed, and when it was cut off.
   */
  app.delete("/shares/:id", async (request) => {
    const actor = requireActor(request);
    const { id } = request.params as { id: string };

    const share = await prisma.meetingShare.findUnique({ where: { id } });
    if (!share) throw ApiError.notFound(`Share ${id} not found`);
    await requireMeetingWrite(actor, share.meetingId);

    if (share.revokedAt) return { share: serializeShare(share) };

    const revoked = await prisma.meetingShare.update({
      where: { id: share.id },
      data: { revokedAt: new Date() },
    });
    return { share: serializeShare(revoked) };
  });

  /**
   * The public read. No session, no workspace, no actor.
   *
   * Rate limited far harder than the rest of the API: it is the only route an
   * unauthenticated client can reach in volume, and the global limiter's key
   * generator falls back to the request IP here because there is no actor to
   * key on.
   */
  app.get(
    "/shared/:token",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { token } = request.params as { token: string };
      // A share response is per-token and mutates a view counter. Nothing in
      // front of this should hold a copy of it.
      noStore(reply);

      /*
       * The token is resolved with `rawPrisma`, on purpose.
       *
       * This request carries no session, so there is no tenant in
       * AsyncLocalStorage — and the extension in db.ts is a no-op without one.
       * Reaching for `prisma` here would run completely unscoped while reading
       * as though it were scoped, which is the worst of both. `rawPrisma` says
       * what is actually happening: one unscoped lookup of a unique,
       * unguessable value, whose only output is the tenant it belongs to.
       *
       * Everything after it runs inside `runWithContext` for that resolved
       * tenant, so every subsequent read is scoped the way the rest of the
       * codebase is. A token is therefore never a way *around* tenancy — it is
       * a way of choosing which tenant to be scoped to, exactly once, using a
       * value only the sharer ever held.
       */
      const share = await rawPrisma.meetingShare.findUnique({
        where: { token },
        select: {
          id: true,
          tenantId: true,
          meetingId: true,
          expiresAt: true,
          revokedAt: true,
          includeRecording: true,
        },
      });

      // Revoked, expired, and never existed are one fact to an anonymous
      // visitor. Telling them apart would make this route an oracle for guessed
      // tokens and buys nobody anything they can act on.
      if (!share || share.revokedAt || (share.expiresAt && share.expiresAt.getTime() <= Date.now())) {
        throw ApiError.notFound("This share link is no longer valid");
      }

      const tenant = await rawPrisma.tenant.findUnique({
        where: { id: share.tenantId },
        select: { slug: true },
      });

      return runWithContext(
        {
          tenantId: share.tenantId,
          tenantSlug: tenant?.slug ?? "",
          // `reviewer` attributes writes to the review gate. A share link can
          // never reach it; naming the context after the link rather than
          // after a person makes an attributed write impossible to fake.
          reviewer: `share:${share.id}`,
        },
        () => renderShare(share),
      );
    },
  );

  /**
   * Visibility.
   *
   * Creator-or-admin for the same reason share creation is: workspace
   * visibility grants every member write access, and a member who can edit the
   * notes should not thereby be able to hide the meeting from everyone else.
   *
   * Tightening visibility does NOT revoke outstanding links, because a link
   * handed to a customer should not silently die when someone tidies internal
   * permissions. Neither should it be forgotten, so the response reports how
   * many are still live and the UI can say so.
   */
  app.patch("/meetings/:id/visibility", async (request) => {
    const actor = requireActor(request);
    const { id } = request.params as { id: string };
    await requireMeetingOwner(actor, id);

    const parsed = visibilitySchema.safeParse(request.body);
    if (!parsed.success) throw ApiError.badRequest("Invalid visibility", parsed.error.flatten().fieldErrors);

    const meeting = await prisma.meeting.update({
      where: { id },
      data: { visibility: parsed.data.visibility },
      select: { id: true, visibility: true },
    });

    const liveShares = await prisma.meetingShare.count({
      where: { meetingId: id, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
    });

    return {
      meeting: { id: meeting.id, visibility: meeting.visibility },
      live_share_links: liveShares,
    };
  });

  app.get("/meetings/:id/collaborators", async (request) => {
    const actor = requireActor(request);
    const { id } = request.params as { id: string };
    await requireMeetingRead(actor, id);

    const collaborators = await prisma.meetingCollaborator.findMany({
      where: { meetingId: id },
      orderBy: { createdAt: "asc" },
      include: { user: { select: { id: true, name: true, email: true, image: true } } },
    });
    return { collaborators: collaborators.map(serializeCollaborator) };
  });

  app.post("/meetings/:id/collaborators", async (request) => {
    const ctx = requireCtx(request);
    const actor = requireActor(request);
    const { id } = request.params as { id: string };
    await requireMeetingWrite(actor, id);

    const parsed = collaboratorSchema.safeParse(request.body);
    if (!parsed.success) throw ApiError.badRequest("Invalid collaborator", parsed.error.flatten().fieldErrors);

    // The target has to already be in this workspace. Not because naming an
    // outsider would leak anything — they could never resolve an actor for this
    // tenant, so the grant would be inert — but because an inert grant rendered
    // in the collaborator list is a lie about who can see the meeting.
    const membership = await rawPrisma.member.findFirst({
      where: { organizationId: actor.organizationId, userId: parsed.data.user_id },
      select: { id: true },
    });
    if (!membership) throw ApiError.badRequest("That user is not a member of this workspace");

    // Upsert, so re-adding an existing collaborator changes their role instead
    // of failing on the unique constraint — which is what the UI's role
    // dropdown does every time it is used.
    const collaborator = await prisma.meetingCollaborator.upsert({
      where: { meetingId_userId: { meetingId: id, userId: parsed.data.user_id } },
      create: {
        tenantId: ctx.tenantId,
        meetingId: id,
        userId: parsed.data.user_id,
        role: parsed.data.role,
      },
      update: { role: parsed.data.role },
      include: { user: { select: { id: true, name: true, email: true, image: true } } },
    });

    return { collaborator: serializeCollaborator(collaborator) };
  });

  app.delete("/meetings/:id/collaborators/:userId", async (request, reply) => {
    const actor = requireActor(request);
    const { id, userId } = request.params as { id: string; userId: string };
    await requireMeetingWrite(actor, id);

    // deleteMany rather than delete: removing a collaborator who is already
    // gone is the same outcome the caller asked for, and a 404 on the second
    // click of a remove button is noise, not information.
    await prisma.meetingCollaborator.deleteMany({ where: { meetingId: id, userId } });
    return reply.status(204).send();
  });
}

/* ---------------------------------------------------------------------- */

/**
 * Acts that change who can reach a meeting, rather than what it says. Write
 * access is not enough for these: `meetingAccess` hands write to the whole
 * workspace for a workspace-visible meeting, which is right for editing and
 * wrong for exposure.
 */
async function requireMeetingOwner(actor: Actor, meetingId: string): Promise<void> {
  const meeting = await prisma.meeting.findUnique({
    where: { id: meetingId, deletedAt: null },
    select: { createdByUserId: true },
  });
  // 404 rather than 403, matching authz.ts: confirming a meeting exists to
  // someone who cannot see it is itself a leak.
  if (!meeting) throw ApiError.notFound(`Meeting ${meetingId} not found`);
  if (meeting.createdByUserId === actor.userId || hasRole(actor, "admin")) return;
  throw new ApiError(403, "forbidden", "Only the meeting's creator or a workspace admin can change its sharing");
}

/**
 * What a share link renders. Runs inside the resolved tenant's context, so
 * every read below is row-scoped exactly as an authenticated one would be.
 */
async function renderShare(share: {
  id: string;
  meetingId: string;
  expiresAt: Date | null;
  includeRecording: boolean;
}) {
  const meeting = await prisma.meeting.findUnique({
    where: { id: share.meetingId, deletedAt: null },
    select: {
      id: true,
      title: true,
      platform: true,
      startedAt: true,
      endedAt: true,
      durationMs: true,
      note: { select: { plainText: true, updatedAt: true } },
      agendaItems: {
        orderBy: { position: "asc" },
        select: {
          id: true,
          position: true,
          title: true,
          description: true,
          durationMins: true,
          completed: true,
          // Name only. A recap is unreadable without knowing who owns what, and
          // an email address on a public page is a different thing entirely.
          owner: { select: { name: true } },
        },
      },
      actionItems: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          title: true,
          description: true,
          status: true,
          dueAt: true,
          assignee: { select: { name: true } },
        },
      },
    },
  });
  // A purged meeting is gone even where the link survives.
  if (!meeting) throw ApiError.notFound("This share link is no longer valid");

  /*
   * Approved claims come from the newest brief version, not from the whole
   * brief_claims table. A claim that survives a merge is written again into
   * every version it survives into, so reading the table directly would render
   * the same claim once per version. The newest version is also the only one
   * that answers the question a reader is actually asking — what does the
   * workspace currently hold as true.
   */
  const current = await prisma.briefVersion.findFirst({
    orderBy: { version: "desc" },
    select: { id: true, version: true },
  });
  const claims = current
    ? await prisma.briefClaim.findMany({
        where: { briefVersionId: current.id, meetingId: meeting.id },
        orderBy: [{ type: "asc" }, { text: "asc" }],
        select: { claimId: true, type: true, text: true, introducedInVersion: true },
      })
    : [];

  const recording = share.includeRecording ? await presignedRecording(meeting.id) : null;

  // Opens are counted with an atomic increment rather than a read-modify-write:
  // a link that gets passed around is opened concurrently, which is precisely
  // when the count matters and precisely when a lost update would occur.
  await prisma.meetingShare.update({
    where: { id: share.id },
    data: { viewCount: { increment: 1 } },
  });

  /*
   * There is no transcript here, and no key that could hold one.
   *
   * The raw transcript is the most sensitive thing a meeting produces — every
   * aside, every name, everything said before people remembered they were
   * recorded — and it is never what someone means by "share the meeting". The
   * verbatim quotes attached to brief claims are omitted for the same reason:
   * a quote is transcript text, and provenance is for reviewers inside the
   * workspace, not for whoever ends up holding the URL.
   */
  return {
    meeting: {
      id: meeting.id,
      title: meeting.title,
      platform: meeting.platform,
      started_at: meeting.startedAt?.toISOString() ?? null,
      ended_at: meeting.endedAt?.toISOString() ?? null,
      duration_label: meeting.durationMs === null ? null : formatTimestamp(meeting.durationMs),
    },
    notes: meeting.note
      ? { text: meeting.note.plainText, updated_at: meeting.note.updatedAt.toISOString() }
      : null,
    agenda: meeting.agendaItems.map((item) => ({
      id: item.id,
      position: item.position,
      title: item.title,
      description: item.description,
      duration_mins: item.durationMins,
      completed: item.completed,
      owner: item.owner?.name ?? null,
    })),
    action_items: meeting.actionItems.map((item) => ({
      id: item.id,
      title: item.title,
      description: item.description,
      status: item.status,
      due_at: item.dueAt?.toISOString() ?? null,
      assignee: item.assignee?.name ?? null,
    })),
    brief_claims: claims.map((claim) => ({
      claim_id: claim.claimId,
      type: claim.type,
      type_label: CLAIM_TYPE_LABEL[claim.type],
      text: claim.text,
      introduced_in_version: claim.introducedInVersion,
    })),
    recording,
    shared: {
      expires_at: share.expiresAt?.toISOString() ?? null,
      includes_recording: share.includeRecording,
    },
  };
}

/**
 * The media artifacts, and only the media artifacts. `transcript_json` lives in
 * the same table and is excluded by name rather than by filtering it out later
 * — it is the raw transcript, and it does not become shareable because someone
 * ticked a box labelled "include recording".
 */
async function presignedRecording(meetingId: string) {
  const artifacts = await prisma.artifact.findMany({
    where: {
      meetingId,
      purgedAt: null,
      kind: { in: [ArtifactKind.recording_video, ArtifactKind.recording_audio] },
    },
  });
  const artifact = artifacts.find((a) => a.kind === ArtifactKind.recording_video) ?? artifacts[0];
  if (!artifact) return null;

  const { url, expiresAt } = await presignGet(artifact.r2Key);
  return {
    kind: artifact.kind,
    content_type: artifact.contentType,
    url,
    expires_at: expiresAt.toISOString(),
  };
}

function serializeShare(share: {
  id: string;
  token: string;
  meetingId: string;
  expiresAt: Date | null;
  revokedAt: Date | null;
  includeRecording: boolean;
  viewCount: number;
  createdByUserId: string | null;
  createdAt: Date;
}) {
  const expired = Boolean(share.expiresAt && share.expiresAt.getTime() <= Date.now());
  return {
    id: share.id,
    meeting_id: share.meetingId,
    token: share.token,
    // Built against the SPA's origin, not the API's: a share link is opened by
    // a person in a browser, and the page that renders it is a client route.
    url: `${env.WEB_ORIGIN}/shared/${share.token}`,
    status: share.revokedAt ? "revoked" : expired ? "expired" : "active",
    expires_at: share.expiresAt?.toISOString() ?? null,
    revoked_at: share.revokedAt?.toISOString() ?? null,
    includes_recording: share.includeRecording,
    view_count: share.viewCount,
    created_by_user_id: share.createdByUserId,
    created_at: share.createdAt.toISOString(),
  };
}

function serializeCollaborator(collaborator: {
  userId: string;
  role: CollaboratorRole;
  createdAt: Date;
  user: { id: string; name: string; email: string; image: string | null };
}) {
  return {
    user_id: collaborator.userId,
    name: collaborator.user.name,
    email: collaborator.user.email,
    image: collaborator.user.image,
    role: collaborator.role,
    added_at: collaborator.createdAt.toISOString(),
  };
}
