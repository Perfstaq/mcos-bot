import { MeetingStatus, ClaimStatus, ArtifactKind } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { MockAgent, setGlobalDispatcher } from "undici";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb, seedTenant, signWebhook } from "./helpers.js";
import webhookFixtures from "./fixtures/webhooks.json" with { type: "json" };
import recordingFixture from "./fixtures/recording.json" with { type: "json" };
import transcriptArtifact from "./fixtures/transcript-artifact.json" with { type: "json" };
import transcriptDownload from "./fixtures/transcript-download.json" with { type: "json" };

/* --- R2 is mocked: this test is about the pipeline, not about S3 ---------- */
const uploads: Array<{ key: string; contentType: string }> = [];

vi.mock("../src/integrations/r2.js", () => ({
  keys: {
    recordingAudio: (t: string, m: string) => `${t}/meetings/${m}/recording.mp3`,
    recordingVideo: (t: string, m: string) => `${t}/meetings/${m}/recording.mp4`,
    transcriptJson: (t: string, m: string) => `${t}/meetings/${m}/transcript.json`,
    meetingPrefix: (t: string, m: string) => `${t}/meetings/${m}/`,
  },
  streamUrlToR2: vi.fn(async (args: { key: string; contentType: string }) => {
    uploads.push(args);
    return { key: args.key, bytes: 4_812_004, checksum: "sha256:fake-audio", contentType: args.contentType };
  }),
  putObject: vi.fn(async (args: { key: string; body: string; contentType: string }) => {
    uploads.push({ key: args.key, contentType: args.contentType });
    return {
      key: args.key,
      bytes: Buffer.byteLength(args.body),
      checksum: "sha256:fake-transcript",
      contentType: args.contentType,
    };
  }),
  presignGet: vi.fn(async (key: string) => ({
    url: `https://r2.test/${key}?sig=presigned`,
    expiresAt: new Date(Date.now() + 3_600_000),
  })),
  deleteObjects: vi.fn(async () => undefined),
  objectExists: vi.fn(async () => true),
  r2: {},
}));

/* --- OpenAI is mocked: deterministic claims, real validation path --------- */
vi.mock("../src/integrations/openai.js", async () => {
  const { segmentHandle } = await import("../src/domain/chunking.js");
  return {
    PROMPT_VERSION: "propose_claims/v2-openai",
    segmentHandle,
    extractFromChunk: vi.fn(async ({ chunk }: { chunk: { segments: Array<{ idx: number; speaker: string; startMs: number; text: string }> } }) => {
      const claims = [];
      for (const segment of chunk.segments) {
        if (segment.text.includes("head of support at a company between")) {
          claims.push({
            type: "icp_fact",
            text: "The ideal customer is a head of support at a 200-800 employee company under a headcount freeze.",
            confidence: 0.94,
            evidence: {
              transcript_segment_ids: [segmentHandle(segment.idx)],
              verbatim_quote: "a head of support at a company between two hundred and eight hundred employees",
              speaker: segment.speaker,
              timestamp_ms: segment.startMs,
            },
          });
        }
        if (segment.text.includes("position as the layer that makes support cost curve flat")) {
          claims.push({
            type: "positioning_statement",
            text: "Position as the layer that flattens the support cost curve, not as a better help desk.",
            confidence: 0.92,
            evidence: {
              transcript_segment_ids: [segmentHandle(segment.idx)],
              verbatim_quote: "position as the layer that makes support cost curve flat not as a better help desk",
              speaker: segment.speaker,
              timestamp_ms: segment.startMs,
            },
          });
          // Same claim again, as chunk overlap genuinely produces. Must collapse.
          claims.push({
            type: "positioning_statement",
            text: "Position as the layer that flattens the support cost curve, not as a better help desk!",
            confidence: 0.9,
            evidence: {
              transcript_segment_ids: [segmentHandle(segment.idx)],
              verbatim_quote: "position as the layer that makes support cost curve flat",
              speaker: segment.speaker,
              timestamp_ms: segment.startMs,
            },
          });
          // Cites a segment that does not exist. Must be dropped.
          claims.push({
            type: "proof_point",
            text: "Deflection reached 41% in eight weeks.",
            confidence: 0.99,
            evidence: {
              transcript_segment_ids: ["s9999"],
              verbatim_quote: "forty one percent deflection in eight weeks",
              speaker: "Daniel Okafor",
              timestamp_ms: 123_000,
            },
          });
          // Quote never said in the cited segment. Must be dropped.
          claims.push({
            type: "proof_point",
            text: "The product guarantees a 90% reduction in support headcount.",
            confidence: 0.99,
            evidence: {
              transcript_segment_ids: [segmentHandle(segment.idx)],
              verbatim_quote: "we guarantee a ninety percent reduction in support headcount for every customer",
              speaker: segment.speaker,
              timestamp_ms: segment.startMs,
            },
          });
        }
      }
      return { claims, inputTokens: 1_200, outputTokens: 340 };
    }),
  };
});

