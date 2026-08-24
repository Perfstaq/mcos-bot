/**
 * Three roles, three different trust relationships:
 *
 *   execution — what ECS itself assumes to pull the image, read the secrets
 *               and write the logs. Never available to code in the container.
 *   task      — what the container's own AWS SDK would get. Almost empty,
 *               because this application's storage is Cloudflare R2 and its
 *               model provider is OpenAI; it has no reason to call AWS at all.
 *   deploy    — what GitHub Actions assumes, via OIDC. No access keys exist
 *               anywhere in this design.
 */

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }

    # Confused-deputy guard: without these, any account that can persuade ECS
    # to assume this role gets it. Scoped to tasks in this account's cluster.
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:${data.aws_partition.current.partition}:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:*"]
    }
  }
}

/* -------------------------------------------------------------------------
 * Task execution role
 * ---------------------------------------------------------------------- */

resource "aws_iam_role" "execution" {
  name               = "${local.name}-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "execution_secrets" {
  # By prefix, not by a list of ARNs. A credential added to the application
  # later is a Terraform change to secrets.tf and nothing else; making it an
  # IAM change too is how a deploy fails at 3am on a permission nobody
  # remembered was per-secret.
  statement {
    sid    = "ReadApplicationSecrets"
    effect = "Allow"

    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      "arn:${data.aws_partition.current.partition}:secretsmanager:${var.aws_region}:${data.aws_caller_identity.current.account_id}:secret:${local.secret_prefix}/*",
    ]
  }

  statement {
    sid       = "DecryptApplicationSecrets"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.this.arn]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.${var.aws_region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  name   = "secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_secrets.json
}

/* -------------------------------------------------------------------------
 * Task role
 * ---------------------------------------------------------------------- */

