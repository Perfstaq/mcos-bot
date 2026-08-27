import crypto from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MediaAssetKind, RenderStatus } from "@prisma/client";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb, seedTenant } from "./helpers.js";

/**
 * `render.submit` — ADR-7's execution stage.
 *
 * The property under test is mostly a NEGATIVE one, and that is deliberate.
 * ADR-7 splits execution into "Remotion Lambda for product renders, local
 * renderer for dev/CI", and the failure that decision must not have is a
 * product render quietly becoming a 10-30 minute CPU encode because Lambda
 * was misconfigured. A fallback like that does not look like a failure — it
 * looks like a slow day — which is exactly how it survives to production. So
 * most of this file asserts that the job REFUSES rather than degrades, and
 * that every refusal names its own reason (03 §7).
 *
 * `env` is re-imported per test because `src/env.ts` validates and freezes
 * `process.env` at module load; `vi.resetModules()` is what lets one test see
 * a different backend configuration from the next.
 */

let tenantId: string;
let workDir: string;

afterAll(async () => {
  await db.$disconnect();
});

beforeEach(async () => {
  vi.resetModules();
  await resetDb();
  tenantId = (await seedTenant()).id;
  workDir = mkdtempSync(path.join(tmpdir(), "render-submit-test-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  delete process.env.RENDER_BACKEND;
  delete process.env.RENDER_LOCAL_SCRIPT;
  delete process.env.REMOTION_LAMBDA_FUNCTION_NAME;
  delete process.env.REMOTION_LAMBDA_SERVE_URL;
  delete process.env.REMOTION_LAMBDA_REGION;
  delete process.env.REMOTION_LAMBDA_BUCKET;
});

/** The minimum a `Render` needs to exist: a plan row, which needs a brief,
 *  a template and footage. The plan payload is deliberately thin — this file
 *  is about execution and failure surfacing, not about plan contents
 *  (plan-build.test.ts owns those). */
async function seedRender(): Promise<{ renderId: string; planId: string }> {
  const brief = await db.contentBrief.create({
    data: {
      tenantId,
      briefVersionId: crypto.randomUUID(),
      claimIds: [crypto.randomUUID()],
      claimSnapshots: [],
      frameworkId: "double_jeopardy",
      frameworkEvidenceTier: "A",
      archetype: "contrarian",
      hookText: "THE POWER OF OBSESSION",
      emphasisWord: "OBSESSION",
      beats: [],
      channel: "reels",
      contentMixSlot: "brand",
      expectedMetric: "saves",
      status: "approved",
      generatedByModel: "gpt-5.6-sol",
      decidedAt: new Date(),
    },
  });
  const template = await db.motionTemplate.create({
    data: {
      name: "statement_serif",
      version: Math.floor(Math.random() * 1_000_000) + 2,
      archetype: "contrarian",
      framing: "letterbox",
      slots: {},
      fonts: {},
      grade: {},
    },
  });
  const footage = await db.mediaAsset.create({
    data: {
      tenantId,
      kind: MediaAssetKind.footage,
      r2Key: `${tenantId}/studio/footage/${crypto.randomUUID()}.mp4`,
      contentType: "video/mp4",
      bytes: 100n,
    },
  });
  const plan = await db.renderPlan.create({
    data: {
      tenantId,
      contentBriefId: brief.id,
      templateId: template.id,
      footageAssetId: footage.id,
      plan: { planVersion: "1", fps: 30, durationInFrames: 1590, cuts: [], captions: [] },
      seed: 42,
      planVersion: "1",
      createdBy: "test",
    },
  });
  const render = await db.render.create({ data: { tenantId, planId: plan.id } });
  return { renderId: render.id, planId: plan.id };
}

async function loadJob() {
  return import("../src/jobs/render-submit.js");
}

/* --------------------------------------------- ADR-7: the backend is explicit */

describe("render.submit — the backend is chosen explicitly, never inferred", () => {
  it("render_failed(backend_unconfigured) when RENDER_BACKEND is unset", async () => {
    const { renderId } = await seedRender();
    const { runRenderSubmit } = await loadJob();

    await expect(runRenderSubmit({ tenantId, renderId })).rejects.toThrow(
      /render_failed\(backend_unconfigured\)/,
    );

    // It must not have started: no status churn on a job that never ran.
    const render = await db.render.findUniqueOrThrow({ where: { id: renderId } });
    expect(render.r2Key).toBeNull();
  });

  it("render_failed(lambda_unavailable) naming EVERY missing Lambda variable", async () => {
    process.env.RENDER_BACKEND = "lambda";
    const { resolveRenderBackend } = await loadJob();

    let thrown: Error | undefined;
    try {
      resolveRenderBackend();
    } catch (e) {
      thrown = e as Error;
    }

    expect(thrown?.message).toMatch(/render_failed\(lambda_unavailable\)/);
    for (const name of [
      "REMOTION_LAMBDA_FUNCTION_NAME",
      "REMOTION_LAMBDA_SERVE_URL",
      "REMOTION_LAMBDA_REGION",
      "REMOTION_LAMBDA_BUCKET",
    ]) {
      expect(thrown?.message).toContain(name);
    }
  });

  it("does NOT silently fall back to the local renderer when Lambda is misconfigured", async () => {
    // The whole point of ADR-7's split. A local script that would work is
    // available, and the job must still refuse: a product render becoming a
    // CPU encode behind the operator's back is the failure this prevents.
    const script = path.join(workDir, "renderer.mjs");
    writeFileSync(script, "process.exit(0)");
    process.env.RENDER_LOCAL_SCRIPT = script;
    process.env.RENDER_BACKEND = "lambda";
    process.env.REMOTION_LAMBDA_FUNCTION_NAME = "remotion-render";
    process.env.REMOTION_LAMBDA_SERVE_URL = "https://example.invalid/site";
    process.env.REMOTION_LAMBDA_REGION = "us-east-1";
    process.env.REMOTION_LAMBDA_BUCKET = "remotionlambda-useast1-abc";

    const { resolveRenderBackend } = await loadJob();

    let thrown: Error | undefined;
    try {
      resolveRenderBackend();
    } catch (e) {
      thrown = e as Error;
    }
    // Fully configured, and it still refuses — because the Lambda submit path
    // is genuinely unbuilt (ADR-5 confines @remotion/lambda to
    // packages/render, which ships no such module). An honest hard failure,
    // not a stub that pretends to render.
    expect(thrown?.message).toMatch(/render_failed\(lambda_unavailable\)/);
    expect(thrown?.message).toMatch(/not implemented/i);
    // And it says so as `lambda`, never as a local success: the reason a
    // reader gets must be about Lambda, not about the renderer that happened
    // to be reachable.
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as { reason?: string }).reason).toBe("lambda_unavailable");
  });

  it("render_failed(local_renderer_missing) when the local entrypoint is not there", async () => {
    process.env.RENDER_BACKEND = "local";
    process.env.RENDER_LOCAL_SCRIPT = path.join(workDir, "does-not-exist.mjs");
    const { resolveRenderBackend } = await loadJob();

    expect(() => resolveRenderBackend()).toThrow(/render_failed\(local_renderer_missing\)/);
  });

  it("resolves the local backend to packages/render's entrypoint by default", async () => {
    process.env.RENDER_BACKEND = "local";
    const { resolveRenderBackend } = await loadJob();

    const backend = resolveRenderBackend();
    expect(backend.kind).toBe("local");
    // ADR-5: only packages/render may know how to invoke the renderer.
    expect(backend.script).toMatch(/packages\/render\/scripts\/render-plan\.mjs$/);
  });
});

