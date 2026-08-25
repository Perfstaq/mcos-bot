import { ActionItemOrigin, ActionItemStatus } from "@prisma/client";
import { prisma, rawPrisma } from "../db.js";
import { chunkBySpeakerTurns, segmentHandle } from "../domain/chunking.js";
import { normalizeClaimText, quoteAppearsIn } from "../domain/claims.js";
import { suggestFromChunk, type SuggestedAction } from "../integrations/openai-actions.js";
import { logger } from "../logger.js";
import { withTenantContext } from "./context.js";

const log = logger.child({ job: "suggest-action-items" });

/**
 * Suggestion proposes; it never commits.
 *
 * Everything this job writes lands as `origin: ai_suggested` with `acceptedAt`
 * and `dismissedAt` both null — the pending state — and the list routes filter
 * that state out. The parallel with the claim review gate is deliberate and it
 * is the same argument: a model may not add work to a person's plate on its
 * own. There is no confidence threshold that auto-accepts here, and adding one
 * would be a second write path into somebody's to-do list.
 */

/** Owned by this file until the integrator moves it into queue.ts alongside
 *  the other job payloads. Same shape as ExtractJob on purpose. */
export type SuggestActionItemsJob = { meetingId: string; tenantId: string };

export type SuggestionRunSummary = {
  proposed: number;
  /** Citation did not resolve to a real segment of this transcript. */
  dropped: number;
  duplicates: number;
  persisted: number;
  inputTokens: number;
  outputTokens: number;
};

export type SegmentRow = { id: string; idx: number; text: string };

export type ResolvedSuggestion = { suggestion: SuggestedAction; segmentId: string };

/**
 * The evidence gate, and the reason it is a separate exported function: it is
 * the only part of this job worth testing without a network.
 *
 * A suggestion is dropped when it cites a handle the transcript does not
 * contain (the model invented one), or when its quote does not appear in the
 * segment it cited. Dropping is the point. `ActionItem.sourceSegmentId` is how
 * somebody settles the argument about whether a commitment was ever made, and
 * a citation that points at nothing reads as evidence right up until the moment
 * a person follows it — which is strictly worse than no citation at all.
 */
export function resolveCitations(
  suggestions: SuggestedAction[],
  byHandle: Map<string, SegmentRow>,
): { resolved: ResolvedSuggestion[]; dropped: number } {
  const resolved: ResolvedSuggestion[] = [];
  let dropped = 0;

  for (const suggestion of suggestions) {
    const segment = byHandle.get(suggestion.sourceHandle.trim());
    if (!segment || !quoteAppearsIn(suggestion.quote, [segment.text])) {
      dropped += 1;
      continue;
    }
    resolved.push({ suggestion, segmentId: segment.id });
  }

  return { resolved, dropped };
}