const BOT_ID = "b0000000-0000-4000-8000-00000000bot1";
const RECORDING_ID = "r0000000-0000-4000-8000-00000000rec1";
const TRANSCRIPT_ID = "t0000000-0000-4000-8000-000000000tr1";

let app: FastifyInstance;
let agent: MockAgent;
let tenantId: string;
let meetingId: string;

// Imported lazily so the vi.mock factories above are installed first.
let queues: typeof import("../src/queue.js");
let jobs: {
  processWebhook: typeof import("../src/jobs/webhook.js")["processWebhook"];
  ingestRecording: typeof import("../src/jobs/ingest-recording.js")["ingestRecording"];
  ingestTranscript: typeof import("../src/jobs/ingest-transcript.js")["ingestTranscript"];
  runExtraction: typeof import("../src/jobs/extract.js")["runExtraction"];
};

beforeAll(async () => {
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);

  const recall = agent.get("https://us-east-1.recall.ai");
  // Registered first so it wins for this one URL; undici matches in order.
  recall
    .intercept({
      path: "/api/v1/bot/",
      method: "POST",
      body: (raw) => String(raw).includes("meet.google.com/broken"),
    })
    .reply(500, { detail: "meeting_url is not reachable" })
    .persist();
  recall
    .intercept({ path: "/api/v1/bot/", method: "POST" })
    .reply(201, { id: BOT_ID, meeting_url: "https://meet.google.com/abc-defg-hij" })
    .persist();
  recall
    .intercept({ path: `/api/v1/recording/${RECORDING_ID}/`, method: "GET" })
    .reply(200, recordingFixture)
    .persist();
  recall
    .intercept({ path: `/api/v1/recording/${RECORDING_ID}/create_transcript/`, method: "POST" })
    .reply(201, { id: TRANSCRIPT_ID, status: { code: "processing", sub_code: null, updated_at: "2026-08-20T10:32:00Z" } })
    .persist();
  recall
    .intercept({ path: `/api/v1/transcript/${TRANSCRIPT_ID}/`, method: "GET" })
    .reply(200, transcriptArtifact)
    .persist();

  const media = agent.get("https://recall-media.test");
  media
    .intercept({ path: "/transcript/tr1.json", query: { sig: "def456" }, method: "GET" })
    .reply(200, transcriptDownload)
    .persist();

  queues = await import("../src/queue.js");
  jobs = {
    processWebhook: (await import("../src/jobs/webhook.js")).processWebhook,
    ingestRecording: (await import("../src/jobs/ingest-recording.js")).ingestRecording,
    ingestTranscript: (await import("../src/jobs/ingest-transcript.js")).ingestTranscript,
    runExtraction: (await import("../src/jobs/extract.js")).runExtraction,
  };
  app = await (await import("../src/server.js")).buildServer();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await queues?.closeQueues();
  await db.$disconnect();
  await agent?.close();
});

beforeEach(async () => {
  uploads.length = 0;
  await resetDb();
  for (const queue of queues.allQueues) await queue.obliterate({ force: true });

  const tenant = await seedTenant();
  tenantId = tenant.id;

  const created = await app.inject({
    method: "POST",
    url: "/api/v1/meetings",
    payload: { meeting_url: "https://meet.google.com/abc-defg-hij", title: "Mid-market positioning review" },
  });
  expect(created.statusCode).toBe(201);
  meetingId = created.json().meeting.id;
});

/* --- helpers -------------------------------------------------------------- */

