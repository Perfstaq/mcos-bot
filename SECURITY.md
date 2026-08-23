# Security Policy

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Report it privately through
[GitHub Security Advisories](https://github.com/Perfstaq/mcos-bot/security/advisories/new),
or email **security@perfstaq.com**.

Please include:

- what the issue is and roughly how severe you think it is
- steps to reproduce, or a proof of concept
- the affected version or commit
- anything you know about impact

You will get an acknowledgement within **3 business days** and an assessment
within **10 business days**. We will keep you updated while we work on a fix, and
credit you in the advisory unless you would rather we did not.

## Supported versions

This project is pre-1.0. Only the default branch receives security fixes.

## Scope

Things we especially want to hear about:

- **Webhook signature verification** — any way to get an unverified payload
  processed (`apps/api/src/integrations/recall.ts`, `routes/webhooks.ts`).
- **Row-level tenancy** — any query that returns another tenant's data
  (`apps/api/src/db.ts`).
- **The review gate** — any path that writes to `brief_versions` or
  `brief_claims` without a human decision, or that forges a `review_decisions`
  row.
- **Artifact access** — presigned R2 URL scope, expiry, or leakage between
  tenants.
- **Prompt injection through transcript content** — a meeting participant saying
  something that changes extraction behaviour rather than being treated as data.
- Authentication, session handling, and authorization once those land.

Out of scope: findings that require an already-compromised host, denial of
service through sheer volume against a local dev instance, and reports generated
by a scanner with no demonstrated impact.

## A note on secrets

Every credential is read from the environment. There are no secrets in this
repository, and `.env` is gitignored. If you believe a credential has been
committed, report it privately rather than opening an issue — and assume it is
compromised regardless of whether the commit was reverted.
