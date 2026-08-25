#!/usr/bin/env bash
#
# Create the Terraform backend: an S3 bucket for state and a DynamoDB table for
# locking. Terraform cannot create its own backend, so this runs once, by hand,
# before the first `terraform init`.
#
# Safe to re-run: every step is idempotent and the script refuses to proceed if
# the region is fenced off by an SCP, rather than failing halfway through.
#
#   ./infra/bootstrap.sh [--profile mcos] [--region ap-south-1] [--bucket NAME]

set -euo pipefail

PROFILE="${AWS_PROFILE:-mcos}"
REGION="ap-south-1"
BUCKET=""
TABLE="mcos-terraform-locks"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2 ;;
    --region)  REGION="$2";  shift 2 ;;
    --bucket)  BUCKET="$2";  shift 2 ;;
    --table)   TABLE="$2";   shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

aws() { command aws --profile "$PROFILE" "$@"; }

ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
BUCKET="${BUCKET:-mcos-tfstate-${ACCOUNT}-${REGION}}"

echo "account : $ACCOUNT"
echo "region  : $REGION"
echo "bucket  : $BUCKET"
echo "table   : $TABLE"
echo

# An organization SCP outranks any role in this account, and read calls succeed
# in regions where writes do not — so the account looks usable right up until
# the first create. Check with a dry run, which creates nothing, and fail here
# with a comprehensible message rather than halfway through the bucket setup.
echo "checking whether this region permits resource creation..."
if err="$(aws ec2 create-vpc --cidr-block 10.99.0.0/16 --dry-run --region "$REGION" 2>&1)"; then
  echo "  unexpected: dry run reported success rather than DryRunOperation" >&2
else
  if grep -q "DryRunOperation" <<<"$err"; then
    echo "  ok — writes are permitted in $REGION"
  elif grep -q "service control policy" <<<"$err"; then
    cat >&2 <<EOF

  BLOCKED. An organization SCP denies resource creation in $REGION.

  This cannot be fixed from inside this account: an SCP is a hard ceiling that
  no role here can override. The management account must add $REGION to the
  policy's allowed-region condition. See docs/AWS-ACCESS.md.

EOF
    exit 1
  else
    echo "  could not verify: $err" >&2
    exit 1
  fi
fi

echo
echo "creating the state bucket..."
if aws s3api head-bucket --bucket "$BUCKET" >/dev/null 2>&1; then
  echo "  already exists"
else
  # us-east-1 is the one region that rejects a LocationConstraint.
  if [[ "$REGION" == "us-east-1" ]]; then
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" >/dev/null
  else
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
      --create-bucket-configuration LocationConstraint="$REGION" >/dev/null
  fi
  echo "  created"
fi

# Versioning before anything is written: state is the only record of what
# exists, and a corrupted apply is recoverable only from a previous version.
aws s3api put-bucket-versioning --bucket "$BUCKET" \
  --versioning-configuration Status=Enabled
aws s3api put-bucket-encryption --bucket "$BUCKET" \
  --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
aws s3api put-public-access-block --bucket "$BUCKET" \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
echo "  versioning, encryption and public-access block applied"

echo
echo "creating the lock table..."
if aws dynamodb describe-table --table-name "$TABLE" --region "$REGION" >/dev/null 2>&1; then
  echo "  already exists"
else
  aws dynamodb create-table --table-name "$TABLE" --region "$REGION" \
    --attribute-definitions AttributeName=LockID,AttributeType=S \
    --key-schema AttributeName=LockID,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST >/dev/null
  aws dynamodb wait table-exists --table-name "$TABLE" --region "$REGION"
  echo "  created"
fi

cat <<EOF

Done. Initialise Terraform with:

  cd infra/terraform
  terraform init \\
    -backend-config=bucket=$BUCKET \\
    -backend-config=key=mcos/terraform.tfstate \\
    -backend-config=region=$REGION \\
    -backend-config=dynamodb_table=$TABLE

Treat the state bucket as a secret store: it holds database and cache
credentials in plaintext. It is encrypted and private; keep it that way.
EOF
