#!/usr/bin/env bash
#
# Release Milestone 1 to production.
#
#   bash infra/ship-m1.sh
#
# PR #20 is already merged; main carries M1 as commit 87165c3. This script no
# longer touches git branches — an earlier version did, and it aborted partway
# because an unrelated modified file blocked its checkout, which is exactly the
# failure mode you do not want between "pushed the image" and "deployed it".
#
# It builds from a dedicated worktree of main so that whatever you have checked
# out in the main working copy is irrelevant to what ships. That matters right
# now: studio-main carries Milestone 2, which is NOT what this deploys.

set -euo pipefail
cd "$(dirname "$0")/.."

# The aws CLI calls below pass --profile explicitly, but terraform's provider
# sets only a region (main.tf:53) and otherwise uses the default credential
# chain. AWS_PROFILE alone is NOT enough here: this profile authenticates with
# `login_session` (AWS CLI v2's browser login), whose token cache only the CLI
# can read — terraform's Go SDK sees no credentials at all and falls through to
# an EC2 IMDS lookup that times out. Exporting materialised credentials is the
# supported bridge. Both failures happen *after* the image is pushed, which is
# the worst place in this sequence to stop.
eval "$(aws configure export-credentials --profile mcos --format env)"

TAG="87165c3"                 # main's tip = Milestone 1
REGISTRY="138067046920.dkr.ecr.ap-southeast-2.amazonaws.com"
REPO="mcos-production"
WORKTREE="../mcos-deploy"

echo "== preflight"
aws sts get-caller-identity --profile mcos --query Arn --output text
git fetch origin main --quiet
ACTUAL=$(git rev-parse --short origin/main)
if [[ "$ACTUAL" != "$TAG" ]]; then
  echo "   main is at $ACTUAL but this script ships $TAG." >&2
  echo "   Update TAG (and infra/terraform/production.auto.tfvars) or rebase." >&2
  exit 1
fi
grep -q "image_tag = \"$TAG\"" infra/terraform/production.auto.tfvars || {
  echo "   production.auto.tfvars does not pin image_tag=$TAG — refusing to deploy" >&2
  echo "   a tag mismatch here is how a 'successful' deploy serves the wrong build." >&2
  exit 1
}

echo "== checking out main into $WORKTREE (build source, isolated from your working copy)"
git worktree remove --force "$WORKTREE" 2>/dev/null || true
git worktree add --detach "$WORKTREE" origin/main

echo "== building $REPO:$TAG (linux/amd64)"
docker buildx build --platform linux/amd64 -t "$REPO:$TAG" "$WORKTREE"

echo "== pushing to ECR"
aws ecr get-login-password --region ap-southeast-2 --profile mcos \
  | docker login --username AWS --password-stdin "$REGISTRY"
docker tag "$REPO:$TAG" "$REGISTRY/$REPO:$TAG"
docker push "$REGISTRY/$REPO:$TAG"

echo "== terraform apply (registers new task definitions)"
terraform -chdir=infra/terraform apply -auto-approve

echo "== deploy (migrations, then services, with replacement proof)"
./infra/deploy.sh --profile mcos

echo "== reclaiming build space"
docker image rm "$REPO:$TAG" "$REGISTRY/$REPO:$TAG" 2>/dev/null || true
docker builder prune -f >/dev/null 2>&1 || true
git worktree remove --force "$WORKTREE" 2>/dev/null || true

echo ""
echo "== DEPLOYED $TAG. Verify: https://bot.perfstaq.com"
