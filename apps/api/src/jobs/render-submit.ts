import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RenderStatus } from "@prisma/client";
import { prisma } from "../db.js";
import { env } from "../env.js";
import { presignGet, studioKeys, uploadFileToR2 } from "../integrations/studio-r2.js";
import { logger } from "../logger.js";
import { renderQcQueue, type RenderSubmitJob } from "../queue.js";
import { withTenantContext } from "./context.js";

const log = logger.child({ job: "render-submit" });

const here = path.dirname(fileURLToPath(import.meta.url));
// apps/api/src/jobs -> repo root
const repoRoot = path.resolve(here, "../../../..");

/** 03_RENDER_PIPELINE §3's render.submit timeout (queue.ts's table comment). */
const RENDER_SUBMIT_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * 03 §7's `render_failed(reason)` — surfaced on the `Render` row, never
 * silent. `reason` is the stable machine-readable half; the message is what a
 * human reads. Both land on `Render.error` alongside `failedStage='render'`,
 * which is the shape `meetings.failure_reason/failed_stage` already
 * established for M1 and which schema.prisma's own comment points at.
 */
export type RenderFailedReason =
  | "backend_unconfigured"
  | "lambda_unavailable"
  | "local_renderer_missing"
  | "render_crashed"
  | "render_timed_out"
  | "no_output";

export class RenderFailedError extends Error {
  constructor(
    readonly reason: RenderFailedReason,
    message: string,
  ) {
    super(`render_failed(${reason}): ${message}`);
    this.name = "RenderFailedError";
  }
}

/* ------------------------------------------------------------------ backends */

/**
 * ADR-7: **Remotion Lambda for product renders, local renderer for dev/CI.**
 *
 * The backend is resolved from explicit config and NEVER inferred. That is the
 * whole point of this function: the failure ADR-7 must not have is a
 * production render quietly falling back to a Fargate/CPU encode that takes
 * 10-30 minutes instead of 1-2 — a fallback like that does not look like a
 * failure, it looks like a slow day, which is exactly how it survives to
 * production. So an unset `RENDER_BACKEND` is an honest failure state, not a
 * default, and a `lambda` backend missing its credentials fails as `lambda`
 * rather than silently becoming `local`.
 */
export type LambdaBackend = { kind: "lambda"; functionName: string; serveUrl: string; region: string; bucket: string };
export type LocalBackend = { kind: "local"; script: string };
export type RenderBackend = LambdaBackend | LocalBackend;

/**
 * The return type is `LocalBackend`, not `RenderBackend`, and that is the
 * point: the Lambda arm below throws rather than returning, because the path
 * is genuinely unbuilt. Typing this as the union would let the compiler
 * pretend a Lambda backend is reachable — a small lie that would outlive
 * anyone's memory of why. When packages/render exports a Lambda submit
 * function, this signature widens to `RenderBackend` and the throw becomes a
 * return, in one place.
 */
