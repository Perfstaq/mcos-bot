#!/usr/bin/env bash
#
# Release main to production.
#
#   bash infra/ship.sh
#
# Was infra/ship-m1.sh; the mechanics are unchanged, the pinned commit is not.
# This script no longer touches git branches — an earlier version did, and it
# aborted partway because an unrelated modified file blocked its checkout,
# which is exactly the failure mode you do not want between "pushed the image"
# and "deployed it".
#
# It builds from a dedicated worktree of origin/main so that whatever you have
# checked out in the main working copy is irrelevant to what ships.
#
# TAG is DERIVED from origin/main, and cross-checked against the image_tag that
# production.auto.tfvars pins.
#
# It was hardcoded here until a moment ago, and the header argued that a human
# writing the value down once and the machine checking it twice was the safety.
# That reasoning does not survive a protected main: any commit that pins TAG to
# main's tip *becomes* main's tip, so the hardcoded value is stale the instant
# it lands. It was only ever self-consistent for M1 because the script sat on an
# unmerged branch while main stood still — the first time it was asked to ship
# from main twice, it refused its own release.
#
# The check that actually prevents shipping the wrong build is untouched, and it
# is the second one. Terraform registers task definitions from image_tag in
# production.auto.tfvars; that file is gitignored, so a human still writes the
# value down, in the one place a machine cannot derive it from. If it disagrees
# with what we are about to build and push, this refuses before the push.
#
# NOTE — this ships the lean image (./Dockerfile: api + worker + migrate).
# Dockerfile.media, which carries the Python analyzer venv, scripts/dist and
# packages/render/scripts, is NOT built, pushed or run by anything here, and
# no ECS service runs apps/api/dist/worker-media.js. Until that exists,
# media.analyze and render.qc jobs enqueue in production and are never
# consumed. See docs/studio/M3_READINESS.md.

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

REGISTRY="138067046920.dkr.ecr.ap-southeast-2.amazonaws.com"
REPO="mcos-production"
WORKTREE="../mcos-deploy"

echo "== preflight"
aws sts get-caller-identity --profile mcos --query Arn --output text
git fetch origin main --quiet
TAG=$(git rev-parse --short origin/main)
echo "   origin/main = $TAG"
grep -q "image_tag = \"$TAG\"" infra/terraform/production.auto.tfvars || {
  echo "   production.auto.tfvars does not pin image_tag=$TAG — refusing to deploy." >&2
  echo "   Set it to \`image_tag = \"$TAG\"\` if $TAG is what you mean to ship." >&2
  echo "   A tag mismatch here is how a 'successful' deploy serves the wrong build:" >&2
  echo "   this script would push \$TAG while terraform registered the other one." >&2
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
