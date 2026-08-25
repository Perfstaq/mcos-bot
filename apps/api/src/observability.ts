import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { rawPrisma } from "./db.js";
import { env } from "./env.js";
import { allQueues, newRedis } from "./queue.js";

/**
 * Operating this thing at 3am.
 *
 * Three separate concerns live here because they answer the same question —
 * "is this deploy healthy, and if not, which part broke?" — and splitting them
 * across three files would mean three places to look:
 *
 *   1. Request correlation. One id follows a request through the ALB, the API
 *      log lines and the error handler, and comes back on the response so a
 *      user can paste it into a ticket.
 *   2. Liveness vs readiness. `/healthz` (already in server.ts) answers "is
 *      this process alive". `/readyz` answers "should the load balancer send
 *      it traffic", which is a different and stricter question — see below.
 *   3. The four numbers that actually page someone. Not a metrics framework:
 *      four counters and a queue depth, emitted as CloudWatch Embedded Metric
 *      Format lines on stdout, which is where the ECS awslogs driver is
 *      already looking.
 *
 * Nothing in this file mounts itself. `registerObservability(app)` is called
 * by server.ts, and the counters are incremented by the two call sites that
 * own the failures — see the integration notes on each export.
 */

/* -------------------------------------------------------------------------
 * Request correlation
 * ---------------------------------------------------------------------- */

export const REQUEST_ID_HEADER = "x-request-id";

/** The ALB stamps this on every request it forwards; it is the join key
 *  between our logs and the ALB access logs in S3. */
const TRACE_HEADER = "x-amzn-trace-id";

/**
 * A client-supplied correlation id is untrusted input like any other header:
 * it ends up in every log line for the request, so an unbounded value is a log
 * injection vector and a storage bill. Anything that is not a short, boring
 * token is replaced rather than sanitised — a rewritten id would silently
 * break the caller's correlation while looking like it worked.
 */
const SAFE_ID = /^[A-Za-z0-9_.:=@/-]{1,128}$/;

function safeHeader(request: FastifyRequest, name: string): string | null {
  const raw = request.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  const trimmed = value.trim();
  return SAFE_ID.test(trimmed) ? trimmed : null;
}

/**
 * Pass to `Fastify({ genReqId })` so pino's own `reqId` is the propagated id
 * rather than a second, unrelated counter. Optional — `registerObservability`
 * does not depend on it — but without it the built-in "incoming request" line
 * carries a different id from every line after it.
 */
export function genReqId(req: { headers: Record<string, string | string[] | undefined> }): string {
  const raw = req.headers[REQUEST_ID_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = value?.trim();
  return trimmed && SAFE_ID.test(trimmed) ? trimmed : crypto.randomUUID();
}

declare module "fastify" {
  interface FastifyRequest {
    /** Propagated or minted correlation id. Always set once the hook has run. */
    requestId?: string;
  }
}

/* -------------------------------------------------------------------------
 * Metrics
 * ---------------------------------------------------------------------- */

/**
 * The whole metric surface. A closed union rather than a free-form string so a
 * typo at a call site is a compile error instead of a metric that silently
 * never fires — which is the failure mode that matters, because a counter
 * nobody increments looks exactly like a system with no failures.
 */
export type CounterName =
  | "WebhookVerificationFailures"
  | "WebhookDuplicates"
  | "ExtractionFailures"
  | "ExtractionClaimsDropped"
  | "JobFailures";

const counters = new Map<CounterName, number>();

export function increment(name: CounterName, by = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + by);
}

/**
 * A rejected webhook is the highest-signal event this system produces: it means
 * either Recall rotated the workspace secret, or somebody is posting forged
 * payloads at the endpoint. Both are pages, and they are indistinguishable from
 * the counter alone, which is why the reason is logged alongside it.
 *
 * INTEGRATOR: call from the `!verification.ok` branch of
 * `routes/webhooks.ts`, next to the existing `request.log.warn`.
 */
export function recordWebhookVerificationFailure(reason: string): void {
  increment("WebhookVerificationFailures");
  emitLog("warn", "webhook verification failed", { reason });
}

