/**
 * w4-chain.ts — W4.1: drive the real gate + real plan.build against the
 * locked-off talking-head fixture (ARCHITECTURE §12.18's missing footage).
 *
 * Deliberately mirrors scripts/studio/prove-plan-chain.ts: real HTTP routes,
 * real Redis, a real registered processor, real rows. Nothing is faked past
 * the gate.
 *
 * Usage (repo root):
 *   VITEST_DB_SUFFIX=w4 npx tsx <this file> --words <words.json> --beats <beats.json>
 */
import crypto from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const outDir = process.argv[process.argv.indexOf("--out") + 1] ?? ".";

const { applyTestEnv } = (await import(
  path.join(repoRoot, "apps/api/tests/setup/test-env.ts")
)) as typeof import("../../apps/api/tests/setup/test-env.js");
applyTestEnv();

const { PrismaClient } = await import("@prisma/client");
const { testDatabaseUrl } = await import("../../apps/api/tests/setup/test-env.js");
const db = new PrismaClient({ datasourceUrl: testDatabaseUrl() });

const { buildServer } = await import("../../apps/api/src/server.js");
const { QUEUE, connection, closeQueues } = await import("../../apps/api/src/queue.js");
const { runPlanBuild } = await import("../../apps/api/src/jobs/plan-build.js");
const { gateG1a } = await import("@mcos/render/gates/g1a");
const { assertValidRenderPlan } = await import("@mcos/render/plan");
const { TEMPLATES, TEMPLATE_IDS } = await import("@mcos/render/templates");
const { Worker } = await import("bullmq");

const WORDS_PATH = process.argv[process.argv.indexOf("--words") + 1]!;
const BEATS_PATH = process.argv[process.argv.indexOf("--beats") + 1]!;
const WORDS = JSON.parse(readFileSync(WORDS_PATH, "utf8"));
const BEATS = JSON.parse(readFileSync(BEATS_PATH, "utf8"));

const HOME = { "x-tenant-slug": "freshworks-demo", "x-reviewer-email": "reviewer@test.example" };

// ── The fixture, measured. ──────────────────────────────────────────────────
// The MASTER carries `rotation=-90`: its stream says 3840x2160 while every
// decoder (cv2, ffmpeg, Chromium) delivers 2160x3840. The proxy was built
// through ffmpeg, so the rotation is already baked into its pixels and its
// stream reports 1080x1920 with no side data. Either way the row records what
// the PIXELS are, never what ffprobe's raw stream fields say — which is the
// distinction the first ingest path will have to get right (§12.40).
const FIXTURE = {
  // The 1080x1920 proxy, not the 4K master: the content region is 1080px wide
  // and the master is 2160, so the downscale is lossless FOR THIS PIPELINE and
  // it is what makes the render fit the disk budget. Inverse of §12.18's
  // upscaling complaint. Master sha256 7dbc78be…17aa1.
  path: "/Users/sathvik/aix/studio-assets/talking-head-v1-1080.mp4",
  sha256: "dd17a3609eca17ea613babf9c32f4892cc213e0edc20bf26fb38c719185af7b6",
  bytes: 85125521n,
  // Container duration (59.656437s), not the audio stream's 59.605 — plan-build
  // explicitly prefers the container, and the tail is silent.
  durationMs: 59656,
  width: 1080,
  height: 1920,
  // avg_frame_rate = 160920000/5362367. `r_frame_rate` is 120/1 and is a LIE.
  fps: 30.008,
};

function log(step: string, detail: string): void {
  process.stdout.write(`${step.padEnd(32)} ${detail}\n`);
}