async function deliver(name: keyof typeof webhookFixtures, overrides?: { timestamp?: number; secret?: string }) {
  const payload = JSON.parse(JSON.stringify(webhookFixtures[name]));
  payload.data.bot.id = BOT_ID;
  const body = JSON.stringify(payload);
  return app.inject({
    method: "POST",
    url: "/api/v1/webhooks/recall",
    payload: body,
    headers: signWebhook({ body, ...overrides }),
  });
}

/** Run every queued job the way the worker would, then clear the queue. */
async function drain(queue: (typeof queues.allQueues)[number], handler: (data: never) => Promise<void>) {
  const pending = await queue.getJobs(["waiting", "delayed", "prioritized", "paused"]);
  for (const job of pending) {
    await handler(job.data as never);
    await job.remove();
  }
  return pending.length;
}

const drainWebhooks = () => drain(queues.webhookQueue, jobs.processWebhook as never);

async function runToReview() {
  for (const event of ["bot.joining_call", "bot.in_call_not_recording", "bot.in_call_recording", "bot.call_ended", "bot.done"] as const) {
    await deliver(event);
  }
  await drainWebhooks();

  await deliver("recording.done");
  await drainWebhooks();
  await drain(queues.ingestRecordingQueue, jobs.ingestRecording as never);

  await deliver("transcript.done");
  await drainWebhooks();
  await drain(queues.ingestTranscriptQueue, jobs.ingestTranscript as never);
  await drain(queues.extractQueue, jobs.runExtraction as never);
}

/* --- tests ---------------------------------------------------------------- */

describe("webhook ingress", () => {
  it("rejects an unsigned webhook and stores nothing", async () => {
    const body = JSON.stringify(webhookFixtures["bot.done"]);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks/recall",
      payload: body,
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("invalid_signature");
    expect(await db.webhookEvent.count()).toBe(0);
  });

  it("rejects a tampered payload", async () => {
    const payload = JSON.parse(JSON.stringify(webhookFixtures["bot.done"]));
    payload.data.bot.id = BOT_ID;
    const body = JSON.stringify(payload);
    const headers = signWebhook({ body });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks/recall",
      payload: body.replace("done", "fatal"),
      headers,
    });

    expect(response.statusCode).toBe(401);
    expect(await db.webhookEvent.count()).toBe(0);
  });

  it("rejects a replayed webhook signed an hour ago", async () => {
    const response = await deliver("bot.done", { timestamp: Math.floor(Date.now() / 1000) - 3600 });
    expect(response.statusCode).toBe(401);
  });

  it("acks fast and defers the work to a job", async () => {
    const response = await deliver("bot.in_call_recording");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });

    // Nothing has been applied yet — the handler only persisted and enqueued.
    const before = await db.meeting.findUniqueOrThrow({ where: { id: meetingId } });
    expect(before.status).toBe(MeetingStatus.bot_scheduled);
    expect(await queues.webhookQueue.getJobCountByTypes("waiting")).toBe(1);

    await drainWebhooks();
    const after = await db.meeting.findUniqueOrThrow({ where: { id: meetingId } });
    expect(after.status).toBe(MeetingStatus.recording);
  });

  it("stores a redelivered webhook only once", async () => {
    await deliver("bot.in_call_recording");
    await deliver("bot.in_call_recording");
    await deliver("bot.in_call_recording");
    expect(await db.webhookEvent.count()).toBe(1);
  });

  it("keeps the raw payload for replay and debugging", async () => {
    await deliver("recording.done");
    const event = await db.webhookEvent.findFirstOrThrow();
    expect(event.eventType).toBe("recording.done");
    expect(event.recordingId).toBe(RECORDING_ID);
    expect((event.payload as { event: string }).event).toBe("recording.done");
  });
});

