import { CalendarConnectionStatus, CalendarProvider } from "@prisma/client";
import { rawPrisma } from "../db.js";
import { logger } from "../logger.js";

const log = logger.child({ module: "calendar-connections" });

/** Scopes that mean this grant can actually read a calendar. */
const CALENDAR_SCOPE_MARKERS = ["calendar", "calendars.read"];

const PROVIDER_BY_ID: Record<string, CalendarProvider> = {
  google: CalendarProvider.google,
  microsoft: CalendarProvider.microsoft,
};

/**
 * Turn linked OAuth accounts into calendar connections.
 *
 * Two moments need this and neither is sufficient alone. A user can link Google
 * *before* they have a workspace (OAuth sign-up creates the account first), and
 * a user can create a workspace long after linking. So this runs from both the
 * account-link hook and the organization-creation hook, and is idempotent.
 *
 * Deliberately does NOT enable `autoRecord`. Linking a calendar so the app can
 * read it is a different decision from letting it send a bot into every meeting
 * on it, and conflating the two is how a product ends up in a room it was never
 * invited to. The user opts in per connection, afterwards.
 */
export async function syncCalendarConnectionsForUser(userId: string): Promise<number> {
  const membership = await rawPrisma.member.findFirst({
    where: { userId },
    include: { organization: { select: { tenant: { select: { id: true } } } } },
    orderBy: { createdAt: "asc" },
  });
  const tenantId = membership?.organization.tenant?.id;
  // No workspace yet. The organization-creation hook will call this again.
  if (!tenantId) return 0;

  const [user, accounts] = await Promise.all([
    rawPrisma.user.findUnique({ where: { id: userId }, select: { email: true } }),
    rawPrisma.account.findMany({
      where: { userId, providerId: { in: Object.keys(PROVIDER_BY_ID) } },
      select: { accountId: true, providerId: true, scope: true },
    }),
  ]);
  if (!user) return 0;

  let created = 0;
  for (const account of accounts) {
    const provider = PROVIDER_BY_ID[account.providerId];
    if (!provider) continue;

    const scope = (account.scope ?? "").toLowerCase();
    if (!CALENDAR_SCOPE_MARKERS.some((marker) => scope.includes(marker))) continue;

    const where = {
      userId_provider_providerAccountId_calendarId: {
        userId,
        provider,
        providerAccountId: account.accountId,
        calendarId: "primary",
      },
    };

    const existing = await rawPrisma.calendarConnection.findUnique({ where, select: { id: true, status: true } });

    if (!existing) {
      await rawPrisma.calendarConnection.create({
        data: {
          tenantId,
          userId,
          provider,
          providerAccountId: account.accountId,
          calendarId: "primary",
          email: user.email,
          status: CalendarConnectionStatus.active,
        },
      });
      created += 1;
      continue;
    }

    // Re-consent. A fresh grant is exactly what reauth_required was waiting for,
    // so clear the stop condition — nothing else in the system does.
    if (existing.status === CalendarConnectionStatus.reauth_required) {
      await rawPrisma.calendarConnection.update({
        where: { id: existing.id },
        data: { status: CalendarConnectionStatus.active, lastSyncError: null },
      });
      log.info({ connectionId: existing.id, userId }, "calendar connection reauthorised");
    }
  }

  if (created > 0) log.info({ userId, created }, "calendar connections provisioned");
  return created;
}
