import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ContentArchetype,
  ContentBriefStatus,
  ContentChannel,
  ContentMixSlot,
  EvidenceTier,
  ExpectedMetric,
  MediaAnalysisStatus,
  MediaAssetKind,
} from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { runWithContext } from "../src/context.js";
import { recordContentBriefDecision } from "../src/domain/content-gate.js";
import {
  assertOutputTimeGrid,
  buildApprovedRenderPlan,
  buildRenderPlan,
  PlanInfeasibleError,
} from "../src/domain/studio/plan-builder.js";
import { runPlanBuild } from "../src/jobs/plan-build.js";
import { db, resetDb, seedTenant } from "./helpers.js";

/**
 * `plan.build` — ARCHITECTURE §12.12's missing middle, tested as the two
 * things it has to be: a correct plan builder, and a correct GATE.
 *
 * The gate half is the reason this file exists at all. §12.12a and §12.13 are
 * both properties that a typecheck and a happy-path unit test cannot see — an
 * approval that went stale between enqueue and execution, and a beat grid that
 * is valid in source time but not in output time. Both were named as hard
 * requirements precisely because they fail SILENTLY, so each gets a test that
 * fails if the guard is removed.
 *
 * Inputs are the real committed analyzer output the render evidence was
 * produced from (`docs/studio/evidence/inputs/`) — 53s of real speech with
 * real RMS and a real librosa `beat_track` grid at 112.347bpm. A synthetic
 * fixture would exercise the wiring and prove nothing about whether a plan
 * built from real footage can pass G1a.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const evidenceInputs = path.join(repoRoot, "docs/studio/evidence/inputs");

const WORDS = JSON.parse(readFileSync(path.join(evidenceInputs, "reference-words.json"), "utf8"));
const BEATS = JSON.parse(readFileSync(path.join(evidenceInputs, "reference-beats.json"), "utf8"));

let tenantId: string;

afterAll(async () => {
  await db.$disconnect();
});

beforeEach(async () => {
  await resetDb();
  tenantId = (await seedTenant()).id;
});

function asTenant<T>(fn: () => Promise<T>, tenant: string = tenantId): Promise<T> {
  return runWithContext({ tenantId: tenant, tenantSlug: "freshworks-demo", reviewer: "reviewer@test.example" }, fn);
}

/* ------------------------------------------------------------------ fixtures */

/** A ContentBrief in `proposed`, shaped exactly as Agent B's generator writes
 *  one. Created directly because generation is upstream of this job and has
 *  its own tests; the APPROVAL below always goes through the real gate. */
async function seedContentBrief(overrides: { hookText?: string; emphasisWord?: string } = {}) {
  const hookText = overrides.hookText ?? "THE POWER OF OBSESSION";
  return db.contentBrief.create({
    data: {
      tenantId,
      briefVersionId: crypto.randomUUID(),
      claimIds: [crypto.randomUUID()],
      claimSnapshots: [
        {
          claim_id: crypto.randomUUID(),
          type: "pain_point",
          text: "Working harder than the people around you is the moment everything changes.",
          verbatim_quote: "the moment you start working harder than the people around you",
          speaker: "Founder",
          timestamp_ms: 0,
        },
      ],
      frameworkId: "double_jeopardy",
      frameworkEvidenceTier: EvidenceTier.A,
      archetype: ContentArchetype.contrarian,
      hookText,
      emphasisWord: overrides.emphasisWord ?? "OBSESSION",
      beats: [{ role: "hook", script: hookText, target_ms: 3000, fills_from: ["pain_point"] }],
      channel: ContentChannel.reels,
      contentMixSlot: ContentMixSlot.brand,
      expectedMetric: ExpectedMetric.saves,
      status: ContentBriefStatus.proposed,
      generatedByModel: "gpt-5.6-sol",
    },
  });
}

/** The global template catalog row whose `name` bridges to packages/render's
 *  TS template (see `resolveRenderTemplateId`). Unique name per call: this
 *  table has no tenant_id, so resetDb()'s tenant cascade does not clear it. */
async function seedTemplate(name = "statement_serif") {
  return db.motionTemplate.create({
    data: {
      // The (name, version) unique constraint means repeated seeds in one run
      // need distinct versions rather than distinct names — the NAME is the
      // bridge and must stay a real catalogue id.
      name,
      version: Math.floor(Math.random() * 1_000_000) + 2,
      archetype: "contrarian",
      framing: "letterbox",
      slots: {},
      fonts: {},
      grade: {},
    },
  });
}