/* ------------------------------------------- 03 §7: failures land on the row */

describe("render.submit — every failure is named on the Render row", () => {
  it("render_crashed carries the renderer's own stderr, not a generic message", async () => {
    const { renderId } = await seedRender();
    const script = path.join(workDir, "renderer.mjs");
    writeFileSync(script, `process.stderr.write("Composition Reel not found"); process.exit(3);`);
    process.env.RENDER_BACKEND = "local";
    process.env.RENDER_LOCAL_SCRIPT = script;

    const { runRenderSubmit, failRenderSubmit } = await loadJob();

    const error = await runRenderSubmit({ tenantId, renderId }).catch((e: Error) => e);
    expect((error as Error).message).toMatch(/render_failed\(render_crashed\)/);
    expect((error as Error).message).toContain("Composition Reel not found");

    await failRenderSubmit({ tenantId, renderId }, error as Error);

    const render = await db.render.findUniqueOrThrow({ where: { id: renderId } });
    expect(render.status).toBe(RenderStatus.failed);
    expect(render.failedStage).toBe("render");
    expect(render.error).toContain("Composition Reel not found");
    expect(render.finishedAt).not.toBeNull();
  });

  it("render_failed(no_output) when the renderer exits 0 but writes no MP4", async () => {
    const { renderId } = await seedRender();
    const script = path.join(workDir, "renderer.mjs");
    // The quiet failure: a zero exit is not evidence of an artifact.
    writeFileSync(script, "process.exit(0)");
    process.env.RENDER_BACKEND = "local";
    process.env.RENDER_LOCAL_SCRIPT = script;

    const { runRenderSubmit } = await loadJob();
    await expect(runRenderSubmit({ tenantId, renderId })).rejects.toThrow(/render_failed\(no_output\)/);
  });

  it("a backend_unconfigured failure is recorded where GET /content/renders/:id can read it", async () => {
    const { renderId } = await seedRender();
    const { runRenderSubmit, failRenderSubmit } = await loadJob();

    const error = await runRenderSubmit({ tenantId, renderId }).catch((e: Error) => e);
    await failRenderSubmit({ tenantId, renderId }, error as Error);

    const render = await db.render.findUniqueOrThrow({ where: { id: renderId } });
    expect(render.status).toBe(RenderStatus.failed);
    expect(render.failedStage).toBe("render");
    // The reason has to be readable by a person, not just a code.
    expect(render.error).toMatch(/RENDER_BACKEND is unset/);
  });
});

