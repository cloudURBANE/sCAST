# Environment variable mapping: Vercel → AWS

This maps every env var relevant to the frontend move to its **new home**.
Three categories:

- **Build-time `VITE_*`** — baked into the SPA bundle at build time. On Vercel
  these were Project → Environment Variables. Now they are provided to the
  **GitHub Actions build step** (`deploy-frontend.yml`) as repo
  variables/secrets, or committed as non-secret defaults in the repo's env
  files. They are **not** AWS resources — CloudFront/S3 never see them.
- **Vercel middleware config** — `BACKEND_ORIGIN`, consumed only by
  `middleware.js`. This is **replaced by Terraform**, not carried over as an env
  var.
- **Railway backend vars** — unchanged. They live on the Railway services and
  are out of scope for this migration.

## Frontend build-time (`VITE_*`) vars

These are read by Vite at build. Set them in the GitHub Actions environment for
the `pnpm run build:web` step (repo → Settings → Secrets and variables →
Actions), or keep the current non-secret defaults in the repo's env file. None
is secret — everything under `VITE_*` is exposed in the browser bundle by
design, so never put a real secret here.

| Var | Value | New home | Notes |
|-----|-------|----------|-------|
| `VITE_FRAGRANCE_API_URL` | `https://srt-scent-engine-production.up.railway.app` | GH Actions build env (or repo env file) | **Points at the Python engine, called directly by the browser. UNAFFECTED by this migration** — not proxied through CloudFront. Must be set or the SPA throws on every search/detail call. |
| `VITE_API_BASE_URL` | **empty / unset** | Leave unset | Keep empty so the SPA calls the Express API **same-origin** at `/api/*`, which CloudFront's `/api/*` behavior forwards to Railway. Setting it to the Railway URL would bypass the CloudFront proxy and reintroduce cross-origin CORS concerns — **do not set it**. |
| `VITE_IMAGE_CDN_BASES` | as configured (may be empty) | GH Actions build env / repo env file | Optional; image CDN allow-list. Unchanged by migration. |
| `VITE_IMAGE_METRICS_URL` | as configured (may be empty) | GH Actions build env / repo env file | Optional; unchanged. |
| `VITE_WEB_VITALS_URL` | as configured (may be empty) | GH Actions build env / repo env file | Optional; unchanged. |

> The build must run with the same `VITE_*` values production expects, because
> Vite inlines them at build time. If a `VITE_*` value changes, you must
> **rebuild and redeploy** — you cannot change it at the edge.

## Vercel middleware config → Terraform

| Var (old) | Was | New home | Notes |
|-----------|-----|----------|-------|
| `BACKEND_ORIGIN` | Vercel project env; read by `middleware.js` to proxy `/api/*` → Railway Express | **Terraform variable `backend_origin_domain`** in `infra/` (the CloudFront `/api/*` second origin) | This is the single most important remapping. On Vercel it was a full origin URL (e.g. `https://scentbeam-api.up.railway.app`). In Terraform it is the **domain only** (e.g. `scentbeam-api.up.railway.app`) used as the CloudFront custom origin. CloudFront's `/api/*` behavior (CachingDisabled + AllViewer) replaces the middleware entirely. |

After migration `BACKEND_ORIGIN` is **no longer used** — `middleware.js` is
removed in the decommission step and CloudFront owns the proxy.

## GitHub Actions secrets/vars (new — deploy plumbing)

Set in sCAST repo → Settings → Secrets and variables → Actions. Values come from
Terraform outputs (see `CUTOVER.md`).

| Name | Type | Source (Terraform output) | Purpose |
|------|------|---------------------------|---------|
| `AWS_DEPLOY_ROLE_ARN` | Secret | `github_actions_role_arn` | OIDC role the workflow assumes (no static AWS keys) |
| `AWS_REGION` | Variable | `us-east-1` (fixed) | Region for S3 + CloudFront calls |
| `FRONTEND_S3_BUCKET` | Variable | `frontend_bucket_name` | Target bucket for `aws s3 sync` |
| `CLOUDFRONT_DISTRIBUTION_ID` | Variable | `cloudfront_distribution_id` | Target for `aws cloudfront create-invalidation` |

## Railway backend vars — UNCHANGED

Everything the Express API and Python engine read stays on Railway exactly as
today. No migration action. Representative examples (not exhaustive — see
`.env.example`): `DATABASE_URL`, `WEATHER_API_KEY`, `SERPER_API_KEY(S)`,
`REMOVE_BG_API_KEY(S)`, `GEMINI_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`,
`ANTHROPIC_API_KEY`, `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, `ADMIN_SECRET`,
Firebase/Supabase storage vars, Rakuten/Amazon affiliate vars, and the engine's
`DECODO_*` / `API_*` vars.

Two backend OAuth-URL notes worth checking after DNS cutover (they concern the
**public origin the browser uses**, which stays the same custom domain):

- `OAUTH_PUBLIC_URL` / `PUBLIC_APP_URL` / `FRONTEND_URL` — if these are pinned to
  a `*.vercel.app` origin, update them to the production custom domain so Google
  OAuth redirects and any absolute links resolve to CloudFront, not Vercel. If
  they are already the custom domain, no change is needed.
- Google OAuth Console authorized redirect URIs must include the callback on the
  final production origin (same custom domain), which is unchanged if the domain
  is unchanged.

## Quick summary

- `VITE_FRAGRANCE_API_URL` → build-time, points at the **Python engine**,
  **unchanged**.
- `VITE_API_BASE_URL` → **stays empty** so `/api/*` is same-origin →
  CloudFront → Railway.
- `BACKEND_ORIGIN` → replaced by Terraform `backend_origin_domain`; the env var
  itself retires with `middleware.js`.
- All Railway backend secrets → **unchanged**.