/** Footage with a succeeded MediaAnalysis carrying the real fixture signals. */
async function seedFootage(opts: { analysis?: "succeeded" | "failed" | "none" } = {}) {
  const asset = await db.mediaAsset.create({
    data: {
      tenantId,
      kind: MediaAssetKind.footage,
      r2Key: `${tenantId}/studio/footage/${crypto.randomUUID()}.mp4`,
      contentType: "video/mp4",
      bytes: 6_995_896n,
      durationMs: Math.round(WORDS.durationSec * 1000),
      width: 1920,
      height: 1080,
      fps: 30,
    },
  });
  const mode = opts.analysis ?? "succeeded";
  if (mode !== "none") {
    await db.mediaAnalysis.create({
      data: {
        tenantId,
        assetId: asset.id,
        status: mode === "succeeded" ? MediaAnalysisStatus.succeeded : MediaAnalysisStatus.failed,
        ...(mode === "succeeded"
          ? { words: WORDS, beats: BEATS, tempoBpm: BEATS.tempoBpm, beatMethod: BEATS.method }
          : { error: "faster-whisper died" }),
        analyzerVersion: "0.2.0+faster-whisper1.1.0+librosa0.11.0+whisper-model-base",
        finishedAt: new Date(),
      },
    });
  }
  return asset;
}

/** The full upstream chain: a brief approved THROUGH THE GATE, a catalogued
 *  template, analysed footage — everything `POST /content/plans` validates
 *  before it enqueues. */
async function seedApprovedChain() {
  const brief = await seedContentBrief();
  await asTenant(() =>
    recordContentBriefDecision({ contentBriefId: brief.id, reviewer: "reviewer@test.example", action: "approve" }),
  );
  const template = await seedTemplate();
  const footage = await seedFootage();
  return {
    job: {
      tenantId,
      planId: crypto.randomUUID(),
      contentBriefId: brief.id,
      templateId: template.id,
      footageAssetId: footage.id,
    },
    brief,
    template,
    footage,
  };
}

/* ------------------------------------------------------ the definition of done */

describe("plan.build — an approved ContentBrief materializes a real RenderPlan", () => {
  it("writes the plan once, complete, at the pre-allocated id, and it passes G1a", async () => {
    const { job, brief, template, footage } = await seedApprovedChain();

    await runPlanBuild(job);

    const row = await db.renderPlan.findUnique({ where: { id: job.planId } });
    expect(row).not.toBeNull();
    expect(row!.contentBriefId).toBe(brief.id);
    expect(row!.templateId).toBe(template.id);
    expect(row!.footageAssetId).toBe(footage.id);
    expect(row!.tenantId).toBe(tenantId);
    expect(row!.planVersion).toBe("1");
    expect(row!.createdBy).toBe("job:plan.build");

    // The row is the reproducible artifact (G13): everything the render
    // consumes is ON it, so a re-render recomputes no analysis and runs no LLM.
    const plan = row!.plan as Record<string, unknown>;
    expect(plan["cuts"]).toBeInstanceOf(Array);
    expect((plan["cuts"] as unknown[]).length).toBeGreaterThan(1);
    expect(plan["captions"]).toBeInstanceOf(Array);
    expect(plan["beatGrid"]).toMatchObject({ method: "beat_track", tempoBpm: BEATS.tempoBpm });
    expect(plan["templateStyle"]).toMatchObject({ templateId: "statement_serif" });
    expect(plan["banner"]).toMatchObject({ text: "THE POWER OF OBSESSION" });
    // §12.13 row 1: continuous playthrough, so no bed and source time IS
    // output time.
    expect(plan["music"]).toBeNull();

    // ADR-8's gate, scored on the payload actually stored — not on an
    // in-memory object that might differ from what was persisted.
    const { gateG1a } = await import("@mcos/render/gates/g1a");
    const { assertValidRenderPlan } = await import("@mcos/render/plan");
    const g1a = gateG1a(assertValidRenderPlan(row!.plan, "stored plan"));
    expect(g1a.pass).toBe(true);
    expect((g1a.measured as { ratio: number }).ratio).toBeGreaterThanOrEqual(0.85);
  });

  it("locks cuts to a grid that survives into the artifact — source time IS output time", async () => {
    const { job } = await seedApprovedChain();
    await runPlanBuild(job);

    const row = await db.renderPlan.findUniqueOrThrow({ where: { id: job.planId } });
    const cuts = (row.plan as { cuts: Array<{ sourceInMs: number; outputStartMs: number }> }).cuts;

    // §12.13's legality condition for a footage-derived grid, asserted rather
    // than assumed: the instant these diverge, the embedded speech grid stops
    // describing what the viewer hears.
    for (const cut of cuts) expect(cut.outputStartMs).toBe(cut.sourceInMs);
  });

  it("is idempotent on (plan_id) — a retry after success does not throw or double-write", async () => {
    const { job } = await seedApprovedChain();
    await runPlanBuild(job);
    await expect(runPlanBuild(job)).resolves.toBeUndefined();
    expect(await db.renderPlan.count({ where: { id: job.planId } })).toBe(1);
  });

  it("derives its seed from {brief, template, footage}, so re-planning reproduces the plan", async () => {
    const { job } = await seedApprovedChain();
    await runPlanBuild(job);
    const first = await db.renderPlan.findUniqueOrThrow({ where: { id: job.planId } });

    // Same three inputs, a different pre-allocated plan id — invariant 6 says
    // a render is reproducible from {ContentBrief, template_id, footage_ref,
    // seed}, and deriving the seed makes that hold without the caller having
    // to carry one.
    const second = { ...job, planId: crypto.randomUUID() };
    await runPlanBuild(second);
    const other = await db.renderPlan.findUniqueOrThrow({ where: { id: second.planId } });

    expect(other.seed).toBe(first.seed);
    expect(JSON.stringify(other.plan)).toBe(JSON.stringify(first.plan));
  });
});

