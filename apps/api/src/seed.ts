import { ClaimType, EvidenceKind, MeetingStatus } from "@prisma/client";
import { rawPrisma, disconnect } from "./db.js";
import { auth } from "./auth.js";
import { runWithContext } from "./context.js";
import { prisma } from "./db.js";
import { dedupeKey } from "./domain/claims.js";
import { PROMPT_VERSION } from "./integrations/openai.js";
import { env } from "./env.js";

/**
 * Seeds the demo tenant, and — with --demo — a fully populated meeting that
 * has already been through ingestion and extraction.
 *
 * The demo path exists so the review gate can be built, demonstrated and
 * tested without dispatching a bot to a live call. It writes claims as
 * `proposed`, never approved: seeding an approved claim would be a second
 * write path into memory, which is precisely what this system forbids.
 */
const DEMO_TRANSCRIPT: Array<{ speaker: string; speakerId: number; startMs: number; text: string }> = [
  { speaker: "Priya Raman", speakerId: 1, startMs: 4_000, text: "Right, so the reason I pulled this session together is that we keep losing mid-market deals at the same point and I want to name why." },
  { speaker: "Daniel Okafor", speakerId: 2, startMs: 13_500, text: "Agreed. I've sat in four of these now. It's always the same moment — somewhere around the second call, when they ask what we replace." },
  { speaker: "Priya Raman", speakerId: 1, startMs: 24_000, text: "And we don't have a clean answer. We say we're a customer engagement suite, which means nothing to a two hundred person company." },
  { speaker: "Marta Silva", speakerId: 3, startMs: 34_200, text: "The buyers we win are almost always a head of support at a company between two hundred and eight hundred employees who has just been told to cut ticket volume without adding headcount. That's the trigger every single time." },
  { speaker: "Daniel Okafor", speakerId: 2, startMs: 49_800, text: "That matches my numbers. When there's no headcount freeze, the deal stalls. The freeze is what makes it urgent." },
  { speaker: "Priya Raman", speakerId: 1, startMs: 58_000, text: "So the pain is that support teams are being asked to absorb more volume with a flat headcount and their existing tooling makes every extra ticket cost the same as the last one." },
  { speaker: "Marta Silva", speakerId: 3, startMs: 71_400, text: "Yes, and they've usually already bought a chatbot that didn't work. That's the objection we hit constantly — we tried automation, it deflected nothing, and it made customers angry." },
  { speaker: "Daniel Okafor", speakerId: 2, startMs: 85_000, text: "Zendesk is in almost every one of these accounts. They're not unhappy with Zendesk as a ticketing system, they're unhappy that it doesn't get cheaper as they grow." },
  { speaker: "Priya Raman", speakerId: 1, startMs: 97_600, text: "Then let's stop positioning against Zendesk on features. We should position as the layer that makes support cost curve flat, not as a better help desk." },
  { speaker: "Marta Silva", speakerId: 3, startMs: 110_200, text: "I like that. And we have the proof — the Ridgeline account went from eleven thousand tickets a month to the same volume with three fewer agents inside a quarter." },
  { speaker: "Daniel Okafor", speakerId: 2, startMs: 123_000, text: "There's also the Hartwell number. Forty-one percent deflection in eight weeks, and their CSAT went up two points rather than down." },
  { speaker: "Priya Raman", speakerId: 1, startMs: 134_500, text: "Good. Decision then — we stop leading with the suite story in mid-market and we lead with the flat cost curve, backed by Ridgeline and Hartwell. I'll get the deck changed this week." },
  { speaker: "Marta Silva", speakerId: 3, startMs: 148_000, text: "One more objection to plan for. Procurement at that size always asks about data residency, and we lose two weeks every time because we don't have a one-pager." },
  { speaker: "Daniel Okafor", speakerId: 2, startMs: 159_300, text: "That's real. It killed the Bramley deal outright." },
];