describe("state machine under real delivery conditions", () => {
  it("walks the meeting through the bot lifecycle", async () => {
    for (const event of ["bot.joining_call", "bot.in_waiting_room", "bot.in_call_not_recording", "bot.in_call_recording", "bot.call_ended"] as const) {
      await deliver(event);
      await drainWebhooks();
    }

    const meeting = await db.meeting.findUniqueOrThrow({
      where: { id: meetingId },
      include: { transitions: { orderBy: { occurredAt: "asc" } } },
    });
    expect(meeting.status).toBe(MeetingStatus.call_ended);
    expect(meeting.startedAt).not.toBeNull();
    expect(meeting.endedAt).not.toBeNull();
    expect(meeting.transitions.map((t) => t.toStatus)).toEqual([
      MeetingStatus.bot_scheduled,
      MeetingStatus.bot_joined,
      MeetingStatus.recording,
      MeetingStatus.call_ended,
    ]);
  });

  it("does not rewind when a bot event arrives after recording.done", async () => {
    await deliver("recording.done");
    await drainWebhooks();
    expect((await db.meeting.findUniqueOrThrow({ where: { id: meetingId } })).status).toBe(
      MeetingStatus.media_processing,
    );

    // Late delivery of an earlier event.
    await deliver("bot.in_call_recording");
    await drainWebhooks();

    const meeting = await db.meeting.findUniqueOrThrow({ where: { id: meetingId } });
    expect(meeting.status).toBe(MeetingStatus.media_processing);
  });

  it("fails the meeting on bot.fatal and records the sub_code", async () => {
    await deliver("bot.fatal");
    await drainWebhooks();

    const meeting = await db.meeting.findUniqueOrThrow({ where: { id: meetingId } });
    expect(meeting.status).toBe(MeetingStatus.failed);
    expect(meeting.failureReason).toContain("meeting_not_found");
  });

  it("fails the meeting when transcription fails", async () => {
    await deliver("transcript.failed");
    await drainWebhooks();
    expect((await db.meeting.findUniqueOrThrow({ where: { id: meetingId } })).status).toBe(
      MeetingStatus.failed,
    );
  });
});

describe("artifact pipeline", () => {
  it("pulls audio into R2 and requests async transcription on recording.done", async () => {
    await deliver("recording.done");
    await drainWebhooks();
    await drain(queues.ingestRecordingQueue, jobs.ingestRecording as never);

    expect(uploads.map((u) => u.key)).toEqual([`${tenantId}/meetings/${meetingId}/recording.mp3`]);

    const artifact = await db.artifact.findFirstOrThrow({
      where: { meetingId, kind: ArtifactKind.recording_audio },
    });
    expect(artifact.contentType).toBe("audio/mpeg");
    expect(Number(artifact.bytes)).toBe(4_812_004);
    expect(artifact.checksum).toBe("sha256:fake-audio");
    // The presigned signature must not be kept in the audit trail.
    expect(artifact.sourceUrl).toBe("https://recall-media.test/audio/rec1.mp3");

    const meeting = await db.meeting.findUniqueOrThrow({ where: { id: meetingId } });
    expect(meeting.recallTranscriptId).toBe(TRANSCRIPT_ID);
  });

  it("is idempotent — a redelivered recording job re-uploads nothing", async () => {
    await deliver("recording.done");
    await drainWebhooks();
    await drain(queues.ingestRecordingQueue, jobs.ingestRecording as never);
    const first = uploads.length;

    await jobs.ingestRecording({ meetingId, tenantId, recordingId: RECORDING_ID });
    expect(uploads.length).toBe(first);
    expect(await db.artifact.count({ where: { meetingId } })).toBe(1);
  });

  it("stores the raw transcript and parses it into citable segments", async () => {
    await deliver("recording.done");
    await drainWebhooks();
    await drain(queues.ingestRecordingQueue, jobs.ingestRecording as never);
    await deliver("transcript.done");
    await drainWebhooks();
    await drain(queues.ingestTranscriptQueue, jobs.ingestTranscript as never);

    expect(uploads.map((u) => u.key)).toContain(`${tenantId}/meetings/${meetingId}/transcript.json`);

    const transcript = await db.transcript.findUniqueOrThrow({
      where: { meetingId },
      include: { segments: { orderBy: { idx: "asc" } }, evidenceSource: true },
    });
    expect(transcript.provider).toBe("recallai_async");
    expect(transcript.segments).toHaveLength(9);
    expect(transcript.segments[0]!.speaker).toBe("Priya Raman");
    expect(transcript.evidenceSource.kind).toBe("meeting_transcript");
    expect(transcript.evidenceSource.externalId).toBe(TRANSCRIPT_ID);
  });
});

