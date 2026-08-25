/**
 * MCOS — production infrastructure, AWS Mumbai (ap-south-1).
 *
 * One image, two ECS Fargate services:
 *   node apps/api/dist/server.js   → the API, behind the ALB, also serves the SPA
 *   node apps/api/dist/worker.js   → the BullMQ workers, no inbound traffic
 *
 * Read infra/terraform/README.md before the first apply. ap-south-1 is an
 * opt-in region and its instance-type coverage is thinner than Mumbai; every
 * instance class in this stack is a variable for exactly that reason.
 *
 * Nothing here contains a credential, an account id or a hostname. Real values
 * come from -var-file (see terraform.tfvars.example) and from Secrets Manager.
 */

terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  /**
   * Partial backend configuration. The bucket, the DynamoDB lock table and the
   * account they live in are deployment facts, not source code, so they are
   * supplied at init time:
   *
   *   terraform init \
   *     -backend-config=bucket=<state-bucket> \
   *     -backend-config=dynamodb_table=<lock-table> \
   *     -backend-config=region=ap-south-1
   *
   * workspace_key_prefix keeps staging and production state under separate
   * prefixes in the same bucket, so a misdirected apply cannot overwrite the
   * other environment's state file even if the workspace guard below is
   * somehow bypassed.
   */
  backend "s3" {
    key                  = "mcos/terraform.tfstate"
    workspace_key_prefix = "env"
    encrypt              = true
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Application = "mcos"
      Environment = var.environment
      ManagedBy   = "terraform"
      Repository  = var.repository
    }
  }
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  name = "mcos-${var.environment}"

  # Prefix for every Secrets Manager entry. Kept in one place because the IAM
  # policy that grants the task execution role read access is written against
  # this prefix, not against a list of ARNs — a secret added later should not
  # need an IAM change to become readable.
  secret_prefix = "mcos/${var.environment}"

  is_production = var.environment == "production"
}

/**
 * Guard: a workspace and a -var-file that disagree is how production gets
 * applied with staging's sizing, or worse. A precondition fails the plan
 * rather than warning about it, which is the difference that matters.
 */
resource "terraform_data" "workspace_guard" {
  input = var.environment

  lifecycle {
    precondition {
      condition     = terraform.workspace == var.environment
      error_message = "Workspace '${terraform.workspace}' does not match var.environment '${var.environment}'. Run: terraform workspace select ${var.environment} && terraform apply -var-file=env/${var.environment}.tfvars"
    }
    precondition {
      condition     = contains(["staging", "production"], var.environment)
      error_message = "var.environment must be 'staging' or 'production'."
    }
  }
}
