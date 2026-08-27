/**
 * prove-plan-chain.ts — run the Definition-of-Done chain for real.
 *
 * 00_MASTER §6's first line is "a ContentBrief generated from a real approved
 * Brief version renders to MP4 end-to-end", and ARCHITECTURE §12.12 names the
 * middle link as the gap. A unit test proves the processor computes correctly;
 * it does not prove the chain is CONNECTED — the route, Redis, the worker
 * registration, the tenant context and the transaction are all seams a test
 * that calls the job function directly walks straight past.
 *
 * So this drives the real surfaces:
 *
 *   POST /content/briefs/:id/approve   (the real gate, over HTTP)
 *   POST /content/plans                (the real route, real validation)
 *          → real BullMQ queue on real Redis
 *          → a real Worker running the registered processor
 *          → a real RenderPlan row
 *          → G1a scored on the stored payload
 *
 * and then repeats it with an undo slipped between enqueue and execution,
 * which is §12.12a's exact sequence and the one a direct function call cannot
 * demonstrate.
 *
 * Usage (from repo root, against the test database):
 *   VITEST_DB_SUFFIX=i npx tsx scripts/studio/prove-plan-chain.ts
 */
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

// Point every module at the test database + logical Redis db before anything
// (src/env.ts freezes process.env at import).
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
const { Worker } = await import("bullmq");

const evidenceInputs = path.join(repoRoot, "docs/studio/evidence/inputs");
const WORDS = JSON.parse(readFileSync(path.join(evidenceInputs, "reference-words.json"), "utf8"));
const BEATS = JSON.parse(readFileSync(path.join(evidenceInputs, "reference-beats.json"), "utf8"));

const HOME = { "x-tenant-slug": "freshworks-demo", "x-reviewer-email": "reviewer@test.example" };

function log(step: string, detail: string): void {
  process.stdout.write(`${step.padEnd(34)} ${detail}\n`);
}