export async function runActionItemSuggestions(
  job: SuggestActionItemsJob,
): Promise<SuggestionRunSummary> {
  const empty: SuggestionRunSummary = {
    proposed: 0,
    dropped: 0,
    duplicates: 0,
    persisted: 0,
    inputTokens: 0,
    outputTokens: 0,
  };

  return withTenantContext(job.tenantId, async () => {
    const meeting = await prisma.meeting.findUnique({
      where: { id: job.meetingId },
      select: {
        id: true,
        tenantId: true,
        title: true,
        startedAt: true,
        createdAt: true,
        deletedAt: true,
      },
    });
    if (!meeting || meeting.deletedAt) return empty;

    const transcript = await prisma.transcript.findUnique({
      where: { meetingId: meeting.id },
      include: { segments: { orderBy: { idx: "asc" } } },
    });
    // Thrown, not swallowed: this job is triggered off the same transcript the
    // extractor uses, so a missing one is a race worth retrying rather than a
    // meeting that legitimately has nothing to suggest.
    if (!transcript) throw new Error(`No transcript for meeting ${meeting.id}`);

    /**
     * Dedupe against every existing item on the meeting, not just previous
     * suggestions. Re-proposing something a human already typed, already
     * accepted, or already dismissed is the failure mode that makes a
     * suggestions inbox worth turning off.
     */
    const existing = await prisma.actionItem.findMany({
      where: { meetingId: meeting.id },
      select: { title: true },
    });
    const seen = new Set(existing.map((item) => normalizeClaimText(item.title)));

    const chunks = chunkBySpeakerTurns(
      transcript.segments.map((s) => ({
        id: s.id,
        idx: s.idx,
        speaker: s.speaker,
        startMs: s.startMs,
        text: s.text,
      })),
    );
    const byHandle = new Map<string, SegmentRow>(
      transcript.segments.map((s) => [segmentHandle(s.idx), { id: s.id, idx: s.idx, text: s.text }]),
    );

    const members = await workspaceMembers(meeting.tenantId);
    const meetingDate = meeting.startedAt ?? meeting.createdAt;
    const summary = { ...empty };

    for (const chunk of chunks) {
      const result = await suggestFromChunk({
        chunk,
        meetingTitle: meeting.title,
        meetingDate,
      });
      summary.inputTokens += result.inputTokens;
      summary.outputTokens += result.outputTokens;
      summary.proposed += result.suggestions.length;

      const { resolved, dropped } = resolveCitations(result.suggestions, byHandle);
      summary.dropped += dropped;

      for (const { suggestion, segmentId } of resolved) {
        const key = normalizeClaimText(suggestion.title);
        if (seen.has(key)) {
          summary.duplicates += 1;
          continue;
        }
        seen.add(key);

        await prisma.actionItem.create({
          data: {
            tenantId: meeting.tenantId,
            meetingId: meeting.id,
            title: suggestion.title,
            description: suggestion.description,
            status: ActionItemStatus.open,
            dueAt: parseDueDate(suggestion.dueDate),
            origin: ActionItemOrigin.ai_suggested,
            groupName: suggestion.groupHint,
            assigneeUserId: resolveOwner(suggestion.ownerHint, members),
            // Left null on purpose. `createdByUserId` means "a person put this
            // on the list", and until somebody accepts it, nobody has. The
            // accept route fills it in.
            createdByUserId: null,
            sourceSegmentId: segmentId,
          },
        });
        summary.persisted += 1;
      }
    }

    log.info({ meetingId: meeting.id, chunks: chunks.length, ...summary }, "suggestions complete");
    return summary;
  });
}

/* ---------------------------------------------------------------------- */

type Member = { userId: string; name: string; email: string };

/**
 * Better Auth's `member` and `user` carry no tenant column, so the tenancy
 * extension cannot scope them and `rawPrisma` is the honest way to say so —
 * the same reasoning as `assertWorkspaceMember` in routes/agenda.ts. The scope
 * that matters is applied explicitly: the organization this tenant belongs to.
 */
async function workspaceMembers(tenantId: string): Promise<Member[]> {
  const tenant = await rawPrisma.tenant.findUnique({
    where: { id: tenantId },
    select: { organizationId: true },
  });
  if (!tenant?.organizationId) return [];

  const rows = await rawPrisma.member.findMany({
    where: { organizationId: tenant.organizationId },
    select: { userId: true, user: { select: { name: true, email: true } } },
  });
  return rows.map((row) => ({
    userId: row.userId,
    name: row.user.name,
    email: row.user.email,
  }));
}

/**
 * Turn "Priya" into a user id, or into nothing.
 *
 * Exactly one match or null — never a best guess. Assigning the wrong person is
 * not a small error even on a proposal: it is what teaches people that the
 * suggestions inbox is not worth reading. An unassigned suggestion is a
 * question the accepter answers in one click; a misassigned one is a wrong
 * answer they have to notice first.
 */
export function resolveOwner(hint: string | null, members: Member[]): string | null {
  if (!hint) return null;
  const needle = normalizeClaimText(hint);
  if (!needle) return null;

  const matches = members.filter((member) => {
    const email = member.email.toLowerCase();
    if (email && (email === hint.trim().toLowerCase() || normalizeClaimText(email.split("@")[0] ?? "") === needle)) {
      return true;
    }
    const name = normalizeClaimText(member.name);
    if (!name) return false;
    // First name only is how people are addressed out loud, and it is safe
    // precisely because ambiguity below collapses to null.
    return name === needle || name.split(" ")[0] === needle;
  });

  return matches.length === 1 ? (matches[0]?.userId ?? null) : null;
}

/**
 * A malformed date loses the date, not the action item. The commitment is the
 * thing worth keeping; "by the 31st of Febtember" is a detail a person can fix
 * on accept.
 */
export function parseDueDate(value: string | null): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  // JavaScript rolls an out-of-range day forward rather than rejecting it, so
  // "2026-02-31" parses cheerfully as the 3rd of March. Round-tripping is the
  // only way to tell a real date from a plausible-looking one, and a due date
  // that quietly moved is worse than no due date.
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return null;
  return date;
}
