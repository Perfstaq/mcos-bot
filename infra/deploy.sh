#!/usr/bin/env bash
#
# Release: migrate, then move both services onto the current task definition.
#
#   ./infra/deploy.sh [--profile mcos] [--region ap-southeast-2] [--env production]
#
# This sets --task-definition explicitly AND forces a new deployment, because
# the two flags fix different halves of the same trap and neither is enough.
#
# The services carry `lifecycle { ignore_changes = [task_definition] }`, which
# exists so a CI pipeline can move the image without Terraform reverting it.
# The consequence is that `terraform apply` registers a NEW revision and leaves
# the service pointed at the old one, so --force-new-deployment on its own
# redeploys that same old revision. Naming the revision fixes that.
#
# But naming a revision the service is ALREADY on is a no-op: no tasks start,
# and the service goes stable instantly. Anything a release carries outside the
# image — a rotated secret, most of all — then never reaches the containers.
# --force-new-deployment fixes that half.
#
# Both failures report success. A deploy that says STABLE while running the
# previous image, or the previous secret, is the worst possible failure mode,
# because nothing anywhere looks wrong.

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
# Record what is running BEFORE anything moves. Task ARNs are unique per task,
# so comparing the sets afterwards proves replacement happened without any
# date arithmetic — see the assertion below for why that matters.
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

for S in api worker; do
  aws ecs list-tasks "${R[@]}" --cluster "$CLUSTER" --service-name "$CLUSTER-$S" \
    --query 'taskArns' --output text | tr '\t' '\n' | sort > "$WORK/$S.before"

  TD=$(aws ecs describe-task-definition "${R[@]}" --task-definition "$CLUSTER-$S" \
    --query 'taskDefinition.taskDefinitionArn' --output text)
  IMG=$(aws ecs describe-task-definition "${R[@]}" --task-definition "$CLUSTER-$S" \
    --query 'taskDefinition.containerDefinitions[0].image' --output text)
  echo "   $S -> ${TD##*/}  image=${IMG##*:}"

  # --force-new-deployment is not belt-and-braces here, it is the point.
  # Pointing a service at the revision it is already on is a no-op: ECS starts
  # no tasks and reports success immediately. That is fine for an image change,
  # which necessarily means a new revision, and wrong for everything else a
  # release carries. Secrets in particular are resolved by the agent at task
  # start and then live in the container's environment, so rotating one in
  # Secrets Manager changes nothing at all until a task is replaced.
  aws ecs update-service "${R[@]}" --cluster "$CLUSTER" --service "$CLUSTER-$S" \
    --task-definition "$TD" --force-new-deployment >/dev/null
done

echo "== waiting for steady state"
aws ecs wait services-stable "${R[@]}" --cluster "$CLUSTER" --services "$CLUSTER-api" "$CLUSTER-worker"

# Two assertions, because "stable" on its own means neither of these things.
#
#   1. Every pre-deploy task is gone. A service that was already on the target
#      revision accepts the update, changes nothing, and goes stable instantly.
#      The image check below cannot see that: the image is correct precisely
#      because nothing moved. This is how a rotated secret got deployed, marked
#      STABLE, and left both containers running the previous value in memory.
#   2. The image running is the image intended. This is the one that catches a
#      release which reported success while serving the previous build.
for S in api worker; do
  aws ecs list-tasks "${R[@]}" --cluster "$CLUSTER" --service-name "$CLUSTER-$S" \
    --query 'taskArns' --output text | tr '\t' '\n' | sort > "$WORK/$S.after"

  SURVIVORS=$(comm -12 "$WORK/$S.before" "$WORK/$S.after")
  if [[ -n "$SURVIVORS" ]]; then
    echo "NOT REPLACED: $S is still running pre-deploy task(s):" >&2
    echo "$SURVIVORS" >&2
    echo "The deploy went stable without starting anything. Nothing was released." >&2
    exit 1
  fi

  RUNNING=$(aws ecs describe-tasks "${R[@]}" --cluster "$CLUSTER" \
    --tasks "$(head -1 "$WORK/$S.after")" \
    --query 'tasks[0].containers[0].image' --output text)
  WANTED=$(aws ecs describe-task-definition "${R[@]}" --task-definition "$CLUSTER-$S" \
    --query 'taskDefinition.containerDefinitions[0].image' --output text)
  if [[ "$RUNNING" != "$WANTED" ]]; then
    echo "MISMATCH: $S running $RUNNING, expected $WANTED" >&2
    exit 1
  fi
  echo "   $S ok: ${RUNNING##*:}"
done

echo "== deployed: ${WANTED##*:}"