/* ------------------------------------------------------ the props envelope */

describe("render.submit — the props the composition actually receives", () => {
  /**
   * This test exists because the bug it catches TYPECHECKS. `Reel` takes
   * `{ plan, footageSrc }`; passing the bare plan is valid JSON, the renderer
   * starts happily, and the composition gets `plan: undefined`. Nothing in a
   * unit test or a `tsc` run can see it — it took an actual render.
   *
   * So the fake renderer here reads the props file the job wrote and reports
   * its shape, which is the only place the contract is observable from.
   */
  it("passes { plan, footageSrc } — not a bare plan", async () => {
    const { renderId } = await seedRender();
    const captured = path.join(workDir, "captured-props.json");
    const script = path.join(workDir, "renderer.mjs");
    writeFileSync(
      script,
      `import { readFileSync, writeFileSync } from "node:fs";
       const i = process.argv.indexOf("--props");
       writeFileSync(${JSON.stringify(captured)}, readFileSync(process.argv[i + 1], "utf8"));
       process.exit(0);`,
    );
    process.env.RENDER_BACKEND = "local";
    process.env.RENDER_LOCAL_SCRIPT = script;

    const { runRenderSubmit } = await loadJob();
    // It fails at `no_output` (the fake renderer writes no MP4), which is
    // after the props were written — exactly the point we want to inspect.
    await expect(runRenderSubmit({ tenantId, renderId })).rejects.toThrow(/no_output/);

    const props = JSON.parse(readFileSync(captured, "utf8")) as { plan?: unknown; footageSrc?: unknown };
    expect(props.plan).toBeTypeOf("object");
    expect(props.plan).toHaveProperty("planVersion", "1");
    // The composition cannot open an R2 key; it needs something
    // <OffthreadVideo> can fetch. ADR-7: "feeds presigned R2 URLs in".
    expect(props.footageSrc).toBeTypeOf("string");
    expect(String(props.footageSrc)).toMatch(/^https?:\/\//);
    expect(String(props.footageSrc)).toContain("X-Amz-Signature");
  });
});

/* --------------------------------------------------------------- idempotency */

describe("render.submit — idempotency", () => {
  it("does nothing when the render already has output", async () => {
    const { renderId } = await seedRender();
    await db.render.update({
      where: { id: renderId },
      data: { r2Key: `${tenantId}/studio/renders/${renderId}.mp4`, status: RenderStatus.qc },
    });
    // No backend configured: if the job did any work it would throw
    // backend_unconfigured, so resolving cleanly proves it short-circuited.
    const { runRenderSubmit } = await loadJob();
    await expect(runRenderSubmit({ tenantId, renderId })).resolves.toBeUndefined();
  });
});
