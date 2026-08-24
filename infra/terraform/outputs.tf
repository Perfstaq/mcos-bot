/**
 * Outputs are ARNs, names and endpoints — never values. `terraform output` is
 * printed in CI logs and pasted into tickets; nothing here should be harmful
 * in either place.
 *
 * The deploy workflow does not read these. It reads the SSM parameter, so a
 * pipeline is not coupled to a Terraform state file it may not be allowed to
 * open. These are for humans following the runbook.
 */

output "alb_dns_name" {
  description = "Point var.domain_name at this with a CNAME, or an ALIAS record if Route 53 hosts the zone."
  value       = aws_lb.this.dns_name
}

output "alb_zone_id" {
  description = "Hosted zone id of the load balancer, for a Route 53 ALIAS record."
  value       = aws_lb.this.zone_id
}

output "webhook_url" {
  description = "Register this in the Recall dashboard. It must be reachable and stable — a change here means re-registering, and unregistered webhooks are silent."
  value       = "https://${var.domain_name}/api/v1/webhooks/recall"
}

output "ecr_repository_url" {
  description = "Image repository. Tags are immutable; the deploy workflow pushes the commit SHA."
  value       = aws_ecr_repository.this.repository_url
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.this.name
}

output "ecs_service_names" {
  value = {
    api    = aws_ecs_service.api.name
    worker = aws_ecs_service.worker.name
  }
}

output "migrate_task_family" {
  description = "Task definition family for the one-off `prisma migrate deploy` task."
  value       = aws_ecs_task_definition.migrate.family
}

output "deploy_manifest_parameter" {
  description = "SSM parameter the deploy workflow reads for cluster, service, subnet and security group ids."
  value       = aws_ssm_parameter.deploy_manifest.name
}

output "github_deploy_role_arn" {
  description = "Set as the AWS_DEPLOY_ROLE_ARN secret in GitHub. It contains the account id, which is why it is a secret rather than a committed value."
  value       = aws_iam_role.deploy.arn
}

output "database_endpoint" {
  description = "RDS endpoint. Reachable only from inside the VPC."
  value       = aws_db_instance.this.endpoint
}

output "database_master_secret_arn" {
  description = "The RDS-managed master credential. Used once, during first deploy, to create the application's own database role — see docs/RUNBOOK.md. The application never uses it."
  value       = try(aws_db_instance.this.master_user_secret[0].secret_arn, null)
}

output "redis_primary_endpoint" {
  description = "ElastiCache primary. Transit encryption is on, so the connection string is rediss://, not redis://."
  value       = aws_elasticache_replication_group.this.primary_endpoint_address
}

output "secret_arns" {
  description = "Every application secret, by environment variable name. ARNs only."
  value       = { for name, secret in aws_secretsmanager_secret.app : name => secret.arn }
}

output "secrets_needing_values" {
  description = "Secrets that still hold the REPLACE_ME placeholder as far as Terraform knows. Terraform does not read secret values back, so this is the list Terraform created a placeholder for — not proof any of them is still unset."
  value       = sort(tolist(local.placeholder_secrets))
}

output "log_groups" {
  value = {
    api     = aws_cloudwatch_log_group.api.name
    worker  = aws_cloudwatch_log_group.worker.name
    migrate = aws_cloudwatch_log_group.migrate.name
  }
}

output "kms_key_arn" {
  value = aws_kms_key.this.arn
}

output "vpc_id" {
  value = aws_vpc.this.id
}

output "private_subnet_ids" {
  value = aws_subnet.private[*].id
}