async function main(): Promise<void> {
  const app = await buildServer();
  await app.ready();

  await db.$executeRawUnsafe(`TRUNCATE TABLE "tenants" CASCADE`);
  await db.$executeRawUnsafe(`TRUNCATE TABLE "motion_templates" CASCADE`);
  const tenant = await db.tenant.upsert({
    where: { slug: "freshworks-demo" },
    create: { slug: "freshworks-demo", name: "Freshworks (demo)" },
    update: {},
  });
  log("tenant", tenant.id);

  const worker = new Worker(QUEUE.planBuild, (job) => runPlanBuild(job.data as never), {
    connection,
    concurrency: 1,
    lockDuration: 120_000,
  });
  const outcomes = new Map<string, { ok: boolean; err?: string }>();
  worker.on("completed", (job) => outcomes.set(String(job.data.planId), { ok: true }));
  worker.on("failed", (job, err) =>
    outcomes.set(String((job?.data as { planId?: string })?.planId), { ok: false, err: err.message }),
  );
  await worker.waitUntilReady();

  // Templates (fixture seed — not memory; see seed-templates.ts's header).
  const templateRows: Record<string, string> = {};
  for (const id of TEMPLATE_IDS) {
    const t = (TEMPLATES as unknown as Record<string, unknown>)[id] as {
      id: string; version: number; archetype: string; framing: "letterbox";
      rhythm: unknown; typography: unknown; grade: unknown;
    };
    const row = await db.motionTemplate.upsert({
      where: { name_version: { name: t.id, version: t.version } },
      create: {
        name: t.id, version: t.version, archetype: t.archetype, framing: t.framing,
        slots: t.rhythm as never, fonts: t.typography as never, grade: t.grade as never, active: true,
      },
      update: { active: true },
    });
    templateRows[id] = row.id;
  }
  log("templates seeded", Object.keys(templateRows).join(", "));

  // ── The footage asset, with POST-ROTATION dimensions ──────────────────────
  const footage = await db.mediaAsset.create({
    data: {
      tenantId: tenant.id,
      kind: "footage",
      r2Key: `${tenant.id}/studio/footage/talking-head-v1-1080.mp4`,
      contentType: "video/mp4",
      bytes: FIXTURE.bytes,
      checksum: `sha256:${FIXTURE.sha256}`,
      durationMs: FIXTURE.durationMs,
      width: FIXTURE.width,
      height: FIXTURE.height,
      fps: FIXTURE.fps,
      originalName: "talking-head-v1-1080.mp4",
    },
  });
  await db.mediaAnalysis.create({
    data: {
      tenantId: tenant.id,
      assetId: footage.id,
      status: "succeeded",
      words: WORDS,
      beats: BEATS,
      tempoBpm: BEATS.tempoBpm,
      beatMethod: BEATS.method,
      analyzerVersion: "studio-analyzer@0.3.0+faster-whisper1.2.1+librosa0.11.0+whisper-model-base",
      finishedAt: new Date(),
    },
  });
  log("footage asset", `${footage.id} · ${FIXTURE.width}x${FIXTURE.height} @ ${FIXTURE.fps}fps`);
  log("analysis", `${BEATS.beatTimesMs.length} beats @ ${BEATS.tempoBpm}bpm · ${WORDS.segments.reduce((n: number, s: { words: unknown[] }) => n + s.words.length, 0)} words`);

  async function http(url: string, payload: Record<string, unknown> = {}) {
    return app.inject({ method: "POST", url, headers: HOME, payload });
  }

  async function waitFor(planId: string, timeoutMs = 180_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const o = outcomes.get(planId);
      if (o) return o;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`timed out waiting for plan ${planId}`);
  }

  /* ── the ContentBrief ─────────────────────────────────────────────────── */
  process.stdout.write("\n── ContentBrief through the REAL gate ──\n");

  // Try the real generation route first. It needs a live LLM; when that is
  // unavailable we fall back to a PROPOSED row and still approve it through
  // the real gate endpoint — the gate governs the transition to `approved`,
  // which is the invariant, and that transition is never faked here.
  let briefId: string | null = null;
  let provenance = "";
  const gen = await http("/api/v1/content/briefs", { channel: "reels", count: 3 });
  if (gen.statusCode === 200) {
    const briefs = gen.json().briefs as { id: string; status: string }[];
    briefId = briefs[0]!.id;
    provenance = `generated via POST /content/briefs (${briefs.length} briefs, all ${briefs[0]!.status})`;
  } else {
    const reason = String(gen.json()?.message ?? gen.statusCode).slice(0, 120);
    const brief = await db.contentBrief.create({
      data: {
        tenantId: tenant.id,
        briefVersionId: crypto.randomUUID(),
        claimIds: [crypto.randomUUID()],
        claimSnapshots: [
          {
            claim_id: crypto.randomUUID(),
            type: "pain_point",
            text: "Gravity is one of the reasons we age, because humans stand upright and blood has to fight to reach the brain.",
            verbatim_quote: "he believes gravity might be one of the reasons we age because humans stand upright",
            speaker: "Founder",
            timestamp_ms: 40700,
          },
        ],
        frameworkId: "double_jeopardy",
        frameworkEvidenceTier: "A",
        archetype: "contrarian",
        hookText: "GRAVITY IS AGEING YOU",
        emphasisWord: "AGEING",
        beats: [{ role: "hook", script: "GRAVITY IS AGEING YOU", target_ms: 3000, fills_from: ["pain_point"] }],
        channel: "reels",
        contentMixSlot: "brand",
        expectedMetric: "saves",
        status: "proposed",
        generatedByModel: "gpt-5.6-sol",
      },
    });
    briefId = brief.id;
    provenance = `seeded PROPOSED (generation unavailable: ${reason}); approval still through the real gate`;
  }
  log("brief provenance", provenance);

  const approved = await http(`/api/v1/content/briefs/${briefId}/approve`);
  if (approved.statusCode !== 200) throw new Error(`approve failed: ${approved.statusCode} ${approved.body}`);
  log("approve (real gate, HTTP)", `${approved.statusCode} · status=${approved.json().brief.status}`);

  const decisions = await db.contentBriefDecision.findMany({ where: { contentBriefId: briefId } });
  log("ContentBriefDecision rows", `${decisions.length} · ${decisions.map((d) => d.action).join(",")} by ${decisions[0]?.reviewer ?? "—"}`);
  const briefRow = await db.contentBrief.findUniqueOrThrow({ where: { id: briefId } });
  log("brief", `${briefId} · ${briefRow.status} · hook "${briefRow.hookText}" · emph ${briefRow.emphasisWord}`);

  /* ── three plans, one per template, through the real chain ────────────── */
  mkdirSync(outDir, { recursive: true });
  const summary: Record<string, unknown> = {};
  for (const id of TEMPLATE_IDS) {
    process.stdout.write(`\n── plan.build · ${id} ──\n`);
    const posted = await http("/api/v1/content/plans", {
      content_brief_id: briefId,
      template_id: templateRows[id],
      footage_asset_id: footage.id,
    });
    const planId = posted.json().id as string;
    log("POST /content/plans", `${posted.statusCode} · ${posted.json().status} · ${planId}`);

    const outcome = await waitFor(planId);
    if (!outcome.ok) {
      log("worker outcome", `FAILED: ${outcome.err}`);
      const attempt = await db.renderAttempt.findUnique({ where: { id: planId } });
      log("attempt row", `${attempt?.status} · ${attempt?.failureCode} · ${attempt?.failureMessage?.slice(0, 140)}`);
      summary[id] = { failed: true, reason: attempt?.failureMessage ?? outcome.err };
      continue;
    }

    const row = await db.renderPlan.findUnique({ where: { id: planId } });
    if (!row) throw new Error(`no RenderPlan row for ${id}`);
    const plan = assertValidRenderPlan(row.plan, `${id} plan`);
    const g1a = gateG1a(plan);
    const m = g1a.measured as { ratio: number; withinCount: number; totalCuts: number; gridQuality: number };
    const shots = plan.cuts.map((c) => (c.outputEndMs - c.outputStartMs) / 1000).sort((a, b) => a - b);
    const continuous = plan.cuts.every((c) => c.outputStartMs === c.sourceInMs);

    const planPath = path.join(outDir, `${id}.plan.json`);
    writeFileSync(planPath, JSON.stringify(plan, null, 2));

    log("RenderPlan row", `${row.id} · seed ${row.seed} · by ${row.createdBy}`);
    log("cuts", `${plan.cuts.length - 1} cuts · median ${shots[shots.length >> 1]!.toFixed(2)}s · min ${shots[0]!.toFixed(2)}s`);
    log("captions", `${plan.captions.length} chunks · ${new Set(plan.captions.map((c) => c.position)).size} positions`);
    log("G1a", `${g1a.pass ? "PASS" : "FAIL"} · ${(m.ratio * 100).toFixed(2)}% (${m.withinCount}/${m.totalCuts})`);
    log("grid (output time)", continuous ? "source == output ✓ (continuous)" : "DIVERGED ✗");
    log("plan written", planPath);

    summary[id] = {
      planId, cuts: plan.cuts.length - 1, medianShot: shots[shots.length >> 1],
      minShot: shots[0], captions: plan.captions.length,
      positions: new Set(plan.captions.map((c) => c.position)).size,
      g1a: { pass: g1a.pass, ratio: m.ratio, locked: `${m.withinCount}/${m.totalCuts}` },
      continuous, planPath, durationInFrames: plan.durationInFrames,
    };
  }

  writeFileSync(path.join(outDir, "chain-summary.json"), JSON.stringify({
    tenantId: tenant.id, footageAssetId: footage.id, briefId, provenance,
    fixture: { ...FIXTURE, bytes: String(FIXTURE.bytes) }, templates: summary,
  }, null, 2));

  await worker.close();
  await closeQueues();
  await app.close();
  await db.$disconnect();
  process.stdout.write("\nchain complete\n");
}

await main();