export function resolveRenderBackend(): LocalBackend {
  const chosen = env.RENDER_BACKEND;
  if (!chosen) {
    throw new RenderFailedError(
      "backend_unconfigured",
      "RENDER_BACKEND is unset, so no renderer is configured. Set it to `lambda` (ADR-7's product path, " +
        "with REMOTION_LAMBDA_FUNCTION_NAME / _SERVE_URL / _REGION / _BUCKET) or `local` (dev/CI). It is not " +
        "defaulted on purpose: a render that silently picks a backend is a render nobody can reason about the " +
        "cost or latency of.",
    );
  }

  if (chosen === "lambda") {
    const missing = (
      [
        ["REMOTION_LAMBDA_FUNCTION_NAME", env.REMOTION_LAMBDA_FUNCTION_NAME],
        ["REMOTION_LAMBDA_SERVE_URL", env.REMOTION_LAMBDA_SERVE_URL],
        ["REMOTION_LAMBDA_REGION", env.REMOTION_LAMBDA_REGION],
        ["REMOTION_LAMBDA_BUCKET", env.REMOTION_LAMBDA_BUCKET],
      ] as const
    )
      .filter(([, value]) => !value)
      .map(([name]) => name);

    if (missing.length) {
      throw new RenderFailedError(
        "lambda_unavailable",
        `RENDER_BACKEND=lambda but ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} unset. ` +
          "This job does NOT fall back to the local renderer: a product render silently becoming a 10-30 minute " +
          "CPU encode is the failure ADR-7 exists to prevent. Configure Lambda or set RENDER_BACKEND=local " +
          "deliberately.",
      );
    }

    // The honest state of the world, stated as a failure rather than as a
    // stub that pretends to render. `@remotion/lambda` is not a dependency
    // anywhere in this repo, and ADR-5's containment guard
    // (tests/render-containment.test.ts, which names `@remotion/lambda`
    // explicitly) means it may only ever live in `packages/render` — a
    // package this agent's boundary forbids adding modules to. So the Lambda
    // submit path is UNBUILT, and this says so with the exact reason instead
    // of degrading to local behind the operator's back.
    throw new RenderFailedError(
      "lambda_unavailable",
      "the Remotion Lambda submit path is not implemented. ADR-5 confines every Remotion import to " +
        "packages/render (enforced by tests/render-containment.test.ts), that package does not depend on the " +
        "Lambda SDK, and no module there wraps it. Until packages/render exports a Lambda submit function, use " +
        "RENDER_BACKEND=local. Deliberately a hard failure, not a fallback.",
    );
  }

  const script = env.RENDER_LOCAL_SCRIPT ?? path.join(repoRoot, "packages/render/scripts/render-plan.mjs");
  if (!existsSync(script)) {
    throw new RenderFailedError(
      "local_renderer_missing",
      `RENDER_BACKEND=local but the renderer entrypoint is not at ${script} ` +
        "(set RENDER_LOCAL_SCRIPT to override). It lives in packages/render because knowing how to invoke the " +
        "renderer is renderer-specific knowledge, and ADR-5 keeps that in one directory.",
    );
  }
  return { kind: "local", script };
}

type SpawnResult = { status: number | null; stdout: string; stderr: string; timedOut: boolean };

/**
 * Promisified `spawn`, not `spawnSync` — same reasoning as render-qc.ts: a
 * sync call blocks the shared event loop long enough to starve a DIFFERENT
 * job's BullMQ lock-renewal heartbeat past its own lockDuration, which is how
 * a wedged render causes an unrelated job to be reclaimed and double-processed.
 */
function runRenderer(bin: string, args: string[]): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(bin, args, { timeout: RENDER_SUBMIT_TIMEOUT_MS, killSignal: "SIGKILL" });
    } catch (e) {
      reject(e as Error);
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({ status: code, stdout, stderr, timedOut: child.killed && signal === "SIGKILL" });
    });
  });
}

/* ----------------------------------------------------------------- the job */

/**
 * The `render.submit` job — the second half of ARCHITECTURE §12.12's missing
 * middle ("`render.submit` needs the same treatment").
 *
 * Takes a materialized `RenderPlan`, renders it, puts the MP4 in R2 and hands
 * the result to `render.qc`. Every failure is named and lands on the `Render`
 * row where the UI can read it (03 §7), and no failure is ever converted into
 * a quieter success.
 */
