import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api.js";
import { authClient, authErrorMessage } from "../auth-client.js";
import { IconPlus, IconRetry, IconTrash, IconX } from "../components/Icons.js";

/**
 * Connecting a calendar is an authentication concern, not an API one: the grant
 * that lets us read someone's calendar is the same grant they signed in with,
 * which is why `auth.ts` puts the calendar scopes on the Google and Microsoft
 * providers rather than asking for a second consent screen. `linkSocial` adds a
 * provider to the account that is already signed in — and re-running it against
 * a provider already linked is how a rejected refresh token gets replaced,
 * which is what the reauth path below depends on.
 */

/** The API's `CalendarProvider` enum. It happens to match the social providers. */
type CalendarProvider = "google" | "microsoft";
type ConnectionStatus = "active" | "reauth_required" | "disabled";

/** Mirrors `autoRecordRulesSchema` in the API. It is `.strict()`: no other keys. */
type AutoRecordRules = {
  externalOnly?: boolean;
  minAttendees?: number;
  titleExcludes?: string[];
};

type Connection = {
  id: string;
  provider: CalendarProvider;
  email: string;
  calendar_id: string;
  status: ConnectionStatus;
  has_sync_token: boolean;
  last_synced_at: string | null;
  last_sync_error: string | null;
  auto_record: boolean;
  auto_record_rules: AutoRecordRules;
  created_at: string;
  event_count: number;
};

type SyncResult = {
  status: "synced" | "reauth_required" | "skipped";
  fetched: number;
  upserted: number;
  cancelled: number;
  dispatched: number;
  full_resync: boolean;
  error: string | null;
};

const PROVIDER_LABEL: Record<CalendarProvider, string> = {
  google: "Google Calendar",
  microsoft: "Microsoft 365",
};

/** The API rejects longer needles; the field refuses to build one. */
const EXCLUDE_MAX = 120;
const EXCLUDES_MAX = 50;

/**
 * Connected calendars, and what the bot is allowed to do with them.
 *
 * Two panes for the same reason Meetings has two: the list is the set of
 * grants, the detail is one grant's rules. Everything on the right is about
 * *narrowing* — recording is opt-in per connection, never retroactive, and
 * every rule fails closed on the server, so the screen's job is to make the
 * current setting legible rather than to make it easy to widen.
 */
