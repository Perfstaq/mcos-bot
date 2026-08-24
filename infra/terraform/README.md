# MCOS infrastructure — AWS Hyderabad (`ap-south-2`)

Terraform for the production and staging stacks: VPC, ECS Fargate (API +
worker), ALB with ACM TLS, RDS Postgres 16, ElastiCache Redis, Secrets Manager,
CloudWatch logs and alarms, and the GitHub OIDC role the deploy workflow uses.

Operational procedures — first deploy, secret rotation, restore, rollback — are
in [`docs/RUNBOOK.md`](../../docs/RUNBOOK.md). What is logged and what pages is
in [`docs/OBSERVABILITY.md`](../../docs/OBSERVABILITY.md).

---

## ⚠️ Read this before the first apply: `ap-south-2` is an opt-in region

Hyderabad is not enabled by default and does not behave like Mumbai
(`ap-south-1`). Four things will bite, in roughly this order:

**1. The region must be enabled before anything works.**
Account → AWS Regions → enable Asia Pacific (Hyderabad). A fresh account cannot
see the region at all until this is done, and IAM propagation afterwards takes
minutes, not seconds — a `terraform apply` started too soon fails with
authorization errors that look like a broken role.

**2. Instance-type coverage is thinner than Mumbai, and varies by AZ *within*
the region.** This is the single most likely cause of a failed first apply. A
class that exists in `ap-south-1` may not exist in `ap-south-2`, and one that
exists in `ap-south-2a` may not exist in `ap-south-2b` — which matters because
the RDS subnet group spans both.

Every instance class in this stack is therefore a **variable**, not a literal:

| Variable | Default | Change it if… |
|---|---|---|
| `db_instance_class` | `db.m6g.large` | RDS rejects the class or the AZ pairing |
| `redis_node_type` | `cache.t4g.medium` | ElastiCache rejects the node type |
| `api_cpu` / `api_memory` | `1024` / `2048` | Fargate rejects the CPU/memory pairing |
| `worker_cpu` / `worker_memory` | `1024` / `2048` | same |
| `task_cpu_architecture` | `X86_64` | you switch the build to Graviton |

An unavailable class is a one-line `.tfvars` change and a re-plan. Nothing else
in this configuration has to move. **Check before you apply:**

```bash
# Which Postgres 16 classes exist here, and in which AZs
aws rds describe-orderable-db-instance-options \
  --engine postgres --engine-version 16 --region ap-south-2 \
  --query 'OrderableDBInstanceOptions[].{class:DBInstanceClass,az:AvailabilityZones[].Name,multiAZ:MultiAZCapable}' \
  --output table

# Which Fargate CPU/memory pairings are legal (this is region-independent, but
# the pairing rules trip people up more often than availability does)
#   256  : 512, 1024, 2048
#   512  : 1024 .. 4096 in 1024 steps
#   1024 : 2048 .. 8192 in 1024 steps
#   2048 : 4096 .. 16384 in 1024 steps
#   4096 : 8192 .. 30720 in 1024 steps
```

ElastiCache has no equivalent "orderable options" API. Attempt the plan, or
check the node type in the console's create wizard for `ap-south-2`.

**3. Recall.ai has no India region.** `var.recall_region` is one of
`us-east-1`, `us-west-2`, `eu-central-1`, `ap-northeast-1` — meeting media is
processed outside India regardless of where this stack runs. **If data
residency is the reason Hyderabad was chosen, compute placement alone does not
deliver it, and that needs to be raised explicitly rather than assumed.**

**4. Cloudflare R2 has no Hyderabad location.** Create the artifact bucket with
a location hint of `apac`; the hint is set once at creation and is immutable.

```bash
npx wrangler r2 bucket create mcos-artifacts --location apac
```

R2's `jurisdiction` flag — the one that actually enforces locality — supports
only `eu` and `fedramp`. A location hint is a placement preference, not a
residency guarantee.

**One more `ap-south-2` specific:** if you enable ALB access logs
(`alb_access_logs_bucket`), the S3 bucket policy must grant the
`logdelivery.elasticloadbalancing.amazonaws.com` **service principal**. The
legacy per-region ELB account-id policy does not cover Hyderabad — AWS's own
list of ELB account ids stops at the regions that existed before August 2022,
and states that regions not in the list do not support the legacy policy.
([AWS: enable access logs for your ALB](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/enable-access-logging.html))

---

## Layout

| File | Contents |
|---|---|
| `main.tf` | Provider, backend, tags, the workspace/environment guard |
| `network.tf` | VPC, public and private subnets, NAT, VPC endpoints |
| `alb.tf` | Load balancer, TLS listener, target group (`/readyz` health check) |
| `ecs.tf` | ECR, cluster, log groups, three task definitions, two services, autoscaling, the deploy manifest |
| `rds.tf` | Postgres 16, Multi-AZ, parameter group, enhanced monitoring |
| `elasticache.tf` | Redis replication group, `noeviction`, transit encryption |
| `secrets.tf` | KMS key and every Secrets Manager entry |
| `iam.tf` | Task execution role, task role, GitHub OIDC deploy role |
| `alarms.tf` | CloudWatch alarms, each with its threshold justified |
| `variables.tf` | Every knob, with the ap-south-2 caveats attached |
| `outputs.tf` | ARNs, names and endpoints — never values |

There are no modules. One environment is one workspace over one flat
configuration; a module layer here would buy indirection and nothing else.

---