resource "aws_iam_role" "task" {
  name               = "${local.name}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "task" {
  # The channel `aws ecs execute-command` runs over. Granted unconditionally
  # because the actual gate is enable_execute_command on the service; a role
  # that can open a session to a service which refuses them is inert.
  statement {
    sid    = "ExecuteCommandChannel"
    effect = "Allow"

    actions = [
      "ssmmessages:CreateControlChannel",
      "ssmmessages:CreateDataChannel",
      "ssmmessages:OpenControlChannel",
      "ssmmessages:OpenDataChannel",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "task" {
  name   = "runtime"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task.json
}

/* -------------------------------------------------------------------------
 * GitHub Actions — OIDC, no long-lived keys
 * ---------------------------------------------------------------------- */

/**
 * One provider per issuer URL per account, which is why this is optional: if
 * staging and production share an account, the second workspace must set
 * create_github_oidc_provider = false and the deploy role there references the
 * existing one via the data source below.
 *
 * No thumbprint_list. Per the AWS provider documentation, for GitHub (among
 * others) "AWS relies on its own library of trusted root certificate
 * authorities (CAs) for validation instead of using any configured
 * thumbprints" — so a hardcoded thumbprint here would be a value that looks
 * load-bearing, is not, and goes stale silently.
 * https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_openid_connect_provider
 */
resource "aws_iam_openid_connect_provider" "github" {
  count = var.enable_github_deploy_role && var.create_github_oidc_provider ? 1 : 0

  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

data "aws_iam_openid_connect_provider" "github" {
  count = var.enable_github_deploy_role && !var.create_github_oidc_provider ? 1 : 0
  url   = "https://token.actions.githubusercontent.com"
}

locals {
  github_oidc_arn = !var.enable_github_deploy_role ? "" : (
    var.create_github_oidc_provider
    ? aws_iam_openid_connect_provider.github[0].arn
    : data.aws_iam_openid_connect_provider.github[0].arn
  )

  # GitHub's sub claim. The environment form is the half of the production
  # approval gate that AWS can enforce: GitHub will not mint a token carrying
  # `environment:production` until a reviewer approves the job, and this trust
  # policy will not accept a token without it.
  github_subjects = concat(
    [for ref in var.github_deploy_branches : "repo:${var.repository}:ref:${ref}"],
    var.github_deploy_environment == "" ? [] : ["repo:${var.repository}:environment:${var.github_deploy_environment}"],
  )
}

data "aws_iam_policy_document" "github_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.github_oidc_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    # StringLike, not StringEquals, only because the value list is exact —
    # every entry is a fully qualified subject with no wildcard. A `repo:x/y:*`
    # here would hand the role to any pull request from a fork.
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = local.github_subjects
    }
  }
}

resource "aws_iam_role" "deploy" {
  count = var.enable_github_deploy_role ? 1 : 0

  name                 = "${local.name}-github-deploy"
  description          = "Assumed by GitHub Actions via OIDC to build, migrate and deploy"
  assume_role_policy   = data.aws_iam_policy_document.github_assume.json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "deploy" {
  statement {
    sid       = "EcrAuth"
    effect    = "Allow"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid    = "EcrPushPull"
    effect = "Allow"

    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:CompleteLayerUpload",
      "ecr:DescribeImages",
      "ecr:GetDownloadUrlForLayer",
      "ecr:InitiateLayerUpload",
      "ecr:PutImage",
      "ecr:UploadLayerPart",
    ]
    resources = [aws_ecr_repository.this.arn]
  }

  # RegisterTaskDefinition and DescribeTaskDefinition have no resource-level
  # permissions in IAM — they are "*" or nothing.
  statement {
    sid    = "TaskDefinitions"
    effect = "Allow"

    actions = [
      "ecs:RegisterTaskDefinition",
      "ecs:DescribeTaskDefinition",
      "ecs:ListTaskDefinitions",
    ]
    resources = ["*"]
  }

  # aws_ecs_service exposes its ARN as `id`; there is no separate `arn`
  # attribute in the 5.x provider.
  statement {
    sid    = "DeployServices"
    effect = "Allow"

    actions = [
      "ecs:UpdateService",
      "ecs:DescribeServices",
    ]
    resources = [
      aws_ecs_service.api.id,
      aws_ecs_service.worker.id,
    ]
  }

  statement {
    sid    = "RunMigrationTask"
    effect = "Allow"

    actions = [
      "ecs:RunTask",
      "ecs:DescribeTasks",
      "ecs:StopTask",
    ]
    resources = ["*"]

    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.this.arn]
    }
  }

  statement {
    sid       = "DescribeCluster"
    effect    = "Allow"
    actions   = ["ecs:DescribeClusters"]
    resources = [aws_ecs_cluster.this.arn]
  }

  # RunTask and UpdateService both hand the task's roles to ECS. Without the
  # PassedToService condition this is "assume any role in the account".
  statement {
    sid       = "PassTaskRoles"
    effect    = "Allow"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.execution.arn, aws_iam_role.task.arn]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }

  # Reading the migration task's own output back into the workflow log. A
  # failed migration should be diagnosable from the Actions run, not from a
  # second trip to the console.
  statement {
    sid    = "ReadMigrationLogs"
    effect = "Allow"

    actions = [
      "logs:GetLogEvents",
      "logs:DescribeLogStreams",
    ]
    resources = ["${aws_cloudwatch_log_group.migrate.arn}:*"]
  }

  # The deploy manifest: cluster name, service names, subnets, security group.
  # Non-secret, but account-specific, which is exactly what must not be in the
  # workflow file.
  statement {
    sid       = "ReadDeployManifest"
    effect    = "Allow"
    actions   = ["ssm:GetParameter"]
    resources = [aws_ssm_parameter.deploy_manifest.arn]
  }
}

resource "aws_iam_role_policy" "deploy" {
  count = var.enable_github_deploy_role ? 1 : 0

  name   = "deploy"
  role   = aws_iam_role.deploy[0].id
  policy = data.aws_iam_policy_document.deploy.json
}
