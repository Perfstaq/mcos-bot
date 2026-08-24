import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { IconPlus, IconX } from "./Icons.js";

export type TranscriptSegment = {
  id: string;
  idx: number;
  speaker: string;
  start_ms: number;
  end_ms: number;
  text: string;
  timestamp_label: string;
};

/**
 * What the "create action item from this" affordance emits.
 *
 * The segment id is the entire point of the affordance, not a convenience:
 * `ActionItem.sourceSegmentId` is where it lands, and an item lifted from the
 * transcript without one is indistinguishable afterwards from one a human
 * typed. The component never posts it itself — deciding whether the reader may
 * write to this meeting is not a transcript renderer's job.
 */
export type ActionItemDraft = { title: string; segmentId: string };

type Turn = { key: string; speaker: string; segments: TranscriptSegment[] };

/** The API rejects a longer title, so the composer refuses to build one. */
const TITLE_MAX = 300;

/**
 * Following the audio is only helpful while the reader is not reading
 * somewhere else. A scroll of their own suspends it for this long rather than
 * turning it off, so nobody has to find a switch to get the follow back.
 */
const FOLLOW_PAUSE_MS = 6000;

/** Our own scrollIntoView fires the scroll handler too; this window tells them apart. */
const SELF_SCROLL_MS = 250;

export type TranscriptViewProps = {
  segments: TranscriptSegment[];
  /** The turn being spoken right now, from the player's clock. */
  currentSegmentId?: string | null;
  /** A segment arrived at from a link — scrolled to once, on arrival. */
  focusSegmentId?: string | null;
  onSeek?: (segment: TranscriptSegment) => void;
  onCreateActionItem?: (draft: ActionItemDraft) => Promise<void> | void;
  empty?: ReactNode;
};

/**
 * The transcript as turns, not as rows.
 *
 * Consecutive segments from one speaker are one turn with the name written
 * once, because a name repeated every four seconds stops being read. The
 * segment stays the unit underneath: it is what a click seeks to, and it is
 * what a citation points at.
 *
 * Memoised because the player re-renders four times a second off `timeupdate`,
 * and only two of these props change across a whole meeting.
 */
export const TranscriptView = memo(function TranscriptView({
  segments,
  currentSegmentId = null,
  focusSegmentId = null,
  onSeek,
  onCreateActionItem,
  empty,
}: TranscriptViewProps) {
  const nodes = useRef(new Map<string, HTMLElement>());
  const lastUserScroll = useRef(0);
  const lastSelfScroll = useRef(0);

  const turns = useMemo(() => groupIntoTurns(segments), [segments]);

  const register = useCallback((id: string, node: HTMLElement | null) => {
    if (node) nodes.current.set(id, node);
    else nodes.current.delete(id);
  }, []);

  const noteUserScroll = useCallback(() => {
    if (Date.now() - lastSelfScroll.current < SELF_SCROLL_MS) return;
    lastUserScroll.current = Date.now();
  }, []);

  // Follow the clock. `block: "nearest"` on purpose: a turn already on screen
  // does not move, so the page only shifts when it genuinely has to.
  useEffect(() => {
    if (!currentSegmentId) return;
    if (Date.now() - lastUserScroll.current < FOLLOW_PAUSE_MS) return;
    const node = nodes.current.get(currentSegmentId);
    if (!node) return;
    lastSelfScroll.current = Date.now();
    node.scrollIntoView({ block: "nearest" });
  }, [currentSegmentId]);

  // Arriving from a search hit is different from following along: the cited
  // line goes to the middle of the pane so its surrounding turns are visible,
  // and it overrides a scroll pause the reader has not started yet.
  useEffect(() => {
    if (!focusSegmentId) return;
    const node = nodes.current.get(focusSegmentId);
    if (!node) return;
    lastSelfScroll.current = Date.now();
    node.scrollIntoView({ block: "center" });
  }, [focusSegmentId, turns]);

  return (
    <div
      className="scroll"
      onScroll={noteUserScroll}
      style={{ flex: 1, minHeight: 0, padding: "10px 14px 28px" }}
    >
      {turns.length === 0
        ? (empty ?? (
            <div className="empty">
              <h3>No transcript</h3>
              <p>Nothing was transcribed for this meeting.</p>
            </div>
          ))
        : turns.map((turn) => (
            <TurnBlock
              key={turn.key}
              turn={turn}
              // Narrowed to this turn so a tick of the clock re-renders the two
              // turns that changed rather than every turn in a two-hour call.
              activeSegmentId={turn.segments.some((s) => s.id === currentSegmentId) ? currentSegmentId : null}
              register={register}
              onSeek={onSeek}
              onCreateActionItem={onCreateActionItem}
            />
          ))}
    </div>
  );
});

/* ---------------------------------------------------------------------- */

