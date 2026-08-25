# Connecting Google and Microsoft calendars

"Google Calendar could not be connected. Provider not found" means exactly one
thing: this deployment holds no OAuth client for that provider, so Better Auth
never registered it. It is configuration, not a fault in the app — and it cannot
be fixed from inside the product, because only you can create an OAuth client
under your own identity.

Calendar access rides the **same grant as sign-in**. There is no second consent
screen, which is why the scopes live on the provider in `apps/api/src/auth.ts`.

---

## Google

### 1. Create the OAuth client

[Google Cloud Console](https://console.cloud.google.com) → pick or create a
project → **APIs & Services**.

1. **Enable the Google Calendar API.** Library → "Google Calendar API" → Enable.
   Skipping this is the most common failure: the OAuth flow succeeds and every
   later API call returns `403 accessNotConfigured`, which reads like a
   permissions bug rather than a missing switch.
2. **OAuth consent screen** → External (or Internal, if this is a Workspace
   org and only your own domain will ever connect — Internal skips verification
   entirely and is worth taking if it applies to you).
3. Add these scopes:
   ```
   https://www.googleapis.com/auth/calendar.readonly
   https://www.googleapis.com/auth/calendar.events.readonly
   ```
4. **Credentials → Create credentials → OAuth client ID → Web application.**
   Authorised redirect URI, exactly:
   ```
   {APP_BASE_URL}/api/auth/callback/google
   ```
   For local development that is `http://localhost:8787/api/auth/callback/google`.
   The path is Better Auth's and is not configurable here.

### 2. Put the credentials in `.env`

```bash
GOOGLE_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=...
```

Restart the API. `GET /api/v1/auth/providers` should now list `google`, and the
Connect button becomes clickable.

### 3. Verification — start this early

Calendar scopes are **sensitive**, so an External app must pass Google's
verification before anyone outside your test users can connect. That review runs
in **weeks**, not days.

Until it passes: add each account as a **Test user** on the consent screen and
it works immediately, with an "unverified app" interstitial. That is enough for
development and for a pilot, and it is not enough for customers. If everyone who
will ever connect is in your own Workspace domain, choose **Internal** instead
and skip the whole process.

---

## Microsoft

[Entra admin centre](https://entra.microsoft.com) → App registrations → New.

1. Redirect URI, **Web** platform:
   ```
   {APP_BASE_URL}/api/auth/callback/microsoft
   ```
2. API permissions → Microsoft Graph → **Delegated**: `Calendars.Read`,
   `offline_access`, `User.Read`.
3. Certificates & secrets → New client secret. Copy the **Value**, not the
   Secret ID — they sit next to each other and the ID is useless here.

```bash
MICROSOFT_CLIENT_ID=...
MICROSOFT_CLIENT_SECRET=...
MICROSOFT_TENANT_ID=common     # or your tenant id to restrict to one org
```

---

## What connecting actually does

Connecting reads your calendar. It does **not** start recording anything.

A `CalendarConnection` is created with `autoRecord: false`, and recording is a
separate, explicit decision you make per calendar or per event. That separation
is deliberate: a product that starts recording the moment you link a calendar
will eventually put a bot in a room it was never invited to.

Precedence, most specific first:

1. a per-event toggle
2. the calendar's rules (`externalOnly`, `minAttendees`, `titleExcludes`)
3. your personal default in **My settings**

An event with no joinable link is never recorded, whatever the settings say — a
bot cannot join a URL that does not exist.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `Provider not found` | No client id/secret for that provider. The button is now disabled when this is the case. |
| `redirect_uri_mismatch` | The URI in the console differs from `{APP_BASE_URL}/api/auth/callback/{provider}` — by a trailing slash, `http` vs `https`, or a port. |
| `403 accessNotConfigured` | The Google Calendar API is not enabled on the project. |
| Connects, then stops syncing days later | No refresh token. `auth.ts` sends `accessType: offline` and `prompt: consent` for exactly this reason; if you changed either, revoke the grant and reconnect. |
| Connection shows `reauth_required` | The refresh token was rejected — usually the grant was revoked. Reconnect; the status clears itself. |
