/**
 * The compute. One ECR repository, one image, three things run from it:
 *
 *   api      node apps/api/dist/server.js   long-running, behind the ALB
 *   worker   node apps/api/dist/worker.js   long-running, no listener
 *   migrate  prisma migrate deploy          one-off, run by the deploy workflow
 *
 * The migrate task definition exists here rather than being an inline override
 * in the workflow so that its command, its log group and its secrets are
 * reviewable in the same place as everything else — and so a human can run the
 * exact same task by hand during an incident.
 */

resource "aws_ecr_repository" "this" {
  name                 = local.name
  image_tag_mutability = "IMMUTABLE"
  force_delete         = !local.is_production

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.this.arn
  }

  tags = { Name = local.name }
}

/**
 * IMMUTABLE tags above plus this policy is the rollback story: every deploy
 * pushes a tag that is the commit SHA and can never be repointed, so
 * "roll back to what was running an hour ago" is an unambiguous instruction.
 * Do not lower the count below the number of deploys you might walk back.
 */
resource "aws_ecr_lifecycle_policy" "this" {
  repository = aws_ecr_repository.this.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged layers quickly; they are build residue."
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 7
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Keep the most recent tagged images as rollback targets."
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = var.ecr_image_retention_count
        }
        action = { type = "expire" }
      },
    ]
  })
}

resource "aws_ecs_cluster" "this" {
  name = local.name

  setting {
    name  = "containerInsights"
    value = local.is_production ? "enhanced" : "enabled"
  }

  tags = { Name = local.name }
}

resource "aws_ecs_cluster_capacity_providers" "this" {
  cluster_name = aws_ecs_cluster.this.name
  # FARGATE_SPOT is deliberately absent. A spot reclamation mid-extraction is
  # survivable (the job retries) but a reclaimed API task drops WebSocket
  # editing sessions, and the saving is not worth explaining that at 3am.
  capacity_providers = ["FARGATE"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
    base              = 0
  }
}

/* -------------------------------------------------------------------------
 * Logs
 * ---------------------------------------------------------------------- */

resource "aws_cloudwatch_log_group" "api" {
  name              = "/ecs/${local.name}/api"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.this.arn
}

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/ecs/${local.name}/worker"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.this.arn
}

# Migrations get their own group so a failed deploy is one console click, not a
# filter expression across every API line emitted in the same minute.
resource "aws_cloudwatch_log_group" "migrate" {
  name              = "/ecs/${local.name}/migrate"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.this.arn
}

/* -------------------------------------------------------------------------
 * Task networking
 * ---------------------------------------------------------------------- */

resource "aws_security_group" "tasks" {
  name        = "${local.name}-tasks"
  description = "ECS tasks: inbound from the ALB only, outbound anywhere"
  vpc_id      = aws_vpc.this.id

  tags = { Name = "${local.name}-tasks" }
}

resource "aws_vpc_security_group_ingress_rule" "tasks_from_alb" {
  security_group_id            = aws_security_group.tasks.id
  description                  = "API port from the load balancer"
  from_port                    = var.container_port
  to_port                      = var.container_port
  ip_protocol                  = "tcp"
  referenced_security_group_id = aws_security_group.alb.id
}

