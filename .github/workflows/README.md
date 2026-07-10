# GitHub Actions workflows

| Workflow              | Trigger                          | Purpose                                                                 |
| --------------------- | -------------------------------- | ----------------------------------------------------------------------- |
| `tests.yml`           | push to `main`, pull_request     | Typecheck + test + build + Lighthouse gate (unchanged).                 |
| `deploy-frontend.yml` | push to `main`, workflow_dispatch| Test/build gate, deploy the SPA to AWS S3 + CloudFront via OIDC, then a post-deploy Chromium smoke against the live host. |
| `readiness-monitor.yml` | every five minutes, workflow_dispatch | Validate the production readiness JSON contracts (API direct, engine, and the canonical CloudFront path) and manage deduplicated GitHub incidents. |

## `readiness-monitor.yml` — production outage detection

The repository-owned monitor probes three readiness endpoints every five
minutes: the Express API directly on Railway (`api`), the Python engine
(`engine`), and the same Express readyz through the canonical CloudFront
`/api/*` proxy (`web`) — the last one distinguishes "Railway down" from "CDN
proxy broken". Each probe requires HTTP 200 plus the service's expected JSON
contract. A failure opens (or reopens) one stable GitHub issue per service; a
healthy result closes the open incident after recovery. The workflow itself
fails whenever any probe is unhealthy so normal Actions notifications fire.

This monitor needs no secrets beyond the workflow-provided `GITHUB_TOKEN` with
the declared `issues: write` permission. External SMS or phone escalation is a
separate dashboard-owned alerting step.

## `deploy-frontend.yml` — auto-deploy the frontend to AWS

Pushing to `main` runs a `test` job (typecheck, `pnpm run test`, `pnpm run build:web`);
only if it is green does the `deploy` job (`needs: test`) run. The deploy job assumes an
AWS IAM role via **GitHub OIDC** (no static AWS keys), uploads the build to S3 in two
cache-control passes, and invalidates the CloudFront HTML entry points.

### Required repository configuration

Set these under **Settings → Secrets and variables → Actions**. All values come from the
Terraform outputs in [`infra/`](../../infra):

| Kind     | Name                         | Value (Terraform output)      | Example        |
| -------- | ---------------------------- | ----------------------------- | -------------- |
| Secret   | `AWS_DEPLOY_ROLE_ARN`        | `github_actions_role_arn`     | `arn:aws:iam::123456789012:role/github_actions_frontend_deploy` |
| Variable | `AWS_REGION`                 | (fixed)                       | `us-east-1`    |
| Variable | `FRONTEND_S3_BUCKET`         | `frontend_bucket_name`        | `scentbeam-frontend-prod` |
| Variable | `CLOUDFRONT_DISTRIBUTION_ID` | `cloudfront_distribution_id`  | `E123ABC456DEF` |
| Variable | `VITE_SENTRY_DSN`            | (Sentry project → Client Keys; optional — SPA skips Sentry when unset) | `https://abc123@o123456.ingest.sentry.io/4500000000000000` |

The IAM role's trust policy is scoped (in Terraform) to
`repo:cloudURBANE/sCAST:ref:refs/heads/main` (plus the pre-cutover migration branch), and
its permission policy is least-privilege: `s3:ListBucket` + `s3:PutObject`/`s3:DeleteObject`
on the one bucket and `cloudfront:CreateInvalidation` on the one distribution.

### Deploy flow

1. Build the SPA (`pnpm run build:web` → `artifacts/scent-cast/dist/public`).
2. **Pass 1** — `aws s3 sync … --delete --cache-control "public, max-age=31536000, immutable"`:
   uploads all files (fingerprinted `/assets/*` are safe to cache forever) and deletes any
   files removed from the build.
3. **Pass 2** — `aws s3 cp --recursive` re-uploads `*.html` and `site.webmanifest` with
   `no-cache, max-age=0, must-revalidate`, overwriting the immutable header from pass 1 so
   the entry points always revalidate.
4. `aws cloudfront create-invalidation` on `/index.html /  /site.webmanifest /community /arena`
   only — not `/*`, since hashed assets are immutable.

`concurrency` cancels a superseded deploy for the same ref.