/* -------------------------------------------- §12.12a — approval at materialization */

describe("plan.build — §12.12a: the approval is re-checked at materialization", () => {
  it("refuses to build when the approval was UNDONE between enqueue and execution", async () => {
    const { job, brief } = await seedApprovedChain();

    // This is the exact sequence §12.12a names: approve → POST /content/plans
    // (which validated approval and enqueued) → undo → the job runs. Undo's
    // own guard counts MATERIALIZED plans and there is none yet, so it
    // succeeds — which is precisely why enqueue-time validation cannot be the
    // guarantee.
    await asTenant(() =>
      recordContentBriefDecision({ contentBriefId: brief.id, reviewer: "reviewer@test.example", action: "undo" }),
    );
    expect((await db.contentBrief.findUniqueOrThrow({ where: { id: brief.id } })).status).toBe(
      ContentBriefStatus.proposed,
    );

    await expect(runPlanBuild(job)).rejects.toThrow(/not approved|is proposed/i);

    // Invariant 1: nothing reached the plan table from a brief history no
    // longer agrees was approved.
    expect(await db.renderPlan.count({ where: { id: job.planId } })).toBe(0);
  });

  it("refuses to build from a brief that was REJECTED after enqueue", async () => {
    const brief = await seedContentBrief();
    const template = await seedTemplate();
    const footage = await seedFootage();
    const job = {
      tenantId,
      planId: crypto.randomUUID(),
      contentBriefId: brief.id,
      templateId: template.id,
      footageAssetId: footage.id,
    };

    await asTenant(() =>
      recordContentBriefDecision({ contentBriefId: brief.id, reviewer: "reviewer@test.example", action: "reject" }),
    );

    await expect(runPlanBuild(job)).rejects.toThrow(/not approved|is rejected/i);
    expect(await db.renderPlan.count({ where: { id: job.planId } })).toBe(0);
  });

  it("refuses to build from a brief SUPERSEDED by an edit-approve", async () => {
    const { job, brief } = await seedApprovedChain();

    // Edit-approve writes a NEW approved row and marks this one superseded.
    // A plan queued against the ORIGINAL must not build: the human approved
    // the successor's text, not this one's.
    await asTenant(() =>
      recordContentBriefDecision({
        contentBriefId: brief.id,
        reviewer: "reviewer@test.example",
        action: "edit_approve",
        edits: { hookText: "THE PRICE OF OBSESSION" },
      }),
    );

    await expect(runPlanBuild(job)).rejects.toThrow(/not approved|superseded/i);
    expect(await db.renderPlan.count({ where: { id: job.planId } })).toBe(0);
  });
});

/* ------------------------------------------------ §12.13 — the output-time grid */