export function CalendarSettings() {
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [sync, setSync] = useState<SyncResult | null>(null);

  const [draft, setDraft] = useState<AutoRecordRules>({});
  const [excludeDraft, setExcludeDraft] = useState("");
  const [saving, setSaving] = useState(false);

  const [params, setParams] = useSearchParams();
  const seeded = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ connections: Connection[] }>("/calendar/connections");
      setConnections(data.connections);
      setSelectedId((id) => id ?? data.connections[0]?.id ?? null);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // The OAuth round trip lands back here with a marker. Read it once, then take
  // it out of the URL so a reload does not re-announce a link from last week.
  useEffect(() => {
    const connected = params.get("connected");
    const failed = params.get("error") ?? params.get("calendar_error");
    if (!connected && !failed) return;
    if (failed) {
      // The provider's error code is the only diagnostic there is, but it comes
      // off the query string — so it is matched against what we sent rather
      // than pasted into the page as it arrived.
      setError(
        failed === "1"
          ? "The calendar connection was not completed."
          : `The calendar connection was not completed (${failed.slice(0, 80)}).`,
      );
    } else {
      const provider = isProvider(connected) ? PROVIDER_LABEL[connected] : "The calendar";
      setNotice(`${provider} connected. Run a sync to pull events in.`);
    }
    setParams(new URLSearchParams(), { replace: true });
  }, [params, setParams]);

  const selected = useMemo(
    () => (connections ?? []).find((c) => c.id === selectedId) ?? null,
    [connections, selectedId],
  );

  // Seeded from the connection once, keyed by id. Re-seeding on every refetch
  // would throw away a half-typed rule the moment a background reload landed.
  useEffect(() => {
    if (!selected || seeded.current === selected.id) return;
    seeded.current = selected.id;
    setDraft(cloneRules(selected.auto_record_rules));
    setExcludeDraft("");
    setSync(null);
  }, [selected]);

  const dirty = selected ? rulesKey(draft) !== rulesKey(selected.auto_record_rules) : false;

  // Which providers this deployment actually holds OAuth credentials for.
  // Offering a Connect button for one it does not is how you get "Provider not
  // found" — an accurate message that tells the user nothing they can act on.
  const [available, setAvailable] = useState<CalendarProvider[] | null>(null);
  useEffect(() => {
    void (async () => {
      try {
        const r = await api.get<{ providers: CalendarProvider[] }>("/auth/providers");
        setAvailable(r.providers);
      } catch {
        // The endpoint is unauthenticated and should not fail. If it does,
        // fall back to offering both rather than hiding a working button.
        setAvailable(["google", "microsoft"]);
      }
    })();
  }, []);

  const connect = async (provider: CalendarProvider) => {
    setBusy(`connect:${provider}`);
    setError(null);
    // No `scopes` here on purpose: auth.ts already puts the calendar scopes on
    // the provider, and the provider merges its configured scope with anything
    // the client asks for. Repeating them here is how the two lists drift.
    const { error: linkError } = await authClient.linkSocial({
      provider,
      callbackURL: returnTo({ connected: provider }),
      errorCallbackURL: returnTo({ calendar_error: "1" }),
    });
    // Reached only when the flow did not start — on success the browser has
    // already left for the provider's consent screen.
    setBusy(null);
    if (linkError) {
      // A provider the deployment holds no credentials for fails here rather
      // than after a redirect, and the code it fails with is the only clue.
      const notConfigured = /provider not found/i.test(authErrorMessage(linkError) ?? "");
      setError(
        notConfigured
          ? `${PROVIDER_LABEL[provider]} is not configured on this deployment. ` +
            `An OAuth client has to exist before anyone can connect one: set ` +
            `${provider === "google" ? "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET" : "MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET"} ` +
            `and restart the API. See docs/CALENDAR-SETUP.md.`
          : `${PROVIDER_LABEL[provider]} could not be connected. ${authErrorMessage(linkError)}`,
      );
    }
  };

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    // Last action's outcome, cleared before the next one: a stale "Rules saved"
    // sitting above a failed sync is worse than no message at all.
    setNotice(null);
    try {
      await fn();
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const toggleAutoRecord = (connection: Connection, next: boolean) =>
    act(`auto:${connection.id}`, async () => {
      await api.patch(`/calendar/connections/${connection.id}`, { auto_record: next });
      // Refetched rather than spliced: the list carries an event count the
      // patch response does not, and a screen showing two sources of one row is
      // a screen that eventually shows them disagreeing.
      await load();
      setNotice(
        next
          ? "Auto-record is on. It applies to events synced from now on, never to ones already in the calendar."
          : "Auto-record is off. Nothing on this calendar will be joined automatically.",
      );
    });

  const saveRules = () =>
    act(`rules:${selected?.id}`, async () => {
      if (!selected) return;
      setSaving(true);
      try {
        await api.patch(`/calendar/connections/${selected.id}`, { auto_record_rules: prune(draft) });
        await load();
        seeded.current = null;
        setNotice("Rules saved.");
      } finally {
        setSaving(false);
      }
    });

  const runSync = (connection: Connection) =>
    act(`sync:${connection.id}`, async () => {
      const result = await api.post<{ sync: SyncResult }>(`/calendar/connections/${connection.id}/sync`);
      setSync(result.sync);
      await load();
    });

  const disconnect = (connection: Connection) => {
    if (
      !window.confirm(
        `Disconnect ${connection.email}? The mirrored events go with it. Meetings already recorded stay, with their transcripts.`,
      )
    ) {
      return;
    }
    void act(`disconnect:${connection.id}`, async () => {
      await api.del(`/calendar/connections/${connection.id}`);
      setSelectedId(null);
      seeded.current = null;
      await load();
    });
  };

  return (
    <div className="screen">
      <header className="screen-head">
        <h1>Calendar</h1>
        <span className="sub">Which calls the bot is allowed to join, and on whose grant</span>
        <div className="grow" />
        {(["google", "microsoft"] as const).map((provider) => {
          const configured = available === null || available.includes(provider);
          return (
            <button
              key={provider}
              className="btn sm"
              disabled={busy === `connect:${provider}` || !configured}
              title={
                configured
                  ? undefined
                  : `This deployment has no ${PROVIDER_LABEL[provider]} OAuth client configured.`
              }
              onClick={() => void connect(provider)}
            >
              <IconPlus /> {provider === "google" ? "Google" : "Microsoft"}
            </button>
          );
        })}
      </header>

      <div className="panes">
        <div className="pane list">
          <div className="pane-head">
            <span className="grow">Connections</span>
            {connections && <span>{connections.length}</span>}
          </div>

          <div className="pane-body scroll">
            {connections === null && <><div className="skeleton" /><div className="skeleton" /></>}

            {connections?.length === 0 && (
              <div className="empty">
                <h3>No calendar connected</h3>
                <p>
                  Connect Google or Microsoft above. The calendar grant rides on the same sign-in
                  consent, so there is no second permission screen.
                </p>
              </div>
            )}

            {connections?.map((connection) => (
              <button
                key={connection.id}
                className={`row${selectedId === connection.id ? " selected" : ""}`}
                onClick={() => setSelectedId(connection.id)}
              >
                <div className="row-top">
                  <span
                    className="grow"
                    style={{ fontWeight: 600, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  >
                    {connection.email}
                  </span>
                  <ConnectionChip connection={connection} />
                </div>
                <div className="row-meta mono">
                  <span>{PROVIDER_LABEL[connection.provider]}</span>
                  <span>{connection.auto_record ? "auto-record on" : "manual only"}</span>
                  <span>{connection.event_count} events</span>
                </div>
              </button>
            ))}
          </div>
        </div>

        <div className="pane detail">
          <div className="pane-head">
            <span className="grow">{selected ? PROVIDER_LABEL[selected.provider] : "Connection"}</span>
            {selected && <span>{selected.calendar_id}</span>}
          </div>

          {error && <div className="banner error">{error}</div>}
          {notice && <div className="banner info">{notice}</div>}

          {!selected ? (
            <div className="empty" style={{ marginTop: 40 }}>
              <h3>No connection selected</h3>
              <p>Pick a calendar to see what it syncs and what it is allowed to record.</p>
            </div>
          ) : (
            <div className="pane-body scroll">
              <div className="detail-body">
                <h2 style={{ margin: "6px 0 4px", fontSize: 20, fontWeight: 600, letterSpacing: "-0.02em" }}>
                  {selected.email}
                </h2>
                <div className="mono" style={{ color: "var(--faint)", marginBottom: 20 }}>
                  {PROVIDER_LABEL[selected.provider]} · connected {new Date(selected.created_at).toLocaleDateString()}
                </div>

                {/* The reauth case says what happened and what to do about it.
                    Reporting it as "last synced 9 days ago" would be true and
                    useless: nothing will change until someone re-consents, and
                    a stale timestamp reads as a delay rather than as a stop. */}
                {selected.status === "reauth_required" && (
                  <div className="banner error" style={{ margin: "0 0 18px" }}>
                    <strong>Syncing has stopped.</strong>{" "}
                    {PROVIDER_LABEL[selected.provider]} rejected the saved permission — this happens
                    when the password changes, the grant is revoked, or an administrator resets it.
                    Nothing on this calendar is being watched and no bot will be scheduled from it
                    until you reconnect.
                    {selected.last_sync_error && (
                      <div className="mono" style={{ marginTop: 6, opacity: 0.85 }}>{selected.last_sync_error}</div>
                    )}
                    <div style={{ marginTop: 10 }}>
                      <button
                        className="btn sm"
                        disabled={busy === `connect:${selected.provider}`}
                        onClick={() => void connect(selected.provider)}
                      >
                        <IconRetry /> Reconnect {PROVIDER_LABEL[selected.provider]}
                      </button>
                    </div>
                  </div>
                )}

                {selected.status === "disabled" && (
                  <div className="banner info" style={{ margin: "0 0 18px" }}>
                    This connection is disabled. It keeps its rules and its history, but it is not
                    being synced.
                  </div>
                )}

                {selected.status === "active" && selected.last_sync_error && (
                  <div className="banner error" style={{ margin: "0 0 18px" }}>
                    Last sync failed — {selected.last_sync_error}
                  </div>
                )}

                <div className="stat-grid">
                  <div className="stat" title={selected.last_synced_at ? new Date(selected.last_synced_at).toLocaleString() : "This calendar has never been synced"}>
                    <div className="v" style={{ fontSize: 15 }}>{formatSince(selected.last_synced_at)}</div>
                    <div className="k">Last synced</div>
                  </div>
                  <div className="stat"><div className="v">{selected.event_count}</div><div className="k">Events</div></div>
                  <div className="stat">
                    <div className="v" style={{ fontSize: 15 }}>{selected.has_sync_token ? "Incremental" : "Full"}</div>
                    <div className="k">Next sync</div>
                  </div>
                </div>

                <div style={{ display: "flex", gap: 8, marginBottom: 24, flexWrap: "wrap" }}>
                  <button
                    className="btn sm"
                    disabled={busy === `sync:${selected.id}` || selected.status !== "active"}
                    title={
                      selected.status === "active"
                        ? "Fetch changes from the provider now"
                        : "Syncing is stopped for this connection"
                    }
                    onClick={() => void runSync(selected)}
                  >
                    <IconRetry /> {busy === `sync:${selected.id}` ? "Syncing…" : "Sync now"}
                  </button>
                  <button
                    className="btn sm reject"
                    disabled={busy === `disconnect:${selected.id}`}
                    onClick={() => disconnect(selected)}
                  >
                    <IconTrash /> Disconnect
                  </button>
                </div>

                {sync && (
                  <div className="section">
                    <h3>Last manual sync</h3>
                    <dl className="kv">
                      <dt>Result</dt><dd>{SYNC_LABEL[sync.status]}</dd>
                      <dt>Fetched</dt><dd>{sync.fetched}</dd>
                      <dt>Updated</dt><dd>{sync.upserted}</dd>
                      <dt>Cancelled</dt><dd>{sync.cancelled}</dd>
                      <dt>Bots sent</dt><dd>{sync.dispatched}</dd>
                      <dt>Mode</dt><dd>{sync.full_resync ? "Full resync — the provider invalidated our cursor" : "Incremental"}</dd>
                      {sync.error && <><dt>Error</dt><dd style={{ color: "var(--red)" }}>{sync.error}</dd></>}
                    </dl>
                  </div>
                )}

                <div className="section">
                  <h3>Auto-record</h3>
                  <label style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={selected.auto_record}
                      disabled={busy === `auto:${selected.id}`}
                      onChange={(e) => void toggleAutoRecord(selected, e.target.checked)}
                      style={{ marginTop: 3, accentColor: "var(--orange)" }}
                    />
                    <span>
                      <span style={{ fontWeight: 600 }}>Send a bot to matching events on this calendar</span>
                      <div style={{ color: "var(--muted)", fontSize: 13 }}>
                        Applies to events synced from now on. Turning it on never reaches back to
                        calls that are already in the calendar.
                      </div>
                    </span>
                  </label>
                </div>

                <div className="section" style={{ opacity: selected.auto_record ? 1 : 0.55 }}>
                  <h3>Which events</h3>
                  {!selected.auto_record && (
                    <div className="mono" style={{ color: "var(--faint)", marginBottom: 10 }}>
                      Stored, but inert while auto-record is off.
                    </div>
                  )}

                  <label style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 12, cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={draft.externalOnly ?? false}
                      onChange={(e) => setDraft((d) => ({ ...d, externalOnly: e.target.checked }))}
                      style={{ marginTop: 3, accentColor: "var(--orange)" }}
                    />
                    <span>
                      <span style={{ fontWeight: 600 }}>Only calls with someone outside {domainOf(selected.email) ?? "this domain"}</span>
                      <div style={{ color: "var(--muted)", fontSize: 13 }}>
                        Internal stand-ups and one-to-ones stay unrecorded.
                      </div>
                    </span>
                  </label>

                  <div style={{ marginBottom: 14 }}>
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>Minimum attendees</div>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <input
                        className="input"
                        type="number"
                        min={0}
                        max={500}
                        style={{ width: 110 }}
                        placeholder="Any"
                        value={draft.minAttendees ?? ""}
                        onChange={(e) => {
                          const raw = e.target.value.trim();
                          setDraft((d) => {
                            const next = { ...d };
                            if (raw === "") delete next.minAttendees;
                            else next.minAttendees = clamp(Number(raw), 0, 500);
                            return next;
                          });
                        }}
                      />
                      <span style={{ color: "var(--muted)", fontSize: 13 }}>
                        Rooms and equipment do not count — the server filters resource attendees out.
                      </span>
                    </div>
                  </div>

                  <div>
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>Skip titles containing</div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
                      {(draft.titleExcludes ?? []).map((needle) => (
                        <span key={needle} className="chip" style={{ textTransform: "none", letterSpacing: 0 }}>
                          {needle}
                          <button
                            className="btn sm"
                            aria-label={`Remove ${needle}`}
                            style={{ border: "none", background: "none", padding: 0, marginLeft: 2 }}
                            onClick={() =>
                              setDraft((d) => ({
                                ...d,
                                titleExcludes: (d.titleExcludes ?? []).filter((n) => n !== needle),
                              }))
                            }
                          >
                            <IconX size={12} />
                          </button>
                        </span>
                      ))}
                      {(draft.titleExcludes ?? []).length === 0 && (
                        <span className="mono" style={{ color: "var(--faint)" }}>nothing excluded</span>
                      )}
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <input
                        className="input"
                        style={{ maxWidth: 260 }}
                        maxLength={EXCLUDE_MAX}
                        placeholder="e.g. 1:1, interview, personal"
                        value={excludeDraft}
                        onChange={(e) => setExcludeDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key !== "Enter") return;
                          e.preventDefault();
                          addExclude();
                        }}
                      />
                      <button className="btn sm" disabled={!canAddExclude()} onClick={addExclude}>
                        <IconPlus /> Add
                      </button>
                    </div>
                    <div className="mono" style={{ color: "var(--faint)", marginTop: 6 }}>
                      Matched case-insensitively, anywhere in the title.
                    </div>
                  </div>
                </div>

                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <button className="btn primary sm" disabled={!dirty || saving} onClick={() => void saveRules()}>
                    {saving ? "Saving…" : "Save rules"}
                  </button>
                  {dirty && (
                    <button
                      className="btn sm"
                      onClick={() => { setDraft(cloneRules(selected.auto_record_rules)); setExcludeDraft(""); }}
                    >
                      Discard
                    </button>
                  )}
                  {/* Rules save explicitly while the toggle applies on the spot:
                      a half-typed exclusion is not something to act on, and a
                      switch that needs a second click reads as broken. */}
                  <span className="mono" style={{ color: "var(--faint)" }}>
                    {dirty ? "unsaved changes" : "saved"}
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  function canAddExclude(): boolean {
    const value = excludeDraft.trim();
    if (value.length === 0 || value.length > EXCLUDE_MAX) return false;
    const existing = draft.titleExcludes ?? [];
    return existing.length < EXCLUDES_MAX && !existing.includes(value);
  }

  function addExclude(): void {
    if (!canAddExclude()) return;
    const value = excludeDraft.trim();
    setDraft((d) => ({ ...d, titleExcludes: [...(d.titleExcludes ?? []), value] }));
    setExcludeDraft("");
  }
}

/* ---------------------------------------------------------------------- */

const SYNC_LABEL: Record<SyncResult["status"], string> = {
  synced: "Synced",
  reauth_required: "Stopped — the provider rejected the saved permission",
  skipped: "Skipped — this connection is not active",
};

function ConnectionChip({ connection }: { connection: Connection }) {
  if (connection.status === "reauth_required") {
    return <span className="chip error"><span className="dot" />reconnect needed</span>;
  }
  if (connection.status === "disabled") {
    return <span className="chip"><span className="dot" />disabled</span>;
  }
  if (connection.last_sync_error) {
    return <span className="chip error"><span className="dot" />sync failed</span>;
  }
  if (!connection.last_synced_at) {
    return <span className="chip working"><span className="dot" />never synced</span>;
  }
  return <span className="chip ready"><span className="dot" />syncing</span>;
}

/**
 * Wherever the integrator mounts this screen, the OAuth round trip has to come
 * back to it. Derived from the current location rather than written out, so the
 * path is not duplicated here as a string that can drift from App.tsx.
 */
function isProvider(value: string | null): value is CalendarProvider {
  return value === "google" || value === "microsoft";
}

function returnTo(params: Record<string, string>): string {
  const url = new URL(window.location.pathname, window.location.origin);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

function cloneRules(rules: AutoRecordRules): AutoRecordRules {
  return {
    ...(rules.externalOnly !== undefined ? { externalOnly: rules.externalOnly } : {}),
    ...(rules.minAttendees !== undefined ? { minAttendees: rules.minAttendees } : {}),
    ...(rules.titleExcludes ? { titleExcludes: [...rules.titleExcludes] } : {}),
  };
}

/**
 * The PATCH replaces the whole rules object, so an unset rule has to be absent
 * rather than false or zero — `externalOnly: false` and no `externalOnly` mean
 * the same thing to the matcher, but only one of them survives a round trip
 * through a `.strict()` schema unchanged.
 */
function prune(rules: AutoRecordRules): AutoRecordRules {
  const out: AutoRecordRules = {};
  if (rules.externalOnly) out.externalOnly = true;
  if (rules.minAttendees !== undefined && rules.minAttendees > 0) out.minAttendees = rules.minAttendees;
  const excludes = (rules.titleExcludes ?? []).map((n) => n.trim()).filter((n) => n.length > 0);
  if (excludes.length > 0) out.titleExcludes = excludes;
  return out;
}

/** Stable serialisation, so a dirty check does not fire on key order. */
function rulesKey(rules: AutoRecordRules): string {
  const pruned = prune(rules);
  return JSON.stringify([
    pruned.externalOnly ?? false,
    pruned.minAttendees ?? null,
    pruned.titleExcludes ?? [],
  ]);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function domainOf(email: string): string | null {
  const at = email.lastIndexOf("@");
  return at === -1 ? null : email.slice(at + 1).toLowerCase() || null;
}

/**
 * "4 minutes ago" over a timestamp, because the question a reader has is how
 * stale this is, not what time it was. The exact time is on the element's title
 * for the case where the answer matters.
 */
function formatSince(iso: string | null): string {
  if (!iso) return "Never";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "Never";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days}d ago` : new Date(iso).toLocaleDateString();
}
