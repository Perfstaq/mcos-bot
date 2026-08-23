import { MeetingStatus, type Prisma } from "@prisma/client";
import type { Db } from "../db.js";

/**
 * The meeting state machine.
 *
 * draft → bot_scheduled → bot_joined → recording → call_ended →
 * media_processing → transcript_ready → extracting → in_review → merged
 *                                                              ↘ failed
 *
 * Transitions are RANK-GUARDED: each state has an ordinal and a move to a
 * lower or equal rank is ignored. This is the whole reason out-of-order
 * webhook delivery is safe — a late `bot.in_call_recording` arriving after
 * `recording.done` cannot rewind the meeting. `failed` is reachable from
 * anywhere and only an explicit retry leaves it.
 */
export const STATUS_RANK: Record<MeetingStatus, number> = {
  [MeetingStatus.draft]: 0,
  [MeetingStatus.bot_scheduled]: 1,
  [MeetingStatus.bot_joined]: 2,
  [MeetingStatus.recording]: 3,
  [MeetingStatus.call_ended]: 4,
  [MeetingStatus.media_processing]: 5,
  [MeetingStatus.transcript_ready]: 6,
  [MeetingStatus.extracting]: 7,
  [MeetingStatus.in_review]: 8,
  [MeetingStatus.merged]: 9,
  [MeetingStatus.failed]: -1,
};

export const TERMINAL: ReadonlySet<MeetingStatus> = new Set([
  MeetingStatus.merged,
  MeetingStatus.failed,
]);

export function canTransition(from: MeetingStatus, to: MeetingStatus): boolean {
  if (from === to) return false;
  if (to === MeetingStatus.failed) return from !== MeetingStatus.failed;
  // A failed meeting only moves again through an explicit retry, which resets
  // the status directly rather than going through this guard.
  if (from === MeetingStatus.failed) return false;
  if (from === MeetingStatus.merged) return false;
  return STATUS_RANK[to] > STATUS_RANK[from];
}

export type TransitionResult = {
  applied: boolean;
  from: MeetingStatus;
  to: MeetingStatus;
};

/**
 * Move a meeting forward and record the move. Returns `applied: false` when
 * the guard rejected it — that is an ordinary outcome, not an error: it means
 * a webhook arrived late or twice.
 */
export async function transition(
  db: Db | Prisma.TransactionClient,
  args: {
    meetingId: string;
    to: MeetingStatus;
    reason?: string;
    /** Extra columns to write in the same statement as the status change. */
    patch?: Prisma.MeetingUpdateInput;
    /** Bypass the rank guard — only the retry path uses this. */
    force?: boolean;
  },
): Promise<TransitionResult> {
  const client = db as Db;
  const meeting = await client.meeting.findUnique({
    where: { id: args.meetingId },
    select: { id: true, tenantId: true, status: true },
  });
  if (!meeting) throw new Error(`Meeting ${args.meetingId} not found`);

  const from = meeting.status;
  const allowed = args.force ? from !== args.to : canTransition(from, args.to);

  if (!allowed) {
    // Still apply the side data (e.g. a recording id learned from a late
    // webhook) — only the status move is suppressed.
    if (args.patch && Object.keys(args.patch).length > 0) {
      await client.meeting.update({ where: { id: meeting.id }, data: args.patch });
    }
    return { applied: false, from, to: args.to };
  }

  await client.meeting.update({
    where: { id: meeting.id },
    data: {
      ...(args.patch ?? {}),
      status: args.to,
      ...(args.to === MeetingStatus.failed ? {} : { failureReason: null, failedStage: null }),
    },
  });

  await client.stateTransition.create({
    data: {
      tenantId: meeting.tenantId,
      meetingId: meeting.id,
      fromStatus: from,
      toStatus: args.to,
      reason: args.reason ?? null,
    },
  });

  return { applied: true, from, to: args.to };
}

export async function markFailed(
  db: Db,
  args: { meetingId: string; stage: string; reason: string },
): Promise<TransitionResult> {
  return transition(db, {
    meetingId: args.meetingId,
    to: MeetingStatus.failed,
    reason: `${args.stage}: ${args.reason}`,
    patch: { failureReason: args.reason, failedStage: args.stage },
  });
}

/** Which stage a failed meeting should resume from when retried. */
export const RETRY_STAGE_FOR_STATUS: Partial<Record<MeetingStatus, string>> = {
  [MeetingStatus.draft]: "dispatch",
  [MeetingStatus.bot_scheduled]: "dispatch",
  [MeetingStatus.media_processing]: "ingest-recording",
  [MeetingStatus.transcript_ready]: "extract",
  [MeetingStatus.extracting]: "extract",
};