/**
 * Extraction failing is not the same as extraction dropping claims. A failure
 * means the run errored and the meeting is stuck before the review queue; a
 * drop means the model cited a segment that does not exist and the evidence
 * gate did its job. The first pages, the second is a quality signal that only
 * matters as a rate — so they are separate counters.
 *
 * INTEGRATOR: call `recordExtractionFailure` from `failExtraction` in
 * `jobs/extract.ts`, and `recordExtractionDrops` where `droppedCount` is
 * written on the run.
 */
export function recordExtractionFailure(meetingId: string, error: string): void {
  increment("ExtractionFailures");
  emitLog("error", "extraction failed", { meetingId, error });
}

export function recordExtractionDrops(meetingId: string, dropped: number): void {
  if (dropped <= 0) return;
  increment("ExtractionClaimsDropped", dropped);
}

/**
 * INTEGRATOR: call from the `failed` handler in `worker.ts`, guarded on the
 * same `final` check that decides whether to mark the meeting failed. A
 * retried job is not an incident; a permanently failed one is.
 */
export function recordJobFailure(queue: string, error: string): void {
  increment("JobFailures");
  emitLog("error", "job failed permanently", { queue, error });
}

/** Counter deltas since the last call. Reset on read: CloudWatch sums the
 *  values it receives over the period, so re-sending a running total would
 *  multiply every failure by the number of flushes it survived. */
function drainCounters(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, value] of counters) out[name] = value;
  counters.clear();
  return out;
}

export type QueueDepth = { queue: string; waiting: number; active: number; delayed: number; failed: number };

/**
 * Queue depth is the one number that tells you the pipeline has stopped moving
 * without any individual thing having failed — workers dead, Redis full, or
 * OpenAI rate limiting every extraction into a retry loop all look identical
 * from the job logs and obvious from here.
 */
export async function queueDepths(): Promise<QueueDepth[]> {
  return Promise.all(
    allQueues.map(async (queue) => ({
      queue: queue.name,
      waiting: await queue.getWaitingCount(),
      active: await queue.getActiveCount(),
      delayed: await queue.getDelayedCount(),
      failed: await queue.getFailedCount(),
    })),
  );
}

/* -------------------------------------------------------------------------
 * CloudWatch Embedded Metric Format
 * ---------------------------------------------------------------------- */

/**
 * EMF: a normal structured log line with an `_aws` member that tells CloudWatch
 * Logs to extract named root-level numbers as metrics. Chosen over PutMetricData
 * because it needs no IAM permission beyond the log write the task already has,
 * no agent, no sidecar, and no network call that can fail on the hot path.
 *
 * Shape per the specification (verified 2026-08-24):
 * https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format_Specification.html
 *   _aws.Timestamp             — milliseconds since epoch
 *   _aws.CloudWatchMetrics[]   — { Namespace, Dimensions: [[key,...]], Metrics: [{Name, Unit}] }
 *   every Name and every dimension key MUST also be a root-level member.
 *
 * Dimension cardinality is billing: each distinct dimension combination is a
 * separate custom metric. Service + Environment only — never the request id.
 */
const EMF_UNIT = { count: "Count", milliseconds: "Milliseconds" } as const;

/**
 * Read from process.env directly rather than added to env.ts, which the
 * integrator owns (see CONTRACTS.md). Both are optional and both have sane
 * defaults, so nothing fails to boot if they are never set.
 */
const NAMESPACE = process.env["METRICS_NAMESPACE"]?.trim() || "MCOS";
const SERVICE = process.env["SERVICE_NAME"]?.trim() || "api";
const ENVIRONMENT = process.env["DEPLOY_ENV"]?.trim() || env.NODE_ENV;

function emitEmf(values: Record<string, number>, unit: keyof typeof EMF_UNIT = "count"): void {
  const names = Object.keys(values);
  if (names.length === 0) return;

  const record = {
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: NAMESPACE,
          Dimensions: [["Service", "Environment"]],
          Metrics: names.map((Name) => ({ Name, Unit: EMF_UNIT[unit] })),
        },
      ],
    },
    Service: SERVICE,
    Environment: ENVIRONMENT,
    ...values,
    msg: "metrics",
  };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(record));
}

/** Same JSON envelope the rest of the app logs in, for the paths that fire
 *  outside a request and so have no `request.log` to inherit bindings from. */
