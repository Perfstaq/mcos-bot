import type { FastifyInstance } from "fastify";
import { ArtifactKind } from "@prisma/client";
import { requireActor, requireMeetingRead, type Actor } from "../authz.js";
import { prisma } from "../db.js";
import { ApiError, requireCtx } from "../http.js";
import { formatTimestamp } from "../domain/transcript.js";
import { presignGet } from "../integrations/r2.js";

/** Why there is no audio, when there is no audio. Never a broken URL. */
export type PlaybackUnavailable = "purged" | "not_recorded";

export async function playbackRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Everything the player needs in one call: a URL it can stream, and the
   * transcript with millisecond offsets so the caption can follow the audio and
   * a click on a line can seek to it. Two round trips would mean the transcript
   * arriving after playback had already started.
   */
  app.get("/meetings/:id/playback", async (request) => {
    // Both: requireCtx because the reads below go through the tenant-scoped
    // client, requireActor because visibility inside the tenant is per-user.
    requireCtx(request);
    const actor = requireActor(request);
    const { id } = request.params as { id: string };
    return loadPlayback(actor, id);
  });
}

export async function loadPlayback(actor: Actor, meetingId: string) {
  // Reads the meeting once to decide access and once to render it. Inlining
  // the visibility rules here to save the query is how they drift out of sync
  // with authz.ts, and a stale copy of an access rule fails open.
  await requireMeetingRead(actor, meetingId);

  // `deletedAt: null` because a deleted meeting is gone from every other read
  // path and should not come back through this one. The purged branch below is
  // for the other case: media aged out under a retention rule while the meeting
  // itself is still very much alive.
  const meeting = await prisma.meeting.findUnique({
    where: { id: meetingId, deletedAt: null },
    select: {
      id: true,
      title: true,
      status: true,
      startedAt: true,
      endedAt: true,
      durationMs: true,
      // Audio only. Video is a separate artifact when RECALL_CAPTURE_VIDEO is
      // on, but the audio track is always written (see jobs/ingest-recording),
      // it is a fraction of the bytes, and click-to-seek needs a clock rather
      // than a picture. The video stays reachable through the artifact URL
      // route on meetings.ts.
      artifacts: { where: { kind: ArtifactKind.recording_audio } },
      transcript: { select: { id: true, durationMs: true, languageCode: true, segmentCount: true } },
    },
  });
  if (!meeting) throw ApiError.notFound(`Meeting ${meetingId} not found`);

  const segments = meeting.transcript
    ? await prisma.transcriptSegment.findMany({
        where: { transcriptId: meeting.transcript.id },
        orderBy: { startMs: "asc" },
        select: { id: true, idx: true, speaker: true, startMs: true, endMs: true, text: true },
      })
    : [];

  const artifact = meeting.artifacts[0] ?? null;

  // A purged artifact still has its row — the deletion path sets purged_at and
  // destroys the object. Presigning it would hand back a URL that 404s from R2
  // several seconds later, which reads to a user as a broken player rather than
  // as a recording that was deliberately deleted. Say which it is.
  let unavailableReason: PlaybackUnavailable | null = null;
  let audio: {
    url: string;
    expires_at: string;
    content_type: string;
    bytes: number;
  } | null = null;

  if (!artifact) {
    unavailableReason = "not_recorded";
  } else if (artifact.purgedAt) {
    unavailableReason = "purged";
  } else {
    const { url, expiresAt } = await presignGet(artifact.r2Key);
    audio = {
      url,
      expires_at: expiresAt.toISOString(),
      content_type: artifact.contentType,
      bytes: Number(artifact.bytes),
    };
  }

  // The transcript's duration is measured off the media; meetings.duration_ms
  // is calendar-shaped and frequently unset. Fall through to the last segment
  // rather than report a zero-length recording the scrubber cannot render.
  const durationMs =
    meeting.transcript?.durationMs ?? meeting.durationMs ?? segments.at(-1)?.endMs ?? 0;

  return {
    meeting: {
      id: meeting.id,
      title: meeting.title,
      status: meeting.status,
      started_at: meeting.startedAt?.toISOString() ?? null,
      ended_at: meeting.endedAt?.toISOString() ?? null,
      duration_ms: durationMs,
      duration_label: formatTimestamp(durationMs),
    },
    audio,
    unavailable_reason: unavailableReason,
    transcript: {
      language_code: meeting.transcript?.languageCode ?? null,
      segment_count: meeting.transcript?.segmentCount ?? 0,
      // Not paginated. The client needs every offset up front to sync captions
      // and to seek, and a two-hour meeting is on the order of 1,500 rows.
      segments: segments.map((s) => ({
        id: s.id,
        idx: s.idx,
        speaker: s.speaker,
        start_ms: s.startMs,
        end_ms: s.endMs,
        text: s.text,
        timestamp_label: formatTimestamp(s.startMs),
      })),
    },
  };
}
