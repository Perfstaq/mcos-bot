# MCOS runbook

For whoever is holding the pager. This assumes you did not build this system
and are reading it for the first time, possibly at 3am.

---

## 60 seconds of context

MCOS records meetings, transcribes them, proposes claims from the transcript,
and a human approves or rejects each one before anything enters the positioning
brief.

```
Recall.ai bot → webhook → BullMQ job → R2 (media) + Postgres (transcript)
              → extraction (OpenAI) → candidate_claims
              → human review → brief_version
```

Four facts that determine what is and is not an emergency:

1. **Nothing writes to the brief except a human decision.** There is no
   auto-approve path. If claims are not appearing in the brief, that is a
   reviewer not having reviewed, not a broken system.
2. **`webhook_events` holds every raw Recall payload.** Almost any pipeline
   failure is replayable from the database. You very rarely lose data; you lose
   *time*.
3. **Every job is idempotent and retried** (5 attempts, exponential backoff;
   extraction gets 3). A single failure is not an incident.
4. **Recall does not get polled.** Bot state arrives by webhook only. If
   webhooks stop, the pipeline stops silently — which is why webhook
   verification failures page.

### Where everything is

Replace `production` with `staging` as needed.

| Thing | Where |
|---|---|
| Cluster | `mcos-production` |
| Services | `mcos-production-api`, `mcos-production-worker` |
| Log groups | `/ecs/mcos-production/api`, `/worker`, `/migrate` |
| Database | `mcos-production` (RDS), private subnets only |
| Redis | `mcos-production` (ElastiCache), `rediss://`, auth token required |
| Secrets | Secrets Manager, prefix `mcos/production/` |
| Deploy manifest | SSM `/mcos/production/deploy-manifest` |
| Metrics | CloudWatch namespace `MCOS`, dimensions `Service` + `Environment` |
| Alarms | CloudWatch, prefix `mcos-production-` |
| Terraform | `infra/terraform`, workspace `production` |

### Two probes, and the difference matters

| | Answers | Who asks | Failure means |
|---|---|---|---|
| `GET /healthz` | Is this process alive and can it reach Postgres and Redis? | ECS container health check | Replace the task |
| `GET /readyz` | Should this task receive traffic? | ALB target group | Do **not** send traffic; a restart will not help |

`/readyz` returns 503 while the database is missing a migration this image
expects. That is deliberate: it is the state during a deploy where the ordering
broke. It reports Redis but does **not** fail on it — a dead Redis stops the
pipeline but leaves reads working, and pulling every task out of the load
balancer would turn a degraded pipeline into a total outage.

```bash
curl -s https://<domain>/readyz | jq
# {"ready":true,"checks":{"database":true,"migrations":true,"redis":true}}
```

### Getting a shell

Only if `enable_execute_command = true` for that environment.

```bash
CLUSTER=mcos-production
TASK=$(aws ecs list-tasks --cluster $CLUSTER \
        --service-name mcos-production-api --query 'taskArns[0]' --output text)

aws ecs execute-command --cluster $CLUSTER --task "$TASK" \
  --container api --interactive --command "/bin/sh"
```

### Reading logs

```bash
# Live tail, one service
aws logs tail /ecs/mcos-production/api --follow --since 15m

# Everything for one request id (it is on every line of that request)
aws logs tail /ecs/mcos-production/api --since 1h \
  --filter-pattern '{ $.requestId = "REQUEST-ID-HERE" }'

# Everything for one tenant
aws logs tail /ecs/mcos-production/api --since 1h \
  --filter-pattern '{ $.tenantSlug = "acme" }'
```

Every log line is JSON and carries `requestId`, `tenantId`, `tenantSlug` and —
when the request is authenticated — `userId`, `actor` and `role`. A user
reporting a problem should be asked for the `x-request-id` response header
first; it turns a search into a lookup.

---

## First deploy

