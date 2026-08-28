# AWS access for the first deploy

## Current state

Access exists. `aws login --profile mcos` assumes
`arn:aws:sts::138067046920:assumed-role/AccountFullAccessRole`, which has ample
IAM permission. **No IAM user needs creating** — the earlier version of this
document asked for one, and that turned out to be unnecessary.

## The actual blocker: an organization SCP

The account is a member of organization `o-k3p8upby76` (management account
`590951086615`), and its Service Control Policy permits resource creation in
**`ap-southeast-2` (Sydney) only**. Verified by dry-run, which creates nothing:

| Region | `ec2:CreateVpc --dry-run` |
|---|---|
| `ap-southeast-2` | allowed |
| `ap-south-1` (Mumbai) | explicit deny, service_control_policy |
| `us-east-1` | explicit deny, service_control_policy |
| `ap-south-2` (Hyderabad) | region `DISABLED`, and would be denied anyway |

An SCP is a hard ceiling. A role called `AccountFullAccessRole` is still refused
by it, and nothing in the member account can work around that — the change has
to be made in the management account.

Note the read/write asymmetry, because it misleads: `ec2:DescribeVpcs`, ECS,
RDS, ElastiCache, S3, IAM, Secrets Manager and ECR all answer normally in
Mumbai. Only mutations — and `ec2:DescribeAvailabilityZones` — are denied. The
account looks usable until you try to build something.

## What the org admin needs to change

Add `ap-south-1` to the SCP's allowed-region condition. Typically the policy
looks like this, and Mumbai needs to join the list:

```json
{
  "Sid": "DenyOutsideApprovedRegions",
  "Effect": "Deny",
  "NotAction": [ "iam:*", "sts:*", "organizations:*", "cloudfront:*", "route53:*", "support:*" ],
  "Resource": "*",
  "Condition": {
    "StringNotEquals": {
      "aws:RequestedRegion": ["ap-southeast-2", "ap-south-1"]
    }
  }
}
```

`ap-south-1` is chosen over `ap-south-2` (Hyderabad) deliberately: it keeps data
in India, is enabled by default so it needs no opt-in step, and has the widest
instance coverage of the India regions. One change instead of two, and it drops
a class of first-apply failures.

Verify the change landed:

```bash
aws ec2 create-vpc --cidr-block 10.99.0.0/16 --dry-run \
  --region ap-south-1 --profile mcos
# "DryRunOperation" = allowed. Creates nothing either way.
```

## Then

```bash
./infra/bootstrap.sh          # state bucket + lock table
cd infra/terraform && terraform init && terraform plan
```

Also needed before an apply:

| | |
|---|---|
| Domain for the API | e.g. `api.perfstaq.com` — the ACM certificate must be ISSUED **in `ap-south-1`** and cover it |
| DNS | whether the zone is in this account, or validation records go in by hand |

## Still outstanding elsewhere

- **Cloudflare R2 is not enabled.** Credentials are correct; the API returns
  `10042 Please enable R2 through the Cloudflare Dashboard`. Then
  `npx wrangler r2 bucket create mcos-artifacts --location apac` — the location
  hint is immutable after creation.
- **`RECALLAI_API_KEY` is a placeholder**, and `APP_BASE_URL` needs a static
  ngrok URL: Recall rejects request bodies containing `localhost`.
- **Google and Microsoft OAuth clients do not exist.** Calendar sync is built and
  cannot work without them. Google's verification for calendar scopes is a
  multi-week review — start it before it is on the critical path.
