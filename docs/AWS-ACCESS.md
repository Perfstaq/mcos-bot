# Granting AWS access for the first deploy

What to create, what to hand over, and what not to. Everything here is done once.

## Do not hand over root credentials

Not for caution's sake — root cannot be scoped, cannot be rotated without
disrupting the account, and cannot be revoked independently of everything else
you own. Create a dedicated deployment identity instead.

## 1. Enable `ap-south-2` first

Console → account menu → **AWS Regions** → enable **Asia Pacific (Hyderabad)**.

Hyderabad is opt-in. Until it is enabled the region is invisible: API calls fail
with authorization errors that read like a broken policy, which is a genuinely
misleading way to spend an afternoon. After enabling, IAM propagation takes a
few minutes — wait before the first `terraform apply`.

## 2. Create the deployment identity

```bash
aws iam create-user --user-name mcos-terraform
aws iam create-access-key --user-name mcos-terraform   # capture the output once
```

Attach these managed policies. Terraform creates the whole stack, so the set is
broad by necessity — this identity exists to build infrastructure, not to run it.

```bash
for P in AmazonVPCFullAccess AmazonECS_FullAccess \
         AmazonEC2ContainerRegistryFullAccess AmazonRDSFullAccess \
         AmazonElastiCacheFullAccess ElasticLoadBalancingFullAccess \
         AWSCertificateManagerFullAccess SecretsManagerReadWrite \
         CloudWatchLogsFullAccess AmazonS3FullAccess AmazonDynamoDBFullAccess \
         IAMFullAccess; do
  aws iam attach-user-policy --user-name mcos-terraform \
    --policy-arn "arn:aws:iam::aws:policy/$P"
done
```

### On `IAMFullAccess`

This is the one worth pausing over, and it is not optional-by-default: Terraform
must create the ECS task execution role, the task role, and the GitHub OIDC
identity provider the deploy pipeline authenticates against. Without it the
apply fails partway, which is worse than not starting.

If you would rather scope it down, replace it with a customer-managed policy
limited to `iam:*Role*`, `iam:*Policy*`, `iam:*OpenIDConnectProvider*` and
`iam:PassRole`, restricted to roles named `mcos-*`. That is more setup and has
to be widened again whenever the stack grows a new role — a reasonable trade if
this account holds anything else that matters.

### Delete it afterwards

Once the stack exists and the pipeline deploys through OIDC, this user has no
remaining purpose:

```bash
aws iam delete-access-key --user-name mcos-terraform --access-key-id <ID>
```

A long-lived key that nothing uses is a key nobody notices being stolen.

## 3. Bootstrap the Terraform backend

Terraform cannot create its own backend. See
[`infra/terraform/README.md`](../infra/terraform/README.md) for the S3 bucket and
DynamoDB lock table — do that before the first `init`.

## 4. What to send

| | |
|---|---|
| `AWS_ACCESS_KEY_ID` | from step 2 |
| `AWS_SECRET_ACCESS_KEY` | from step 2 |
| Account ID | 12 digits |
| Domain for the API | e.g. `api.perfstaq.com` — needed for the ACM certificate |
| Route 53? | whether the domain's DNS is in this account, or validation records go in by hand |

Send them through something that is not a chat transcript, and rotate them after
the stack is up.

## What is still outstanding elsewhere

AWS is not the only gap between this repo and a running product:

- **Cloudflare R2 is not enabled on the account.** The credentials are correct;
  the API returns `10042 Please enable R2 through the Cloudflare Dashboard`.
  Enable it, then `npx wrangler r2 bucket create mcos-artifacts --location apac`.
  The location hint is immutable after creation.
- **`RECALLAI_API_KEY` is still a placeholder**, and `APP_BASE_URL` needs a
  static ngrok URL — Recall rejects request bodies containing `localhost`.
- **Google and Microsoft OAuth clients do not exist.** Calendar sync is built and
  cannot work without them. Google's verification for calendar scopes is a
  multi-week review: start it before it is on the critical path.
