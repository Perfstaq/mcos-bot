/**
 * Everything that differs between staging and production, and everything that
 * ap-south-1 might refuse to give us.
 *
 * The instance classes below are variables and not literals on purpose. See
 * README.md § "ap-south-1 is an opt-in region": Mumbai's instance-type
 * coverage is thinner than Mumbai's and varies by AZ within the region, so a
 * class that turns out to be unavailable must be a one-line tfvars change, not
 * a code change and a review cycle.
 */

variable "environment" {
  description = "Deployment environment. Must equal the Terraform workspace name."
  type        = string

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be 'staging' or 'production'."
  }
}

variable "aws_region" {
  description = "AWS region. ap-south-1 (Mumbai) is enabled by default and has the widest instance coverage of the India regions."
  type        = string
  default     = "ap-south-1"
}

variable "repository" {
  description = "owner/repo, used for resource tagging and for the GitHub OIDC trust policy."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$", var.repository))
    error_message = "repository must be in owner/repo form."
  }
}

/* -------------------------------------------------------------------------
 * Network
 * ---------------------------------------------------------------------- */

variable "vpc_cidr" {
  description = "CIDR for the VPC. /16 leaves room for the /20 subnets below."
  type        = string
  default     = "10.40.0.0/16"
}

variable "az_count" {
  description = "Availability Zones to spread across. Two is the minimum for RDS Multi-AZ and for an ALB."
  type        = number
  default     = 2

  validation {
    condition     = var.az_count >= 2 && var.az_count <= 3
    error_message = "az_count must be 2 or 3. ap-south-1 has three AZs; not every instance class is offered in all of them."
  }
}

variable "single_nat_gateway" {
  description = "Route every private subnet through one NAT Gateway. Cheaper, but the NAT's AZ becomes a single point of failure for outbound traffic. Intended for staging only."
  type        = bool
  default     = false
}

variable "enable_vpc_endpoints" {
  description = "Create interface endpoints for ECR, Secrets Manager, CloudWatch Logs and SSM, plus an S3 gateway endpoint. Keeps image pulls and secret reads off the NAT Gateway, which is most of the NAT bill."
  type        = bool
  default     = true
}