function emitLog(level: "warn" | "error", msg: string, fields: Record<string, unknown>): void {
  const record = { level, time: new Date().toISOString(), service: SERVICE, ...fields, msg };
  const line = env.NODE_ENV === "production" ? JSON.stringify(record) : `${level.toUpperCase()} ${msg} ${JSON.stringify(fields)}`;
  // Matching logger.ts: errors to stderr, everything else to stdout.
  // eslint-disable-next-line no-console
  if (level === "error") console.error(line);
  // eslint-disable-next-line no-console
  else console.log(line);
}

export type MetricsReporterOptions = {
  /** Milliseconds between flushes. One minute matches CloudWatch's standard
   *  resolution; anything faster produces high-resolution metrics you pay for
   *  and cannot alarm on any more usefully. */
  intervalMs?: number;
  /**
   * Report queue depth as well as counters. Enable in ONE service — the worker
   * — because every replica that reports it publishes the same gauge, and a
   * Sum across replicas would read as N times the real backlog. Alarm on
   * Average or Maximum regardless.
   */
  queueDepth?: boolean;
};

/**
 * INTEGRATOR: call once at the end of server.ts and worker.ts, with
 * `{ queueDepth: true }` in the worker only. Returns a stop function for the
 * shutdown path; the timer is unref'd, so forgetting to call it delays nothing.
 */