const DEMO_CLAIMS: Array<{
  type: ClaimType;
  text: string;
  confidence: number;
  segmentIdx: number[];
  quote: string;
}> = [
  {
    type: ClaimType.icp_fact,
    text: "The ideal customer is a head of support at a 200–800 employee company who has just been told to reduce ticket volume without adding headcount.",
    confidence: 0.94,
    segmentIdx: [3],
    quote: "a head of support at a company between two hundred and eight hundred employees who has just been told to cut ticket volume without adding headcount",
  },
  {
    type: ClaimType.icp_fact,
    text: "A headcount freeze is the buying trigger; without one, deals stall regardless of fit.",
    confidence: 0.86,
    segmentIdx: [4],
    quote: "When there's no headcount freeze, the deal stalls. The freeze is what makes it urgent.",
  },
  {
    type: ClaimType.pain_point,
    text: "Support teams must absorb rising ticket volume on flat headcount, and their current tooling makes each additional ticket cost as much as the last.",
    confidence: 0.91,
    segmentIdx: [5],
    quote: "support teams are being asked to absorb more volume with a flat headcount and their existing tooling makes every extra ticket cost the same as the last one",
  },
  {
    type: ClaimType.objection,
    text: "Buyers have usually already bought a chatbot that deflected nothing and frustrated customers, so they discount automation claims by default.",
    confidence: 0.89,
    segmentIdx: [6],
    quote: "we tried automation, it deflected nothing, and it made customers angry",
  },
  {
    type: ClaimType.objection,
    text: "Procurement at mid-market size always raises data residency, and the absence of a one-pager adds roughly two weeks to the cycle.",
    confidence: 0.83,
    segmentIdx: [12],
    quote: "Procurement at that size always asks about data residency, and we lose two weeks every time because we don't have a one-pager.",
  },
  {
    type: ClaimType.competitor_mention,
    text: "Zendesk is incumbent in nearly every mid-market account; the dissatisfaction is with cost scaling, not with ticketing capability.",
    confidence: 0.9,
    segmentIdx: [7],
    quote: "They're not unhappy with Zendesk as a ticketing system, they're unhappy that it doesn't get cheaper as they grow.",
  },
  {
    type: ClaimType.positioning_statement,
    text: "Position as the layer that flattens the support cost curve, not as a better help desk competing on features.",
    confidence: 0.92,
    segmentIdx: [8],
    quote: "We should position as the layer that makes support cost curve flat, not as a better help desk.",
  },
  {
    type: ClaimType.positioning_statement,
    text: 'The current "customer engagement suite" framing is meaningless to a 200-person company and fails at the "what do you replace" question.',
    confidence: 0.78,
    segmentIdx: [2],
    quote: "We say we're a customer engagement suite, which means nothing to a two hundred person company.",
  },
  {
    type: ClaimType.proof_point,
    text: "Ridgeline sustained 11,000 tickets a month with three fewer agents within one quarter.",
    confidence: 0.95,
    segmentIdx: [9],
    quote: "the Ridgeline account went from eleven thousand tickets a month to the same volume with three fewer agents inside a quarter",
  },
  {
    type: ClaimType.proof_point,
    text: "Hartwell reached 41% deflection in eight weeks with CSAT rising two points.",
    confidence: 0.93,
    segmentIdx: [10],
    quote: "Forty-one percent deflection in eight weeks, and their CSAT went up two points rather than down.",
  },
  {
    type: ClaimType.messaging_decision,
    text: "Stop leading with the suite story in mid-market; lead with the flat cost curve, evidenced by Ridgeline and Hartwell.",
    confidence: 0.96,
    segmentIdx: [11],
    quote: "we stop leading with the suite story in mid-market and we lead with the flat cost curve, backed by Ridgeline and Hartwell",
  },
];

const DEMO_PASSWORD = process.env.SEED_PASSWORD ?? "perfstaq-demo-password";

/**
 * Create the demo account through Better Auth rather than by inserting rows.
 *
 * Writing a user and a member row directly would produce an account that cannot
 * sign in — the password would be unhashed, the `issuer` unset, and the
 * organization's tenant never provisioned, because all three happen inside the
 * auth layer. Going through the public API means the seeded workspace is
 * identical to one a real signup produces.
 */
async function seedWorkspace(): Promise<{ tenantId: string; email: string }> {
  const email = env.DEFAULT_REVIEWER_EMAIL;

  const existing = await rawPrisma.user.findUnique({ where: { email }, select: { id: true } });
  if (!existing) {
    await auth.api.signUpEmail({
      body: { email, password: DEMO_PASSWORD, name: "Demo Reviewer" },
    });
    console.log(`user ${email} created (password: ${DEMO_PASSWORD})`);
  }

  const user = await rawPrisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } });

  const org = await rawPrisma.organization.findUnique({
    where: { slug: env.DEFAULT_TENANT_SLUG },
    include: { tenant: { select: { id: true } } },
  });

  if (org?.tenant) return { tenantId: org.tenant.id, email };

  // createOrganization runs afterCreateOrganization, which provisions the
  // tenant. Calling it with the user's headers is what makes them the owner.
  const created = await auth.api.createOrganization({
    body: { name: "Freshworks (demo)", slug: env.DEFAULT_TENANT_SLUG, userId: user.id },
  });
  if (!created) throw new Error("Better Auth declined to create the demo organization");

  const tenant = await rawPrisma.tenant.findUniqueOrThrow({
    where: { organizationId: created.id },
    select: { id: true, slug: true },
  });
  console.log(`workspace ${tenant.slug} -> tenant ${tenant.id}`);
  return { tenantId: tenant.id, email };
}

