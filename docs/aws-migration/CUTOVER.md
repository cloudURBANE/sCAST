# Cutover runbook: Vercel → AWS S3 + CloudFront

Ordered, reversible steps to move the sCAST SPA to CloudFront and, if needed,
roll back. Backends never move (Railway), so the cutover is **DNS-only at the
end** and rollback is low-risk.

Region is **us-east-1** for all AWS resources. Do not switch DNS until the
`*.cloudfront.net` smoke tests (step 4) pass.

Prerequisites: AWS account with permission to run Terraform for S3/CloudFront/IAM
OIDC; the AWS CLI and Terraform installed locally; admin on the `cloudURBANE/sCAST`
GitHub repo; access to the DNS provider for the production domain.

---

## 1. Provision AWS infra with Terraform

From `infra/`:

```bash
cd infra
terraform init          # local backend by default (see infra/README.md for S3+DynamoDB remote state)
terraform plan \
  -var 'backend_origin_domain=scentbeam-api.up.railway.app' \
  # -var 'domain_name=app.example.com'   # OPTIONAL: only once you're ready to attach a custom domain + ACM cert
terraform apply \
  -var 'backend_origin_domain=scentbeam-api.up.railway.app'
```

- `backend_origin_domain` is the **Railway Express** domain (domain only, no
  scheme, no trailing slash) — the value that used to live in Vercel's
  `BACKEND_ORIGIN`.
- Leave `domain_name` **empty for the first apply**. You then test against the
  `*.cloudfront.net` domain. Add `domain_name` (and let Terraform attach the
  validated ACM cert + aliases) only when you are ready to move DNS (step 5).

Capture the outputs — you need all four:

```bash
terraform output
# frontend_bucket_name        = "scentbeam-frontend-prod"
# cloudfront_distribution_id  = "E123ABC456DEF7"
# cloudfront_domain_name      = "d1234abcd.cloudfront.net"
# github_actions_role_arn     = "arn:aws:iam::<acct>:role/github_actions_frontend_deploy"
```

## 2. Set the four GitHub Actions secrets/vars

sCAST repo → **Settings → Secrets and variables → Actions**. Map from step 1
outputs:

| Name | Kind | Value (from Terraform output) |
|------|------|-------------------------------|
| `AWS_DEPLOY_ROLE_ARN` | **Secret** | `github_actions_role_arn` |
| `AWS_REGION` | **Variable** | `us-east-1` |
| `FRONTEND_S3_BUCKET` | **Variable** | `frontend_bucket_name` |
| `CLOUDFRONT_DISTRIBUTION_ID` | **Variable** | `cloudfront_distribution_id` |

CLI equivalent (optional):

```bash
gh secret   set AWS_DEPLOY_ROLE_ARN       --repo cloudURBANE/sCAST --body "arn:aws:iam::<acct>:role/github_actions_frontend_deploy"
gh variable set AWS_REGION                 --repo cloudURBANE/sCAST --body "us-east-1"
gh variable set FRONTEND_S3_BUCKET         --repo cloudURBANE/sCAST --body "scentbeam-frontend-prod"
gh variable set CLOUDFRONT_DISTRIBUTION_ID --repo cloudURBANE/sCAST --body "E123ABC456DEF7"
```

The OIDC trust policy allows both `refs/heads/main` and the migration branch
`claude/vercel-aws-migration-mb8vae`, so you can deploy from the branch for
pre-cutover testing before merging to `main`.

## 3. Trigger the first deploy

Run `.github/workflows/deploy-frontend.yml`:

```bash
# Option A — from the migration branch, on demand:
gh workflow run deploy-frontend.yml --repo cloudURBANE/sCAST --ref claude/vercel-aws-migration-mb8vae

# Option B — push to main (production trigger):
git switch main && git pull --ff-only
# … merge the migration PR …  push triggers the workflow automatically
```

The workflow: installs (`pnpm install --frozen-lockfile`), builds
(`pnpm run build:web`), assumes the OIDC role, `aws s3 sync`s
`artifacts/scent-cast/dist/public` to the bucket with per-path cache-control, and
invalidates only the no-cache HTML entry points. Confirm the run is green before
proceeding.

## 4. Smoke-test the CloudFront URL — BEFORE any DNS change

Use the `cloudfront_domain_name` from step 1 (e.g. `d1234abcd.cloudfront.net`).
All four checks must pass:

```bash
CF=d1234abcd.cloudfront.net

# a) SPA root loads (200, HTML)
curl -sS -o /dev/null -w '%{http_code}\n' "https://$CF/"

# b) Immutable asset served from S3 with long cache
curl -sS -D - -o /dev/null "https://$CF/assets/"   # spot-check a real hashed file; expect cache-control: public, max-age=31536000, immutable

# c) SPA deep-route rewrite: a hard navigation to a client route must return the
#    app shell (200 + index.html), NOT a 404. This proves the 403/404 → /index.html
#    custom error responses work.
curl -sS -o /dev/null -w '%{http_code}\n' "https://$CF/arena"
curl -sS -o /dev/null -w '%{http_code}\n' "https://$CF/share/anything-here"

# d) THE PROXY: an /api/* call must reach Railway Express (not 403/503 from S3).
#    This proves the CloudFront → Railway origin + AllViewer policy works.
curl -sS -o /dev/null -w '%{http_code}\n' "https://$CF/api/health"   # use a real lightweight API route

# d2) Auth header + cookies pass through unchanged (same-origin Bearer model):
curl -sS -D - -o /dev/null \
  -H "Authorization: Bearer <a-valid-users.token>" \
  "https://$CF/api/<an-authenticated-route>"   # expect a 200/authorized response, and any Set-Cookie echoed back
```