# Unrestricted egress, because the destinations are Recall, OpenAI and
# Cloudflare R2 — three third parties with large, undocumented and changing IP
# ranges. Narrowing this to CIDRs would be a maintenance burden that fails
# closed on somebody else's schedule.
resource "aws_vpc_security_group_egress_rule" "tasks_all" {
  security_group_id = aws_security_group.tasks.id
  description       = "Outbound to third-party APIs, AWS endpoints and the data stores"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

/* -------------------------------------------------------------------------
 * Container definitions
 * ---------------------------------------------------------------------- */

locals {
  image = "${aws_ecr_repository.this.repository_url}:${var.image_tag}"

  # Non-secret configuration. Everything here is safe in a plan output and in
  # the ECS console; anything that is not lives in local.container_secrets.
  common_environment = [
    { name = "NODE_ENV", value = "production" },
    { name = "PORT", value = tostring(var.container_port) },
    { name = "HOST", value = "0.0.0.0" },
    { name = "LOG_LEVEL", value = var.log_level },
    { name = "APP_BASE_URL", value = "${local.public_url}" },
    { name = "WEB_ORIGIN", value = "${local.public_url}" },
    { name = "ALLOWED_ORIGINS", value = "${local.public_url}" },
    { name = "AWS_REGION", value = var.aws_region },
    { name = "RECALL_REGION", value = var.recall_region },
    { name = "RECALL_BOT_NAME", value = var.recall_bot_name },
    { name = "RECALL_CAPTURE_VIDEO", value = tostring(var.recall_capture_video) },
    { name = "R2_BUCKET", value = var.r2_bucket },
    { name = "OPENAI_MODEL", value = var.openai_model },
    { name = "OPENAI_REASONING_EFFORT", value = var.openai_reasoning_effort },
    { name = "MICROSOFT_TENANT_ID", value = var.microsoft_tenant_id },
    { name = "RATE_LIMIT_MAX", value = tostring(var.rate_limit_max) },
    { name = "RATE_LIMIT_WINDOW", value = var.rate_limit_window },
    { name = "TRUST_PROXY", value = "true" },
    # env.ts refuses this in production regardless of the value. Set explicitly
    # so nobody has to go and check that it does.
    { name = "AUTH_DEV_HEADERS", value = "false" },
    { name = "METRICS_NAMESPACE", value = var.metrics_namespace },
    { name = "DEPLOY_ENV", value = var.environment },
  ]

  container_secrets = [
    for name in sort(tolist(local.all_secret_names)) : {
      name      = name
      valueFrom = aws_secretsmanager_secret.app[name].arn
    }
  ]

  log_configuration = {
    api     = { group = aws_cloudwatch_log_group.api.name, prefix = "api" }
    worker  = { group = aws_cloudwatch_log_group.worker.name, prefix = "worker" }
    migrate = { group = aws_cloudwatch_log_group.migrate.name, prefix = "migrate" }
  }
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${local.name}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.api_cpu)
  memory                   = tostring(var.api_memory)
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.task_cpu_architecture
  }

  container_definitions = jsonencode([
    {
      name      = "api"
      image     = local.image
      essential = true
      # The Dockerfile's CMD, restated. An override that matches the default is
      # not redundant here: it is the only place a reader can see both commands
      # side by side and confirm they come from one image.
      command = ["node", "apps/api/dist/server.js"]

      portMappings = [{ containerPort = var.container_port, protocol = "tcp" }]

      environment = concat(local.common_environment, [{ name = "SERVICE_NAME", value = "api" }])
      secrets     = local.container_secrets

      # Liveness, not readiness. /healthz says the process can reach Postgres
      # and Redis; a task failing this should be replaced. Readiness is the
      # ALB's business and points at /readyz — see alb.tf.
      healthCheck = {
        command     = ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:${var.container_port}/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 30
      }

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = local.log_configuration.api.group
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = local.log_configuration.api.prefix
        }
      }
    }
  ])

  tags = { Name = "${local.name}-api" }
}

resource "aws_ecs_task_definition" "worker" {
  family                   = "${local.name}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.worker_cpu)
  memory                   = tostring(var.worker_memory)
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.task_cpu_architecture
  }

  container_definitions = jsonencode([
    {
      name      = "worker"
      image     = local.image
      essential = true
      command   = ["node", "apps/api/dist/worker.js"]

      environment = concat(local.common_environment, [{ name = "SERVICE_NAME", value = "worker" }])
      secrets     = local.container_secrets

      /**
       * 120s, the Fargate maximum. worker.ts closes every BullMQ worker on
       * SIGTERM, which waits for in-flight jobs; an extraction that is mid-call
       * to OpenAI needs most of this. Anything still running when it expires is
       * SIGKILLed and the job is retried, which is safe — every job in this
       * pipeline is idempotent — but retrying an extraction costs real money.
       */
      stopTimeout = 120

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = local.log_configuration.worker.group
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = local.log_configuration.worker.prefix
        }
      }
    }
  ])

  tags = { Name = "${local.name}-worker" }
}

/**
 * Migrations. Run as a one-off task by the deploy workflow BEFORE either
 * service is updated, so the new schema is in place before any code that
 * depends on it starts serving.
 *
 * NOTE FOR THE INTEGRATOR — this task cannot work as the Dockerfile stands.
 * The build runs `npm prune --omit=dev`, and `prisma` (the CLI) is a
 * devDependency, so `npx prisma` in the runtime image either fails or silently
 * downloads a version from npm at run time. `prisma` must move to
 * `dependencies` in apps/api/package.json — a file this build is not permitted
 * to edit. var.migrate_command exists so an alternative invocation is a tfvars
 * change if that move is not made.
 */
resource "aws_ecs_task_definition" "migrate" {
  family                   = "${local.name}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.task_cpu_architecture
  }

  container_definitions = jsonencode([
    {
      name      = "migrate"
      image     = local.image
      essential = true
      command   = var.migrate_command

      environment = concat(local.common_environment, [{ name = "SERVICE_NAME", value = "migrate" }])
      secrets     = local.container_secrets

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = local.log_configuration.migrate.group
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = local.log_configuration.migrate.prefix
        }
      }
    }
  ])

  tags = { Name = "${local.name}-migrate" }
}

/* -------------------------------------------------------------------------
 * Services
 * ---------------------------------------------------------------------- */

