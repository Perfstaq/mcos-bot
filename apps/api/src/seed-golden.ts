import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EvidenceKind, MeetingStatus } from "@prisma/client";
import { disconnect, prisma } from "./db.js";
import { runWithContext } from "./context.js";
import { env } from "./env.js";
import { parseTranscript } from "./domain/transcript.js";
import type { RecallTranscriptEntry } from "./integrations/recall.js";
import { passwordSourceMessage, seedWorkspace } from "./seed-workspace.js";

/**
 * Golden-fixture seed: ingests the two realistic golden transcripts
 * (tests/fixtures/transcripts/golden-freshworks.json,
 * golden-discovery.json) into the demo tenant as completed meetings, in
 * `transcript_ready` — exactly the state jobs/ingest-transcript.ts leaves a
 * meeting in once Recall's real webhook flow has run.
 *
 * Deliberately stops there. No extraction, no candidate claims, no brief
 * versions: GATE-ONLY WRITES means nothing but a human review decision may
 * ever reach brief/memory tables, and a seed script is exactly the kind of
 * shortcut that invariant exists to rule out. Downstream agents run
 * extraction themselves (against a mocked model — see
 * tests/helpers/llm-mock.ts) to exercise that path.
 *
 * `seedGoldenMeetings` is the reusable half: given a tenantId, it ingests
 * both fixtures with plain Prisma writes under `runWithContext`, no Better
 * Auth involved, so tests can call it directly against a lightweight test
 * tenant (see tests/seed-golden.test.ts). The five writes per meeting
 * (meeting, evidence source, transcript, segments, state transition) run
 * inside one `prisma.$transaction`, so a crash mid-seed can never leave a
 * half-written meeting behind for the idempotency check (`findFirst` by
 * title, then `findUniqueOrThrow` on its transcript) to trip over on rerun.
 *
 * `main` below is the CLI entrypoint, which additionally resolves/creates
 * the real demo tenant through Better Auth — that half is intentionally NOT
 * exercised by the automated suite, because pipeline.test.ts truncates the
 * `tenants` table before every test and would orphan the Organization row
 * this creates.
 */

export type GoldenMeetingSummary = {
  meetingId: string;
  title: string;
  segmentCount: number;
  wordCount: number;
  durationMs: number;
  reused: boolean;
};

export type GoldenSeedSummary = {
  tenantId: string;
  meetings: GoldenMeetingSummary[];
};

const GOLDEN_TRANSCRIPTS: Array<{
  key: string;
  title: string;
  fixtureFile: string;
  meetingUrl: string;
  platform: string;
}> = [
  {
    key: "golden-freshworks",
    title: "Golden: Freshworks positioning workshop",
    fixtureFile: "golden-freshworks.json",
    meetingUrl: "https://meet.google.com/golden-seed-freshworks",
    platform: "google_meet",
  },
  {
    key: "golden-discovery",
    title: "Golden: Freshworks discovery call",
    fixtureFile: "golden-discovery.json",
    meetingUrl: "https://meet.google.com/golden-seed-discovery",
    platform: "google_meet",
  },
];

function fixturePath(file: string): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../tests/fixtures/transcripts", file);
}

function loadEntries(file: string): RecallTranscriptEntry[] {
  const raw = fs.readFileSync(fixturePath(file), "utf-8");
  const decoded: unknown = JSON.parse(raw);
  if (!Array.isArray(decoded)) throw new Error(`${file} is not a transcript array`);
  return decoded as RecallTranscriptEntry[];
}

/**
 * Ingest both golden transcripts into `tenantId`. Idempotent by title: a
 * meeting that already exists for this tenant is left untouched and reported
 * back as `reused: true`, so `npm run seed:golden` is safe to run twice.
 *
 * Must run inside `runWithContext({ tenantId, ... })` — every write here goes
 * through the tenant-scoped `prisma` client, same as production code.
 */
