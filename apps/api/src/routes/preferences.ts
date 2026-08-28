import { AutoRecordMode, type UserPreference } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireActor } from "../authz.js";
import { rawPrisma } from "../db.js";
import { ApiError } from "../http.js";

/**
 * Personal recording settings — the workspace menu's Auto-record selector and
 * preferred method.
 *
 * These belong to a person, not to a workspace. Someone who is in two
 * workspaces has one answer to "should a bot join my meetings", and splitting
 * it per tenant would mean the same calendar behaving differently depending on
 * which workspace happened to be active. That is why `UserPreference` carries
 * no `tenant_id` and why every query here goes through `rawPrisma`: the tenancy
 * extension would inject a column the table does not have. The access boundary
 * is `actor.userId` — a caller can only ever read or write their own row, and
 * the row id never comes from the request.
 */

/**
 * Only "bot" exists. Kept as a closed enum rather than free text because
 * widening it is a product decision — a desktop capture path is a different
 * consent story, not a new string.
 */
const RECORDING_METHODS = ["bot"] as const;

const patchSchema = z
  .object({
    auto_record_mode: z.nativeEnum(AutoRecordMode).optional(),
    timezone: z.string().trim().min(1).max(64).nullable().optional(),
    recording_method: z.enum(RECORDING_METHODS).optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, { message: "No fields to update" })
  .superRefine((patch, ctx) => {
    // Validated by asking the platform rather than against a hardcoded list:
    // the IANA database gains zones every year, and a stale allowlist rejects
    // real ones. A bad zone here would break every time on the calendar grid.
    if (patch.timezone && !isKnownTimeZone(patch.timezone)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["timezone"],
        message: `Unknown IANA time zone "${patch.timezone}"`,
      });
    }
  });

export async function preferenceRoutes(app: FastifyInstance): Promise<void> {
  app.get("/preferences", async (request) => {
    const actor = requireActor(request);
    return { preferences: serializePreference(await loadOrCreate(actor.userId)) };
  });

  /**
   * A partial update, created on demand like the GET.
   *
   * `upsert` rather than read-then-write: two settings tabs open at once would
   * otherwise race on the create and one would lose to the unique constraint on
   * `user_id`. Absent fields keep their stored value, so a client that only
   * knows about the Auto-record selector cannot blank out the timezone a later
   * build set.
   */
  app.patch("/preferences", async (request) => {
    const actor = requireActor(request);
    const parsed = patchSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw ApiError.badRequest("Invalid preferences", parsed.error.flatten());
    }
    const patch = parsed.data;

    const data = {
      ...(patch.auto_record_mode !== undefined ? { autoRecordMode: patch.auto_record_mode } : {}),
      ...(patch.timezone !== undefined ? { timezone: patch.timezone } : {}),
      ...(patch.recording_method !== undefined ? { recordingMethod: patch.recording_method } : {}),
    };

    const preference = await rawPrisma.userPreference.upsert({
      where: { userId: actor.userId },
      create: { userId: actor.userId, ...data },
      update: data,
    });

    return { preferences: serializePreference(preference) };
  });
}

/* ---------------------------------------------------------------------- */

/**
 * Reading settings creates the row.
 *
 * The alternative — returning defaults without persisting — means the value the
 * settings screen shows and the value `decideAutoRecord` reads are two
 * different things until the first write, and the enum default (`none`) is the
 * safe one either way.
 */
export async function loadOrCreate(userId: string): Promise<UserPreference> {
  return rawPrisma.userPreference.upsert({
    where: { userId },
    create: { userId },
    update: {},
  });
}

function isKnownTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function serializePreference(preference: UserPreference) {
  return {
    auto_record_mode: preference.autoRecordMode,
    timezone: preference.timezone,
    recording_method: preference.recordingMethod,
    updated_at: preference.updatedAt.toISOString(),
  };
}
