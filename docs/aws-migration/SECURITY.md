# Security model: S3 + CloudFront frontend deploy

Security posture for the Vercel → AWS migration. The guiding principles: **no
long-lived AWS keys anywhere**, **least privilege**, **the S3 bucket is never
public**, and **the existing same-origin Bearer-token auth model is preserved
byte-for-byte** through the CloudFront `/api/*` proxy.

## 1. GitHub OIDC instead of long-lived AWS keys

The deploy workflow authenticates to AWS via **GitHub OIDC**
(`aws-actions/configure-aws-credentials@v4`, `permissions: id-token: write`).
GitHub mints a short-lived OIDC token per run; AWS STS exchanges it for temporary
credentials scoped to one IAM role.

- **No `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` is ever stored** in GitHub
  secrets, the repo, or a developer machine. There is nothing static to leak or
  rotate.
- The only "secret" the workflow holds is `AWS_DEPLOY_ROLE_ARN` — an ARN, not a
  credential; it grants nothing without a matching OIDC trust.

### Trust policy scoping (who may assume the role)

The role `github_actions_frontend_deploy` trusts the GitHub OIDC provider
(`token.actions.githubusercontent.com`) with the audience `sts.amazonaws.com`,
and its `sub` condition is restricted to this repository and specific refs:

- `repo:cloudURBANE/sCAST:ref:refs/heads/main`
- `repo:cloudURBANE/sCAST:ref:refs/heads/claude/vercel-aws-migration-mb8vae`
  (temporary, for pre-cutover testing).

No other repo, fork, or branch can assume the role. **After cutover, remove the
migration-branch subject** so only `main` can deploy (see checklist).

### Permission policy (what the role may do) — least privilege

The role's permission policy is the minimum for a static deploy, scoped to the
**one** bucket and the **one** distribution:

- `s3:ListBucket` on the bucket ARN.
- `s3:PutObject` + `s3:DeleteObject` on `<bucket-arn>/*` (needed for
  `aws s3 sync --delete`).
- `cloudfront:CreateInvalidation` on the specific distribution ARN only.

No `s3:*`, no `iam:*`, no account-wide CloudFront rights, no read of other
buckets. A compromised workflow can at worst overwrite/invalidate this one
frontend — it cannot pivot.

## 2. S3 private + CloudFront OAC (no public bucket)

- The S3 bucket has **Block Public Access fully enabled** and **no public bucket
  policy / no website hosting**. Objects are never reachable directly over the
  internet.
- CloudFront reaches S3 via **Origin Access Control (OAC)**, SigV4-signed. The
  bucket policy grants read **only** to the CloudFront distribution's service
  principal (scoped by `AWS:SourceArn` to this distribution). All public traffic
  goes through CloudFront; the origin is otherwise closed.
- Because the default behavior serves a private bucket via OAC, there is no
  world-readable object surface and no S3 website endpoint to bypass CloudFront.

## 3. CloudFront TLS + optional WAF

- **Viewer protocol policy: redirect-to-HTTPS** (or HTTPS-only). No plaintext
  serving.
- **Minimum TLS version `TLSv1.2_2021`** on the viewer certificate — no TLS 1.0/1.1.
- The custom-domain certificate is an **ACM cert in us-east-1** (CloudFront
  requirement), DNS-validated; must be `ISSUED` and attached before DNS cutover.
- **Origin to Railway is HTTPS-only** (custom origin, `origin-protocol-policy =
  https-only`), so the `/api/*` hop from CloudFront to the Express backend is
  encrypted end to end.
- **AWS WAF is optional but recommended** — attach a Web ACL to the distribution
  with AWS Managed Rules (common rule set + known-bad-inputs) and rate-based
  rules. Left as a follow-up so the base cutover stays simple (see checklist).

## 4. No secrets in the repo

- Everything environment-specific is a **Terraform variable**, a **GitHub secret/
  variable**, or a **Railway variable** — never committed.
- The only browser-exposed values are `VITE_*` build-time vars, which are
  **non-secret by design** (they ship in the client bundle). Real secrets
  (`SUPABASE_SERVICE_ROLE_KEY`, `ADMIN_SECRET`, provider API keys, OAuth client
  secret, etc.) live only on Railway and are never surfaced through `VITE_*` or
  CloudFront.
- No AWS static keys exist (OIDC). The Terraform state may contain resource IDs;
  if you enable the S3+DynamoDB remote backend, keep that state bucket private
  and encrypted.

## 5. The `/api/*` proxy preserves the current auth model

The app uses an **opaque per-user Bearer token** (`users.token`, a UUID — not a
JWT) sent as `Authorization: Bearer <token>`, plus any cookies. Today the SPA
calls the Express API **same-origin** at `/api/*`, and `middleware.js` proxies
that to Railway. CloudFront's `/api/*` behavior replaces `middleware.js` while
keeping the model identical:

- **Behavior `/api/*` → Railway origin**, `CachingDisabled`, with an **AllViewer**
  origin request policy so **all viewer headers (including `Authorization`),
  cookies, and query strings are forwarded** to Railway. `Set-Cookie` from the
  backend is passed back to the browser.
- Because requests remain **same-origin** (the browser talks to the CloudFront
  host, which relays to Railway server-side), there is **no CORS change** and no
  new cross-origin exposure. `VITE_API_BASE_URL` stays empty to preserve
  same-origin behavior — do not point it directly at Railway (that would make
  API calls cross-origin and change the security surface).
- `/api/*` responses are **not cached** (`CachingDisabled`), so no
  authenticated/user-specific payload can be served to another user from the
  edge cache. (The old middleware also forced `private, no-store` on cookie'd
  responses; CachingDisabled achieves the same "never cache" guarantee at the
  edge.)
- The Python engine is reached **directly** from the browser via
  `VITE_FRAGRANCE_API_URL` and is not part of the CloudFront trust boundary — its
  own CORS/`FRONTEND_ORIGINS` config governs it, unchanged.

## 6. Security follow-up checklist

- [ ] **Restrict OIDC trust to `main` only** — remove the
      `claude/vercel-aws-migration-mb8vae` subject from the role trust policy
      once cutover is verified.
- [ ] **Enable AWS WAF** on the distribution (managed rules + rate limiting).
- [ ] **Turn on access logging** — CloudFront standard/real-time logs and S3
      server access logging to a private, restricted log bucket.
- [ ] **Rotate any secret that ever lived in Vercel** (e.g. `BACKEND_ORIGIN` is
      not secret, but audit provider keys / OAuth client secret if they were
      duplicated into Vercel env) after decommission.
- [ ] Confirm **Block Public Access** stays fully on for the frontend bucket and
      the OAC bucket policy is scoped to this distribution's `SourceArn`.
- [ ] Confirm **`min TLS = TLSv1.2_2021`** and viewer redirect-to-HTTPS on the
      distribution.
- [ ] If using remote Terraform state, ensure the **state bucket is private +
      encrypted** and the DynamoDB lock table is access-restricted.