Everything before step 4 is a prerequisite, not a step. Read
[`infra/terraform/README.md`](../infra/terraform/README.md) first — especially
the `ap-south-2` section.

**1. Prerequisites.**

- `ap-south-2` enabled in the account (Account → AWS Regions). Wait for IAM to
  propagate — minutes, not seconds.
- S3 state bucket + DynamoDB lock table created (commands in the Terraform
  README).
- ACM certificate **ISSUED**, in `ap-south-2`, covering your domain.
- R2 bucket created with `--location apac` (the hint is immutable).
- Recall.ai workspace, API key and workspace webhook secret, in a region Recall
  actually operates in — there is no India region.

**2. Apply the infrastructure with zero tasks.**

The application cannot start until its secrets are real, and crash-looping
tasks during the first apply make everything else harder to read.

```bash
cd infra/terraform
terraform workspace select production
terraform apply -var-file=env/production.tfvars \
  -var api_desired_count=0 -var worker_desired_count=0
```

**3. Point DNS at the load balancer.**

```bash
terraform output alb_dns_name   # CNAME, or a Route 53 ALIAS using alb_zone_id
```

**4. Create the application's database role.**

RDS owns the master password and rotates it. The application must not use it.

You need network access to a private RDS instance. Any of: a bastion, an AWS
CloudShell VPC environment attached to a private subnet with the
`mcos-production-tasks` security group, or — needing no extra infrastructure —
a throwaway ECS task:

```bash
MANIFEST=$(aws ssm get-parameter --name /mcos/production/deploy-manifest \
             --query Parameter.Value --output text)
SUBNETS=$(echo "$MANIFEST" | jq -r '.subnets | join(",")')
SG=$(echo "$MANIFEST" | jq -r '.security_group')

aws ecs run-task --cluster mcos-production \
  --task-definition mcos-production-migrate \
  --launch-type FARGATE --enable-execute-command \
  --overrides '{"containerOverrides":[{"name":"migrate","command":["sh","-c","sleep 3600"]}]}' \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$SG],assignPublicIp=DISABLED}"
```

Get the master credential (this is the one and only time it is used):

```bash
aws secretsmanager get-secret-value \
  --secret-id "$(terraform output -raw database_master_secret_arn)" \
  --query SecretString --output text | jq
```

Then, from inside the VPC, run this SQL as `mcos_master` against database
`mcos`:

```sql
CREATE ROLE mcos_app LOGIN PASSWORD '<generate 32+ random characters>';
ALTER DATABASE mcos OWNER TO mcos_app;
GRANT ALL ON SCHEMA public TO mcos_app;
```

`mcos_app` owns the database rather than being a restricted DML-only role,
because migrations run as this user and one of them executes
`CREATE EXTENSION IF NOT EXISTS pg_trgm`. `pg_trgm` is a *trusted* extension in
PostgreSQL 13+, so a database owner can install it without superuser. If RDS
refuses it anyway, grant `rds_superuser` to `mcos_app`, run the migration, and
revoke it again.

**5. Write the secrets.** See "Rotating a secret" below for the command. Every
name listed by `terraform output secrets_needing_values` must be set. In
particular:

```
DATABASE_URL = postgresql://mcos_app:<password>@<endpoint>/mcos?schema=public&sslmode=require
```

`sslmode=require` is not optional — the parameter group sets
`rds.force_ssl = 1` and a plaintext connection is refused.

`REDIS_URL` is already written by Terraform. Do not overwrite it.

**6. Deploy.** GitHub → Actions → Deploy → Run workflow → `production`.
Approve when the environment gate asks. The workflow builds, pushes, runs
`prisma migrate deploy` as a one-off task, then updates both services.

**7. Raise the task counts.**

```bash
terraform apply -var-file=env/production.tfvars
```

**8. Register the webhook with Recall.**

```bash
terraform output webhook_url
# https://<domain>/api/v1/webhooks/recall
```

Recall rejects request bodies containing `localhost` or a bare IP with a 403
from CloudFront. This must be the real public hostname.

