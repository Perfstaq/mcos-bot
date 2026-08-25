import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Ref,
  type SyntheticEvent,
} from "react";
import { api, type MeetingStatus } from "../api.js";
import {
  TranscriptView,
  segmentAt,
  type ActionItemDraft,
  type TranscriptSegment,
} from "./TranscriptView.js";

/** Why there is no audio, when there is no audio — never a broken player. */
export type PlaybackUnavailable = "purged" | "not_recorded";

export type Playback = {
  meeting: {
    id: string;
    title: string | null;
    status: MeetingStatus;
    started_at: string | null;
    ended_at: string | null;
    duration_ms: number;
    duration_label: string;
  };
  audio: { url: string; expires_at: string; content_type: string; bytes: number } | null;
  /** Present only when the meeting was captured with video_mixed_mp4. */
  video: { url: string; expires_at: string; content_type: string; bytes: number } | null;
  unavailable_reason: PlaybackUnavailable | null;
  transcript: {
    language_code: string | null;
    segment_count: number;
    segments: TranscriptSegment[];
  };
};

const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];

/**
 * How far ahead of the presigned URL's expiry we ask for a new one.
 *
 * R2 signatures are checked per request, and the browser issues a fresh range
 * request every time it refills its buffer — so a URL that expires mid-session
 * does not fail at the moment it expires, it fails several minutes later at a
 * seemingly random point in the recording. Re-issuing early means the failure
 * never happens; the error path below exists for the case where it does anyway
 * (a clock skew, a laptop resumed from sleep).
 */
const REISSUE_LEAD_MS = 60_000;

/** Enough retries to survive a bad URL, few enough that a broken R2 stops. */
const MAX_REISSUES = 3;

/**
 * Playback of a recording against the transcript.
 *
 * The two are one component rather than two because the only thing that makes
 * either of them useful is that they agree: the highlighted turn is the turn
 * you are hearing, and a click on a turn is a seek. Splitting them would put
 * the audio clock behind a prop and let them drift.
 */