async function main(): Promise<void> {
  const withDemo = process.argv.includes("--demo") || process.env.SEED_DEMO === "1";

  const { tenantId, email } = await seedWorkspace();
  const tenant = await rawPrisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  console.log(`sign in as ${email} / ${DEMO_PASSWORD}`);

  if (!withDemo) {
    console.log("Seeded tenant only. Re-run with --demo for a populated meeting.");
    return;
  }

  await runWithContext(
    { tenantId: tenant.id, tenantSlug: tenant.slug, reviewer: "seed" },
    async () => {
      const existing = await prisma.meeting.findFirst({
        where: { title: "Mid-market positioning review" },
      });
      if (existing) {
        console.log(`demo meeting already present (${existing.id})`);
        return;
      }

      const meeting = await prisma.meeting.create({
        data: {
          tenantId: tenant.id,
          title: "Mid-market positioning review",
          meetingUrl: "https://meet.google.com/seed-demo-only",
          platform: "google_meet",
          status: MeetingStatus.in_review,
          startedAt: new Date(Date.now() - 3 * 24 * 3600 * 1000),
          endedAt: new Date(Date.now() - 3 * 24 * 3600 * 1000 + 170_000),
          recallBotId: `seed-bot-${Date.now()}`,
        },
      });

      const evidence = await prisma.evidenceSource.create({
        data: {
          tenantId: tenant.id,
          kind: EvidenceKind.meeting_transcript,
          meetingId: meeting.id,
          externalId: `seed-transcript-${meeting.id}`,
          capturedAt: new Date(),
          metadata: { provider: "seed", note: "Seeded demo transcript — no Recall call was made." },
        },
      });

      const transcript = await prisma.transcript.create({
        data: {
          tenantId: tenant.id,
          meetingId: meeting.id,
          evidenceSourceId: evidence.id,
          provider: "seed",
          languageCode: "en",
          segmentCount: DEMO_TRANSCRIPT.length,
          wordCount: DEMO_TRANSCRIPT.reduce((n, s) => n + s.text.split(/\s+/).length, 0),
          durationMs: 170_000,
        },
      });

      await prisma.transcriptSegment.createMany({
        data: DEMO_TRANSCRIPT.map((s, idx) => ({
          tenantId: tenant.id,
          transcriptId: transcript.id,
          idx,
          speaker: s.speaker,
          speakerId: s.speakerId,
          startMs: s.startMs,
          endMs: s.startMs + Math.max(4_000, s.text.length * 55),
          text: s.text,
        })),
      });

      const segments = await prisma.transcriptSegment.findMany({
        where: { transcriptId: transcript.id },
        orderBy: { idx: "asc" },
      });

      const run = await prisma.extractionRun.create({
        data: {
          tenantId: tenant.id,
          meetingId: meeting.id,
          model: "seed",
          promptVersion: PROMPT_VERSION,
          status: "succeeded",
          chunkCount: 1,
          proposedCount: DEMO_CLAIMS.length,
          persistedCount: DEMO_CLAIMS.length,
          finishedAt: new Date(),
        },
      });

      for (const claim of DEMO_CLAIMS) {
        const cited = claim.segmentIdx
          .map((i) => segments[i])
          .filter((s): s is NonNullable<typeof s> => Boolean(s));
        if (cited.length === 0) continue;

        const created = await prisma.candidateClaim.create({
          data: {
            tenantId: tenant.id,
            meetingId: meeting.id,
            evidenceSourceId: evidence.id,
            extractionRunId: run.id,
            type: claim.type,
            text: claim.text,
            confidence: claim.confidence,
            verbatimQuote: claim.quote,
            speaker: cited[0]!.speaker,
            timestampMs: cited[0]!.startMs,
            dedupeKey: dedupeKey(claim.type, claim.text),
          },
        });

        await prisma.claimSegment.createMany({
          data: cited.map((s) => ({ claimId: created.id, segmentId: s.id })),
          skipDuplicates: true,
        });
      }

      await prisma.stateTransition.create({
        data: {
          tenantId: tenant.id,
          meetingId: meeting.id,
          fromStatus: MeetingStatus.extracting,
          toStatus: MeetingStatus.in_review,
          reason: `${DEMO_CLAIMS.length} claims proposed (seed)`,
        },
      });

      console.log(
        `demo meeting ${meeting.id} — ${DEMO_TRANSCRIPT.length} segments, ${DEMO_CLAIMS.length} claims waiting for review`,
      );
    },
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => disconnect());
