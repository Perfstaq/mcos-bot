-- AlterTable
ALTER TABLE "calendar_events" ADD COLUMN     "all_day" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "auto_record_override" BOOLEAN;