export function RecordingPlayer({
  meetingId,
  initialPositionMs = 0,
  focusSegmentId = null,
  canWrite = true,
  onCreateActionItem,
}: {
  meetingId: string;
  /** Arrival point from a deep link, in milliseconds. */
  initialPositionMs?: number;
  focusSegmentId?: string | null;
  /** False suppresses the action-item affordance for a read-only collaborator. */
  canWrite?: boolean;
  /** Supplied by a page that owns action items; otherwise the default posts them. */
  onCreateActionItem?: (draft: ActionItemDraft) => Promise<void>;
}) {
  const [data, setData] = useState<Playback | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [positionMs, setPositionMs] = useState(initialPositionMs);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);

  /**
   * The element that is playing, whichever kind it is.
   *
   * `HTMLMediaElement` rather than `HTMLAudioElement` because everything below
   * — the clock, seeking, the expiry swap — is defined on the media interface
   * and does not care whether there is a picture attached to it.
   */
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  /** Where to pick up after a URL swap: the element reloads from zero, paused. */
  const resume = useRef<{ at: number; playing: boolean } | null>(null);
  const reissues = useRef(0);
  const reissuing = useRef(false);

  const load = useCallback(async () => {
    try {
      const playback = await api.get<Playback>(`/meetings/${meetingId}/playback`);
      setData(playback);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [meetingId]);

  useEffect(() => {
    resume.current = initialPositionMs > 0 ? { at: initialPositionMs / 1000, playing: false } : null;
    setPositionMs(initialPositionMs);
    void load();
    // initialPositionMs is the arrival point, not a live input: re-running this
    // whenever it changed would yank playback back to it mid-listen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  /**
   * Ask for a fresh presigned URL and carry the listener's place across it.
   *
   * The whole meeting response comes back, not just the URL — the transcript is
   * the same rows and re-rendering it is cheap, and a playback endpoint that
   * hands out URLs on their own is a second code path with its own access
   * check to get wrong.
   */
  const reissueUrl = useCallback(async () => {
    if (reissuing.current) return;
    if (reissues.current >= MAX_REISSUES) {
      setError("The recording link keeps expiring before it can be played. Reload the page to try again.");
      return;
    }
    reissuing.current = true;
    reissues.current += 1;
    const el = mediaRef.current;
    if (el) resume.current = { at: el.currentTime, playing: !el.paused };
    try {
      await load();
    } finally {
      reissuing.current = false;
    }
  }, [load]);

  // The proactive half: re-issue before the signature dies rather than after.
  useEffect(() => {
    // The one being played, not the audio: a video-backed meeting expires on
    // the video's signature and would otherwise never be re-issued.
    const expiresAt = data?.video?.expires_at ?? data?.audio?.expires_at;
    if (!expiresAt) return;
    const due = Date.parse(expiresAt) - REISSUE_LEAD_MS - Date.now();
    if (Number.isNaN(due)) return;
    const timer = window.setTimeout(() => void reissueUrl(), Math.max(due, 1_000));
    return () => window.clearTimeout(timer);
  }, [data?.video?.expires_at, data?.audio?.expires_at, reissueUrl]);

  const segments = data?.transcript.segments ?? [];
  const durationMs = data?.meeting.duration_ms ?? 0;
  const current = useMemo(() => segmentAt(segments, positionMs), [segments, positionMs]);

  const seekTo = useCallback((ms: number) => {
    const el = mediaRef.current;
    setPositionMs(ms);
    if (!el) return;
    // Before `loadedmetadata` the element has no seekable range and assigning
    // `currentTime` is silently dropped, which is how a click on a turn during
    // the first second of the page does nothing at all. Park it as a resume
    // instead; the metadata handler is the one place that applies these.
    if (Number.isFinite(el.duration)) el.currentTime = ms / 1000;
    else resume.current = { at: ms / 1000, playing: !el.paused };
  }, []);

  const onSeekSegment = useCallback(
    (segment: TranscriptSegment) => seekTo(segment.start_ms),
    [seekTo],
  );

  const toggle = () => {
    const el = mediaRef.current;
    if (!el) return;
    if (el.paused) void el.play().catch((e: Error) => setError(e.message));
    else el.pause();
  };

  /**
   * Provenance by default. A page that owns action items passes its own
   * handler; without one the affordance still writes a real, cited item rather
   * than being decorative, because `origin: "transcript"` plus the segment id
   * is the whole contract the API asks for.
   */
  const createActionItem = useCallback(
    async (draft: ActionItemDraft) => {
      if (onCreateActionItem) return onCreateActionItem(draft);
      await api.post(`/meetings/${meetingId}/action-items`, {
        title: draft.title,
        origin: "transcript",
        source_segment_id: draft.segmentId,
      });
    },
    [meetingId, onCreateActionItem],
  );

  if (!data) {
    return (
      <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
        {error ? (
          <>
            <div className="banner error">{error}</div>
            <div style={{ padding: "0 14px" }}>
              <button className="btn sm" onClick={() => void load()}>Try again</button>
            </div>
          </>
        ) : (
          <><div className="skeleton" /><div className="skeleton" /></>
        )}
      </div>
    );
  }

  /**
   * The handlers, shared by both element kinds.
   *
   * Written once and spread rather than duplicated: an <audio> and a <video>
   * that disagree about restoring position or handling an expired URL is a bug
   * that only ever shows up on whichever kind is rarer.
   */
  const mediaEvents = {
    onLoadedMetadata: (e: SyntheticEvent<HTMLMediaElement>) => {
      const el = e.currentTarget;
      el.playbackRate = rate;
      const pending = resume.current;
      resume.current = null;
      if (pending) {
        el.currentTime = pending.at;
        if (pending.playing) void el.play().catch(() => undefined);
      }
    },
    // A URL that survived long enough to play is a URL that worked; only then
    // is the retry budget worth handing back.
    onCanPlay: () => {
      reissues.current = 0;
    },
    onTimeUpdate: (e: SyntheticEvent<HTMLMediaElement>) =>
      setPositionMs(Math.round(e.currentTarget.currentTime * 1000)),
    onPlay: () => setPlaying(true),
    onPause: () => setPlaying(false),
    onEnded: () => setPlaying(false),
    // The reactive half of the expiry handling. A 403 on a range request
    // surfaces here as a media error with no useful detail, so the response is
    // the same either way: get a new URL and resume.
    onError: () => void reissueUrl(),
  };

  /** Something to play: the video when there is one, the audio track otherwise. */
  const playable = Boolean(data.video ?? data.audio);

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      {error && <div className="banner error">{error}</div>}

      {playable ? (
        <>
          {/* The picture, when there is one. Above the transport rather than
              beside it, so the video never moves when the controls reflow. */}
          {data.video && (
            <div
              style={{
                flex: "none",
                background: "#000",
                borderBottom: "1px solid var(--line-soft)",
                display: "flex",
                justifyContent: "center",
              }}
            >
              <video
                ref={mediaRef as Ref<HTMLVideoElement>}
                src={data.video.url}
                playsInline
                preload="metadata"
                style={{ width: "100%", maxHeight: 380, objectFit: "contain", background: "#000" }}
                {...mediaEvents}
              />
            </div>
          )}

        <div
          style={{
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 12,
            flex: "none",
            padding: "12px 16px",
            borderBottom: "1px solid var(--line-soft)",
            background: "var(--pane-2)",
          }}
        >
          {/* Only when there is no video. One ref cannot drive two elements,
              and video_mixed already carries the audio track. */}
          {!data.video && data.audio && (
            <audio
              ref={mediaRef as Ref<HTMLAudioElement>}
              src={data.audio.url}
              preload="metadata"
              {...mediaEvents}
            />
          )}

          <button className="btn primary sm" onClick={toggle} aria-label={playing ? "Pause" : "Play"}>
            {playing ? <IconPause /> : <IconPlay />}
            {playing ? "Pause" : "Play"}
          </button>

          <span className="mono" style={{ color: "var(--muted)", flex: "none" }}>
            {formatClock(positionMs)} / {data.meeting.duration_label}
          </span>

          <input
            type="range"
            min={0}
            max={Math.max(durationMs, 1)}
            step={250}
            value={Math.min(positionMs, Math.max(durationMs, 1))}
            disabled={durationMs === 0}
            onChange={(e) => seekTo(Number(e.target.value))}
            aria-label="Seek"
            style={{ flex: 1, minWidth: 80, accentColor: "var(--orange)" }}
          />

          <select
            className="select"
            value={rate}
            aria-label="Playback speed"
            onChange={(e) => {
              const next = Number(e.target.value);
              setRate(next);
              if (mediaRef.current) mediaRef.current.playbackRate = next;
            }}
          >
            {SPEEDS.map((speed) => (
              <option key={speed} value={speed}>{speed}×</option>
            ))}
          </select>
        </div>
        </>
      ) : (
        <div className="banner info" style={{ flex: "none" }}>
          {data.unavailable_reason === "purged"
            ? "The recording was deleted under the retention policy. The transcript below is what survives of it."
            : "This meeting was never recorded. The transcript below is all there is."}
        </div>
      )}

      <TranscriptView
        segments={segments}
        currentSegmentId={playable ? (current?.id ?? null) : null}
        focusSegmentId={focusSegmentId}
        onSeek={playable ? onSeekSegment : undefined}
        onCreateActionItem={canWrite ? createActionItem : undefined}
      />
    </div>
  );
}

/* ------------------------------------------------------------- deep links */

/**
 * The link a search hit, a citation or a share follows to land on a meeting at
 * a point in it. One function on both sides so the parameter names cannot
 * drift: `t` is the offset in milliseconds, `segment` is what to highlight —
 * both, because a timestamp survives a re-transcription and a segment id is
 * exact.
 */
export function playbackDeepLink(
  meetingId: string,
  at?: { startMs?: number | null; segmentId?: string | null },
): string {
  const params = new URLSearchParams();
  if (at?.startMs != null) params.set("t", String(Math.max(0, Math.round(at.startMs))));
  if (at?.segmentId) params.set("segment", at.segmentId);
  const query = params.toString();
  return `/meetings/${meetingId}${query ? `?${query}` : ""}`;
}

export function readPlaybackDeepLink(search: string): { startMs: number; segmentId: string | null } {
  const params = new URLSearchParams(search);
  const raw = Number(params.get("t"));
  return {
    startMs: Number.isFinite(raw) && raw > 0 ? Math.round(raw) : 0,
    segmentId: params.get("segment"),
  };
}

/* ----------------------------------------------------------------- pieces */

/**
 * Mirrors `formatTimestamp` in the API's domain/transcript.ts. The server sends
 * labels for the segments and the total, but the moving clock has to be
 * formatted here, and two formats on one screen reads as a bug.
 */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

/* Local rather than in Icons.tsx: that file is shared, and two people adding
   glyphs to it in the same week is a conflict for no benefit. */
const glyph = {
  width: 15,
  height: 15,
  viewBox: "0 0 20 20",
  fill: "currentColor",
  "aria-hidden": true,
} as const;

const IconPlay = () => <svg {...glyph}><path d="M6 3.5 16 10 6 16.5Z" /></svg>;
const IconPause = () => <svg {...glyph}><path d="M5.5 3.5h3.2v13H5.5zM11.3 3.5h3.2v13h-3.2z" /></svg>;
