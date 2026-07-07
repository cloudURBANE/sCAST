# sCAST frontend migration: Vercel → AWS S3 + CloudFront

This directory documents moving **only the sCAST frontend SPA** off Vercel to
**AWS S3 + CloudFront**. The Express API and the Python fragrance engine **do
not move** — they stay on Railway.

| Doc | What it covers |
|-----|----------------|
| [`README.md`](./README.md) | Target architecture, what moved / what stayed (this file) |
| [`ENV_MAPPING.md`](./ENV_MAPPING.md) | Every relevant env var → its new home |
| [`CUTOVER.md`](./CUTOVER.md) | Ordered cutover runbook + rollback plan |
| [`SECURITY.md`](./SECURITY.md) | OIDC, IAM least-privilege, OAC, TLS, auth model |

## What moved vs what stayed

| Component | Before | After |
|-----------|--------|-------|
| **sCAST SPA (static build)** | Vercel | **S3 (private) + CloudFront** ← the migration |
| **`/api/*` proxy** | `middleware.js` (Vercel Edge) → `BACKEND_ORIGIN` | **CloudFront `/api/*` behavior** → Railway Express |
| Express API (`@workspace/api-server`) | Railway | **Railway (unchanged)** |
| Python fragrance engine | Railway | **Railway (unchanged)** |
| Postgres / Supabase, Firebase Storage, etc. | Unchanged | **Unchanged** |

The SPA is a React 19 + Vite build. Build command `pnpm run build:web`
(= `pnpm --filter @workspace/scent-cast run build`); static output lands in
`artifacts/scent-cast/dist/public`. That directory is what gets synced to S3.

## Target architecture (text diagram)

```
  Developer
     |  git push  →  branch main (or workflow_dispatch)
     v
  GitHub Actions: .github/workflows/deploy-frontend.yml
     |  1. pnpm install --frozen-lockfile  (pnpm 9.15.9 via corepack, Node 24)
     |  2. pnpm run build:web  →  artifacts/scent-cast/dist/public
     |  3. assume AWS_DEPLOY_ROLE_ARN via OIDC (no static keys)
     |  4. aws s3 sync … s3://$FRONTEND_S3_BUCKET --delete   (per-path cache-control)
     |  5. aws cloudfront create-invalidation  (HTML entry points only)
     v
  ┌──────────────────────────────────────────────────────────────────┐
  │                       CloudFront distribution                      │
  │                                                                    │
  │  Default behavior  ────────────────►  S3 bucket (PRIVATE, OAC)     │
  │   (SPA static assets)                 scentbeam-frontend-prod      │
  │   cache policy mirrors vercel.json    (no public access)          │
  │   403/404 → /index.html (200)  = SPA client-side routing          │
  │                                                                    │
  │  Behavior  /api/*  ────────────────►  Railway Express backend      │
  │   CachingDisabled                     backend_origin_domain        │
  │   AllViewer (fwd all headers/         (custom origin, HTTPS-only)  │
  │   cookies/querystring)                = replaces middleware.js     │
  └──────────────────────────────────────────────────────────────────┘
     ▲ browser: SPA + same-origin /api/*        │ browser: direct (NOT via CloudFront)
     │                                           v
  End users                              Python fragrance engine on Railway
                                         (VITE_FRAGRANCE_API_URL, unchanged)
```

### Two request paths the browser uses

1. **Same-origin `/api/*`** — the SPA calls the Express API at a relative
   `/api/*` path (`VITE_API_BASE_URL` stays empty = same-origin). CloudFront's
   `/api/*` behavior forwards these to the Railway Express backend with no
   caching and all headers/cookies intact. This **replaces `middleware.js`** and
   is what keeps the Bearer-token auth model working (see `SECURITY.md`).
2. **Direct to the Python engine** — search/detail intelligence calls go
   straight from the browser to `VITE_FRAGRANCE_API_URL`
   (`https://srt-scent-engine-production.up.railway.app`). These are **not**
   proxied through CloudFront and are **unaffected** by this migration.

## Infrastructure that backs this

- **Terraform** in [`../../infra/`](../../infra/) provisions the S3 bucket,
  CloudFront distribution (both origins + behaviors), the GitHub OIDC provider,
  and the least-privilege deploy IAM role. Region is **us-east-1** everywhere
  (required for CloudFront's ACM cert). See `infra/README.md` for variables and
  outputs.
- **CI/CD**: [`../../.github/workflows/deploy-frontend.yml`](../../.github/workflows/deploy-frontend.yml)
  builds and deploys on push to `main`. The existing `tests.yml` gate is kept
  intact.

Terraform outputs feed the four GitHub Actions secrets/vars the workflow needs
(`AWS_DEPLOY_ROLE_ARN`, `AWS_REGION`, `FRONTEND_S3_BUCKET`,
`CLOUDFRONT_DISTRIBUTION_ID`) — see `CUTOVER.md` step 2.

## Retained until cutover

`vercel.json` and `middleware.js` are **intentionally kept in the repo** until
the CloudFront cutover is verified in production. They are removed only in the
decommission step of `CUTOVER.md` — do not delete them earlier.