const TurnBlock = memo(function TurnBlock({
  turn,
  activeSegmentId,
  register,
  onSeek,
  onCreateActionItem,
}: {
  turn: Turn;
  activeSegmentId: string | null;
  register: (id: string, node: HTMLElement | null) => void;
  onSeek?: (segment: TranscriptSegment) => void;
  onCreateActionItem?: (draft: ActionItemDraft) => Promise<void> | void;
}) {
  const [hovered, setHovered] = useState<string | null>(null);
  const [composing, setComposing] = useState<TranscriptSegment | null>(null);
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const composerRef = useRef<HTMLInputElement>(null);

  const startCompose = (segment: TranscriptSegment) => {
    setComposing(segment);
    // Seeded with what was actually said. Most action items are a lightly
    // edited version of the sentence that created them, and retyping it is
    // how the wording drifts away from the citation underneath it.
    setTitle(segment.text.trim().slice(0, TITLE_MAX));
    setError(null);
    setSaved(false);
    window.setTimeout(() => composerRef.current?.select(), 0);
  };

  const submit = async () => {
    if (!composing || !onCreateActionItem) return;
    const text = title.trim();
    if (text.length === 0) return;
    setSaving(true);
    try {
      await onCreateActionItem({ title: text.slice(0, TITLE_MAX), segmentId: composing.id });
      setComposing(null);
      setSaved(true);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ marginBottom: 10 }}>
      {turn.segments.map((segment, i) => {
        const active = segment.id === activeSegmentId;
        const seekable = Boolean(onSeek);
        return (
          <div
            key={segment.id}
            ref={(el) => { register(segment.id, el); }}
            className={`turn${active ? " cited" : ""}`}
            style={{ alignItems: "flex-start" }}
            onMouseEnter={() => setHovered(segment.id)}
            onMouseLeave={() => setHovered((h) => (h === segment.id ? null : h))}
            // Focus is tracked on the row, not on the words, because tabbing
            // from the words to the action button beside them leaves the words
            // — and clearing the row there would hide the button a keystroke
            // before it could be reached. `relatedTarget` is what tells moving
            // within the line apart from leaving it.
            onFocus={() => setHovered(segment.id)}
            onBlur={(event) => {
              if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
              setHovered((h) => (h === segment.id ? null : h));
            }}
          >
            <span className="who">
              {i === 0 ? turn.speaker : <span className="mono" style={{ opacity: 0.55 }}>{segment.timestamp_label}</span>}
            </span>

            {/* The words carry the seek, not the row: a row that is itself a
                button cannot legally contain the action control beside it. */}
            <span
              className="said"
              style={{ flex: 1, minWidth: 0, cursor: seekable ? "pointer" : "default" }}
              {...(seekable
                ? {
                    role: "button",
                    tabIndex: 0,
                    title: `Jump to ${segment.timestamp_label}`,
                    onClick: () => onSeek?.(segment),
                    onKeyDown: (event: React.KeyboardEvent) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      onSeek?.(segment);
                    },
                  }
                : {})}
            >
              {segment.text}
            </span>

            {onCreateActionItem && (
              // Kept in the flow rather than absolutely positioned, so it never
              // covers the words it is offering to quote. Hidden by visibility,
              // not display: the line must not reflow under the pointer.
              <button
                className="btn sm"
                style={{
                  flex: "none",
                  padding: "1px 6px",
                  visibility: hovered === segment.id || composing?.id === segment.id ? "visible" : "hidden",
                }}
                title="Create an action item citing this line"
                onClick={() => startCompose(segment)}
              >
                <IconPlus size={13} /> Action
              </button>
            )}
          </div>
        );
      })}

      {composing && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "6px 10px 2px" }}>
          <input
            ref={composerRef}
            className="input"
            value={title}
            maxLength={TITLE_MAX}
            placeholder="What has to happen?"
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); void submit(); }
              if (e.key === "Escape") { e.preventDefault(); setComposing(null); }
            }}
          />
          <button className="btn sm primary" disabled={saving || title.trim().length === 0} onClick={() => void submit()}>
            {saving ? "Saving…" : "Create"}
          </button>
          <button className="btn sm" onClick={() => setComposing(null)} aria-label="Cancel">
            <IconX size={13} />
          </button>
        </div>
      )}

      {composing && (
        <div className="mono" style={{ color: "var(--faint)", padding: "0 10px 4px" }}>
          cites {composing.speaker} at {composing.timestamp_label}
        </div>
      )}

      {error && <div className="banner error" style={{ margin: "4px 10px" }}>{error}</div>}
      {saved && !composing && (
        <div className="mono" style={{ color: "var(--green)", padding: "0 10px 4px" }}>Action item created</div>
      )}
    </div>
  );
});

/**
 * Speaker diarisation emits a row per utterance, and a back-and-forth produces
 * runs of two-word rows. Grouping the runs is what makes the page read like a
 * conversation instead of a log.
 */
export function groupIntoTurns(segments: TranscriptSegment[]): Turn[] {
  const turns: Turn[] = [];
  for (const segment of segments) {
    const last = turns.at(-1);
    if (last && last.speaker === segment.speaker) last.segments.push(segment);
    else turns.push({ key: segment.id, speaker: segment.speaker, segments: [segment] });
  }
  return turns;
}

/**
 * The turn being spoken at `positionMs`, or null before the first one.
 *
 * Silence between two turns keeps the earlier one selected: it is the line the
 * listener just heard, and blanking the highlight through every pause makes the
 * transcript flicker rather than follow. Binary search because this runs on
 * every `timeupdate`, four times a second, over a couple of thousand rows.
 */
export function segmentAt(segments: TranscriptSegment[], positionMs: number): TranscriptSegment | null {
  let lo = 0;
  let hi = segments.length - 1;
  let found: TranscriptSegment | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const segment = segments[mid];
    if (!segment) break;
    if (segment.start_ms <= positionMs) {
      found = segment;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}
