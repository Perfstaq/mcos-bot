/**
 * The alarms that are allowed to wake someone.
 *
 * Every threshold here has a reason written next to it, because an alarm whose
 * threshold nobody can justify is an alarm that gets muted after the second
 * false page and is then absent during the real one. The full list — including
 * what is deliberately NOT alarmed — is in docs/OBSERVABILITY.md.
 *
 * Alarms are created whether or not an SNS topic is configured. A red light
 * nobody is subscribed to is still better than a metric nobody looked at, and
 * wiring the topic later is a variable change.
 */

locals {
  alarm_actions = var.alarm_sns_topic_arn == "" ? [] : [var.alarm_sns_topic_arn]

  # Metric names as observability.ts emits them: the BullMQ queue name with
  # non-alphanumerics stripped. Change one and this list must follow.
  queue_metrics = {
    webhook          = "QueueWaiting_webhook"
    ingestrecording  = "QueueWaiting_ingestrecording"
    ingesttranscript = "QueueWaiting_ingesttranscript"
    extract          = "QueueWaiting_extract"
  }

  emf_dimensions = {
    Service     = "worker"
    Environment = var.environment
  }
}

/* -------------------------------------------------------------------------
 * Application counters (CloudWatch Embedded Metric Format)
 * ---------------------------------------------------------------------- */

/**
 * Webhook signature verification failing is the highest-signal event this
 * system produces. Two causes, both urgent and indistinguishable from the
 * count alone: Recall rotated the workspace secret (in which case every
 * meeting silently stops ingesting), or someone is posting forged payloads.
 *
 * Five in five minutes rather than one: an internet-facing endpoint collects
 * scanner traffic, and a single unsigned POST is not an incident. A rotated
 * secret produces far more than five within one Recall retry cycle.
 */
resource "aws_cloudwatch_metric_alarm" "webhook_verification_failures" {
  alarm_name        = "${local.name}-webhook-verification-failures"
  alarm_description = "Recall webhook signatures are not verifying. Check whether the workspace secret was rotated: docs/RUNBOOK.md."

  namespace   = var.metrics_namespace
  metric_name = "WebhookVerificationFailures"
  dimensions = {
    Service     = "api"
    Environment = var.environment
  }

  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 5
  comparison_operator = "GreaterThanOrEqualToThreshold"
  # No failures means no data point at all. That is the healthy state.
  treat_missing_data = "notBreaching"

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions
}

/**
 * Extraction failing means meetings are reaching transcript_ready and stopping
 * before the review queue — invisible to a user until they wonder where their
 * claims went. Three in fifteen minutes filters the single OpenAI timeout that
 * the job's own retries already handle.
 */
resource "aws_cloudwatch_metric_alarm" "extraction_failures" {
  alarm_name        = "${local.name}-extraction-failures"
  alarm_description = "Extraction jobs are failing permanently. Meetings are stuck before the review queue."

  namespace   = var.metrics_namespace
  metric_name = "ExtractionFailures"
  dimensions  = local.emf_dimensions

  statistic           = "Sum"
  period              = 900
  evaluation_periods  = 1
  threshold           = 3
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions
}

/**
 * A permanently failed job of any kind marks its meeting failed. Individually
 * survivable; a cluster of them is a third party being down or a bad deploy.
 */
resource "aws_cloudwatch_metric_alarm" "job_failures" {
  alarm_name        = "${local.name}-job-failures"
  alarm_description = "Jobs are exhausting their retries. Check which queue in the worker log group."

  namespace   = var.metrics_namespace
  metric_name = "JobFailures"
  dimensions  = local.emf_dimensions

  statistic           = "Sum"
  period              = 900
  evaluation_periods  = 1
  threshold           = 5
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions
}

/**
 * Queue depth: the number that shows the pipeline has stopped without anything
 * having failed. Dead workers, a full Redis, or OpenAI rate-limiting every
 * extraction into backoff all look normal in the job logs and obvious here.
 *
 * Maximum, not Sum: every worker replica publishes the same gauge each minute,
 * so a Sum reads as N times the real backlog.
 *
 * Two evaluation periods of five minutes, because a burst of meetings ending at
 * the top of the hour is a legitimate spike. Ten minutes of sustained backlog
 * is not.
 */
