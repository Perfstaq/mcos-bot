# Observability

What this system records, what it measures, what wakes someone up — and, at the
end and deliberately, what none of it covers yet.

The implementation is one file: [`apps/api/src/observability.ts`](../apps/api/src/observability.ts).
No agent, no sidecar, no vendor SDK. Structured JSON on stdout, which the ECS
`awslogs` driver already ships to CloudWatch.

---

## Logs

### Format

Every line is JSON. In development the same records are printed readably; the
switch is `NODE_ENV`.

```json
{
  "level": "info",
  "time": "2026-08-24T02:41:07.882Z",
  "requestId": "c1f0a2b4-9c7e-4d21-8a55-1f2e3d4c5b6a",
  "traceId": "Root=1-6708aa11-1c2d3e4f5a6b7c8d9e0f1a2b",
  "tenantId": "9f3c...",
  "tenantSlug": "acme",
  "userId": "usr_...",
  "actor": "priya@acme.example",
  "role": "admin",
  "organizationId": "org_...",
  "method": "POST",
  "url": "/api/v1/meetings",
  "statusCode": 201,
  "durationMs": 148,
  "msg": "request completed"
}
```

### What is on every line

| Field | Source | Why |
|---|---|---|
| `requestId` | `x-request-id` if the client sent a sane one, otherwise minted | Correlation. Returned on the response, so a user can quote it |
| `traceId` | `x-amzn-trace-id`, stamped by the ALB | Joins these logs to ALB access logs |
| `tenantId`, `tenantSlug` | `request.ctx` | "Which customer is this" is the first question asked of any log line |
| `userId`, `actor`, `role`, `organizationId` | `request.actor` | Present only when authenticated |

A client-supplied `x-request-id` is untrusted input: anything that is not
128 characters or fewer of `[A-Za-z0-9_.:=@/-]` is discarded and replaced
rather than sanitised, because a silently rewritten id breaks the caller's
correlation while appearing to work.

### What is deliberately not logged

- **Request and response bodies.** They contain transcript text, meeting notes
  and claim text — customer content, in a log group with 30-day retention and a
  wider read audience than the database.
- **Secrets, tokens and share tokens.** A share token is a bearer credential;
  logging one is publishing it.
- **Health probes.** `/healthz` and `/readyz` are skipped by the access-log
  hook. They are the majority of traffic on a quiet service and none of it is
  informative. They still appear in the ALB access logs.
- **Unverified webhook bodies in full.** The webhook route logs the first 500
  characters and the rejection reason — enough to diagnose, not enough to
  become a store of unauthenticated attacker-controlled data.

### Where

| Group | Contents | Retention |
|---|---|---|
| `/ecs/mcos-<env>/api` | Fastify request lines, errors, webhook rejections | `var.log_retention_days` (30) |
| `/ecs/mcos-<env>/worker` | Job lifecycle, extraction results, EMF metric lines | same |
| `/ecs/mcos-<env>/migrate` | One-off `prisma migrate deploy` output | same |
| `/elasticache/mcos-<env>/slow-log` | Redis slow log | same |
| RDS `postgresql` export | Statements over 1s, autovacuum over 1s | RDS-managed |

All encrypted with the stack's KMS key. Retention is validated against
CloudWatch's accepted values in `variables.tf`; "never expire" is not offered,
because a log group with no retention is a bill that only grows.

---

## Health and readiness

Two probes, two questions, two consumers. Conflating them is the mistake this
design exists to avoid.

| | `/healthz` | `/readyz` |
|---|---|---|
| Question | Is the process alive? | Should this task get traffic? |
| Consumer | ECS container health check | ALB target group |
| Checks | Postgres `SELECT 1`, Redis `PING` | Postgres, **pending migrations**, Redis (reported only) |
| Failure action | Replace the task | Stop routing to it — a restart will not help |

