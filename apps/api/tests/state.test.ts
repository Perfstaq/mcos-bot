import { MeetingStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { canTransition } from "../src/domain/state.js";
import { dedupeKeyFor, readIds, statusForBotEvent } from "../src/domain/webhook.js";
import webhooks from "./fixtures/webhooks.json" with { type: "json" };

describe("meeting state machine", () => {
  it("moves forward through the happy path", () => {
    const path = [
      MeetingStatus.draft,
      MeetingStatus.bot_scheduled,
      MeetingStatus.bot_joined,
      MeetingStatus.recording,
      MeetingStatus.call_ended,
      MeetingStatus.media_processing,
      MeetingStatus.transcript_ready,
      MeetingStatus.extracting,
      MeetingStatus.in_review,
      MeetingStatus.merged,
    ];
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition(path[i]!, path[i + 1]!)).toBe(true);
    }
  });

  it("ignores a late webhook that would rewind the meeting", () => {
    // The whole point of the rank guard: `bot.in_call_recording` arriving
    // after `recording.done` must not pull the meeting back to `recording`.
    expect(canTransition(MeetingStatus.media_processing, MeetingStatus.recording)).toBe(false);
    expect(canTransition(MeetingStatus.in_review, MeetingStatus.transcript_ready)).toBe(false);
  });

  it("ignores a redelivered webhook for the state already reached", () => {
    expect(canTransition(MeetingStatus.recording, MeetingStatus.recording)).toBe(false);
  });

  it("allows failure from any live state but not out of it", () => {
    for (const from of [MeetingStatus.bot_scheduled, MeetingStatus.extracting, MeetingStatus.in_review]) {
      expect(canTransition(from, MeetingStatus.failed)).toBe(true);
    }
    expect(canTransition(MeetingStatus.failed, MeetingStatus.recording)).toBe(false);
    expect(canTransition(MeetingStatus.failed, MeetingStatus.failed)).toBe(false);
  });

  it("treats merged as terminal", () => {
    expect(canTransition(MeetingStatus.merged, MeetingStatus.in_review)).toBe(false);
    expect(canTransition(MeetingStatus.merged, MeetingStatus.failed)).toBe(true);
  });
});

describe("webhook payload mapping", () => {
  const fixtures = webhooks as Record<string, unknown>;

  it("maps every recorded bot event to a status", () => {
    expect(statusForBotEvent("bot.joining_call")).toBe(MeetingStatus.bot_scheduled);
    expect(statusForBotEvent("bot.in_waiting_room")).toBe(MeetingStatus.bot_scheduled);
    expect(statusForBotEvent("bot.in_call_not_recording")).toBe(MeetingStatus.bot_joined);
    expect(statusForBotEvent("bot.in_call_recording")).toBe(MeetingStatus.recording);
    expect(statusForBotEvent("bot.call_ended")).toBe(MeetingStatus.call_ended);
    expect(statusForBotEvent("bot.done")).toBe(MeetingStatus.call_ended);
    expect(statusForBotEvent("bot.fatal")).toBeNull();
  });

  it("reads ids out of the recorded envelope shapes", () => {
    const recording = readIds(fixtures["recording.done"] as never);
    expect(recording.recordingId).toBe("r0000000-0000-4000-8000-00000000rec1");
    expect(recording.botId).toBe("b0000000-0000-4000-8000-00000000bot1");

    const transcript = readIds(fixtures["transcript.done"] as never);
    expect(transcript.transcriptId).toBe("t0000000-0000-4000-8000-000000000tr1");
    expect(transcript.subCode).toBeNull();

    const fatal = readIds(fixtures["bot.fatal"] as never);
    expect(fatal.subCode).toBe("meeting_not_found");
  });

  it("gives a redelivery the same dedupe key and a new event a different one", () => {
    const once = readIds(fixtures["recording.done"] as never);
    const twice = readIds(JSON.parse(JSON.stringify(fixtures["recording.done"])) as never);
    expect(dedupeKeyFor(once)).toBe(dedupeKeyFor(twice));
    expect(dedupeKeyFor(once)).not.toBe(dedupeKeyFor(readIds(fixtures["transcript.done"] as never)));
  });
});