async function main(): Promise<void> {
  const app = await buildServer();
  await app.ready();

  await db.$executeRawUnsafe(`TRUNCATE TABLE "tenants" CASCADE`);
  const tenant = await db.tenant.upsert({
    where: { slug: "freshworks-demo" },
    create: { slug: "freshworks-demo", name: "Freshworks (demo)" },
    update: {},
  });
  log("tenant", tenant.id);

  // A real worker, on the real queue, running the registered processor. This
  // is the link that did not exist.
  const worker = new Worker(QUEUE.planBuild, (job) => runPlanBuild(job.data as never), {
    connection,
    concurrency: 1,
    lockDuration: 60_000,
  });
  const outcomes = new Map<string, { ok: boolean; err?: string }>();
  worker.on("completed", (job) => outcomes.set(String(job.data.planId), { ok: true }));
  worker.on("failed", (job, err) =>
    outcomes.set(String((job?.data as { planId?: string })?.planId), { ok: false, err: err.message }),
  );
  await worker.waitUntilReady();

  const template = await db.motionTemplate.upsert({
    where: { name_version: { name: "statement_serif", version: 1 } },
    create: {
      name: "statement_serif",
      version: 1,
      archetype: "A claim stated once, held long enough to land.",
      framing: "letterbox",
      slots: {},
      fonts: {},
      grade: {},
    },
    update: {},
  });

  const footage = await db.mediaAsset.create({
    data: {
      tenantId: tenant.id,
      kind: "footage",
      r2Key: `${tenant.id}/studio/footage/reference-16x9-proxy.mp4`,
      contentType: "video/mp4",
      bytes: 6_995_896n,
      durationMs: Math.round(WORDS.durationSec * 1000),
      width: 1920,
      height: 1080,
      fps: 30,
      originalName: "reference-16x9-proxy.mp4",
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
      analyzerVersion: "0.2.0+faster-whisper1.1.0+librosa0.11.0+whisper-model-base",
      finishedAt: new Date(),
    },
  });
  log("footage + analysis", `${footage.id} · ${BEATS.beatTimesMs.length} beats @ ${BEATS.tempoBpm}bpm`);

  async function seedProposedBrief(): Promise<string> {
    const brief = await db.contentBrief.create({
      data: {
        tenantId: tenant.id,
        briefVersionId: crypto.randomUUID(),
        claimIds: [crypto.randomUUID()],
        claimSnapshots: [
          {
            claim_id: crypto.randomUUID(),
            type: "pain_point",
            text: "The moment you start working harder than the people around you, everything changes.",
            verbatim_quote: "the moment you start working harder than the people around you",
            speaker: "Founder",
            timestamp_ms: 0,
          },
        ],
        frameworkId: "double_jeopardy",
        frameworkEvidenceTier: "A",
        archetype: "contrarian",
        hookText: "THE POWER OF OBSESSION",
        emphasisWord: "OBSESSION",
        beats: [{ role: "hook", script: "THE POWER OF OBSESSION", target_ms: 3000, fills_from: ["pain_point"] }],
        channel: "reels",
        contentMixSlot: "brand",
        expectedMetric: "saves",
        status: "proposed",
        generatedByModel: "gpt-5.6-sol",
      },
    });
    return brief.id;
  }

  async function http(method: "POST", url: string, payload: unknown = {}) {
    return app.inject({ method, url, headers: HOME, payload });
  }

  async function waitFor(planId: string, timeoutMs = 90_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const outcome = outcomes.get(planId);
      if (outcome) return outcome;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`timed out waiting for plan ${planId}`);
  }

  /* ---------------------------------------------- run 1: the happy chain */
  process.stdout.write("\n── run 1 · approved brief → plan.build → RenderPlan ──\n");

  const briefId = await seedProposedBrief();
  const approved = await http("POST", `/api/v1/content/briefs/${briefId}/approve`);
  log("approve (real gate, HTTP)", `${approved.statusCode} · status=${approved.json().brief.status}`);

  const planned = await http("POST", "/api/v1/content/plans", {
    content_brief_id: briefId,
    template_id: template.id,
    footage_asset_id: footage.id,
  });
  const planId = planned.json().id as string;
  log("POST /content/plans", `${planned.statusCode} · ${planned.json().status} · plan ${planId}`);

  const outcome = await waitFor(planId);
  log("worker outcome", outcome.ok ? "completed" : `FAILED: ${outcome.err}`);
  if (!outcome.ok) throw new Error(`the happy path failed: ${outcome.err}`);

  const row = await db.renderPlan.findUnique({ where: { id: planId } });
  if (!row) throw new Error("no RenderPlan row was written");
  const plan = assertValidRenderPlan(row.plan, "materialized plan");
  const g1a = gateG1a(plan);
  const m = g1a.measured as { ratio: number; withinCount: number; totalCuts: number; gridQuality: number };
  const shots = plan.cuts.map((c) => (c.outputEndMs - c.outputStartMs) / 1000).sort((a, b) => a - b);

  log("RenderPlan row", `${row.id} · seed ${row.seed} · planVersion ${row.planVersion} · by ${row.createdBy}`);
  log("cuts", `${plan.cuts.length - 1} cuts · median ${shots[shots.length >> 1]!.toFixed(2)}s · min ${shots[0]!.toFixed(2)}s`);
  log("captions", `${plan.captions.length} chunks · ${new Set(plan.captions.map((c) => c.position)).size} positions`);
  log("G1a", `${g1a.pass ? "PASS" : "FAIL"} · ${(m.ratio * 100).toFixed(2)}% (${m.withinCount}/${m.totalCuts}) · gridQuality ${m.gridQuality}`);
  log("grid (output time)", plan.cuts.every((c) => c.outputStartMs === c.sourceInMs) ? "source == output ✓" : "DIVERGED ✗");

  /* -------------------------------- run 2: §12.12a — undo between the two */
  process.stdout.write("\n── run 2 · §12.12a · approve → enqueue → UNDO → worker runs ──\n");

  // The worker is PAUSED across the enqueue/undo pair on purpose. An earlier
  // version of this script raced it and the job sometimes won — which proved
  // nothing about the guard either way, because a plan committed BEFORE the
  // undo commits was legitimately built from an approved brief. §12.12a is
  // about a specific ORDER (undo lands first, job runs second), so the script
  // has to establish that order rather than hope for it.
  await worker.pause();

  const briefId2 = await seedProposedBrief();
  await http("POST", `/api/v1/content/briefs/${briefId2}/approve`);

  // Enqueued while approved — the route's own check passes, which is the
  // whole point: enqueue-time validation is not the guarantee.
  const planned2 = await http("POST", "/api/v1/content/plans", {
    content_brief_id: briefId2,
    template_id: template.id,
    footage_asset_id: footage.id,
  });
  const planId2 = planned2.json().id as string;
  log("POST /content/plans", `${planned2.statusCode} · enqueued while approved · plan ${planId2}`);

  const undone = await http("POST", `/api/v1/content/briefs/${briefId2}/undo`);
  log("undo (real gate, HTTP)", `${undone.statusCode} · status=${undone.json().brief.status}`);

  worker.resume();
  const outcome2 = await waitFor(planId2);
  const row2 = await db.renderPlan.findUnique({ where: { id: planId2 } });
  log("worker outcome", outcome2.ok ? "completed (WRONG)" : "rejected at materialization ✓");
  log("reason", outcome2.err ?? "—");
  log("RenderPlan row", row2 ? `WRITTEN ${row2.id} — INVARIANT 1 VIOLATED ✗` : "none ✓");

  /* ------------ run 2b: the residual that belongs to content-gate.ts ------ */
  //
  // The OTHER order, which §12.12a's fix deliberately does not cover and
  // which this script found by racing: the job commits first, and the undo
  // arrives afterwards. The plan is legitimate — the brief WAS approved at
  // the instant of the write — so nothing in `plan.build` should stop it.
  // `content-gate.ts`'s undo is supposed to: it counts materialised
  // RenderPlans and refuses when one exists ("Decide again instead").
  //
  // Whether it actually refuses is a property of that module, not of this
  // one, and it is off-limits to this agent. Probed here rather than assumed,
  // because a guard nobody has exercised is a guard nobody knows the state of.
  process.stdout.write("\n── run 2b · the reverse order · plan committed, THEN undo ──\n");

  const undoAfter = await http("POST", `/api/v1/content/briefs/${briefId}/undo`);
  const briefAfter = await db.contentBrief.findUniqueOrThrow({ where: { id: briefId } });
  const plansOnIt = await db.renderPlan.count({ where: { contentBriefId: briefId } });
  log("undo after materialization", `${undoAfter.statusCode} (409 = guard held)`);
  log("brief status now", briefAfter.status);
  log("plans still attached", String(plansOnIt));
  const undoGuardHeld = undoAfter.statusCode === 409 && briefAfter.status === "approved";
  log(
    "verdict",
    undoGuardHeld
      ? "content-gate's undo guard HELD ✓"
      : "content-gate's undo guard did NOT hold — an approved-built plan now hangs off a non-approved brief",
  );

  /* ------------------------------- run 3 (opt-in): does the plan RENDER? */
  //
  // `--render <footage.mp4>` shells to the SAME entrypoint `render.submit`
  // resolves (packages/render/scripts/render-plan.mjs) with the SAME props
  // envelope it writes, differing only in `footageSrc`.
  //
  // On `footageSrc`, because the shape of it is a trap: `Reel` branches
  // `startsWith("http") || startsWith("/")` straight through to
  // `<OffthreadVideo src>` and otherwise calls `staticFile()`. A LEADING
  // SLASH IS NOT A FILESYSTEM PATH — the browser resolves it against the
  // bundle server's root, so `/Users/…/clip.mp4` 404s inside the webpack
  // bundle. Only two things actually work: an http(s) URL, or a bare
  // filename staged into `packages/render/public/`. `render.submit` uses the
  // first (a presigned R2 URL, ADR-7); this proof uses the second, because
  // R2 credentials here are stubs.
  //
  // This step has already earned its keep: it is what caught `render.submit`
  // passing a bare plan where the composition wants `{ plan, footageSrc }` —
  // a mistake that typechecks, starts the renderer, and renders nothing.
  let rendered: string | null = null;
  const renderIdx = process.argv.indexOf("--render");
  if (renderIdx >= 0 && process.argv[renderIdx + 1]) {
    const footagePath = path.resolve(process.argv[renderIdx + 1]!);
    process.stdout.write("\n── run 3 · does the materialized plan actually render? ──\n");

    const { execFileSync } = await import("node:child_process");
    const { copyFileSync, mkdirSync, mkdtempSync, writeFileSync, existsSync, statSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");

    if (!existsSync(footagePath)) throw new Error(`footage not found: ${footagePath}`);

    // Stage into packages/render/public so `staticFile()` resolves it — the
    // same gitignored scratch dir the evidence harness uses.
    const stagingDir = path.join(repoRoot, "packages/render/public");
    mkdirSync(stagingDir, { recursive: true });
    const stagedName = path.basename(footagePath);
    const staged = path.join(stagingDir, stagedName);
    if (!existsSync(staged) || statSync(staged).size !== statSync(footagePath).size) {
      copyFileSync(footagePath, staged);
    }

    const dir = mkdtempSync(path.join(tmpdir(), "prove-render-"));
    const propsPath = path.join(dir, "props.json");
    writeFileSync(propsPath, JSON.stringify({ plan, footageSrc: stagedName }));
    const outPath = path.join(dir, "render.mp4");
    const script = path.join(repoRoot, "packages/render/scripts/render-plan.mjs");

    log("renderer entrypoint", script);
    log("footage", `${footagePath} (${(statSync(footagePath).size / 1e6).toFixed(1)}MB)`);
    const started = Date.now();
    execFileSync(process.execPath, [script, "--props", propsPath, "--out", outPath, "--composition", "Reel"], {
      stdio: "inherit",
    });
    if (!existsSync(outPath)) throw new Error("renderer exited 0 but wrote no MP4");
    rendered = outPath;
    log("rendered", `${outPath} · ${(statSync(outPath).size / 1e6).toFixed(1)}MB · ${((Date.now() - started) / 1000).toFixed(0)}s`);
  }

  // `undoGuardHeld` is reported, not asserted: it is `content-gate.ts`'s
  // property, and this agent's boundary forbids fixing it there.
  const ok = !outcome2.ok && !row2 && g1a.pass;

  await worker.close();
  await app.close();
  await closeQueues();
  await db.$disconnect();

  process.stdout.write(
    `\n${ok ? "CHAIN PROVEN" : "CHAIN BROKEN"}${rendered ? ` · rendered to ${rendered}` : " · render step skipped (pass --render <footage.mp4>)"}\n`,
  );
  process.exit(ok ? 0 : 1);
}

await main();