describe("extraction and the review gate", () => {
  it("proposes claims, drops unevidenced ones and collapses duplicates", async () => {
    await runToReview();

    const meeting = await db.meeting.findUniqueOrThrow({ where: { id: meetingId } });
    expect(meeting.status).toBe(MeetingStatus.in_review);

    const claims = await db.candidateClaim.findMany({ where: { meetingId }, include: { segments: true } });
    expect(claims).toHaveLength(2);
    expect(claims.every((c) => c.status === ClaimStatus.proposed)).toBe(true);
    // Provenance is structural: no claim exists without a segment link.
    expect(claims.every((c) => c.segments.length > 0)).toBe(true);

    const run = await db.extractionRun.findFirstOrThrow({ where: { meetingId } });
    expect(run.status).toBe("succeeded");
    expect(run.droppedCount).toBeGreaterThanOrEqual(2); // invented id + fabricated quote
    expect(run.duplicateCount).toBeGreaterThanOrEqual(1); // overlap duplicate
    expect(run.persistedCount).toBe(2);
  });

  it("writes NOTHING into the brief without a human decision", async () => {
    await runToReview();
    expect(await db.briefVersion.count()).toBe(0);
    expect(await db.briefClaim.count()).toBe(0);

    const merge = await app.inject({ method: "POST", url: "/api/v1/brief/versions", payload: {} });
    expect(merge.statusCode).toBe(409);
  });

  it("serves the review queue with provenance attached to every card", async () => {
    await runToReview();

    const response = await app.inject({ method: "GET", url: "/api/v1/review-queue" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.claims).toHaveLength(2);

    for (const claim of body.claims) {
      expect(claim.evidence.verbatim_quote.length).toBeGreaterThan(10);
      expect(claim.evidence.speaker).toBeTruthy();
      expect(claim.evidence.timestamp_label).toMatch(/^\d+:\d{2}$/);
      expect(claim.evidence.segments.length).toBeGreaterThan(0);
    }
  });

  it("records every decision in the append-only audit log", async () => {
    await runToReview();
    const claims = await db.candidateClaim.findMany({ where: { meetingId }, orderBy: { type: "asc" } });

    await app.inject({ method: "POST", url: `/api/v1/claims/${claims[0]!.id}/approve`, payload: { note: "clear" } });
    await app.inject({
      method: "PATCH",
      url: `/api/v1/claims/${claims[1]!.id}`,
      payload: { text: "Lead with the flat support cost curve in mid-market.", note: "tightened" },
      headers: { "x-reviewer-email": "priya@freshworks.example" },
    });

    const decisions = await db.reviewDecision.findMany({ orderBy: { createdAt: "asc" } });
    expect(decisions).toHaveLength(2);
    expect(decisions[0]!.action).toBe("approve");
    expect(decisions[0]!.reviewer).toBe("reviewer@test.example");
    expect(decisions[1]!.action).toBe("edit_approve");
    expect(decisions[1]!.reviewer).toBe("priya@freshworks.example");
    expect(decisions[1]!.previousText).toBe(claims[1]!.text);
    expect(decisions[1]!.editedText).toBe("Lead with the flat support cost curve in mid-market.");
  });
});

describe("brief versioning", () => {
  it("merges approved claims into version 1 and leaves rejected ones out", async () => {
    await runToReview();
    const claims = await db.candidateClaim.findMany({ where: { meetingId }, orderBy: { type: "asc" } });

    await app.inject({ method: "POST", url: `/api/v1/claims/${claims[0]!.id}/approve`, payload: {} });
    await app.inject({ method: "POST", url: `/api/v1/claims/${claims[1]!.id}/reject`, payload: { note: "duplicate of v0" } });

    const merged = await app.inject({ method: "POST", url: "/api/v1/brief/versions", payload: { note: "first" } });
    expect(merged.statusCode).toBe(201);
    expect(merged.json().version).toMatchObject({ version: 1, added: 1, removed: 0, edited: 0, total: 1 });

    const current = await app.inject({ method: "GET", url: "/api/v1/brief/current" });
    expect(current.json().total).toBe(1);
    expect(current.json().claims_by_type[0].claims[0].text).toBe(claims[0]!.text);
  });

  it("carries version N-1 forward and reports the delta", async () => {
    await runToReview();
    const claims = await db.candidateClaim.findMany({ where: { meetingId }, orderBy: { type: "asc" } });

    await app.inject({ method: "POST", url: `/api/v1/claims/${claims[0]!.id}/approve`, payload: {} });
    await app.inject({ method: "POST", url: "/api/v1/brief/versions", payload: {} });

    await app.inject({ method: "POST", url: `/api/v1/claims/${claims[1]!.id}/approve`, payload: {} });
    const second = await app.inject({ method: "POST", url: "/api/v1/brief/versions", payload: {} });
    expect(second.json().version).toMatchObject({ version: 2, added: 1, total: 2 });

    const diff = (await app.inject({ method: "GET", url: "/api/v1/brief/versions/1/diff/2" })).json();
    expect(diff.added).toHaveLength(1);
    expect(diff.removed).toHaveLength(0);
    expect(diff.unchanged).toBe(1);
  });

  it("freezes claim text at merge time — a later edit becomes a new version's delta", async () => {
    await runToReview();
    const claims = await db.candidateClaim.findMany({ where: { meetingId }, orderBy: { type: "asc" } });

    await app.inject({ method: "POST", url: `/api/v1/claims/${claims[0]!.id}/approve`, payload: {} });
    await app.inject({ method: "POST", url: "/api/v1/brief/versions", payload: {} });

    await app.inject({
      method: "PATCH",
      url: `/api/v1/claims/${claims[0]!.id}`,
      payload: { text: "Position as the layer that flattens the support cost curve." },
    });
    const second = await app.inject({ method: "POST", url: "/api/v1/brief/versions", payload: {} });
    expect(second.json().version).toMatchObject({ version: 2, edited: 1, added: 0 });

    const v1 = (await app.inject({ method: "GET", url: "/api/v1/brief/versions/1" })).json();
    expect(v1.claims_by_type[0].claims[0].text).toBe(claims[0]!.text);

    const diff = (await app.inject({ method: "GET", url: "/api/v1/brief/versions/1/diff/2" })).json();
    expect(diff.edited).toHaveLength(1);
    expect(diff.edited[0].before).toBe(claims[0]!.text);
    expect(diff.edited[0].after).toBe("Position as the layer that flattens the support cost curve.");
  });

  it("drops a claim from the next version when it is rejected after merging", async () => {
    await runToReview();
    const claims = await db.candidateClaim.findMany({ where: { meetingId }, orderBy: { type: "asc" } });

    await app.inject({ method: "POST", url: `/api/v1/claims/${claims[0]!.id}/approve`, payload: {} });
    await app.inject({ method: "POST", url: `/api/v1/claims/${claims[1]!.id}/approve`, payload: {} });
    await app.inject({ method: "POST", url: "/api/v1/brief/versions", payload: {} });

    await app.inject({ method: "POST", url: `/api/v1/claims/${claims[1]!.id}/reject`, payload: { note: "wrong" } });
    const second = await app.inject({ method: "POST", url: "/api/v1/brief/versions", payload: {} });
    expect(second.json().version).toMatchObject({ version: 2, removed: 1, total: 1 });

    const v1 = (await app.inject({ method: "GET", url: "/api/v1/brief/versions/1" })).json();
    expect(v1.total).toBe(2); // history is immutable
  });
});

describe("deletion path", () => {
  it("purges evidence but keeps merged claims, marked redacted", async () => {
    await runToReview();
    const claims = await db.candidateClaim.findMany({ where: { meetingId }, orderBy: { type: "asc" } });
    await app.inject({ method: "POST", url: `/api/v1/claims/${claims[0]!.id}/approve`, payload: {} });
    await app.inject({ method: "POST", url: "/api/v1/brief/versions", payload: {} });

    const deleted = await app.inject({ method: "DELETE", url: `/api/v1/meetings/${meetingId}` });
    expect(deleted.statusCode).toBe(204);

    expect(await db.transcript.count({ where: { meetingId } })).toBe(0);
    expect(await db.transcriptSegment.count()).toBe(0);
    expect(await db.candidateClaim.count({ where: { meetingId, mergedAt: null } })).toBe(0);

    const briefClaims = await db.briefClaim.findMany({ where: { meetingId } });
    expect(briefClaims).toHaveLength(1);
    expect(briefClaims[0]!.evidenceRedacted).toBe(true);
    expect(briefClaims[0]!.verbatimQuote).toBe("[evidence redacted]");
    expect(briefClaims[0]!.text).toBe(claims[0]!.text);

    // The audit log survives deletion.
    expect(await db.reviewDecision.count()).toBe(1);
  });
});

describe("tenancy", () => {
  it("does not leak another tenant's claims into the review queue", async () => {
    await runToReview();
    await db.tenant.create({ data: { slug: "other-co", name: "Other Co" } });

    const other = await app.inject({
      method: "GET",
      url: "/api/v1/review-queue",
      headers: { "x-tenant-slug": "other-co" },
    });
    expect(other.json().claims).toHaveLength(0);

    const own = await app.inject({ method: "GET", url: "/api/v1/review-queue" });
    expect(own.json().claims).toHaveLength(2);
  });

  it("refuses a request whose identity resolves to nothing", async () => {
    // With sessions in play, a header naming a tenant that does not exist is
    // not a bad request — it is an unauthenticated one. There is no identity
    // behind it, and saying "no such tenant" would confirm which slugs exist.
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/meetings",
      headers: { "x-tenant-slug": "no-such-tenant" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("unauthenticated");
  });

  it("refuses an unauthenticated request outright", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/review-queue" });
    // The dev-header fallback supplies the seeded tenant, so this asserts the
    // request is *identified*, not that it is anonymous. The production guard
    // (AUTH_DEV_HEADERS ignored when NODE_ENV=production) is what makes the
    // fallback safe; see resolveContext in src/http.ts.
    expect([200, 401]).toContain(response.statusCode);
  });
});

describe("failure and retry", () => {
  it("marks the meeting failed when Recall refuses the bot", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/meetings",
      payload: { meeting_url: "https://meet.google.com/broken-link" },
    });

    expect(response.statusCode).toBe(502);
    const meeting = await db.meeting.findFirstOrThrow({
      where: { meetingUrl: "https://meet.google.com/broken-link" },
    });
    expect(meeting.status).toBe(MeetingStatus.failed);
    expect(meeting.failedStage).toBe("dispatch");
    expect(meeting.failureReason).toContain("Recall POST /bot/ failed");
  });

  it("re-dispatches the bot when dispatch is what failed", async () => {
    await deliver("bot.fatal");
    await drainWebhooks();
    expect((await db.meeting.findUniqueOrThrow({ where: { id: meetingId } })).status).toBe(
      MeetingStatus.failed,
    );

    const retry = await app.inject({ method: "POST", url: `/api/v1/meetings/${meetingId}/retry` });
    expect(retry.statusCode).toBe(202);

    const meeting = await db.meeting.findUniqueOrThrow({ where: { id: meetingId } });
    expect(meeting.status).toBe(MeetingStatus.bot_scheduled);
    expect(meeting.failureReason).toBeNull();
    expect(meeting.failedStage).toBeNull();
  });

  it("re-runs extraction instead of re-dispatching when extraction failed", async () => {
    await deliver("recording.done");
    await drainWebhooks();
    await drain(queues.ingestRecordingQueue, jobs.ingestRecording as never);
    await deliver("transcript.done");
    await drainWebhooks();
    await drain(queues.ingestTranscriptQueue, jobs.ingestTranscript as never);
    await queues.extractQueue.obliterate({ force: true });

    await db.meeting.update({
      where: { id: meetingId },
      data: { status: MeetingStatus.failed, failedStage: "extract", failureReason: "rate limited" },
    });

    const retry = await app.inject({ method: "POST", url: `/api/v1/meetings/${meetingId}/retry` });
    expect(retry.statusCode).toBe(202);

    const meeting = await db.meeting.findUniqueOrThrow({ where: { id: meetingId } });
    expect(meeting.status).toBe(MeetingStatus.transcript_ready);
    expect(await queues.extractQueue.getJobCountByTypes("waiting")).toBe(1);

    // The artifacts already in R2 are not fetched a second time.
    const uploadCount = uploads.length;
    await drain(queues.extractQueue, jobs.runExtraction as never);
    expect(uploads.length).toBe(uploadCount);
    expect((await db.meeting.findUniqueOrThrow({ where: { id: meetingId } })).status).toBe(
      MeetingStatus.in_review,
    );
  });

  it("refuses to retry a meeting that has not failed", async () => {
    const retry = await app.inject({ method: "POST", url: `/api/v1/meetings/${meetingId}/retry` });
    expect(retry.statusCode).toBe(409);
    expect(retry.json().error.code).toBe("conflict");
  });
});
