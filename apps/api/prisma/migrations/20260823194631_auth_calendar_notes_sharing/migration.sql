-- CreateEnum
CREATE TYPE "calendar_provider" AS ENUM ('google', 'microsoft');

-- CreateEnum
CREATE TYPE "calendar_connection_status" AS ENUM ('active', 'reauth_required', 'disabled');

-- CreateEnum
CREATE TYPE "action_item_status" AS ENUM ('open', 'in_progress', 'done', 'cancelled');

-- CreateEnum
CREATE TYPE "meeting_visibility" AS ENUM ('private', 'workspace');

-- CreateEnum
CREATE TYPE "collaborator_role" AS ENUM ('viewer', 'editor');

-- AlterTable
ALTER TABLE "meetings" ADD COLUMN     "created_by_user_id" TEXT,
ADD COLUMN     "duration_ms" INTEGER,
ADD COLUMN     "organizer_email" TEXT,
ADD COLUMN     "visibility" "meeting_visibility" NOT NULL DEFAULT 'workspace';

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "organization_id" TEXT;

-- CreateTable
CREATE TABLE "user" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "role" TEXT,
    "banned" BOOLEAN DEFAULT false,
    "banReason" TEXT,
    "banExpires" TIMESTAMP(3),

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" TEXT NOT NULL,
    "activeOrganizationId" TEXT,
    "impersonatedBy" TEXT,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "logo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "metadata" TEXT,

    CONSTRAINT "organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inviterId" TEXT NOT NULL,

    CONSTRAINT "invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calendar_connections" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "provider" "calendar_provider" NOT NULL,
    "provider_account_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "calendar_id" TEXT NOT NULL DEFAULT 'primary',
    "sync_token" TEXT,
    "last_synced_at" TIMESTAMP(3),
    "last_sync_error" TEXT,
    "watch_channel_id" TEXT,
    "watch_resource_id" TEXT,
    "watch_expires_at" TIMESTAMP(3),
    "status" "calendar_connection_status" NOT NULL DEFAULT 'active',
    "auto_record" BOOLEAN NOT NULL DEFAULT false,
    "auto_record_rules" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "calendar_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calendar_events" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "ical_uid" TEXT,
    "title" TEXT,
    "description" TEXT,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3) NOT NULL,
    "timezone" TEXT,
    "organizer_email" TEXT,
    "attendees" JSONB NOT NULL DEFAULT '[]',
    "is_recurring" BOOLEAN NOT NULL DEFAULT false,
    "cancelled" BOOLEAN NOT NULL DEFAULT false,
    "meeting_url" TEXT,
    "platform" TEXT,
    "auto_record" BOOLEAN NOT NULL DEFAULT false,
    "bot_dispatched" BOOLEAN NOT NULL DEFAULT false,
    "meeting_id" TEXT,
    "raw" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "calendar_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meeting_notes" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "meeting_id" TEXT NOT NULL,
    "state" BYTEA NOT NULL,
    "plain_text" TEXT NOT NULL DEFAULT '',
    "revision" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by_user_id" TEXT,

    CONSTRAINT "meeting_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agenda_items" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "meeting_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "duration_mins" INTEGER,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "owner_user_id" TEXT,
    "created_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agenda_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "action_items" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "meeting_id" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "action_item_status" NOT NULL DEFAULT 'open',
    "due_at" TIMESTAMP(3),
    "assignee_user_id" TEXT,
    "created_by_user_id" TEXT,
    "source_segment_id" TEXT,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "action_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meeting_collaborators" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "meeting_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" "collaborator_role" NOT NULL DEFAULT 'viewer',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meeting_collaborators_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meeting_shares" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "meeting_id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "include_recording" BOOLEAN NOT NULL DEFAULT false,
    "view_count" INTEGER NOT NULL DEFAULT 0,
    "created_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meeting_shares_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE INDEX "session_userId_idx" ON "session"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "session_token_key" ON "session"("token");

-- CreateIndex
CREATE INDEX "account_userId_idx" ON "account"("userId");

-- CreateIndex
CREATE INDEX "verification_identifier_idx" ON "verification"("identifier");