resource "aws_ecs_service" "api" {
  name             = "${local.name}-api"
  cluster          = aws_ecs_cluster.this.id
  task_definition  = aws_ecs_task_definition.api.arn
  desired_count    = var.api_desired_count
  launch_type      = "FARGATE"
  platform_version = var.fargate_platform_version

  enable_execute_command = var.enable_execute_command
  propagate_tags         = "SERVICE"

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = var.container_port
  }

  # Two generations of tasks at once during a deploy, never fewer than the
  # current count healthy. With desired_count >= 2 this is a zero-downtime
  # rolling update.
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  /**
   * The safety net that matters most at 3am: a deployment whose tasks never
   * pass /readyz is rolled back automatically instead of sitting half-applied
   * until somebody notices. This is why the migration step runs first — a
   * circuit breaker cannot undo a migration.
   */
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  # /readyz has to answer within this window on a cold task. Prisma's client
  # init plus the first connection is the slow part.
  health_check_grace_period_seconds = 90

  lifecycle {
    /**
     * The deploy workflow, not Terraform, moves the image forward: it
     * registers a new task definition revision and calls UpdateService.
     * Without this, the next `terraform apply` would quietly redeploy whatever
     * var.image_tag happened to be — usually an older build. desired_count is
     * ignored for the same reason: autoscaling owns it after the first apply.
     */
    ignore_changes = [task_definition, desired_count]
  }

  depends_on = [aws_lb_listener.https]

  tags = { Name = "${local.name}-api" }
}

resource "aws_ecs_service" "worker" {
  name             = "${local.name}-worker"
  cluster          = aws_ecs_cluster.this.id
  task_definition  = aws_ecs_task_definition.worker.arn
  desired_count    = var.worker_desired_count
  launch_type      = "FARGATE"
  platform_version = var.fargate_platform_version

  enable_execute_command = var.enable_execute_command
  propagate_tags         = "SERVICE"

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = false
  }

  # Workers have no health check to fail, so a bad image would roll forever
  # without the circuit breaker: ECS treats repeated task exits as a failed
  # deployment and reverts.
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }

  tags = { Name = "${local.name}-worker" }
}

/* -------------------------------------------------------------------------
 * Autoscaling
 *
 * CPU target tracking on both services. The honest limitation: the worker's
 * real load signal is queue depth, not CPU — a worker blocked on an OpenAI
 * call is idle and busy at the same time. Scaling on the queue-depth metric
 * observability.ts emits is the obvious next step and is NOT wired up; see
 * docs/OBSERVABILITY.md § "Not covered yet".
 * ---------------------------------------------------------------------- */

resource "aws_appautoscaling_target" "api" {
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.this.name}/${aws_ecs_service.api.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = var.api_desired_count
  max_capacity       = var.api_max_count
}

resource "aws_appautoscaling_policy" "api_cpu" {
  name               = "${local.name}-api-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.api.service_namespace
  resource_id        = aws_appautoscaling_target.api.resource_id
  scalable_dimension = aws_appautoscaling_target.api.scalable_dimension

  target_tracking_scaling_policy_configuration {
    target_value = 60

    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }

    scale_in_cooldown  = 300
    scale_out_cooldown = 60
  }
}

resource "aws_appautoscaling_target" "worker" {
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.this.name}/${aws_ecs_service.worker.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = var.worker_desired_count
  max_capacity       = var.worker_max_count
}

resource "aws_appautoscaling_policy" "worker_cpu" {
  name               = "${local.name}-worker-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.worker.service_namespace
  resource_id        = aws_appautoscaling_target.worker.resource_id
  scalable_dimension = aws_appautoscaling_target.worker.scalable_dimension

  target_tracking_scaling_policy_configuration {
    target_value = 65

    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }

    # Slow to scale in: killing a worker mid-extraction costs an OpenAI call.
    scale_in_cooldown  = 600
    scale_out_cooldown = 60
  }
}

/* -------------------------------------------------------------------------
 * Deploy manifest
 * ---------------------------------------------------------------------- */

/**
 * Everything the deploy workflow needs to know about this environment, in one
 * parameter it reads at run time.
 *
 * The alternative is subnet ids, security group ids and an account number in
 * .github/workflows/deploy.yml, committed to a repository. None of it is
 * secret, all of it is account-specific, and none of it belongs in git. The
 * workflow needs exactly two facts from GitHub: the role to assume and the
 * region to assume it in.
 */
resource "aws_ssm_parameter" "deploy_manifest" {
  name = "/mcos/${var.environment}/deploy-manifest"
  type = "String"
  tier = "Standard"

  value = jsonencode({
    cluster                = aws_ecs_cluster.this.name
    api_service            = aws_ecs_service.api.name
    worker_service         = aws_ecs_service.worker.name
    api_task_family        = aws_ecs_task_definition.api.family
    worker_task_family     = aws_ecs_task_definition.worker.family
    migrate_task_family    = aws_ecs_task_definition.migrate.family
    migrate_log_group      = aws_cloudwatch_log_group.migrate.name
    ecr_repository_url     = aws_ecr_repository.this.repository_url
    subnets                = aws_subnet.private[*].id
    security_group         = aws_security_group.tasks.id
    api_container_name     = "api"
    worker_container_name  = "worker"
    migrate_container_name = "migrate"
    # For the workflow's post-deploy smoke check. Public and non-secret, but it
    # still belongs here rather than in the workflow: staging and production
    # differ, and a hostname hardcoded in CI is a hostname that goes stale.
    public_url = "${local.public_url}"
  })

  tags = { Name = "${local.name}-deploy-manifest" }
}