describe("plan.build — §12.13: the cutting grid must be valid in OUTPUT time", () => {
  it("allows continuous playthrough against the footage's own grid", () => {
    expect(() => assertOutputTimeGrid({ removesFootage: false, gridSource: "footage_audio" })).not.toThrow();
  });

  it("allows footage removal against a music bed's grid", () => {
    expect(() => assertOutputTimeGrid({ removesFootage: true, gridSource: "music_bed" })).not.toThrow();
  });

  it("allows a music bed without removal", () => {
    expect(() => assertOutputTimeGrid({ removesFootage: false, gridSource: "music_bed" })).not.toThrow();
  });

  it("REJECTS footage removal against a source-derived grid — the invalid quadrant", () => {
    let thrown: unknown;
    try {
      assertOutputTimeGrid({ removesFootage: true, gridSource: "footage_audio" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(PlanInfeasibleError);
    expect((thrown as PlanInfeasibleError).code).toBe("invalid_grid_configuration");
    expect((thrown as Error).message).toMatch(/plan_infeasible\(invalid_grid_configuration\)/);
    // The reason has to explain itself: a UI showing only a code teaches
    // nobody why removal and the bed are coupled.
    expect((thrown as Error).message).toMatch(/output time/i);
  });

  it("rejects it through the builder too, before any planning work is done", () => {
    expect(() =>
      buildRenderPlan({
        templateId: "statement_serif",
        words: WORDS.segments.flatMap((s: { words: unknown[] }) => s.words),
        durationSec: WORDS.durationSec,
        beats: BEATS,
        seed: 42,
        hookText: "THE POWER OF OBSESSION",
        emphasisWord: "OBSESSION",
        claimTexts: ["working harder than the people around you"],
        handleText: "@PERFSTAQ",
        footage: { assetId: "a", r2Key: "k" },
        removesFootage: true,
      }),
    ).toThrow(/invalid_grid_configuration/);
  });
});

/* ------------------------------------------------------ ADR-8 — G1a before spend */

describe("plan.build — ADR-8: G1a is evaluated before the plan is persisted", () => {
  it("rejects a plan whose lock % is under the gate, with the measured number in the reason", () => {
    // A grid that no word edge in this speech can land on: 97 beats jammed
    // into the first two seconds, so every cut after that is far outside the
    // 150ms window. The planner will still return its best attempt (that is
    // what `gatePct: 0` is for); G1a is what refuses it.
    const unlockableGrid = {
      method: "beat_track" as const,
      tempoBpm: 112.347,
      beatTimesMs: Array.from({ length: 97 }, (_, i) => i * 20),
      gridQuality: 2.2934,
    };

    let thrown: unknown;
    try {
      buildApprovedRenderPlan({
        templateId: "statement_serif",
        words: WORDS.segments.flatMap((s: { words: unknown[] }) => s.words),
        durationSec: WORDS.durationSec,
        beats: unlockableGrid,
        seed: 42,
        hookText: "THE POWER OF OBSESSION",
        emphasisWord: "OBSESSION",
        claimTexts: ["working harder"],
        handleText: "@PERFSTAQ",
        footage: { assetId: "a", r2Key: "k" },
      });
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(PlanInfeasibleError);
    expect((thrown as PlanInfeasibleError).code).toBe("g1a_below_gate");
    // 03 §7: the failure has to carry the measurement, not just a verdict.
    expect((thrown as Error).message).toMatch(/%/);
    expect((thrown as PlanInfeasibleError).measured).toHaveProperty("ratio");
  });

  it("does not persist a G1a failure — a rejected plan costs no render and leaves no row", async () => {
    const { job, footage } = await seedApprovedChain();

    // Same unlockable grid, now on the real analysis row the job reads.
    await db.mediaAnalysis.update({
      where: { assetId: footage.id },
      data: { beats: { ...BEATS, beatTimesMs: Array.from({ length: 97 }, (_, i) => i * 20) } },
    });

    await expect(runPlanBuild(job)).rejects.toThrow(/g1a_below_gate/);
    expect(await db.renderPlan.count({ where: { id: job.planId } })).toBe(0);
  });

  it("uses the ONE gate — the same gateG1a the QC script imports, not a local copy", async () => {
    // §12.19: "there is exactly one ruler". If plan.build ever grew its own
    // beat-lock arithmetic, this is the test that would notice.
    const source = readFileSync(path.join(repoRoot, "apps/api/src/domain/studio/plan-builder.ts"), "utf8");
    expect(source).toMatch(/import \{ gateG1a \} from "@mcos\/render\/gates\/g1a"/);
    expect(source).not.toMatch(/150\s*\)?\s*\?/); // no local window comparison
  });
});

/* ------------------------------------------------- 03 §7 — failures say why */

describe("plan.build — failure states are named, never silent", () => {
  it("plan_infeasible(analysis_missing) when media.analyze has not succeeded", async () => {
    const brief = await seedContentBrief();
    await asTenant(() =>
      recordContentBriefDecision({ contentBriefId: brief.id, reviewer: "reviewer@test.example", action: "approve" }),
    );
    const template = await seedTemplate();
    const footage = await seedFootage({ analysis: "failed" });

    const job = {
      tenantId,
      planId: crypto.randomUUID(),
      contentBriefId: brief.id,
      templateId: template.id,
      footageAssetId: footage.id,
    };

    await expect(runPlanBuild(job)).rejects.toThrow(/plan_infeasible\(analysis_missing\)/);
    expect(await db.renderPlan.count({ where: { id: job.planId } })).toBe(0);
  });

  it("plan_infeasible(analysis_missing) when there is no MediaAnalysis at all", async () => {
    const brief = await seedContentBrief();
    await asTenant(() =>
      recordContentBriefDecision({ contentBriefId: brief.id, reviewer: "reviewer@test.example", action: "approve" }),
    );
    const template = await seedTemplate();
    const footage = await seedFootage({ analysis: "none" });

    await expect(
      runPlanBuild({
        tenantId,
        planId: crypto.randomUUID(),
        contentBriefId: brief.id,
        templateId: template.id,
        footageAssetId: footage.id,
      }),
    ).rejects.toThrow(/plan_infeasible\(analysis_missing\)/);
  });

  it("plan_infeasible(unknown_template) when the catalog row names no shipped template", async () => {
    const brief = await seedContentBrief();
    await asTenant(() =>
      recordContentBriefDecision({ contentBriefId: brief.id, reviewer: "reviewer@test.example", action: "approve" }),
    );
    // The seam Agent T's TS catalogue and this FK column meet at: a row whose
    // `name` is not a catalogued id cannot back a plan.
    const template = await seedTemplate(`vertical-standard-${crypto.randomUUID()}`);
    const footage = await seedFootage();

    await expect(
      runPlanBuild({
        tenantId,
        planId: crypto.randomUUID(),
        contentBriefId: brief.id,
        templateId: template.id,
        footageAssetId: footage.id,
      }),
    ).rejects.toThrow(/plan_infeasible\(unknown_template\)/);
  });

  it("plan_infeasible(banner_wrap) when the hook cannot fit the banner's G9 carve-out", async () => {
    expect(() =>
      buildRenderPlan({
        templateId: "statement_serif",
        words: WORDS.segments.flatMap((s: { words: unknown[] }) => s.words),
        durationSec: WORDS.durationSec,
        beats: BEATS,
        seed: 42,
        hookText: "WWWWWWWWWW ".repeat(30).trim(),
        emphasisWord: null,
        claimTexts: [],
        handleText: "@PERFSTAQ",
        footage: { assetId: "a", r2Key: "k" },
      }),
    ).toThrow(/plan_infeasible\(banner_wrap\)/);
  });

  it("plan_infeasible(footage_too_short) rather than an unhelpful planner crash", () => {
    expect(() =>
      buildRenderPlan({
        templateId: "statement_serif",
        words: [{ word: "hi", start: 0, end: 0.4 }],
        durationSec: 1.2,
        beats: BEATS,
        seed: 42,
        hookText: "SHORT",
        emphasisWord: null,
        claimTexts: [],
        handleText: "@PERFSTAQ",
        footage: { assetId: "a", r2Key: "k" },
      }),
    ).toThrow(/plan_infeasible\(footage_too_short\)/);
  });
});

/* ------------------------------------------------------- invariant 5 — tenancy */

describe("plan.build — tenant isolation", () => {
  it("cannot build a plan from another tenant's content brief", async () => {
    const { job } = await seedApprovedChain();
    const other = await db.tenant.create({ data: { slug: `other-${crypto.randomUUID()}`, name: "Other" } });

    await expect(runPlanBuild({ ...job, tenantId: other.id, planId: crypto.randomUUID() })).rejects.toThrow();
    expect(await db.renderPlan.count({ where: { tenantId: other.id } })).toBe(0);
  });
});