## State and workspaces

Remote state in S3 with a DynamoDB lock table. Both are **prerequisites** —
Terraform cannot bootstrap its own backend. Create them once, by hand, in the
account that will hold the stacks:

```bash
REGION=ap-south-2
BUCKET=<your-state-bucket>           # must be globally unique
TABLE=mcos-terraform-locks

aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
  --create-bucket-configuration LocationConstraint="$REGION"
aws s3api put-bucket-versioning --bucket "$BUCKET" \
  --versioning-configuration Status=Enabled
aws s3api put-bucket-encryption --bucket "$BUCKET" \
  --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
aws s3api put-public-access-block --bucket "$BUCKET" \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

aws dynamodb create-table --table-name "$TABLE" --region "$REGION" \
  --attribute-definitions AttributeName=LockID,AttributeType=S \
  --key-schema AttributeName=LockID,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST
```

Versioning is not optional. It is the only thing standing between a corrupted
apply and a hand-rebuilt state file.

Then:

```bash
cd infra/terraform

terraform init \
  -backend-config=bucket="$BUCKET" \
  -backend-config=dynamodb_table="$TABLE" \
  -backend-config=region="$REGION"

terraform workspace new staging      # or: terraform workspace select staging
terraform apply -var-file=env/staging.tfvars
```

`var.environment` must equal the workspace name. A precondition in `main.tf`
fails the plan if they disagree, because applying production's workspace with
staging's variables is a failure mode with no cheap recovery.

**Treat the state bucket as a secret store.** The ElastiCache auth token is
generated by Terraform and is therefore in state. Everything else — the RDS
master password, every application credential — is outside state by design
(see below), but that one is not, and pretending otherwise is worse than
saying so.

---

## Variables

Copy `terraform.tfvars.example` to `env/staging.tfvars` and
`env/production.tfvars`. Both are gitignored. Nothing secret goes in them:
credentials live in Secrets Manager.

Required with no default: `environment`, `repository`, `domain_name`,
`acm_certificate_arn`.

The ACM certificate must already be **ISSUED**, in `ap-south-2`, and cover
`domain_name`. It is an input rather than a resource because validation is a
DNS change Terraform cannot complete on its own, and a stack that hangs for an
hour on `aws_acm_certificate_validation` is a stack nobody can `apply` twice.

---

## Secrets

Terraform creates the Secrets Manager **entries** and writes a `REPLACE_ME`
placeholder. A human writes the real value once, out of band, and
`ignore_changes` keeps Terraform from ever reading it back or reverting it.

Two exceptions:

- **`REDIS_URL`** is composed by Terraform — it is the only thing that holds
  both the endpoint and the generated auth token. Note the scheme is `rediss://`
  (transit encryption is on); `redis://` produces a connection reset that reads
  like a network fault.
- **The RDS master password** is managed by RDS itself
  (`manage_master_user_password`), so it never enters state. The application
  does not use it — first deploy creates a separate database role. See the
  runbook.

The first deploy **will** fail until the placeholders are replaced: `env.ts`
validates its configuration at boot and exits on a missing credential. That is
the intended behaviour, not a bug in this stack.

---

## What a human must verify before the first apply

Terraform has been formatted (`terraform fmt`) and validated
(`terraform validate`) against AWS provider 5.100. **It has never been planned
or applied against a real AWS account** — validation checks syntax and schema,
not whether Hyderabad will actually sell you a `db.m6g.large`. Before the first
apply, confirm:

1. `ap-south-2` is enabled in the account, and IAM has propagated.
2. `db_instance_class` is orderable for Postgres 16 in `ap-south-2`, in the AZs
   the subnet group will span (see the CLI command above).
3. `redis_node_type` is available in `ap-south-2`.
4. The Fargate CPU/memory pairings in the tfvars are legal (table above).
5. The ACM certificate is ISSUED, in `ap-south-2`, and covers `domain_name`.
6. Service quotas for the region: Fargate vCPU (default 6 vCPU on a new
   account — this stack requests 4 at baseline and up to 12 at full scale-out),
   VPCs, Elastic IPs (one per NAT Gateway), and NAT Gateways per AZ.
7. The S3 state bucket and DynamoDB lock table exist, in the same account.
8. `repository` is exactly `owner/repo` — a typo means the deploy role trusts
   a repository that is not yours.
9. If staging and production share an AWS account,
   `create_github_oidc_provider = false` in the second one. An account can hold
   only one OIDC provider per issuer URL and the second apply will fail on
   `EntityAlreadyExists`.
10. `terraform plan` output contains no resource replacement you did not expect.
    On a first apply everything is a create; on any later one, read the diff.

Then run a plan and read it. `terraform plan -var-file=env/staging.tfvars`
against a real account is the first meaningful test this configuration has had.

---

## GitHub setup

The deploy workflow needs exactly two values, because everything else comes
from the SSM deploy manifest Terraform writes:

| Where | Name | Value |
|---|---|---|
| Repository **secret** | `AWS_DEPLOY_ROLE_ARN` | `terraform output github_deploy_role_arn` |
| Repository **variable** | `AWS_REGION` | `ap-south-2` |

The role ARN is a secret only because it contains the account id.

Create a GitHub **environment** named `production` with required reviewers.
That approval is one half of the gate; the other half is the IAM trust policy,
which will not accept a token whose `sub` claim lacks
`environment:production`. Set `github_deploy_environment = "production"` in the
production tfvars so the two halves match.