resource "aws_cloudwatch_metric_alarm" "queue_backlog" {
  for_each = local.queue_metrics

  alarm_name        = "${local.name}-queue-backlog-${each.key}"
  alarm_description = "The ${each.key} queue is not draining. See docs/RUNBOOK.md § 'The queue is backing up'."

  namespace   = var.metrics_namespace
  metric_name = each.value
  dimensions  = local.emf_dimensions

  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  threshold           = each.key == "extract" ? 50 : 200
  comparison_operator = "GreaterThanThreshold"
  # Missing data here means the reporter stopped, not that the queue is empty —
  # but a scale-in to zero workers produces the same gap, so this does not alarm
  # on absence. Absence is covered by the running-task-count alarm below.
  treat_missing_data = "missing"

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions
}

/* -------------------------------------------------------------------------
 * Platform
 * ---------------------------------------------------------------------- */

# Zero running workers with a non-empty queue is the failure the queue alarm
# cannot see. Container Insights publishes this; the cluster enables it.
resource "aws_cloudwatch_metric_alarm" "worker_tasks_running" {
  alarm_name        = "${local.name}-worker-no-tasks"
  alarm_description = "The worker service has no running tasks. Nothing is draining any queue."

  namespace   = "ECS/ContainerInsights"
  metric_name = "RunningTaskCount"
  dimensions = {
    ClusterName = aws_ecs_cluster.this.name
    ServiceName = aws_ecs_service.worker.name
  }

  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 5
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions
}

# Unhealthy targets: tasks failing /readyz. During a deploy this is expected
# briefly, which is what the five evaluation periods absorb.
resource "aws_cloudwatch_metric_alarm" "alb_unhealthy_targets" {
  alarm_name        = "${local.name}-alb-unhealthy-targets"
  alarm_description = "API tasks are failing the /readyz health check. Check for pending migrations first."

  namespace   = "AWS/ApplicationELB"
  metric_name = "UnHealthyHostCount"
  dimensions = {
    LoadBalancer = aws_lb.this.arn_suffix
    TargetGroup  = aws_lb_target_group.api.arn_suffix
  }

  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 5
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions
}

# 5xx from the load balancer itself — no healthy target, or a target that
# never answered. Distinct from a 500 the application chose to return, which
# is in HTTPCode_Target_5XX_Count and is a bug report, not a page.
resource "aws_cloudwatch_metric_alarm" "alb_5xx" {
  alarm_name        = "${local.name}-alb-5xx"
  alarm_description = "The load balancer is returning 5xx without reaching a target."

  namespace   = "AWS/ApplicationELB"
  metric_name = "HTTPCode_ELB_5XX_Count"
  dimensions  = { LoadBalancer = aws_lb.this.arn_suffix }

  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 10
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "rds_cpu" {
  alarm_name        = "${local.name}-rds-cpu"
  alarm_description = "Database CPU sustained above 80%. Check pg_stat_statements before scaling."

  namespace   = "AWS/RDS"
  metric_name = "CPUUtilization"
  dimensions  = { DBInstanceIdentifier = aws_db_instance.this.identifier }

  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "missing"

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions
}

/**
 * Storage autoscaling raises the ceiling on its own, but it is rate-limited —
 * it will not act more than once every six hours. Twenty percent of the current
 * allocation is roughly the margin that survives one such interval under an
 * ingest burst.
 */
resource "aws_cloudwatch_metric_alarm" "rds_storage" {
  alarm_name        = "${local.name}-rds-free-storage"
  alarm_description = "Database free storage below 20% of allocated. Storage autoscaling may not keep up."

  namespace   = "AWS/RDS"
  metric_name = "FreeStorageSpace"
  dimensions  = { DBInstanceIdentifier = aws_db_instance.this.identifier }

  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 2
  threshold           = var.db_allocated_storage * 0.2 * 1024 * 1024 * 1024
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "missing"

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions
}

/**
 * maxmemory-policy is noeviction (see elasticache.tf), so a full Redis returns
 * write errors rather than silently dropping jobs. That is the right failure
 * mode and it is still an outage of the ingest pipeline — 80% is the point at
 * which there is time to act rather than react.
 */
resource "aws_cloudwatch_metric_alarm" "redis_memory" {
  alarm_name        = "${local.name}-redis-memory"
  alarm_description = "Redis memory above 80%. With noeviction, a full Redis rejects new jobs."

  namespace   = "AWS/ElastiCache"
  metric_name = "DatabaseMemoryUsagePercentage"
  dimensions  = { ReplicationGroupId = aws_elasticache_replication_group.this.replication_group_id }

  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "missing"

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions
}
