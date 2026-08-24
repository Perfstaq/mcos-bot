/**
 * RDS Postgres 16. The system of record for everything except media.
 *
 * Multi-AZ, encrypted with the stack's CMK, automated backups, deletion
 * protection. The append-only tables (review_decisions, brief_versions,
 * brief_claims, state_transitions, webhook_events) mean point-in-time recovery
 * is a real recovery story rather than a formality — the history is in the
 * database, so a restore reconstructs what a reviewer actually decided.
 */

resource "aws_db_subnet_group" "this" {
  name       = local.name
  subnet_ids = aws_subnet.private[*].id
  tags       = { Name = local.name }
}

resource "aws_security_group" "database" {
  name        = "${local.name}-db"
  description = "Postgres from the ECS tasks only"
  vpc_id      = aws_vpc.this.id

  tags = { Name = "${local.name}-db" }
}

# Separate rule resources rather than inline blocks: an inline egress/ingress
# block makes the security group and its rules one resource, so adding a rule
# later shows up as a replacement of the group every service references.
resource "aws_vpc_security_group_ingress_rule" "database_from_tasks" {
  security_group_id            = aws_security_group.database.id
  description                  = "Postgres from ECS tasks"
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  referenced_security_group_id = aws_security_group.tasks.id
}

resource "aws_db_parameter_group" "this" {
  name        = "${local.name}-pg${var.db_engine_version}"
  family      = "postgres${var.db_engine_version}"
  description = "${local.name} Postgres parameters"

  # Reject any connection that is not TLS. The application connects over the
  # private subnets, but "inside the VPC" is not an encryption story.
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  # Static parameter: takes effect on reboot, not on apply. Terraform would
  # otherwise report success while the setting sits pending.
  parameter {
    name         = "shared_preload_libraries"
    value        = "pg_stat_statements"
    apply_method = "pending-reboot"
  }

  # Anything slower than a second is either a missing index or a query that is
  # not using the GIN expression indexes — both worth a log line, neither
  # frequent enough to drown the log group.
  parameter {
    name  = "log_min_duration_statement"
    value = "1000"
  }

  parameter {
    name  = "log_autovacuum_min_duration"
    value = "1000"
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_iam_role" "rds_monitoring" {
  name               = "${local.name}-rds-monitoring"
  assume_role_policy = data.aws_iam_policy_document.rds_monitoring_assume.json
}

data "aws_iam_policy_document" "rds_monitoring_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["monitoring.rds.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy_attachment" "rds_monitoring" {
  role       = aws_iam_role.rds_monitoring.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}

resource "aws_db_instance" "this" {
  identifier     = local.name
  engine         = "postgres"
  engine_version = var.db_engine_version
  instance_class = var.db_instance_class

  db_name  = "mcos"
  username = "mcos_master"

  /**
   * RDS creates the master password, stores it in Secrets Manager and rotates
   * it. The alternative — a random_password here — puts a live database
   * credential in Terraform state forever. The trade is that Terraform cannot
   * compose DATABASE_URL, which is fine: the application must not be
   * connecting as the master user anyway. First deploy creates an owner role
   * and writes the URL by hand. See docs/RUNBOOK.md § "First deploy".
   */
  manage_master_user_password   = true
  master_user_secret_kms_key_id = aws_kms_key.this.key_id

  allocated_storage     = var.db_allocated_storage
  max_allocated_storage = var.db_max_allocated_storage
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = aws_kms_key.this.arn

  multi_az               = var.db_multi_az
  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.database.id]
  parameter_group_name   = aws_db_parameter_group.this.name
  port                   = 5432
  publicly_accessible    = false

  backup_retention_period = var.db_backup_retention_days
  # UTC. 20:30 UTC is 02:00 IST — after the working day in Hyderabad and before
  # the maintenance window, which must not overlap it.
  backup_window            = "20:30-21:30"
  maintenance_window       = "Mon:22:00-Mon:23:00"
  copy_tags_to_snapshot    = true
  delete_automated_backups = false

  deletion_protection       = var.db_deletion_protection
  skip_final_snapshot       = !local.is_production
  final_snapshot_identifier = local.is_production ? "${local.name}-final-${formatdate("YYYYMMDDhhmmss", timestamp())}" : null

  performance_insights_enabled          = true
  performance_insights_retention_period = var.db_performance_insights_retention
  performance_insights_kms_key_id       = aws_kms_key.this.arn
  monitoring_interval                   = 30
  monitoring_role_arn                   = aws_iam_role.rds_monitoring.arn
  enabled_cloudwatch_logs_exports       = ["postgresql", "upgrade"]

  auto_minor_version_upgrade = true
  # Never apply a change to a live database the moment a plan is approved.
  # Everything that is not applied immediately lands in the maintenance window,
  # which is a scheduled event somebody can be awake for.
  apply_immediately = false

  lifecycle {
    # timestamp() changes on every plan, so the final snapshot name would show
    # as drift and force replacement of the database. It is only read when the
    # instance is actually destroyed.
    ignore_changes = [final_snapshot_identifier]
  }

  tags = { Name = local.name }
}