variable "ingress_cidrs" {
  description = "Source CIDRs allowed to reach the ALB on 80/443."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

/* -------------------------------------------------------------------------
 * TLS and DNS
 * ---------------------------------------------------------------------- */

variable "acm_certificate_arn" {
  description = "ARN of an ISSUED ACM certificate in var.aws_region covering var.domain_name. Validation is a DNS change outside Terraform's control, so the certificate is an input, not a resource here."
  type        = string

  validation {
    condition     = can(regex("^arn:aws[a-z-]*:acm:", var.acm_certificate_arn))
    error_message = "acm_certificate_arn must be an ACM certificate ARN."
  }
}

variable "domain_name" {
  description = "Public hostname for the API and SPA, e.g. app.example.com. Becomes APP_BASE_URL and WEB_ORIGIN, and therefore the Recall webhook URL."
  type        = string
}

variable "ssl_policy" {
  description = "ALB TLS policy."
  type        = string
  default     = "ELBSecurityPolicy-TLS13-1-2-2021-06"
}

variable "alb_access_logs_bucket" {
  description = "S3 bucket for ALB access logs. Empty disables them. The bucket and its policy are created outside this stack — see README.md, the bucket policy for ap-south-1 must use the logdelivery service principal, not a regional ELB account id."
  type        = string
  default     = ""
}

variable "alb_deletion_protection" {
  description = "Refuse to delete the load balancer. Independent of the RDS setting because they fail differently: a deleted ALB is a DNS change away from recovery, a deleted database is not."
  type        = bool
  default     = true
}

/* -------------------------------------------------------------------------
 * Compute — ECS Fargate
 * ---------------------------------------------------------------------- */

variable "image_tag" {
  description = "Image tag to deploy. The deploy workflow passes the commit SHA; 'latest' is deliberately not the default because it makes a rollback unexpressible."
  type        = string
  default     = "latest"
}

variable "container_port" {
  description = "Port the API listens on. Injected as PORT so it cannot drift from the Dockerfile's EXPOSE."
  type        = number
  default     = 8787
}

# Fargate accepts only certain CPU/memory pairs. 512/1024, 1024/2048-8192,
# 2048/4096-16384 and so on — an invalid pair is rejected at RunTask, not at
# plan time, which is why these are called out rather than left to a guess.
variable "api_cpu" {
  description = "Fargate CPU units for the API task."
  type        = number
  default     = 1024
}

variable "api_memory" {
  description = "Fargate memory (MiB) for the API task. Must be a legal pairing with api_cpu."
  type        = number
  default     = 2048
}

variable "worker_cpu" {
  description = "Fargate CPU units for the worker task."
  type        = number
  default     = 1024
}

variable "worker_memory" {
  description = "Fargate memory (MiB) for the worker task."
  type        = number
  default     = 2048
}

variable "api_desired_count" {
  description = "Baseline API tasks. Two or more, or a deploy is an outage."
  type        = number
  default     = 2
}

variable "worker_desired_count" {
  description = "Baseline worker tasks."
  type        = number
  default     = 2
}

variable "api_max_count" {
  description = "Autoscaling ceiling for the API."
  type        = number
  default     = 6
}

variable "worker_max_count" {
  description = "Autoscaling ceiling for the workers."
  type        = number
  default     = 6
}

variable "fargate_platform_version" {
  description = "Fargate platform version. LATEST is fine; pin it if a platform change ever correlates with a regression."
  type        = string
  default     = "LATEST"
}

variable "task_cpu_architecture" {
  description = "X86_64 or ARM64. Must match what the deploy workflow builds — an ARM64 task definition with an amd64 image fails at task start with an exec format error, which reads like a corrupt image. Graviton is cheaper; switching means adding a buildx platform to the workflow first."
  type        = string
  default     = "X86_64"

  validation {
    condition     = contains(["X86_64", "ARM64"], var.task_cpu_architecture)
    error_message = "task_cpu_architecture must be X86_64 or ARM64."
  }
}

variable "migrate_command" {
  description = "Command for the one-off migration task. A variable because the runtime image may or may not carry the Prisma CLI — see the note on aws_ecs_task_definition.migrate in ecs.tf."
  type        = list(string)
  default     = ["npx", "prisma", "migrate", "deploy", "--schema", "apps/api/prisma/schema.prisma"]
}

variable "enable_execute_command" {
  description = "Allow `aws ecs execute-command` into a running task. On in staging for debugging; a deliberate decision in production, because it is a shell on a container holding live customer data."
  type        = bool
  default     = false
}

/* -------------------------------------------------------------------------
 * Data stores
 *
 * Instance classes here are the single most likely thing to fail a first apply
 * in ap-south-1. Change the tfvars, re-plan; nothing else has to move.
 * ---------------------------------------------------------------------- */

variable "db_instance_class" {
  description = "RDS instance class. Verify availability in ap-south-1 AND in the specific AZs of the DB subnet group before applying: aws rds describe-orderable-db-instance-options --engine postgres --engine-version 16 --region ap-south-1"
  type        = string
  default     = "db.m6g.large"
}

variable "db_engine_version" {
  description = "Postgres major version. Minor upgrades are applied automatically in the maintenance window."
  type        = string
  default     = "16"
}

variable "db_allocated_storage" {
  description = "Initial storage (GiB)."
  type        = number
  default     = 100
}

variable "db_max_allocated_storage" {
  description = "Storage autoscaling ceiling (GiB). Set above allocated storage to enable autoscaling."
  type        = number
  default     = 500
}

variable "db_multi_az" {
  description = "Synchronous standby in a second AZ. Non-negotiable in production; the variable exists so staging can be cheaper."
  type        = bool
  default     = true
}

variable "db_backup_retention_days" {
  description = "Automated backup retention. Also the width of the point-in-time-recovery window."
  type        = number
  default     = 14

  validation {
    condition     = var.db_backup_retention_days >= 7
    error_message = "Retention below 7 days makes 'restore to just before the bad migration' a coin flip. Raise it."
  }
}

variable "db_deletion_protection" {
  description = "Refuse to delete the database."
  type        = bool
  default     = true
}

variable "db_performance_insights_retention" {
  description = "Performance Insights retention in days. 7 is the free tier; 731 is the paid long-term option."
  type        = number
  default     = 7
}

variable "redis_node_type" {
  description = "ElastiCache node type. Same ap-south-1 caveat as db_instance_class: aws elasticache describe-reserved-cache-nodes-offerings is not a availability check — use the console or attempt a plan in a scratch account."
  type        = string
  default     = "cache.t4g.medium"
}

variable "redis_engine_version" {
  description = "ElastiCache Redis engine version. 7.1 supports in-transit encryption changes without replacement."
  type        = string
  default     = "7.1"
}

variable "redis_num_cache_clusters" {
  description = "Primary plus replicas. Two is the minimum for automatic failover."
  type        = number
  default     = 2
}

variable "redis_automatic_failover" {
  description = "Promote a replica when the primary fails. Requires redis_num_cache_clusters >= 2."
  type        = bool
  default     = true
}

variable "redis_snapshot_retention_days" {
  description = "Daily snapshot retention. BullMQ state is reconstructible from Postgres, so this is a convenience, not a recovery plan."
  type        = number
  default     = 3
}

/* -------------------------------------------------------------------------
 * Application configuration
 * ---------------------------------------------------------------------- */

variable "recall_region" {
  description = "Recall.ai region. NOT an AWS region and NOT ap-south-1 — Recall has no India region. One of: us-east-1, us-west-2, eu-central-1, ap-northeast-1. API keys, bots and webhook secrets are region-scoped and not portable."
  type        = string
  default     = "ap-northeast-1"

  validation {
    condition     = contains(["us-east-1", "us-west-2", "eu-central-1", "ap-northeast-1"], var.recall_region)
    error_message = "recall_region must be one of the four regions Recall operates in."
  }
}

variable "r2_bucket" {
  description = "Cloudflare R2 bucket for media artifacts. R2 has no Mumbai location; create it with --location apac, which is immutable after creation."
  type        = string
  default     = "mcos-artifacts"
}

variable "openai_model" {
  description = "Extraction model."
  type        = string
  default     = "gpt-5.6-terra"
}

variable "openai_reasoning_effort" {
  description = "minimal | low | medium | high."
  type        = string
  default     = "low"
}

variable "recall_bot_name" {
  description = "Name the bot shows in the participant list."
  type        = string
  default     = "Perfstaq Notetaker"
}

variable "recall_capture_video" {
  description = "Capture mixed video as well as audio. Costs more at Recall and in R2."
  type        = bool
  default     = false
}

variable "log_level" {
  description = "fatal | error | warn | info | debug | trace | silent."
  type        = string
  default     = "info"
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention. Must be a value CloudWatch accepts (1,3,5,7,14,30,60,90,120,150,180,365,400,545,731,1096,1827,2192,2557,2922,3288,3653) — 0 means never expire and is not offered here, because a log group with no retention is a bill that only grows."
  type        = number
  default     = 30

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653], var.log_retention_days)
    error_message = "log_retention_days must be one of CloudWatch's accepted retention values."
  }
}

