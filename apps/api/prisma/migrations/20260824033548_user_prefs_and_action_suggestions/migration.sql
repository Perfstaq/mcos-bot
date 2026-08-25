-- CreateEnum
CREATE TYPE "auto_record_mode" AS ENUM ('none', 'all', 'external', 'owned');

-- CreateEnum
CREATE TYPE "action_item_origin" AS ENUM ('manual', 'ai_suggested');

-- AlterTable
ALTER TABLE "action_items" ADD COLUMN     "accepted_at" TIMESTAMP(3),
ADD COLUMN     "dismissed_at" TIMESTAMP(3),
ADD COLUMN     "group_name" TEXT,
ADD COLUMN     "origin" "action_item_origin" NOT NULL DEFAULT 'manual';

-- CreateTable
CREATE TABLE "user_preferences" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "auto_record_mode" "auto_record_mode" NOT NULL DEFAULT 'none',
    "timezone" TEXT,
    "recording_method" TEXT NOT NULL DEFAULT 'bot',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_preferences_user_id_key" ON "user_preferences"("user_id");

-- CreateIndex
CREATE INDEX "action_items_tenant_id_origin_dismissed_at_idx" ON "action_items"("tenant_id", "origin", "dismissed_at");

-- AddForeignKey
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