**9. Verify, do not assume.**

```bash
curl -s https://<domain>/readyz | jq          # ready: true, all three checks true
curl -si https://<domain>/healthz | head -1   # 200
```

Then record a real meeting end to end. Nothing in the test suite has ever
talked to a live Recall bot or a real R2 bucket — the first real meeting is the
first real test.

---

## Rotating a secret

The same three steps for every credential. Terraform never reads these values
back (`ignore_changes` on the secret version), so writing one is safe at any
time.

```bash
ENV=production
NAME=OPENAI_API_KEY          # any entry under mcos/$ENV/

aws secretsmanager put-secret-value \
  --secret-id "mcos/$ENV/$NAME" \
  --secret-string 'the-new-value'

# ECS reads secrets at task start, so running tasks keep the old value until
# they are replaced. Nothing picks this up on its own.
aws ecs update-service --cluster mcos-$ENV --service mcos-$ENV-api    --force-new-deployment
aws ecs update-service --cluster mcos-$ENV --service mcos-$ENV-worker --force-new-deployment

aws ecs wait services-stable --cluster mcos-$ENV \
  --services mcos-$ENV-api mcos-$ENV-worker
```

**Never** paste a secret into a shell that records history, a Terraform
variable file, or a GitHub secret. `--secret-string file://path` reads from a
file if you prefer; delete the file afterwards.

Per-secret notes, in the order you are most likely to need them:

| Secret | What rotating it costs | Notes |
|---|---|---|
| `RECALL_WEBHOOK_SECRET` | Every webhook fails verification until deployed | See the dedicated section below — this one has an ordering problem |
| `RECALLAI_API_KEY` | New bots cannot be dispatched; in-flight bots continue | Region-scoped. A key from the wrong Recall region fails with a 401 that looks like a bad key |
| `OPENAI_API_KEY` | Extraction fails; everything else works | Extraction retries 3 times, so a short gap self-heals |
| `BETTER_AUTH_SECRET` | **Signs out every user and invalidates every pending email verification.** | That is the point of rotating it. Announce it |
| `DATABASE_URL` | Tasks crash-loop until the new deployment lands | Change the password in Postgres *first*, then the secret, then redeploy. `ALTER ROLE mcos_app PASSWORD '...'` — existing connections survive; new ones use the new password |
| `REDIS_URL` | Jobs fail until deployed | **Terraform owns this one.** Rotate by changing `random_password.redis_auth` (taint it) and applying; `auth_token_update_strategy = "ROTATE"` keeps the old token valid during the transition so tasks are not cut off mid-deploy |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | Media upload and playback presigning fail | Rotate both together; they are one credential in two entries |
| `CF_ACCOUNT_ID` | Not really a secret, but R2 addressing breaks | Rarely changes |
| `GOOGLE_*` / `MICROSOFT_*` | Sign-in with that provider fails; calendar sync stops until users re-consent | Rotating the client secret does not invalidate existing refresh tokens; deleting the OAuth app does |

### The RDS master password

You do not rotate this by hand — RDS does. To force it:

```bash
aws rds modify-db-instance --db-instance-identifier mcos-production \
  --rotate-master-user-password --apply-immediately
```

The application does not use it, so nothing needs redeploying.

---

## The Recall webhook secret rotated

**Symptom:** the `mcos-production-webhook-verification-failures` alarm, and
`"rejected unverified webhook"` in the API log group. Every meeting stops
progressing past `bot_scheduled`. Nothing errors from a user's point of view —
meetings just never finish.

```bash
aws logs tail /ecs/mcos-production/api --since 30m \
  --filter-pattern '"rejected unverified webhook"'
```

`reason` tells you which failure it is:

| `reason` | Meaning |
|---|---|
| `no matching signature` | **The secret changed.** This is the rotation case |
| `missing signature headers` | Not from Recall. A scanner, or a misconfigured proxy stripping headers |
| `timestamp outside tolerance` | Replay, or genuine clock skew — the window is 5 minutes |
| `no webhook secret configured` | `RECALL_WEBHOOK_SECRET` is empty or still `REPLACE_ME` |

