import { MeetingStatus } from "@prisma/client";

/**
 * Recall webhook payloads. Every event — bot status changes and recording /
 * media artifact events alike — shares this envelope:
 *
 *   { event, data: { data: { code, sub_code, updated_at },
 *                    bot?: {id}, recording?: {id}, transcript?: {id} } }
 */
export type RecallWebhookPayload = {
  event?: string;
  data?: {
    data?: { code?: string; sub_code?: string | null; updated_at?: string };
    bot?: { id?: string; metadata?: Record<string, string> };
    recording?: { id?: string; metadata?: Record<string, string> };
    transcript?: { id?: string; metadata?: Record<string, string> };
  };
};

export type WebhookIds = {
  eventType: string;
  botId: string | null;
  recordingId: string | null;
  transcriptId: string | null;
  updatedAt: string | null;
  subCode: string | null;
};

export function readIds(payload: RecallWebhookPayload): WebhookIds {
  const d = payload.data ?? {};
  return {
    eventType: payload.event ?? "unknown",
    botId: d.bot?.id ?? null,
    recordingId: d.recording?.id ?? null,
    transcriptId: d.transcript?.id ?? null,
    updatedAt: d.data?.updated_at ?? null,
    subCode: d.data?.sub_code ?? null,
  };
}

/**
 * Dedupe key: (event type, subject id, updated_at).
 *
 * Recall may deliver the same webhook more than once and out of order. A
 * unique index on this key means a redelivery is a no-op insert rather than a
 * second run of the handler.
 */
export function dedupeKeyFor(ids: WebhookIds): string {
  const subject = ids.transcriptId ?? ids.recordingId ?? ids.botId ?? "unknown";
  return `${ids.eventType}:${subject}:${ids.updatedAt ?? "no-ts"}`;
}

/** Bot lifecycle events that move the meeting forward. */
const BOT_STATUS_MAP: Record<string, MeetingStatus> = {
  "bot.joining_call": MeetingStatus.bot_scheduled,
  "bot.in_waiting_room": MeetingStatus.bot_scheduled,
  "bot.in_call_not_recording": MeetingStatus.bot_joined,
  "bot.recording_permission_allowed": MeetingStatus.bot_joined,
  "bot.in_call_recording": MeetingStatus.recording,
  "bot.call_ended": MeetingStatus.call_ended,
  "bot.done": MeetingStatus.call_ended,
};

export function statusForBotEvent(eventType: string): MeetingStatus | null {
  return BOT_STATUS_MAP[eventType] ?? null;
}

const FAILURE_EVENTS = new Set([
  "bot.fatal",
  "bot.recording_permission_denied",
  "recording.failed",
  "transcript.failed",
]);

export function isFailureEvent(eventType: string): boolean {
  return FAILURE_EVENTS.has(eventType);
}

/** Events we log but take no action on — breakout rooms, deletions, progress. */
export function isActionable(eventType: string): boolean {
  return (
    Boolean(BOT_STATUS_MAP[eventType]) ||
    FAILURE_EVENTS.has(eventType) ||
    eventType === "recording.done" ||
    eventType === "transcript.done"
  );
}