export async function seedGoldenMeetings(tenantId: string): Promise<GoldenSeedSummary> {
  const meetings: GoldenMeetingSummary[] = [];

  for (const def of GOLDEN_TRANSCRIPTS) {
    const existing = await prisma.meeting.findFirst({
      where: { tenantId, title: def.title },
      select: { id: true },
    });

    if (existing) {
      const transcript = await prisma.transcript.findUniqueOrThrow({
        where: { meetingId: existing.id },
        select: { segmentCount: true, wordCount: true, durationMs: true },
      });
      meetings.push({
        meetingId: existing.id,
        title: def.title,
        segmentCount: transcript.segmentCount,
        wordCount: transcript.wordCount,
        durationMs: transcript.durationMs,
        reused: true,
      });
      continue;
    }

    const entries = loadEntries(def.fixtureFile);
    const parsed = parseTranscript(entries);
    if (parsed.segments.length === 0) {
      throw new Error(`${def.fixtureFile} produced no segments — fixture is broken`);
    }

    // Backdated so a seeded "completed" meeting doesn't end in the future:
    // it ended just now and ran for as long as the transcript's own duration.
    const endedAt = new Date();
    const startedAt = new Date(endedAt.getTime() - parsed.durationMs);

    const meeting = await prisma.$transaction(async (tx) => {
      const meeting = await tx.meeting.create({
        data: {
          tenantId,
          title: def.title,
          meetingUrl: def.meetingUrl,
          platform: def.platform,
          status: MeetingStatus.transcript_ready,
          startedAt,
          endedAt,
          durationMs: parsed.durationMs,
          // recallBotId/recallTranscriptId are globally @unique on Meeting.
          // No real Recall bot ever ran for a seeded meeting, so recallBotId
          // is null — every consumer tolerates that. recallTranscriptId is
          // different: jobs/ingest-transcript.ts always sets it once a
          // transcript row exists, so a transcript_ready meeting with a null
          // recallTranscriptId is a state production can never produce, and
          // routes/meetings.ts gates the retry-after-failed-extract path on
          // `stage === "extract" && meeting.recallTranscriptId` — null falls
          // through to the branch that dispatches a real Recall bot at the
          // meeting's (fake) URL. Scoped by tenantId so it stays unique
          // across tenants seeding the same fixture.
          recallBotId: null,
          recallTranscriptId: `${def.key}-${tenantId}`,
        },
      });

      const evidence = await tx.evidenceSource.create({
        data: {
          tenantId,
          kind: EvidenceKind.meeting_transcript,
          meetingId: meeting.id,
          externalId: `${def.key}-transcript`,
          capturedAt: startedAt,
          metadata: {
            provider: "golden-fixture",
            fixture: def.fixtureFile,
            note: "Seeded from a golden fixture — no Recall call was made.",
          },
        },
      });

      const transcript = await tx.transcript.create({
        data: {
          tenantId,
          meetingId: meeting.id,
          evidenceSourceId: evidence.id,
          provider: "golden-fixture",
          languageCode: parsed.languageCode,
          segmentCount: parsed.segments.length,
          wordCount: parsed.wordCount,
          durationMs: parsed.durationMs,
        },
      });

      await tx.transcriptSegment.createMany({
        data: parsed.segments.map((s) => ({
          tenantId,
          transcriptId: transcript.id,
          idx: s.idx,
          speaker: s.speaker,
          speakerId: s.speakerId,
          startMs: s.startMs,
          endMs: s.endMs,
          text: s.text,
        })),
      });

      await tx.stateTransition.create({
        data: {
          tenantId,
          meetingId: meeting.id,
          fromStatus: null,
          toStatus: MeetingStatus.transcript_ready,
          reason: `golden fixture ingested (${def.fixtureFile})`,
        },
      });

      return meeting;
    });

    meetings.push({
      meetingId: meeting.id,
      title: def.title,
      segmentCount: parsed.segments.length,
      wordCount: parsed.wordCount,
      durationMs: parsed.durationMs,
      reused: false,
    });
  }

  return { tenantId, meetings };
}

/**
 * Hard refusal to run this seed anywhere near a production environment.
 * Extracted from `main` so the guard is behaviorally unit-testable (see
 * tests/seed-golden.test.ts) rather than only verifiable by grepping the
 * compiled source for the check.
 */
export function assertNotProduction(nodeEnv: string): void {
  if (nodeEnv === "production") {
    throw new Error("Refusing to run the golden seed against NODE_ENV=production.");
  }
}

async function main(): Promise<void> {
  assertNotProduction(env.NODE_ENV);

  const { tenantId, email } = await seedWorkspace();
  console.log(passwordSourceMessage(email));

  const summary = await runWithContext(
    { tenantId, tenantSlug: env.DEFAULT_TENANT_SLUG, reviewer: "seed-golden" },
    () => seedGoldenMeetings(tenantId),
  );

  for (const m of summary.meetings) {
    const label = m.reused ? "already present" : "seeded";
    console.log(
      `${m.title}: meeting ${m.meetingId} (${label}) — ${m.segmentCount} segments, ${m.wordCount} words, ${Math.round(m.durationMs / 1000)}s`,
    );
  }
}

// Only run when this file is the process entrypoint (`tsx src/seed-golden.ts`),
// not when seedGoldenMeetings is imported directly by a test.
const isDirectRun =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isDirectRun) {
  main()
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => disconnect());
}