**Readiness fails while migrations are pending.** The check compares the
migration directories in the image against `_prisma_migrations` rows with
`finished_at IS NOT NULL AND rolled_back_at IS NULL`. A task whose image
expects a migration the database has not applied is not fit to serve, and
restarting it changes nothing. Once every migration is applied the result is
latched for the life of the process — a later migration arrives with a later
image, which is a new process — so the ALB's 15-second health check is not
querying the migrations table forever.

**Redis is reported but does not gate readiness**, and that asymmetry is
deliberate. A dead Redis stops new bots and job processing but leaves every
read path working. Failing readiness on it would pull *every* API task out of
the load balancer and turn a degraded pipeline into a total outage. It alarms
instead.

---

## Metrics

Emitted as [CloudWatch Embedded Metric Format](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format_Specification.html)
lines on stdout: a normal structured log line with an `_aws` member telling
CloudWatch Logs to extract named root-level numbers as metrics.

Chosen over `PutMetricData` because it needs no IAM permission beyond the log
write the task already has, no agent, and no network call that can fail on the
hot path. The cost is that a metric appears only when a log line is written —
there is no push on a schedule independent of the process being alive.

- **Namespace:** `var.metrics_namespace`, default `MCOS`
- **Dimensions:** `Service` (`api` | `worker`) and `Environment`. Nothing
  high-cardinality: every distinct dimension combination is a separate billable
  custom metric, so `requestId` will never appear here.
- **Flush interval:** 60 seconds, matching CloudWatch standard resolution.
- **Counters are deltas.** They reset on flush, because CloudWatch sums what it
  receives over a period — re-sending a running total would multiply every
  failure by the number of flushes it survived.

### What is counted

| Metric | Meaning | Where it is incremented |
|---|---|---|
| `WebhookVerificationFailures` | A Recall webhook failed signature verification | API, webhook route |
| `WebhookDuplicates` | A redelivered webhook was deduped | API, webhook route |
| `ExtractionFailures` | An extraction run failed permanently | Worker, `jobs/extract.ts` |
| `ExtractionClaimsDropped` | Claims dropped by the evidence gate | Worker, `jobs/extract.ts` |
| `JobFailures` | A job exhausted its retries | Worker, `worker.ts` |
| `QueueWaiting_<queue>` | Jobs waiting | Worker, every 60s |
| `QueueActive_<queue>` | Jobs in flight | Worker, every 60s |
| `QueueDelayed_<queue>` | Jobs backing off | Worker, every 60s |
| `QueueFailed_<queue>` | Jobs in the failed set | Worker, every 60s |

Queue names are the BullMQ names with non-alphanumerics stripped:
`webhook`, `ingestrecording`, `ingesttranscript`, `extract`.

**Queue depth is reported by the worker only**, and it is a gauge. Every worker
replica publishes the same value each minute, so a `Sum` across replicas reads
as N times the real backlog. **Alarm on `Maximum` or `Average`, never `Sum`.**
The alarms in `alarms.tf` use `Maximum`.

### Also available without any of the above

| Source | Useful metrics |
|---|---|
| `AWS/ApplicationELB` | `TargetResponseTime`, `HTTPCode_Target_5XX_Count`, `HTTPCode_ELB_5XX_Count`, `UnHealthyHostCount`, `RequestCount` |
| `AWS/ECS` and `ECS/ContainerInsights` | CPU, memory, `RunningTaskCount`, per-task metrics |
| `AWS/RDS` | CPU, `FreeStorageSpace`, `DatabaseConnections`, `ReadLatency`, `WriteLatency` |
| `AWS/ElastiCache` | `DatabaseMemoryUsagePercentage`, `CurrConnections`, `Evictions` |
| RDS Performance Insights | Top SQL by wait, with `pg_stat_statements` preloaded |

---

## What alerts, and why that threshold

Every alarm is in [`infra/terraform/alarms.tf`](../infra/terraform/alarms.tf)
with its reasoning next to it. An alarm whose threshold nobody can justify gets
muted after the second false page and is then absent during the real one.

