/**
 * ElastiCache Redis — the BullMQ backing store.
 *
 * Not a cache. Losing this loses in-flight jobs: webhooks accepted but not yet
 * processed, recordings mid-ingest, extractions queued. Recall retries
 * non-2xx, but we return 2xx before enqueueing, so a dropped queue is a
 * dropped meeting. Hence a replica and automatic failover rather than a single
 * node, and hence the snapshot retention — which is a convenience, not the
 * recovery plan. The recovery plan is that webhook_events holds every raw
 * payload and can be replayed.
 */

resource "aws_elasticache_subnet_group" "this" {
  name       = local.name
  subnet_ids = aws_subnet.private[*].id
  tags       = { Name = local.name }
}

resource "aws_security_group" "cache" {
  name        = "${local.name}-cache"
  description = "Redis from the ECS tasks only"
  vpc_id      = aws_vpc.this.id

  tags = { Name = "${local.name}-cache" }
}

resource "aws_vpc_security_group_ingress_rule" "cache_from_tasks" {
  security_group_id            = aws_security_group.cache.id
  description                  = "Redis from ECS tasks"
  from_port                    = 6379
  to_port                      = 6379
  ip_protocol                  = "tcp"
  referenced_security_group_id = aws_security_group.tasks.id
}

resource "aws_elasticache_parameter_group" "this" {
  name        = "${local.name}-redis"
  family      = "redis7"
  description = "${local.name} Redis parameters"

  /**
   * noeviction, explicitly.
   *
   * BullMQ keeps job state in Redis keys. Under an allkeys-lru policy a memory
   * spike silently evicts jobs and the queue reports itself empty — the worst
   * possible failure mode, because nothing errors. noeviction turns the same
   * spike into write errors that are loud, retryable and alarmable.
   */
  parameter {
    name  = "maxmemory-policy"
    value = "noeviction"
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_cloudwatch_log_group" "redis_slow" {
  name              = "/elasticache/${local.name}/slow-log"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.this.arn
}

resource "aws_elasticache_replication_group" "this" {
  replication_group_id = local.name
  description          = "${local.name} BullMQ queues"

  engine         = "redis"
  engine_version = var.redis_engine_version
  node_type      = var.redis_node_type
  port           = 6379

  num_cache_clusters = var.redis_num_cache_clusters
  # Both flags are gated on the node count, not just multi_az_enabled. AWS
  # rejects automatic failover on a single-node group, so asking for one node
  # and leaving failover at its default made the plan fail with an error about
  # a variable the operator never set. Failover is a property of having a
  # replica; it cannot be requested independently of one.
  automatic_failover_enabled = var.redis_automatic_failover && var.redis_num_cache_clusters > 1
  multi_az_enabled           = var.redis_automatic_failover && var.redis_num_cache_clusters > 1

  subnet_group_name    = aws_elasticache_subnet_group.this.name
  security_group_ids   = [aws_security_group.cache.id]
  parameter_group_name = aws_elasticache_parameter_group.this.name

  at_rest_encryption_enabled = true
  kms_key_id                 = aws_kms_key.this.arn
  transit_encryption_enabled = true
  auth_token                 = random_password.redis_auth.result
  # Rotating an auth token in place: ROTATE accepts both the old and the new
  # token during the transition, so tasks that have not picked up the new
  # REDIS_URL keep working. SET would cut them off mid-deploy.
  auth_token_update_strategy = "ROTATE"

  snapshot_retention_limit = var.redis_snapshot_retention_days
  snapshot_window          = "19:00-20:00"
  maintenance_window       = "tue:22:00-tue:23:00"

  auto_minor_version_upgrade = true
  apply_immediately          = false

  log_delivery_configuration {
    destination      = aws_cloudwatch_log_group.redis_slow.name
    destination_type = "cloudwatch-logs"
    log_format       = "json"
    log_type         = "slow-log"
  }

  tags = { Name = local.name }
}
