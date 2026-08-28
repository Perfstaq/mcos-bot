/**
 * Every credential the application reads, and the key that encrypts them.
 *
 * The rule this file exists to enforce: no secret value is ever in git, in a
 * .tfvars, or in a plan output. Terraform creates the *containers* and a
 * placeholder version; a human writes the real value once with the AWS CLI,
 * and `ignore_changes` means Terraform never reads it back or reverts it. See
 * docs/RUNBOOK.md § "Rotating a secret".
 *
 * Two exceptions, both deliberate:
 *   REDIS_URL   — Terraform knows the endpoint and generates the auth token,
 *                 so it composes the whole URL. Nobody should be assembling a
 *                 rediss:// string by hand at 3am.
 *   DATABASE_URL — a placeholder, because the application must NOT connect as
 *                 the RDS master user. First deploy creates a least-privilege
 *                 role and writes the URL. See the runbook.
 *
 * Consequence to be honest about: the ElastiCache auth token is in Terraform
 * state. State is in S3 with encryption and versioning on and is readable only
 * by the deploy role — treat the state bucket as a secret store, because it is.
 */

resource "aws_kms_key" "this" {
  description             = "${local.name} — secrets, database, cache and log encryption"
  enable_key_rotation     = true
  deletion_window_in_days = local.is_production ? 30 : 7

  policy = data.aws_iam_policy_document.kms.json

  tags = { Name = local.name }
}

resource "aws_kms_alias" "this" {
  name          = "alias/${local.name}"
  target_key_id = aws_kms_key.this.key_id
}

data "aws_iam_policy_document" "kms" {
  # Without this the key is unmanageable: KMS has no implicit account access,
  # so a key policy that omits the root principal locks everyone out including
  # the account that created it.
  statement {
    sid       = "AccountAdministration"
    effect    = "Allow"
    actions   = ["kms:*"]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = ["arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
  }

  # CloudWatch Logs encrypts with the key itself rather than through a caller's
  # credentials, so it needs its own grant. The ArnLike condition scopes it to
  # this account's log groups instead of every log group in the region.
  statement {
    sid    = "CloudWatchLogs"
    effect = "Allow"

    actions = [
      "kms:Encrypt*",
      "kms:Decrypt*",
      "kms:ReEncrypt*",
      "kms:GenerateDataKey*",
      "kms:Describe*",
    ]
    resources = ["*"]

    principals {
      type        = "Service"
      identifiers = ["logs.${var.aws_region}.amazonaws.com"]
    }

    condition {
      test     = "ArnLike"
      variable = "kms:EncryptionContext:aws:logs:arn"
      values   = ["arn:${data.aws_partition.current.partition}:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:*"]
    }
  }
}

/* -------------------------------------------------------------------------
 * Application secrets
 * ---------------------------------------------------------------------- */

locals {
  # Required by env.ts — the API refuses to boot without any of these, which is
  # the correct behaviour and also why the first deploy fails until they are
  # filled in. That failure is the system working.
  required_secrets = [
    "DATABASE_URL",
    "RECALLAI_API_KEY",
    "RECALL_WEBHOOK_SECRET",
    "OPENAI_API_KEY",
    "CF_ACCOUNT_ID",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "BETTER_AUTH_SECRET",
  ]

  # Human-written secrets: placeholder now, real value out of band.
  placeholder_secrets = toset(concat(local.required_secrets, var.optional_secrets))

  # Terraform-written secrets: composed from resources in this stack.
  derived_secrets = toset(["REDIS_URL"])

  all_secret_names = setunion(local.placeholder_secrets, local.derived_secrets)

  # A short recovery window in staging so a rebuild is not blocked for a month
  # by a name that is scheduled for deletion. Production keeps the safety net.
  secret_recovery_days = local.is_production ? 7 : 0
}

resource "aws_secretsmanager_secret" "app" {
  for_each = local.all_secret_names

  name                    = "${local.secret_prefix}/${each.value}"
  description             = "${each.value} for MCOS ${var.environment}"
  kms_key_id              = aws_kms_key.this.arn
  recovery_window_in_days = local.secret_recovery_days

  tags = { Name = "${local.secret_prefix}/${each.value}" }
}

/**
 * A placeholder, not a value. The string is deliberately one that cannot work
 * anywhere — a secret that is still "REPLACE_ME" fails loudly at boot instead
 * of quietly authenticating as something unexpected.
 *
 * ignore_changes is what makes the whole scheme hold: after a human writes the
 * real value, Terraform sees drift and is told not to care. Removing it would
 * mean every apply silently reverts production credentials to REPLACE_ME.
 */
resource "aws_secretsmanager_secret_version" "placeholder" {
  for_each = local.placeholder_secrets

  secret_id     = aws_secretsmanager_secret.app[each.value].id
  secret_string = "REPLACE_ME"

  lifecycle {
    ignore_changes = [secret_string, version_stages]
  }
}

/**
 * Redis connection string, composed here because Terraform is the only thing
 * that holds both halves.
 *
 * rediss:// — not redis:// — because transit encryption is on. ioredis picks
 * TLS from the scheme, and BullMQ inherits the connection, so this one
 * character is the difference between a working queue and a connection reset
 * that looks like a network fault. Empty username, token as password, which is
 * how Redis AUTH maps onto a URL.
 */
resource "aws_secretsmanager_secret_version" "redis_url" {
  secret_id = aws_secretsmanager_secret.app["REDIS_URL"].id
  secret_string = format(
    "rediss://:%s@%s:%d",
    urlencode(random_password.redis_auth.result),
    aws_elasticache_replication_group.this.primary_endpoint_address,
    aws_elasticache_replication_group.this.port,
  )
}

/**
 * ElastiCache auth token. Alphanumeric only: the token has to survive being a
 * URL password, and ElastiCache separately forbids '/', '"', '@' and spaces.
 * 64 characters of base62 is ~380 bits, so dropping punctuation costs nothing
 * that matters and removes a whole class of escaping bug.
 */
resource "random_password" "redis_auth" {
  length  = 64
  special = false
}
