import type { MeetingStatus } from "../api.js";

/**
 * One chip per state-machine state. The tone groups states by what the user
 * should do about them: nothing yet, it's live, we're working, it's your turn,
 * it broke.
 */
const STATES: Record<MeetingStatus, { label: string; tone: string; pulse?: boolean }> = {
  draft: { label: "Draft", tone: "pending" },
  bot_scheduled: { label: "Bot scheduled", tone: "pending" },
  bot_joined: { label: "In call", tone: "live" },
  recording: { label: "Recording", tone: "live", pulse: true },
  call_ended: { label: "Call ended", tone: "working" },
  media_processing: { label: "Fetching media", tone: "working", pulse: true },
  transcript_ready: { label: "Transcript ready", tone: "working" },
  extracting: { label: "Extracting", tone: "working", pulse: true },
  in_review: { label: "Needs review", tone: "ready" },
  merged: { label: "Merged", tone: "ready" },
  failed: { label: "Failed", tone: "error" },
};

export const STATUS_LABEL: Record<MeetingStatus, string> = Object.fromEntries(
  Object.entries(STATES).map(([k, v]) => [k, v.label]),
) as Record<MeetingStatus, string>;

export function StatusChip({ status }: { status: MeetingStatus }) {
  const state = STATES[status] ?? { label: status, tone: "pending" };
  return (
    <span className={`chip ${state.tone}`}>
      <span className={`dot${state.pulse ? " pulse" : ""}`} />
      {state.label}
    </span>
  );
}

/** States where the pipeline is still moving on its own and polling is useful. */
export const ACTIVE_STATUSES: MeetingStatus[] = [
  "bot_scheduled",
  "bot_joined",
  "recording",
  "call_ended",
  "media_processing",
  "transcript_ready",
  "extracting",
];