**There is an ordering problem, and it has a solution.** Verification accepts
*either* `RECALL_WEBHOOK_SECRET` or `RECALL_SVIX_WEBHOOK_SECRET`, trying both.
Use that as an overlap window:

1. Put the **new** secret into `RECALL_SVIX_WEBHOOK_SECRET` and deploy. Both
   old and new now verify.
2. Rotate the secret in the Recall dashboard.
3. Confirm the alarm clears and webhooks are arriving.
4. Move the new secret into `RECALL_WEBHOOK_SECRET`, clear
   `RECALL_SVIX_WEBHOOK_SECRET`, deploy again.

If `RECALL_SVIX_WEBHOOK_SECRET` is not in `var.optional_secrets` for this
environment, add it and `terraform apply` before step 1.

**Recovering the meetings that were dropped.** Unverified requests are logged
and dropped — never stored as processable — so there is nothing to replay. Ask
Recall to redeliver from their dashboard once verification is working again.
For bots that have already finished, the recording and transcript are still
retrievable from the Recall API by bot id; the meeting rows are in
`bot_scheduled` or `recording` with a `recall_bot_id` set.

> A caveat worth knowing before you touch anything: accounts created before
> 2025-12-15 use a separate per-endpoint Svix secret for dashboard webhooks;
> newer accounts use one workspace secret for everything and **must** leave
> `RECALL_SVIX_WEBHOOK_SECRET` empty in steady state. Setting it permanently on
> a new account is not harmful to verification, but it means a compromised old
> secret keeps working.

---

## Extraction is failing

**Symptom:** the `mcos-production-extraction-failures` alarm. Meetings reach
`transcript_ready` and stop. Reviewers see an empty queue for recent meetings.

**1. Is it every meeting or one meeting?**

```bash
aws logs tail /ecs/mcos-production/worker --since 1h \
  --filter-pattern '"extraction failed"'
```

**2. Check the run record.** `extraction_runs` stores the failure and the
counts for every attempt:

```sql
SELECT id, meeting_id, status, model, prompt_version,
       chunk_count, proposed_count, dropped_count, persisted_count,
       started_at, finished_at, error
  FROM extraction_runs
 ORDER BY started_at DESC
 LIMIT 20;
```

| What you see | Cause | Action |
|---|---|---|
| `error` mentioning 401 / invalid key | `OPENAI_API_KEY` rotated or revoked | Rotate the secret, redeploy |
| `error` mentioning 429 | Rate limited | Jobs retry with 15s exponential backoff. If it persists, reduce worker concurrency or raise the OpenAI quota |
| `error` mentioning the model name | `OPENAI_MODEL` names a model this key cannot reach | Fix `var.openai_model`, apply, redeploy |
| `status = succeeded` but `persisted_count` far below `proposed_count` | **Not a failure.** The evidence gate is dropping claims whose quotes do not resolve to real transcript segments | See below |
| `chunk_count = 0` | The transcript has no segments — the failure is upstream, in ingest | Check `transcripts` and `transcript_segments` for that meeting |

**3. A high drop rate is a quality signal, not an outage.** Provenance is
structural here: a claim that cannot be tied to a real transcript segment is
dropped at the boundary and counted, never persisted. A noisy transcript
produces more drops. This is the system working. Watch the *rate*:

```sql
SELECT date_trunc('hour', started_at) AS hour,
       sum(proposed_count)  AS proposed,
       sum(dropped_count)   AS dropped,
       round(100.0 * sum(dropped_count) / nullif(sum(proposed_count), 0), 1) AS drop_pct
  FROM extraction_runs
 WHERE started_at > now() - interval '24 hours'
 GROUP BY 1 ORDER BY 1 DESC;
```