| Alarm | Condition | Why this number | Runbook |
|---|---|---|---|
| `webhook-verification-failures` | `Sum ≥ 5` over 5 min | Either Recall rotated the workspace secret (every meeting silently stops ingesting) or someone is posting forged payloads. Not 1, because an internet-facing endpoint collects scanner traffic; a rotated secret produces far more than 5 within one Recall retry cycle | [Webhook secret rotated](RUNBOOK.md#the-recall-webhook-secret-rotated) |
| `extraction-failures` | `Sum ≥ 3` over 15 min | Meetings reach `transcript_ready` and stop — invisible to a user until they wonder where their claims went. 3 filters the single OpenAI timeout the job's own retries already handle | [Extraction is failing](RUNBOOK.md#extraction-is-failing) |
| `job-failures` | `Sum ≥ 5` over 15 min | A permanently failed job marks its meeting failed. One is survivable; a cluster is a third party down or a bad deploy | [Queue backing up](RUNBOOK.md#the-queue-is-backing-up) |
| `queue-backlog-extract` | `Maximum > 50` for 2 × 5 min | Extraction is the slowest stage; 50 waiting is roughly an hour of backlog at steady throughput. Two periods because meetings ending at the top of the hour is a legitimate spike | [Queue backing up](RUNBOOK.md#the-queue-is-backing-up) |
| `queue-backlog-{webhook,ingest*}` | `Maximum > 200` for 2 × 5 min | These stages are fast; a sustained backlog means workers are gone or Redis is refusing writes | same |
| `worker-no-tasks` | `RunningTaskCount < 1` for 5 min | Nothing is draining any queue. The failure the queue-depth alarms cannot see, because a dead reporter and an empty queue look identical | same |
| `alb-unhealthy-targets` | `UnHealthyHostCount > 0` for 5 min | API tasks failing `/readyz`. Five periods absorbs the expected blip during a deploy. **Check for pending migrations first** | [Rolling back](RUNBOOK.md#rolling-back) |
| `alb-5xx` | `Sum > 10` over 5 min | 5xx from the load balancer itself — no healthy target, or one that never answered. Distinct from `HTTPCode_Target_5XX_Count`, which is a 500 the application chose to return: a bug report, not a page | |
| `rds-cpu` | `Average > 80%` for 15 min | Sustained, not spiky. Check `pg_stat_statements` before scaling — the GIN expression indexes only work if a query uses the identical expression | |
| `rds-free-storage` | `< 20%` of allocated for 10 min | Storage autoscaling acts at most once every six hours; 20% is roughly the margin that survives one such interval under an ingest burst | [Restoring](RUNBOOK.md#restoring-from-backup) |
| `redis-memory` | `Maximum > 80%` for 10 min | `maxmemory-policy` is `noeviction`, so a full Redis rejects new jobs rather than silently dropping them. Loud beats silent, and it is still an ingest outage. 80% is where there is time to act rather than react | [Queue backing up](RUNBOOK.md#the-queue-is-backing-up) |

`treat_missing_data` is set per alarm and is not incidental: `notBreaching` for
counters (no failures means no data point, which is the healthy state),
`missing` for gauges (a scale-in to zero produces the same gap as a dead
reporter), `breaching` for `worker-no-tasks` (absence of a task count *is* the
condition).

All alarms notify `var.alarm_sns_topic_arn`. If that is empty the alarms still
exist and notify nobody — better than a metric nobody looked at, but set it.

---

## Not covered yet

Stated plainly, because the gaps in a monitoring story are the part people
discover during the incident rather than before it.

**No distributed tracing.** `requestId` correlates lines within a request and
`traceId` joins them to the ALB, but there are no spans. A slow request tells
you it was slow, not which of Postgres, R2, Recall and OpenAI it was slow in.
The honest next step is OpenTelemetry with the ADOT collector as a sidecar.

**No latency histograms.** `durationMs` is logged per request but not emitted
as a metric, so p50/p95/p99 come from `AWS/ApplicationELB TargetResponseTime` —
which measures the whole request through the load balancer and cannot be
broken down by route. There is no per-route or per-tenant latency anywhere.

**No business metrics.** Meetings recorded, transcripts ingested, claims
proposed, claims approved, claims rejected, time-to-review, brief versions
merged — none of these are measured. All of it is in Postgres and none of it is
on a dashboard. This is the most valuable missing piece and the cheapest to
add: the counters already exist as a mechanism.

**No CloudWatch dashboard.** The alarms exist; there is no single page that
shows the pipeline. You are querying log groups by hand, which is exactly what
a runbook should not require.

**Queue depth does not drive autoscaling.** Both services scale on CPU. A
worker blocked on an OpenAI call is idle and busy at once, so CPU is the wrong
signal for the worker — a backlog will not scale it out and step scaling on
`QueueWaiting_extract` is the obvious fix. Not wired up. Scale by hand; the
runbook says how.

**No synthetic monitoring.** Nothing exercises the product from outside except
the deploy workflow's one-shot `/readyz` check. A silent failure between
deploys — Recall rejecting bots, R2 credentials expired, sign-in broken — is
discovered by a user. A CloudWatch Synthetics canary hitting sign-in and one
authenticated read would close most of this.

**No alerting on the absence of work.** Zero webhooks for six hours during a
working day is a strong signal that something upstream is broken, and nothing
here notices — every alarm fires on a bad value, none on a missing one.

**Media is unmonitored.** R2 is a separate system with its own credentials,
lifecycle and failure modes, and none of it is visible from CloudWatch. Upload
failures surface only as failed jobs. There is no check that an artifact row in
Postgres corresponds to an object that still exists in the bucket.

**Costs are not tracked.** The two that can run away are OpenAI tokens
(`extraction_runs.input_tokens` / `output_tokens` are recorded per run and
never aggregated) and NAT Gateway data processing. Neither is alarmed.

**No log-based security alerting.** Failed sign-ins, share-token brute forcing,
and rate-limit rejections are all logged and none of them alarm.

**The metrics themselves have no health check.** If `startMetricsReporter` is
never called, or throws every minute, the counters read as zero and every
counter alarm sits green. There is no heartbeat metric that would distinguish
"no failures" from "no reporter".

---

## Wiring — for the integrator

`observability.ts` mounts nothing on its own. Four call sites, none of which
this build was permitted to edit:

1. **`server.ts`** — `registerObservability(app)` immediately **after**
   `registerCore(app, ...)`. Order matters: `registerCore`'s `onRequest` hook
   resolves `request.ctx` and `request.actor`, Fastify runs hooks in
   registration order, and a hook added before it would bind an undefined
   tenant onto every line. Optionally also pass `genReqId` to `Fastify({...})`
   so pino's own `reqId` is the propagated id.
   Then `startMetricsReporter()` once at startup.
2. **`routes/webhooks.ts`** — `recordWebhookVerificationFailure(reason)` in the
   `!verification.ok` branch, and `increment("WebhookDuplicates")` where a
   duplicate is ignored.
3. **`jobs/extract.ts`** — `recordExtractionFailure(meetingId, error)` in
   `failExtraction`, and `recordExtractionDrops(meetingId, dropped)` where
   `droppedCount` is written on the run.
4. **`worker.ts`** — `recordJobFailure(queue, error)` in the `failed` handler,
   guarded on the same `final` check that decides whether to mark the meeting
   failed, plus `startMetricsReporter({ queueDepth: true })` — queue depth in
   the worker **only**.

Two optional environment variables are read directly from `process.env` rather
than through `env.ts` (which this build does not own): `METRICS_NAMESPACE` and
`SERVICE_NAME`. `DEPLOY_ENV` is read the same way and falls back to
`NODE_ENV`. All three are set by the ECS task definitions.