-- CreateIndex
CREATE UNIQUE INDEX "organization_slug_key" ON "organization"("slug");

-- CreateIndex
CREATE INDEX "member_organizationId_idx" ON "member"("organizationId");

-- CreateIndex
CREATE INDEX "member_userId_idx" ON "member"("userId");

-- CreateIndex
CREATE INDEX "invitation_organizationId_idx" ON "invitation"("organizationId");

-- CreateIndex
CREATE INDEX "invitation_email_idx" ON "invitation"("email");

-- CreateIndex
CREATE INDEX "calendar_connections_tenant_id_status_idx" ON "calendar_connections"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "calendar_connections_watch_expires_at_idx" ON "calendar_connections"("watch_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "calendar_connections_user_id_provider_provider_account_id_c_key" ON "calendar_connections"("user_id", "provider", "provider_account_id", "calendar_id");

-- CreateIndex
CREATE UNIQUE INDEX "calendar_events_meeting_id_key" ON "calendar_events"("meeting_id");

-- CreateIndex
CREATE INDEX "calendar_events_tenant_id_starts_at_idx" ON "calendar_events"("tenant_id", "starts_at");

-- CreateIndex
CREATE INDEX "calendar_events_starts_at_bot_dispatched_idx" ON "calendar_events"("starts_at", "bot_dispatched");

-- CreateIndex
CREATE UNIQUE INDEX "calendar_events_connection_id_external_id_key" ON "calendar_events"("connection_id", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "meeting_notes_meeting_id_key" ON "meeting_notes"("meeting_id");

-- CreateIndex
CREATE INDEX "agenda_items_meeting_id_position_idx" ON "agenda_items"("meeting_id", "position");

-- CreateIndex
CREATE INDEX "action_items_tenant_id_status_due_at_idx" ON "action_items"("tenant_id", "status", "due_at");

-- CreateIndex
CREATE INDEX "action_items_assignee_user_id_status_idx" ON "action_items"("assignee_user_id", "status");

-- CreateIndex
CREATE INDEX "meeting_collaborators_user_id_idx" ON "meeting_collaborators"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "meeting_collaborators_meeting_id_user_id_key" ON "meeting_collaborators"("meeting_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "meeting_shares_token_key" ON "meeting_shares"("token");

-- CreateIndex
CREATE INDEX "meeting_shares_meeting_id_idx" ON "meeting_shares"("meeting_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_organization_id_key" ON "tenants"("organization_id");

-- AddForeignKey
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account" ADD CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member" ADD CONSTRAINT "member_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member" ADD CONSTRAINT "member_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_inviterId_fkey" FOREIGN KEY ("inviterId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_connections" ADD CONSTRAINT "calendar_connections_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_connections" ADD CONSTRAINT "calendar_connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_meeting_id_fkey" FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "calendar_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_notes" ADD CONSTRAINT "meeting_notes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_notes" ADD CONSTRAINT "meeting_notes_meeting_id_fkey" FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_notes" ADD CONSTRAINT "meeting_notes_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agenda_items" ADD CONSTRAINT "agenda_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agenda_items" ADD CONSTRAINT "agenda_items_meeting_id_fkey" FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agenda_items" ADD CONSTRAINT "agenda_items_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action_items" ADD CONSTRAINT "action_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action_items" ADD CONSTRAINT "action_items_meeting_id_fkey" FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action_items" ADD CONSTRAINT "action_items_assignee_user_id_fkey" FOREIGN KEY ("assignee_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action_items" ADD CONSTRAINT "action_items_source_segment_id_fkey" FOREIGN KEY ("source_segment_id") REFERENCES "transcript_segments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_collaborators" ADD CONSTRAINT "meeting_collaborators_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_collaborators" ADD CONSTRAINT "meeting_collaborators_meeting_id_fkey" FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_collaborators" ADD CONSTRAINT "meeting_collaborators_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_shares" ADD CONSTRAINT "meeting_shares_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_shares" ADD CONSTRAINT "meeting_shares_meeting_id_fkey" FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