variable "optional_secrets" {
  description = "Optional credentials to create in Secrets Manager and inject. Omit a name and the app never sees the variable at all — which is what env.ts wants for a provider that is not configured, because a half-configured OAuth provider is worse than an absent one. RECALL_SVIX_WEBHOOK_SECRET applies only to Recall accounts created before 2025-12-15."
  type        = list(string)
  default     = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET"]

  validation {
    condition = alltrue([
      for name in var.optional_secrets : contains([
        "GOOGLE_CLIENT_ID",
        "GOOGLE_CLIENT_SECRET",
        "MICROSOFT_CLIENT_ID",
        "MICROSOFT_CLIENT_SECRET",
        "RECALL_SVIX_WEBHOOK_SECRET",
      ], name)
    ])
    error_message = "optional_secrets may only contain names env.ts declares as optional."
  }
}

variable "microsoft_tenant_id" {
  description = "Entra ID tenant. 'common' allows any tenant plus personal accounts."
  type        = string
  default     = "common"
}

variable "rate_limit_max" {
  description = "Requests per window per actor."
  type        = number
  default     = 300
}

variable "rate_limit_window" {
  description = "Rate limit window, as @fastify/rate-limit parses it."
  type        = string
  default     = "1 minute"
}

variable "metrics_namespace" {
  description = "CloudWatch namespace for the embedded-metric-format counters emitted by observability.ts."
  type        = string
  default     = "MCOS"
}

/* -------------------------------------------------------------------------
 * Alarms
 * ---------------------------------------------------------------------- */

variable "alarm_sns_topic_arn" {
  description = "SNS topic that alarms notify. Empty creates the alarms without an action, which is a metric with a red light nobody sees — set it."
  type        = string
  default     = ""
}

/* -------------------------------------------------------------------------
 * CI/CD
 * ---------------------------------------------------------------------- */

variable "create_github_oidc_provider" {
  description = "Create the GitHub OIDC provider. An account can hold exactly one per issuer URL, so this must be false in the second environment if both share an AWS account."
  type        = bool
  default     = true
}

variable "github_deploy_branches" {
  description = "Branch refs allowed to assume the deploy role, in GitHub's sub-claim form."
  type        = list(string)
  default     = ["refs/heads/main"]
}

variable "github_deploy_environment" {
  description = "GitHub environment name whose jobs may assume the deploy role. This is the other half of the manual approval gate: the approval is enforced by GitHub, the scoping by this trust policy."
  type        = string
  default     = ""
}

variable "ecr_image_retention_count" {
  description = "Untagged and superseded images to keep. Rollback targets live here, so do not set this below the number of deploys you might need to walk back through."
  type        = number
  default     = 30
}