A sudden jump usually means the model changed or the prompt version changed —
both are recorded per run, so compare `model` and `prompt_version` across the
boundary.

**4. Re-run a stuck meeting.** Extraction is idempotent: a run that already
succeeded is skipped. Enqueue again rather than editing rows.

---

## The queue is backing up

**Symptom:** a `mcos-production-queue-backlog-*` alarm. Meetings are not
progressing and nothing is erroring.

**1. Is anything running?**

```bash
aws ecs describe-services --cluster mcos-production \
  --services mcos-production-worker \
  --query 'services[0].{desired:desiredCount,running:runningCount,pending:pendingCount,status:status}'
```

Zero running workers is the most common cause and the fastest fix — the
`mcos-production-worker-no-tasks` alarm covers exactly this. Check
`describe-services --query 'services[0].events[:10]'` for why they are not
starting; the usual answers are an image that will not pull, a secret that is
still `REPLACE_ME`, and Fargate capacity.

**2. Which queue?** The alarm name says so. What that tells you:

| Queue | Backing up means |
|---|---|
| `webhook` | Workers are down, or Redis is refusing writes. Webhooks are still being accepted and stored — nothing is lost yet |
| `ingest-recording` | R2 or Recall media downloads are slow or failing. Check for R2 credential errors |
| `ingest-transcript` | Recall transcript downloads failing |
| `extract` | OpenAI is slow, rate limiting, or down. Usually the least urgent — it is the last stage |

**3. Is Redis healthy?** `maxmemory-policy` is `noeviction` on purpose: a full
Redis returns *write errors* rather than silently evicting jobs. Loud beats
silent, and it is still an ingest outage.

```bash
aws cloudwatch get-metric-statistics --namespace AWS/ElastiCache \
  --metric-name DatabaseMemoryUsagePercentage \
  --dimensions Name=ReplicationGroupId,Value=mcos-production \
  --start-time "$(date -u -v-1H +%Y-%m-%dT%H:%M:%SZ)" \
  --end-time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --period 300 --statistics Maximum
```

**4. Scale out.** Autoscaling on the workers tracks CPU, and a worker blocked
on an OpenAI call is idle — so CPU will not react to a backlog. Scale by hand:

```bash
aws ecs update-service --cluster mcos-production \
  --service mcos-production-worker --desired-count 6
```

Put it back afterwards, or the next `terraform apply` will look confusing
(`desired_count` is in `ignore_changes`, so Terraform will not fight you — but
the autoscaling minimum will pull it back down).

**5. Failed jobs are retained for 7 days** (`removeOnFail`) and can be
inspected or retried. Completed jobs are dropped after 24 hours.

---

## Restoring from backup

Automated backups run daily in the `20:30–21:30` UTC window and are retained
for `db_backup_retention_days` (14 in production). Point-in-time recovery
covers any second inside that window.

**Restore to a new instance. Never restore over the live one.** RDS cannot
restore in place; and if the live instance is fine, you almost certainly want
to compare before switching.

```bash
# The oldest and newest points you can restore to
aws rds describe-db-instances --db-instance-identifier mcos-production \
  --query 'DBInstances[0].{earliest:EarliestRestorableTime,latest:LatestRestorableTime}'

aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier mcos-production \
  --target-db-instance-identifier mcos-production-restore-$(date +%Y%m%d%H%M) \
  --restore-time 2026-08-24T02:15:00Z \
  --db-subnet-group-name mcos-production \
  --vpc-security-group-ids <the mcos-production-db security group id> \
  --no-publicly-accessible
```

The restored instance comes up with the **source's master credential** and its
own endpoint. To cut over:

1. Verify the restore. `SELECT max(created_at) FROM webhook_events;` and
   `SELECT max(version) FROM brief_versions;` tell you how far it got.
2. Set both services to `desired-count 0`. Do not run two writers.
3. Update `DATABASE_URL` in Secrets Manager to the new endpoint.
4. Restore the counts and force a new deployment.
5. Reconcile: any Recall webhook delivered during the lost window is gone. Ask
   Recall to redeliver.

