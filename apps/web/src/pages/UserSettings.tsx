import { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";
import { useSession } from "../auth-client.js";
import { isRouteMissing } from "../components/ActionItemRow.js";

/**
 * You, and whether a bot walks into your meetings.
 *
 * These settings belong to a person rather than to a workspace — someone in two
 * workspaces has one answer to "should a recorder join my calls" — which is why
 * they sit on their own screen instead of under Workspace, and why the API
 * serves them from `/preferences` with no tenant in sight.
 *
 * Every mode below is explained in the interface rather than left to its name.
 * "External" is not self-evident, and this is the setting that decides whether
 * a recorder joins a conversation somebody else is in: a person choosing it has
 * to be able to predict what it will do without reading the source.
 */

const AUTO_RECORD_MODES = ["none", "all", "external", "owned"] as const;
type AutoRecordMode = (typeof AUTO_RECORD_MODES)[number];

/**
 * Written from `fromMode` in apps/api/src/domain/auto-record.ts, which is the
 * only place these mean anything. If that ladder changes, this copy is wrong
 * and somebody gets recorded who did not expect to be.
 */
const MODE_COPY: Record<AutoRecordMode, { label: string; what: string }> = {
  none: {
    label: "Never",
    what: "No bot joins anything on its own. You start every recording yourself, from the calendar or from a meeting.",
  },
  all: {
    label: "Every meeting",
    what: "A bot joins every calendar event that has a joinable link. All-day blocks and events without a link are skipped — there is nothing to join.",
  },
  external: {
    label: "Meetings with people outside your company",
    what: "A bot joins only when at least one invited person's email domain differs from the connected mailbox's. An all-internal meeting is left alone. Meeting rooms and equipment are not counted as people.",
  },
  owned: {
    label: "Meetings you organise",
    what: "A bot joins only when the event's organiser is the connected mailbox. An event with no organiser is skipped rather than guessed at.",
  },
};

type Preferences = {
  auto_record_mode: AutoRecordMode;
  timezone: string | null;
  recording_method: string;
  updated_at: string;
};

export function UserSettings() {
  const session = useSession();
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ preferences: Preferences }>("/preferences");
      setPreferences(data.preferences);
      setUnavailable(false);
      setError(null);
    } catch (e) {
      if (isRouteMissing(e)) {
        setUnavailable(true);
        return;
      }
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Optimistic, and rolled back loudly.
   *
   * A radio that snaps back without saying why would leave someone believing
   * they had switched recording off. The banner is the point of the rollback,
   * not a courtesy on top of it.
   */
  const save = (patch: Partial<Preferences>, said: string) => {
    if (!preferences) return;
    const before = preferences;
    setPreferences({ ...preferences, ...patch });
    setBusy(true);
    setNotice(null);

    void (async () => {
      try {
        const data = await api.patch<{ preferences: Preferences }>("/preferences", patch);
        setPreferences(data.preferences);
        setNotice(said);
        setError(null);
      } catch (e) {
        setPreferences(before);
        setNotice(null);
        setError(`Not saved — ${(e as Error).message}`);
      } finally {
        setBusy(false);
      }
    })();
  };

  const user = session.data?.user;
  const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return (
    <div className="screen">
      <header className="screen-head">
        <h1>You</h1>
        <span className="sub">Your account, and what recording does by default</span>
        <div className="grow" />
        {preferences && (
          <span className="chip">
            <span className="dot" />
            auto-record: {MODE_COPY[preferences.auto_record_mode].label.toLowerCase()}
          </span>
        )}
      </header>

      <div className="panes">
        <div className="pane detail">
          <div className="pane-head">
            <span className="grow">{user?.name || "Settings"}</span>
            {preferences && (
              <span>saved {new Date(preferences.updated_at).toLocaleString()}</span>
            )}
          </div>

          {error && <div className="banner error">{error}</div>}
          {notice && <div className="banner info">{notice}</div>}

          <div className="pane-body scroll">
            <div className="detail-body">
              <div className="section">
                <h3>Account</h3>
                <dl className="kv">
                  <dt>Name</dt>
                  <dd>{user?.name || "—"}</dd>
                  <dt>Email</dt>
                  <dd className="mono">{user?.email || "—"}</dd>
                  <dt>User</dt>
                  <dd className="mono">{user?.id || "—"}</dd>
                </dl>
                {/* Read-only rather than a form that does nothing: the API has
                    no route that changes a name or an email, and an input that
                    silently discards what you type is worse than a fact. */}
                <p style={HINT}>
                  Your name and email come from the account you signed in with and
                  are changed there.
                </p>
              </div>

              {unavailable ? (
                <div className="empty" style={{ marginTop: 30 }}>
                  <h3>Recording preferences are not available</h3>
                  <p>
                    This build does not serve <span className="mono">/preferences</span>.
                    Until it does, auto-record falls back to its default: never.
                  </p>
                </div>
              ) : (
                <>
                  <div className="section">
                    <h3>Auto-record</h3>

                    {/* Said before the choice rather than after it. Someone who
                        picks "Every meeting" and then finds a calendar not
                        recording will otherwise conclude the setting is broken,
                        when in fact it was correctly overruled. */}
                    <div className="banner info" style={{ margin: "0 0 12px" }}>
                      This is your default, and it is the last word rather than the
                      first. A recording switch on an individual event wins over it,
                      and so does a calendar you have given its own rules — so
                      turning this on cannot drag an opted-out calendar into
                      recording.
                    </div>

                    {preferences === null && !error ? (
                      <>
                        <div className="skeleton" />
                        <div className="skeleton" />
                      </>
                    ) : (
                      preferences &&
                      AUTO_RECORD_MODES.map((mode) => {
                        const active = preferences.auto_record_mode === mode;
                        return (
                          <label
                            key={mode}
                            style={{
                              display: "flex",
                              gap: 10,
                              alignItems: "flex-start",
                              padding: "11px 12px",
                              marginBottom: 8,
                              border: `1px solid ${active ? "var(--orange-line)" : "var(--line)"}`,
                              borderRadius: "var(--r)",
                              background: active ? "var(--orange-soft)" : "var(--pane)",
                              cursor: busy ? "progress" : "pointer",
                            }}
                          >
                            <input
                              type="radio"
                              name="auto-record-mode"
                              value={mode}
                              checked={active}
                              disabled={busy}
                              onChange={() =>
                                save(
                                  { auto_record_mode: mode },
                                  `Auto-record set to “${MODE_COPY[mode].label}”.`,
                                )
                              }
                              style={{ marginTop: 3, accentColor: "var(--orange)" }}
                            />
                            <span>
                              <span style={{ display: "block", fontWeight: 600, fontSize: 13 }}>
                                {MODE_COPY[mode].label}
                              </span>
                              <span
                                style={{
                                  display: "block",
                                  fontSize: 12,
                                  color: "var(--muted)",
                                  lineHeight: 1.5,
                                  marginTop: 3,
                                }}
                              >
                                {MODE_COPY[mode].what}
                              </span>
                            </span>
                          </label>
                        );
                      })
                    )}
                  </div>

                  <div className="section">
                    <h3>How it records</h3>
                    <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                      <select
                        className="select"
                        aria-label="Recording method"
                        value={preferences?.recording_method ?? "bot"}
                        disabled
                        onChange={() => undefined}
                      >
                        <option value="bot">A bot joins the call</option>
                      </select>
                      <span className="chip">only option</span>
                    </div>
                    {/* A select with one entry is honest here in a way a fixed
                        label would not be: the field exists on the record and
                        will grow, and hiding it would make the eventual second
                        option look like a new feature rather than a choice. */}
                    <p style={HINT}>
                      A visible participant joins the call and records it, so everyone
                      in the meeting can see it is there. Capturing from your own
                      machine is a different consent question and is not offered.
                    </p>
                  </div>

                  <div className="section">
                    <h3>Time zone</h3>
                    <p style={{ ...HINT, marginTop: 0 }}>
                      The zone your calendar and due dates are read in. Leave it unset
                      and this device's zone is used, which follows you when you
                      travel — set it when you would rather it did not.
                    </p>

                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <select
                        className="select"
                        aria-label="Time zone"
                        style={{ maxWidth: 320 }}
                        value={preferences?.timezone ?? ""}
                        disabled={busy || !preferences}
                        onChange={(e) =>
                          save(
                            // The API rejects an empty string and takes null to
                            // mean "not set", so the blank option has to send
                            // one rather than the other.
                            { timezone: e.target.value || null },
                            e.target.value
                              ? `Time zone set to ${e.target.value}.`
                              : "Time zone cleared — this device's zone is used.",
                          )
                        }
                      >
                        <option value="">Use this device ({deviceZone})</option>
                        {/* An unknown zone stored by an older build would match
                            no option and render blank, which reads as "unset"
                            rather than as "something you cannot see". */}
                        {preferences?.timezone && !TIME_ZONES.includes(preferences.timezone) && (
                          <option value={preferences.timezone}>{preferences.timezone}</option>
                        )}
                        {TIME_ZONES.map((zone) => (
                          <option key={zone} value={zone}>
                            {zone.replace(/_/g, " ")}
                          </option>
                        ))}
                      </select>

                      {preferences?.timezone !== deviceZone && (
                        <button
                          className="btn sm"
                          disabled={busy || !preferences}
                          onClick={() =>
                            save({ timezone: deviceZone }, `Time zone set to ${deviceZone}.`)
                          }
                        >
                          Use {deviceZone}
                        </button>
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------- */

/**
 * Asked of the platform rather than shipped as a list, matching the API's
 * validation — it calls `Intl.DateTimeFormat` on whatever arrives rather than
 * checking an allowlist, so a hardcoded list here could only ever be a subset
 * of what the server accepts. Older engines without `supportedValuesOf` fall
 * back to the device's own zone, which is the one that matters most.
 */
const TIME_ZONES: string[] = (() => {
  const supported = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
  const zones = supported ? supported("timeZone") : [];
  const device = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return zones.length > 0 ? zones : [device];
})();

const HINT: React.CSSProperties = {
  color: "var(--faint)",
  fontSize: 12,
  lineHeight: 1.55,
  margin: "10px 0 0",
};