export async function runRenderSubmit(job: RenderSubmitJob): Promise<void> {
  await withTenantContext(job.tenantId, async () => {
    const render = await prisma.render.findUnique({
      where: { id: job.renderId },
      include: { plan: { include: { footage: true } } },
    });
    if (!render) throw new Error(`Unknown render ${job.renderId}`);

    // 03 §3: "Idempotency: dedupe on (plan_id)". A retry after a successful
    // upload must not re-render and must not re-enqueue QC.
    if (render.r2Key) {
      log.info({ renderId: render.id, r2Key: render.r2Key }, "render already has output — nothing to do");
      return;
    }

    // Resolved BEFORE any work: an unconfigured backend should cost a
    // millisecond, not a footage download.
    const backend = resolveRenderBackend();

    await prisma.render.update({
      where: { id: render.id },
      data: { status: RenderStatus.rendering, error: null, failedStage: null },
    });

    const workDir = mkdtempSync(path.join(tmpdir(), "render-submit-"));
    try {
      // "Plan-as-props": the composition's ONLY source of timing is the plan
      // row (03 §4). Nothing is recomputed here — the render is reproducible
      // from the plan alone (G13).
      //
      // The props envelope is `{ plan, footageSrc }`, NOT a bare plan. The
      // plan carries the footage's `assetId` and `r2Key`, but the composition
      // cannot open an R2 key — it needs something `<OffthreadVideo>` can
      // fetch, and the key deliberately is not that. So the plan stays the
      // frozen artifact and the fetchable location is supplied per render.
      //
      // This is worth stating because it is a mistake that typechecks: a bare
      // plan is valid JSON, the renderer starts, and the composition gets
      // `plan: undefined`. It cost a render to find.
      const { url: footageSrc } = await presignGet(render.plan.footage.r2Key, RENDER_SUBMIT_TIMEOUT_MS / 1000);
      const propsPath = path.join(workDir, "props.json");
      writeFileSync(propsPath, JSON.stringify({ plan: render.plan.plan, footageSrc }));

      const outPath = path.join(workDir, "render.mp4");

      log.info({ renderId: render.id, planId: render.planId, backend: backend.kind }, "submitting render");
      const result = await runRenderer(process.execPath, [
        backend.script,
        "--props",
        propsPath,
        "--out",
        outPath,
        "--composition",
        "Reel",
      ]);

      if (result.timedOut) {
        throw new RenderFailedError(
          "render_timed_out",
          `the renderer was killed after ${RENDER_SUBMIT_TIMEOUT_MS}ms without producing an MP4.`,
        );
      }
      if (result.status !== 0) {
        throw new RenderFailedError(
          "render_crashed",
          `the renderer exited ${result.status}: ${(result.stderr || result.stdout).slice(-2000).trim()}`,
        );
      }
      if (!existsSync(outPath)) {
        throw new RenderFailedError(
          "no_output",
          "the renderer exited 0 but wrote no MP4 — treated as a failure rather than an empty success.",
        );
      }

      const r2Key = studioKeys.render(job.tenantId, render.id);
      const uploaded = await uploadFileToR2({ filePath: outPath, key: r2Key, contentType: "video/mp4" });

      // From the plan, not from ffprobe: the plan IS the duration contract
      // (03 §4, "no component computes its own timing"), and a probe here
      // would be a second opinion nothing needs. QC measures the artifact.
      const { durationInFrames, fps } = render.plan.plan as unknown as { durationInFrames: number; fps: number };
      const durationMs = Math.round((durationInFrames / fps) * 1000);

      await prisma.render.update({
        where: { id: render.id },
        data: { status: RenderStatus.qc, r2Key, bytes: BigInt(uploaded.bytes), durationMs },
      });

      // The MP4 exists; QC is a separate stage with its own image and its own
      // failure vocabulary (`qc_failed(metric, value)`), so it gets its own
      // job rather than being inlined here.
      await renderQcQueue.add("qc", { tenantId: job.tenantId, renderId: render.id });

      log.info(
        { renderId: render.id, backend: backend.kind, r2Key, bytes: uploaded.bytes, durationMs },
        "render submitted and queued for QC",
      );
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
}

/**
 * Records the failure on the `Render` row. Called on a permanent BullMQ
 * failure (see worker.ts) and never throws itself — a failure to record a
 * failure must not mask the original error. Mirrors `failRenderQc`.
 *
 * `failedStage: "render"` + a `render_failed(reason)` message is exactly what
 * `GET /content/renders/:id` already serializes, so the reason reaches the UI
 * without a new surface.
 */
export async function failRenderSubmit(job: RenderSubmitJob, error: Error): Promise<void> {
  await withTenantContext(job.tenantId, async () => {
    await prisma.render
      .update({
        where: { id: job.renderId },
        data: {
          status: RenderStatus.failed,
          failedStage: "render",
          error:
            error instanceof RenderFailedError ? error.message : `render_failed(render_crashed): ${error.message}`,
          finishedAt: new Date(),
        },
      })
      .catch((e: unknown) => {
        log.error({ err: (e as Error).message }, "could not record render-submit failure");
      });
  });
}
