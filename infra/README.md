# sCAST frontend infrastructure (Terraform)

Terraform that hosts the **sCAST SPA** on **AWS S3 + CloudFront**, replacing Vercel.
The Express API and the Python fragrance engine **stay on Railway** — this stack only
moves the static frontend and reproduces Vercel's `/api/*` same-origin proxy at the CDN.

Everything lives in **us-east-1** (CloudFront's ACM certificate must be there).

---

## What this creates

| File | Resources | Purpose |
|---|---|---|
| `versions.tf` | terraform + `hashicorp/aws ~> 5.40`, provider (us-east-1), commented remote-state backend | Version pins, region, default tags |
| `s3.tf` | `aws_s3_bucket.frontend`, ownership controls, public-access-block (all true), SSE, bucket policy | Private origin bucket; readable **only** by CloudFront via OAC |
| `cloudfront.tf` | `aws_cloudfront_origin_access_control.s3`, cache policy `static_long`, 3 response-headers policies, `aws_cloudfront_distribution.frontend` | The CDN + the `/api/*` proxy + cache behaviors |
| `acm.tf` | `aws_acm_certificate.frontend` (+ optional Route53 validation/alias), locals | TLS cert, only when `domain_name` is set |
| `iam_oidc.tf` | `aws_iam_openid_connect_provider.github`, `aws_iam_role.github_actions_frontend_deploy`, least-privilege inline policy | Keyless CI deploys via GitHub OIDC |
| `outputs.tf` | 4 outputs (see below) | Values to paste into GitHub Actions |
| `variables.tf` | input variables | Configuration |
| `terraform.tfvars.example` | — | Copy to `terraform.tfvars` and fill in |

### Exact outputs

| Output | Feeds GitHub Actions | Notes |
|---|---|---|
| `frontend_bucket_name` | variable `FRONTEND_S3_BUCKET` | S3 sync target |
| `cloudfront_distribution_id` | variable `CLOUDFRONT_DISTRIBUTION_ID` | invalidation target |
| `cloudfront_domain_name` | (smoke-test URL / DNS target) | `*.cloudfront.net` |
| `github_actions_role_arn` | secret `AWS_DEPLOY_ROLE_ARN` | role the workflow assumes |

---

## Prerequisites

- Terraform >= 1.5, an AWS account, and local AWS credentials with permission to
  create S3/CloudFront/ACM/IAM resources (`aws configure` or `AWS_PROFILE=...`).
- The Railway Express backend's public hostname (for `backend_origin_domain`).

---

## Usage

```sh
cd infra
cp terraform.tfvars.example terraform.tfvars
# edit terraform.tfvars: set backend_origin_domain (required), and optionally
# frontend_bucket_name / domain_name / route53_zone_id

terraform init
terraform plan
terraform apply

# read the outputs any time:
terraform output
```

`terraform init` works out of the box with **local state** (the S3 backend in
`versions.tf` is commented). See [Remote state](#remote-state) to switch to shared state.

---

## Wiring the outputs into GitHub Actions

In the `cloudURBANE/sCAST` repo → **Settings → Secrets and variables → Actions**:

| Kind | Name | Value |
|---|---|---|
| Secret | `AWS_DEPLOY_ROLE_ARN` | `terraform output -raw github_actions_role_arn` |
| Variable | `AWS_REGION` | `us-east-1` |
| Variable | `FRONTEND_S3_BUCKET` | `terraform output -raw frontend_bucket_name` |
| Variable | `CLOUDFRONT_DISTRIBUTION_ID` | `terraform output -raw cloudfront_distribution_id` |

CLI shortcut:

```sh
gh secret   set AWS_DEPLOY_ROLE_ARN     -R cloudURBANE/sCAST --body "$(terraform output -raw github_actions_role_arn)"
gh variable set AWS_REGION              -R cloudURBANE/sCAST --body "us-east-1"
gh variable set FRONTEND_S3_BUCKET      -R cloudURBANE/sCAST --body "$(terraform output -raw frontend_bucket_name)"
gh variable set CLOUDFRONT_DISTRIBUTION_ID -R cloudURBANE/sCAST --body "$(terraform output -raw cloudfront_distribution_id)"
```

The deploy workflow authenticates with **OIDC** (`aws-actions/configure-aws-credentials@v4`,
`role-to-assume = AWS_DEPLOY_ROLE_ARN`) — no static AWS keys exist anywhere.

---

## The `/api/*` proxy (replaces `middleware.js`)

Today the SPA calls the Express API **same-origin** at `/api/*`, and Vercel's
`middleware.js` proxies those to the Railway backend (`BACKEND_ORIGIN`). On
CloudFront this is reproduced with a **second origin + an ordered cache behavior**:

- **Origin 2** `railway-backend` — custom origin, `origin_protocol_policy = "https-only"`
  (CloudFront always talks HTTPS to Railway).
- **Behavior** `path_pattern = "/api/*"` → `railway-backend`, using:
  - Managed **`CachingDisabled`** cache policy → nothing is ever cached (correct for
    an authenticated API).
  - Managed **`AllViewerExceptHostHeader`** origin-request policy → forwards **all
    viewer headers, all cookies, and all query strings** to Railway. So the
    `Authorization: Bearer <token>` header and any cookies pass straight through,
    preserving the current same-origin auth model.
  - `allowed_methods` includes `GET/HEAD/OPTIONS/PUT/POST/PATCH/DELETE` so the full
    REST surface works.

**Why "ExceptHost":** Railway routes by the `Host` header. Forwarding the viewer's
Host (the CloudFront domain) would misroute; excluding it lets CloudFront send the
origin's own hostname. This matches `middleware.js`, which explicitly stripped the
incoming `Host`. The Python fragrance engine (`VITE_FRAGRANCE_API_URL`) is called
directly by the browser and is **not** proxied — untouched here.

---

## Cache-behavior mapping (mirrors `vercel.json`)

CloudFront separates **edge (CDN) caching** (the *cache policy* TTLs) from the
**`Cache-Control` header the browser receives** (a *response-headers policy* that
overrides it). Vercel expressed the same split with `Cache-Control` (browser) vs
`Vercel-CDN-Cache-Control` (CDN). Mapping:

| vercel.json source | Browser `Cache-Control` | CDN | CloudFront implementation |
|---|---|---|---|
| `/assets/*` | `public, max-age=31536000, immutable` | 1 yr | behavior `/assets/*`: `static_long` cache policy + `immutable_assets` response-headers policy |
| `/nav/*`, `/icons/*`, `/social/*`, `/beta/*`, `/favicon.svg`, `/opengraph-scentbeam-v2.png`, `/opengraph.jpg`, `/scent-concierge-avatar.png` | `public, max-age=86400, stale-while-revalidate=604800` | immutable 1 yr | one behavior per pattern (generated via `dynamic`): `static_long` cache policy + `browser_short` response-headers policy |
| `/index.html`, `/`, `/site.webmanifest`, `/community`, `/arena`, `/debug/*`, `/share/*` | `no-cache, max-age=0, must-revalidate` | no-store | **default behavior**: `CachingDisabled` + `no_cache_html` response-headers policy |
| all other routes (SPA client routes) | `no-cache` | no-store | same default behavior; 403/404 → `/index.html` (200) |

### Why the no-cache routes are handled by the *default* behavior

Every no-cache path in `vercel.json` (`index.html`, `/`, `site.webmanifest`,
`community`, `arena`, `debug/*`, `share/*`) plus every unlisted SPA route must be
served as the no-cache HTML shell. Rather than declare an ordered behavior per exact
path, the **default behavior is itself no-cache HTML**, so all of them are covered by
one rule. The only ordered behaviors are the *cached* groups (`/assets/*` and the
browser-cached static dirs/files) and `/api/*`. This is faithful because Vercel's
catch-all rewrite (`/(.*) -> /index.html`) also sends unmatched routes to the
no-cache shell.

### SPA routing

`custom_error_response` for **403** and **404** → `response_page_path = /index.html`,
`response_code = 200`. S3 returns 403/404 for client-side routes that aren't real
objects; CloudFront rewrites them to the SPA shell. This reproduces vercel.json's
`rewrites: /(.*) -> /index.html`.

---

## Custom domain & TLS

- **No domain (`domain_name = ""`, the default):** CloudFront serves its
  `*.cloudfront.net` domain with the default CloudFront certificate. Nothing else to do.
- **Custom domain (`domain_name = "app.example.com"`):** an ACM cert is requested in
  us-east-1 (DNS validation), attached with `ssl_support_method = "sni-only"` and a
  **`TLSv1.2_2021`** minimum protocol version, and set as a CloudFront alias.

Two DNS-validation paths:

1. **Route53 (automated)** — set `route53_zone_id` as well. Terraform creates the
   ACM validation CNAMEs, waits for issuance (`aws_acm_certificate_validation`), and
   creates `A`/`AAAA` alias records pointing the domain at CloudFront. Single
   `terraform apply`.
2. **External DNS (manual)** — leave `route53_zone_id = ""`. On the first `apply`,
   Terraform requests the cert; retrieve the validation `CNAME name/value` from the
   ACM console (or `terraform state show 'aws_acm_certificate.frontend[0]'`), add
   them at your DNS provider, wait for ACM to show **Issued**, then run `terraform
   apply` again so the (now-validated) cert attaches to the distribution. Finally,
   create a `CNAME`/`ALIAS` from your domain to `cloudfront_domain_name` at your DNS
   provider.

> Because an unvalidated ACM cert cannot attach to CloudFront, the manual path may
> need two `apply`s (request → validate out-of-band → attach). The Route53 path does
> it in one.

---

## Remote state

Default is **local state** so `terraform init` just works. For team use, adopt an
S3 + DynamoDB backend:

1. One-time bootstrap (create these once, out of band or in a separate tiny stack):
   - a **versioned, private** S3 bucket, e.g. `scentbeam-terraform-state`
   - a DynamoDB table, e.g. `scentbeam-terraform-locks`, partition key **`LockID`** (String)
2. Uncomment the `backend "s3"` block in `versions.tf` (adjust names/`key` if needed).
3. Migrate:
   ```sh
   terraform init -migrate-state
   ```

---

## Validation

Terraform was **not installed in the authoring environment**, so these files were
reviewed by hand for HCL correctness. Before your first apply, run:

```sh
terraform -chdir=infra fmt
terraform -chdir=infra init -backend=false
terraform -chdir=infra validate
```

---

## Notes / assumptions / follow-ups

- **`backend_origin_domain` is required** and has no safe default — set it to the
  Railway Express public hostname (bare host, no scheme), e.g.
  `scentbeam-api.up.railway.app`.
- `frontend_bucket_name` must be **globally unique**; change it if
  `scentbeam-frontend-prod` is taken.
- **Do not delete `vercel.json` / `middleware.js` yet** — keep them until cutover is
  verified (per the migration contract), then remove in the decommission step.
- The OIDC trust policy allows both `refs/heads/main` and the pre-cutover branch
  `refs/heads/claude/vercel-aws-migration-mb8vae`. Tighten `github_deploy_refs` to
  just `main` after cutover.
- CloudFront distributions take ~5–15 min to deploy on create/update; plan cutover
  timing accordingly.
