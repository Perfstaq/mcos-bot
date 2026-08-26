import { prisma } from "../db.js";
import { env } from "../env.js";
import { generateMeetingDigest } from "../integrations/openai.js";
import { formatTimestamp } from "../domain/transcript.js";
import { logger } from "../logger.js";
import type { DigestJob } from "../queue.js";
import { withTenantContext } from "./context.js";

const log = logger.child({ job: "digest" });

/**
 * A cheap, best-effort meeting label: a one-line title and a three-sentence
 * digest, generated once a transcript lands.
 *
 * This is metadata, not memory. It never touches `candidate_claims`,
 * `review_decisions` or `brief_versions` — GATE-ONLY WRITES is about what
 * reaches the brief, and a digest never does. It also never fails the
 * pipeline: every error here is caught, logged, and swallowed, and the
 * meeting falls back to showing its raw URL exactly as it did before this
 * job existed. A meeting whose digest generation failed is not a failed
 * meeting.
 *
 * Idempotent: a meeting that already has a digest is left alone, so a
 * redelivered job (or a retry of the ingest step that enqueued it) is a
 * no-op rather than a second model call.
 */
export async function runDigest(job: DigestJob): Promise<void> {
  try {
    await withTenantContext(job.tenantId, () => generateAndStore(job.meetingId));
  } catch (error) {
    log.warn(
      { meetingId: job.meetingId, err: (error as Error).message },
      "digest generation failed — the meeting falls back to its raw URL",
    );
  }
}

async function generateAndStore(meetingId: string): Promise<void> {
  const meeting = await prisma.meeting.findUnique({
    where: { id: meetingId },
    select: { id: true, title: true, digest: true, deletedAt: true },
  });
  if (!meeting || meeting.deletedAt || meeting.digest) return;

  const transcript = await prisma.transcript.findUnique({
    where: { meetingId },
    include: { segments: { orderBy: { idx: "asc" }, take: SEGMENT_SAMPLE_LIMIT } },
  });
  if (!transcript || transcript.segments.length === 0) return;

  const excerpt = buildExcerpt(transcript.segments);
  const result = await generateMeetingDigest({
    transcriptExcerpt: excerpt,
    existingTitle: meeting.title,
  });

  await prisma.meeting.update({
    where: { id: meetingId },
    data: {
      // Never override a title a human already typed when they sent the bot.
      title: meeting.title ?? result.title,
      digest: result.digest,
      digestModel: env.DIGEST_MODEL,
      digestGeneratedAt: new Date(),
    },
  });

  log.info({ meetingId }, "digest generated");
}

/** How much of the call this cheap call actually reads. A digest is a label,
 *  not a transcript review, so an opening excerpt is enough — and bounding it
 *  keeps the call cheap regardless of how long the meeting ran. */
const SEGMENT_SAMPLE_LIMIT = 120;
const EXCERPT_CHAR_LIMIT = 8_000;

type ExcerptSegment = { speaker: string; startMs: number; text: string };

function buildExcerpt(segments: ExcerptSegment[]): string {
  const lines: string[] = [];
  let length = 0;
  for (const segment of segments) {
    const line = `[${formatTimestamp(segment.startMs)}] ${segment.speaker}: ${segment.text}`;
    if (length + line.length > EXCERPT_CHAR_LIMIT) break;
    lines.push(line);
    length += line.length + 1;
  }
  return lines.join("\n");
}