export function startMetricsReporter(opts: MetricsReporterOptions = {}): () => void {
  const intervalMs = opts.intervalMs ?? 60_000;

  const flush = async (): Promise<void> => {
    try {
      const values = drainCounters();
      if (opts.queueDepth) {
        for (const depth of await queueDepths()) {
          const key = depth.queue.replace(/[^A-Za-z0-9]/g, "");
          values[`QueueWaiting_${key}`] = depth.waiting;
          values[`QueueActive_${key}`] = depth.active;
          values[`QueueDelayed_${key}`] = depth.delayed;
          values[`QueueFailed_${key}`] = depth.failed;
        }
      }
      emitEmf(values);
    } catch (error) {
      // A metrics flush that throws must never take the process with it.
      emitLog("warn", "metrics flush failed", { err: (error as Error).message });
    }
  };

  const timer = setInterval(() => void flush(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

/* -------------------------------------------------------------------------
 * Readiness
 * ---------------------------------------------------------------------- */

const here = path.dirname(fileURLToPath(import.meta.url));

/** Resolves to apps/api/prisma/migrations from both src/ (tsx) and dist/
 *  (the built image), because both sit one level under apps/api. */
const MIGRATIONS_DIR = path.resolve(here, "../prisma/migrations");

function migrationsOnDisk(): string[] {
  try {
    return fs
      .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    // No migrations directory means this is not a deployed image (a test
    // harness, say). Nothing to be pending against.
    return [];
  }
}

type MigrationRow = { migration_name: string };

/**
 * Migrations the image expects that the database has not finished applying.
 *
 * rawPrisma, not prisma: `_prisma_migrations` has no tenant_id and is not a
 * Prisma model at all, so the scoping extension has nothing to inject.
 */
export async function pendingMigrations(): Promise<string[]> {
  const expected = migrationsOnDisk();
  if (expected.length === 0) return [];

  const applied = await rawPrisma.$queryRaw<MigrationRow[]>`
    SELECT migration_name
      FROM _prisma_migrations
     WHERE finished_at IS NOT NULL
       AND rolled_back_at IS NULL
  `;
  const done = new Set(applied.map((row) => row.migration_name));
  return expected.filter((name) => !done.has(name));
}

export type Readiness = {
  ready: boolean;
  checks: { database: boolean; migrations: boolean; redis: boolean };
  pending?: string[];
  error?: string;
};

/**
 * Once every migration is applied it stays applied for the life of the
 * process — a later migration arrives with a later image, which is a new
 * process. Latching it keeps the ALB's health check off the migrations table
 * every fifteen seconds for the rest of the deployment's life.
 */
let migrationsSettled = false;

export async function readiness(): Promise<Readiness> {
  const checks = { database: false, migrations: migrationsSettled, redis: false };
  let pending: string[] | undefined;
  let error: string | undefined;

  try {
    await rawPrisma.$queryRaw`SELECT 1`;
    checks.database = true;
  } catch (e) {
    error = `database: ${(e as Error).message}`;
  }

  if (checks.database && !migrationsSettled) {
    try {
      pending = await pendingMigrations();
      checks.migrations = pending.length === 0;
      if (checks.migrations) migrationsSettled = true;
    } catch (e) {
      // A missing _prisma_migrations table is a database that has never been
      // migrated, which is exactly the state readiness exists to refuse.
      error ??= `migrations: ${(e as Error).message}`;
    }
  }

  const redis = newRedis();
  try {
    checks.redis = (await redis.ping()) === "PONG";
  } catch (e) {
    error ??= `redis: ${(e as Error).message}`;
  } finally {
    redis.disconnect();
  }

  /**
   * Redis is reported but does not gate readiness, and that asymmetry is
   * deliberate. A dead Redis stops new bots and job processing but leaves
   * every read path working; failing readiness on it would pull all API tasks
   * out of the ALB and turn a degraded pipeline into a total outage. It alarms
   * instead — see docs/OBSERVABILITY.md.
   */
  const ready = checks.database && checks.migrations;
  return {
    ready,
    checks,
    ...(pending && pending.length > 0 ? { pending } : {}),
    ...(error ? { error } : {}),
  };
}

/* -------------------------------------------------------------------------
 * Wiring
 * ---------------------------------------------------------------------- */

/**
 * INTEGRATOR: call from server.ts immediately AFTER `registerCore(app, ...)`.
 *
 * Order is not cosmetic. registerCore's onRequest hook is what resolves
 * `request.ctx` and `request.actor`; Fastify runs onRequest hooks in
 * registration order, so a hook added before it would bind a tenant and an
 * actor that are both still undefined onto every log line.
 *
 * A plain function on the root instance rather than a Fastify plugin, matching
 * registerCore: hooks added inside an encapsulated plugin apply only to that
 * plugin's own routes, which for a logging hook is the one thing it must not do.
 */
export function registerObservability(app: FastifyInstance): void {
  app.addHook("onRequest", async (request, reply) => {
    // request.id is Fastify's own — the propagated header when genReqId is
    // wired up, an incrementing counter when it is not.
    const requestId = safeHeader(request, REQUEST_ID_HEADER) ?? request.id;
    request.requestId = requestId;
    void reply.header(REQUEST_ID_HEADER, requestId);

    const bindings: Record<string, unknown> = { requestId };

    const traceId = safeHeader(request, TRACE_HEADER);
    if (traceId) bindings["traceId"] = traceId;

    // Tenant and actor on every line is the whole point: "which customer is
    // this" is the first question asked of any log, and grepping for it after
    // the fact only works if it was never omitted.
    if (request.ctx) {
      bindings["tenantId"] = request.ctx.tenantId;
      bindings["tenantSlug"] = request.ctx.tenantSlug;
    }
    if (request.actor) {
      bindings["userId"] = request.actor.userId;
      bindings["actor"] = request.actor.email;
      bindings["role"] = request.actor.role;
      bindings["organizationId"] = request.actor.organizationId;
    }

    const child = request.log.child(bindings);
    request.log = child;
    // reply.log is a separate reference captured at request creation, and it is
    // the one Fastify's built-in "request completed" line uses. Rebinding only
    // request.log would leave that line without a tenant.
    reply.log = child;
  });

  app.addHook("onResponse", async (request, reply) => {
    // Health probes are the majority of traffic on a quiet service and none of
    // it is interesting. They still show up in the ALB access logs.
    if (request.url === "/healthz" || request.url === "/readyz") return;
    request.log.info(
      {
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
      },
      "request completed",
    );
  });

  /**
   * Readiness, not liveness. `/healthz` says the process is up and can reach
   * its dependencies; a container that fails it should be restarted. `/readyz`
   * says this task is fit to serve, which is false while the database is
   * missing migrations this image needs — the window during a deploy where
   * server.js is running against a schema that has not caught up yet. Restarting
   * the container would not fix that, so it must be a distinct probe: the ALB
   * target group health check points here, the ECS container health check
   * points at /healthz.
   */
  app.get("/readyz", { config: { rateLimit: false } }, async (_request, reply) => {
    const result = await readiness();
    return reply.status(result.ready ? 200 : 503).header("cache-control", "no-store").send(result);
  });
}
