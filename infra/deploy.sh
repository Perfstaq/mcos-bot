#!/usr/bin/env bash
#
# Release: migrate, then move both services onto the current task definition.
#
#   ./infra/deploy.sh [--profile mcos] [--region ap-southeast-2] [--env production]
#
# Why this sets --task-definition explicitly rather than relying on
# --force-new-deployment: the ECS services carry
# `lifecycle { ignore_changes = [task_definition] }`, which exists so a CI
# pipeline can move the image without Terraform reverting it. The consequence
# is that `terraform apply` registers a NEW task definition revision and leaves
# the service pointed at the old one, and --force-new-deployment redeploys that
# same old revision. Both report success. A deploy that says STABLE while
# running the previous image is the worst possible failure mode, because
# nothing anywhere looks wrong.

set -euo pipefail

PROFILE="${AWS_PROFILE:-mcos}"
REGION="ap-southeast-2"
ENVIRONMENT="production"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2 ;;
    --region)  REGION="$2";  shift 2 ;;
    --env)     ENVIRONMENT="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

CLUSTER="mcos-$ENVIRONMENT"
R=(--region "$REGION" --profile "$PROFILE")
aws() { command aws "$@"; }

SUBNETS=$(aws ecs describe-services "${R[@]}" --cluster "$CLUSTER" --services "$CLUSTER-api" \
  --query 'services[0].networkConfiguration.awsvpcConfiguration.subnets' --output text | tr '\t' ',')
SG=$(aws ecs describe-services "${R[@]}" --cluster "$CLUSTER" --services "$CLUSTER-api" \
  --query 'services[0].networkConfiguration.awsvpcConfiguration.securityGroups[0]' --output text)

echo "== migrations"
ARN=$(aws ecs run-task "${R[@]}" --cluster "$CLUSTER" \
  --task-definition "$CLUSTER-migrate" --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$SG],assignPublicIp=DISABLED}" \
  --query 'tasks[0].taskArn' --output text)
aws ecs wait tasks-stopped "${R[@]}" --cluster "$CLUSTER" --tasks "$ARN"
CODE=$(aws ecs describe-tasks "${R[@]}" --cluster "$CLUSTER" --tasks "$ARN" \
  --query 'tasks[0].containers[0].exitCode' --output text)
echo "   exit=$CODE"
if [[ "$CODE" != "0" ]]; then
  echo "   MIGRATION FAILED — not deploying. Last log lines:" >&2
  aws logs tail "/ecs/$CLUSTER/migrate" "${R[@]}" --since 10m 2>/dev/null | tail -25 >&2
  exit 1
fi

echo "== deploying"
for S in api worker; do
  TD=$(aws ecs describe-task-definition "${R[@]}" --task-definition "$CLUSTER-$S" \
    --query 'taskDefinition.taskDefinitionArn' --output text)
  IMG=$(aws ecs describe-task-definition "${R[@]}" --task-definition "$CLUSTER-$S" \
    --query 'taskDefinition.containerDefinitions[0].image' --output text)
  echo "   $S -> ${TD##*/}  image=${IMG##*:}"
  aws ecs update-service "${R[@]}" --cluster "$CLUSTER" --service "$CLUSTER-$S" \
    --task-definition "$TD" >/dev/null
done

echo "== waiting for steady state"
aws ecs wait services-stable "${R[@]}" --cluster "$CLUSTER" --services "$CLUSTER-api" "$CLUSTER-worker"

# Assert what is actually running, rather than trusting that "stable" means
# "the thing I just built". This is the check that would have caught the
# release which reported success while serving the previous image.
RUNNING=$(aws ecs describe-tasks "${R[@]}" --cluster "$CLUSTER" \
  --tasks "$(aws ecs list-tasks "${R[@]}" --cluster "$CLUSTER" --service-name "$CLUSTER-api" --query 'taskArns[0]' --output text)" \
  --query 'tasks[0].containers[0].image' --output text)
WANTED=$(aws ecs describe-task-definition "${R[@]}" --task-definition "$CLUSTER-api" \
  --query 'taskDefinition.containerDefinitions[0].image' --output text)
if [[ "$RUNNING" != "$WANTED" ]]; then
  echo "MISMATCH: running $RUNNING, expected $WANTED" >&2
  exit 1
fi
echo "== deployed: ${RUNNING##*:}"