Then load `https://$CF/` in a real browser and confirm: the app renders; a
search works (that is the browser hitting the **Python engine directly** via
`VITE_FRAGRANCE_API_URL` — unaffected); signing in / an authenticated wardrobe
action works (that is the `/api/*` → Railway proxy carrying the Bearer token).
Check DevTools that `/api/*` requests are same-origin against the CloudFront host
and return real backend JSON (not the `middleware.js` 503).

If (d) fails, the `/api/*` behavior or `backend_origin_domain` is wrong — fix
Terraform and re-apply **before** touching DNS.

## 5. DNS cutover

Only after step 4 is fully green.

1. **Attach the custom domain in Terraform first.** Set `domain_name` (and any
   `www` alias your config supports) and `terraform apply`. ACM certificate
   validation (DNS-validated, us-east-1) must complete and the alias must be
   added to the distribution **before** you point traffic at it — otherwise
   CloudFront serves a cert mismatch. Wait for the cert status to be `ISSUED` and
   the distribution to redeploy (`Deployed`).
2. **Lower TTL ahead of time.** A few hours before cutover, drop the existing
   Vercel DNS record TTL (e.g. to 300s) so the switch propagates fast and a
   rollback is quick.
3. **Repoint the records** from Vercel to CloudFront:
   - Apex/root: an **ALIAS/ANAME** (or provider flattened CNAME) → the
     distribution domain `cloudfront_domain_name` (`d1234abcd.cloudfront.net`).
   - `www`: a **CNAME** → the same `cloudfront_domain_name`.
   - Remove the old Vercel A/CNAME targets.
4. Watch propagation: `dig +short app.example.com` and
   `dig +short www.app.example.com` should resolve to the CloudFront domain.

## 6. Verify production

Repeat the step-4 checks against the **real domain** (not `*.cloudfront.net`):

```bash
DOMAIN=app.example.com
curl -sS -o /dev/null -w '%{http_code}\n' "https://$DOMAIN/"
curl -sS -o /dev/null -w '%{http_code}\n' "https://$DOMAIN/arena"          # SPA rewrite
curl -sS -o /dev/null -w '%{http_code}\n' "https://$DOMAIN/api/health"     # proxy → Railway
```

In a browser on the production domain: SPA renders, search works (Python
engine), sign-in + an authenticated action works (Express via `/api/*`), and TLS
shows the ACM cert. Confirm the `Cache-Control` headers match `vercel.json`
semantics (immutable `/assets/*`, `no-cache` on HTML entry points).

## 7. Decommission Vercel

Only after step 6 is verified in production and has been stable for a short
window.

1. **Stop Vercel auto-deploys first:** in the Vercel project → **Settings → Git**,
   **disconnect the Git integration** so pushes no longer trigger Vercel builds.
   This is the reversible "make it dormant" action — keep the project itself.
2. Keep the Vercel project **dormant (not deleted)** for the rollback window
   (see Rollback below).
3. After the window, if everything is healthy, **delete the Vercel project** and
   remove any Vercel-only DNS leftovers.
4. **Remove the now-dead proxy from the repo** (a normal PR): delete
   `vercel.json` and `middleware.js`. They were retained until this point on
   purpose. Also retire the now-unused `BACKEND_ORIGIN` env var from any config
   store (its role is now the Terraform `backend_origin_domain`).
5. Rotate any secret that was only ever held in Vercel (see `SECURITY.md`).

---

## Rollback

Because **no backend moved**, rollback is **DNS-only** and fast.

1. **Re-point DNS back to Vercel.** Restore the apex/`www` records to their prior
   Vercel targets. Because you lowered TTL in step 5.2, this propagates in
   minutes. `dig +short app.example.com` should resolve back to Vercel.
2. **The Vercel project is still there.** As long as you only did step-7.1
   (disconnected Git / kept it dormant) and did **not** delete it, Vercel serves
   the last good build immediately. If Git was disconnected, the existing
   deployment still serves; reconnect Git only if you need new Vercel builds
   again.
3. **`vercel.json` + `middleware.js` are still in the repo** (they are only
   removed in step 7.4, after the window), so the Vercel `/api/*` proxy behavior
   is intact on rollback. Ensure `BACKEND_ORIGIN` is still set on Vercel.
4. Nothing to roll back on Railway — the Express API and Python engine were never
   touched. The CloudFront distribution can be left running (idle) or torn down
   later with `terraform destroy`; leaving it up costs little and makes a second
   cutover attempt trivial.

**Rollback window guidance:** keep the Vercel project dormant for **at least
7 days** (N days) after cutover before deleting it, and keep DNS TTL low for the
first day or two. Delete `vercel.json` / `middleware.js` and the Vercel project
only once you are confident you will not roll back.

### TTL considerations
- Lower TTL (e.g. 300s) **before** cutover so both the switch and any rollback
  propagate quickly.
- Raise TTL back to normal (e.g. 3600s+) only after production has been stable on
  CloudFront for a day or two.