**What a restore does and does not give you back.** The append-only tables —
`review_decisions`, `state_transitions`, `brief_versions`, `brief_claims`,
`webhook_events` — are never updated or deleted in normal operation, so a
restore reconstructs the actual decision history, not a summary of it. Media in
R2 is **not** covered: R2 is a separate system with its own lifecycle, and a
Postgres restore to a point before an artifact row existed leaves the object
orphaned in the bucket, not deleted.

**Deletion is redaction, not erasure.** If someone reports that a meeting
"disappeared", check `meetings.deleted_at` and `brief_claims.evidence_redacted`
before reaching for a restore. The purge path deliberately keeps the claim and
redacts the evidence.

---

## Rolling back

**The fastest rollback is a redeploy of the previous image.** Image tags are
commit SHAs and are immutable, so "the previous image" is unambiguous.

```
GitHub → Actions → Deploy → Run workflow
  environment: production
  image_tag:   <the previous commit SHA>
```

Approve the environment gate. The workflow skips the build (the image is
already in ECR), re-runs migrations (a no-op — `prisma migrate deploy` applies
what is pending and exits 0), and updates both services.

Find the previous tag:

```bash
aws ecr describe-images --repository-name mcos-production \
  --query 'reverse(sort_by(imageDetails,&imagePushedAt))[:10].{tag:imageTags[0],pushed:imagePushedAt}' \
  --output table
```

**Or roll back to the previous task definition revision** — faster still, and
it does not touch the migration step:

```bash
CLUSTER=mcos-production
aws ecs update-service --cluster $CLUSTER --service $CLUSTER-api \
  --task-definition "$CLUSTER-api:<previous-revision-number>"
aws ecs update-service --cluster $CLUSTER --service $CLUSTER-worker \
  --task-definition "$CLUSTER-worker:<previous-revision-number>"
aws ecs wait services-stable --cluster $CLUSTER \
  --services $CLUSTER-api $CLUSTER-worker
```

**Often you do not have to.** The ECS deployment circuit breaker is enabled on
both services with `rollback = true`: a deployment whose tasks never pass
`/readyz` is reverted automatically. If the deploy workflow failed at "Wait for
both services to stabilise", check the service events before doing anything —
the rollback has probably already happened.

```bash
aws ecs describe-services --cluster mcos-production \
  --services mcos-production-api --query 'services[0].events[:10]'
```

### Rolling back a migration

**You cannot, automatically.** `prisma migrate deploy` only rolls forward.
There is no down-migration in this repository and adding one under pressure is
worse than the alternatives.

Options, in order of preference:

1. **Roll the code back and leave the schema forward.** Additive migrations —
   new tables, new nullable columns, new indexes — are almost always safe for
   the previous image to run against. This is why the deploy order is
   migrate-then-deploy: the old code has to tolerate the new schema for the
   duration of a rolling update anyway.
2. **Write a new forward migration** that undoes the damage, and deploy it.
3. **Point-in-time restore** to just before the migration. Last resort: you
   lose everything written since, and this is why
   `db_backup_retention_days` has a floor of 7.

If a migration is running when you decide to abort: it holds locks. Let it
finish. Killing the migration task mid-statement leaves
`_prisma_migrations` with a row where `finished_at IS NULL`, and every
subsequent `migrate deploy` will refuse to proceed until that is resolved by
hand (`prisma migrate resolve --applied` or `--rolled-back`). `/readyz` will
correctly report the migration as pending throughout, which is the signal that
tells you this happened.

---

## Escalation

Before escalating, capture: the alarm name, the `requestId` or `meetingId`, the
relevant log lines, and what you already tried. Everything in this document is
safe to do without waking anyone; anything not in this document probably
warrants a second person.

Third parties with their own status pages, in the order they are likely to be
the cause: Recall.ai, OpenAI, Cloudflare (R2), AWS `ap-south-2`.
