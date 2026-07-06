# Vercel → AWS Migration Plan (deep audit + execution plan)

Date: 2026-07-06. Scope: remove Vercel entirely and host the stack on AWS, as simply as
possible. This document covers the web app (this repo). The Python engine has its own
companion plan at `srt-scent-engine/docs/AWS_MIGRATION_PLAN.md`.

## Implementation status (2026-07-06)

Repo-side work is DONE; what remains is AWS account work (Phases 0-3) and the
post-cutover cleanup (Phase 4, deliberately NOT done yet — Vercel/Railway are live).

- **`Dockerfile`**: `ARG VITE_GIT_SHA` now feeds the SPA build (Phase 2 step 1), so
  the telemetry build tag survives without `VITE_VERCEL_GIT_COMMIT_SHA`. Empty
  default keeps Railway builds unchanged.
- **`.github/workflows/tests.yml`**: Phase 5 deploy job added behind the existing
  typecheck/test/Lighthouse gates. It stays skipped until the repo variable
  `AWS_DEPLOY_ENABLED=true` is set (plus `AWS_REGION`, `AWS_DEPLOY_ROLE_ARN`,
  `ECR_REPOSITORY`, optional `APPRUNNER_SERVICE_ARN`), so Vercel/Railway git-push
  deploys remain authoritative during the parallel run.
- The engine repo's half (its Dockerfile + gated pipeline) is landed on its side —
  see the companion plan's own implementation-status section.

---

## 1. Current topology (audited)

| Piece | Today | Evidence |
|---|---|---|
| SPA (`artifacts/scent-cast`) | Vercel static hosting + CDN, built to `dist/public` | `vercel.json:6` (`outputDirectory`) |
| `/api/*` same-origin proxy | Vercel Edge middleware → `BACKEND_ORIGIN` (Railway) | `middleware.js:73-135` |
| Express API (`artifacts/api-server`) | Railway, Docker build, `pnpm start`, port 8080 | `railway.json`, `Dockerfile:33-42` |
| Python engine | Railway (separate repo `srt-scent-engine`) | its `railway.toml` |
| DB / storage | Supabase Postgres (`DATABASE_URL`) + Supabase/Firebase storage buckets | `.env.example`, `imageObjectStorage.ts` |
| Domains | `scentbeam.com` (SPA), `api.scentbeam.com` (API) | `docs/WARDROBE_SYNC_FAILED_PC_DIAGNOSIS.md:9,23-35` |

### The entire Vercel footprint (what actually has to be replaced)

1. `vercel.json` (root) + `artifacts/scent-cast/vercel.json` — build config, cache
   headers (including proprietary `Vercel-CDN-Cache-Control`), and the SPA rewrite
   `/(.*) → /index.html`.
2. `middleware.js` (root) + `artifacts/scent-cast/middleware.js` — the Edge proxy that
   makes `/api/*` same-origin. Load-bearing behaviors: body buffering, header
   stripping (`host`/`origin`/`referer`/`accept-encoding`), setting
   `x-forwarded-host`/`x-forwarded-proto` (OAuth depends on these —
   `routes/oauth.ts:27-30`), and stripping `content-encoding`/`content-length` from
   upstream responses (`middleware.js:128-129`).
3. One env read: `VITE_VERCEL_GIT_COMMIT_SHA` fallback in
   `src/lib/webVitalsTelemetry.ts:26`.

That's all. No `@vercel/*` dependencies, no `.vercel/` dir, no `vercel.app` URLs in
shipping code.

### The escape hatch we already own

`artifacts/api-server/src/app.ts:99-124` serves `artifacts/scent-cast/dist/public`
statically with a correct SPA fallback (and 404s for stale `/assets/*` instead of
returning HTML), and `app.ts:79-97` reproduces the exact cache-header rules from
`vercel.json` (immutable hashed assets, `no-cache` shell, 1-day SWR media). The
production `Dockerfile` already builds the SPA into the image (`Dockerfile:24`). In
other words: **the repo already contains a single self-hosted container that replaces
both Vercel and the Railway API service.** The migration is mostly deployment work, not
code work.

---

## 2. Recommended target architecture (simple and effective)

**One container on AWS App Runner, fronted by CloudFront, on `scentbeam.com`.**

```
Route 53 (scentbeam.com)
   └── CloudFront (TLS, CDN caching driven by origin Cache-Control headers)
         └── App Runner service "scentbeam-web" (existing Dockerfile)
               ├── serves SPA shell + hashed assets (app.ts static mount)
               ├── serves /api/* (Express, same process → same-origin, no proxy needed)
               └── proxies /api/engine/* → Python engine (fragranceEngineProxy.ts)
Supabase  ── unchanged (DATABASE_URL, storage buckets)
Engine    ── its own App Runner service (see companion plan)
```

Why this over the "AWS-native" S3 + CloudFront + separate API stack:

- **Same-origin is preserved for free.** The SPA is deliberately architected for
  relative `/api` calls because guests' privacy tooling blocks cross-origin requests
  (`fragranceApi.ts:942-943`). With S3+CloudFront you'd have to rebuild the Vercel
  middleware's header-stripping behavior as CloudFront origin-request/response
  policies — the exact fiddly layer we're trying to delete. With one container there
  is no proxy at all.
- **One deploy target instead of two.** No S3 sync + CloudFront invalidation + ECS
  deploy choreography; push an image, App Runner rolls it.
- **The cache rules already live in code** (`app.ts:79-97`), so CloudFront just needs
  the managed *"CachingOptimized"*-style policy that respects origin `Cache-Control` —
  no per-path CloudFront cache policies to hand-maintain (which is what the 200-line
  `vercel.json` headers block would otherwise become).
- App Runner gives Railway-like DX (image → URL, health checks, custom domain, TLS,
  autoscaling) with no VPC/ALB/target-group management.

Fallback if App Runner ever binds (e.g. need EFS, WebSockets, >120s requests — none
apply today): the same image runs unchanged on ECS Fargate behind an ALB. Nothing in
the plan locks us out of that.

CloudFront is kept in front (rather than App Runner's domain alone) for CDN caching of
the immutable `/assets/*` and public media, and to keep TLS/domain management in one
place. It's optional on day one — App Runner custom domains work directly — but it's
what replaces Vercel's CDN value.

---

## 3. Migration phases

### Phase 0 — Prep (no downtime, no AWS yet)

1. Inventory secrets: everything in `.env.example` currently set on Railway/Vercel.
   Minimum for prod parity: `DATABASE_URL`, `PORT`, storage vars
   (`SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`/`SUPABASE_IMAGE_*` and/or
   `FIREBASE_STORAGE_*`), `SERPER_API_KEY`, `REMOVE_BG_API_KEY`, `GEMINI_API_KEY`,
   `OPENAI_API_KEY`, `GOOGLE_CLIENT_ID`/`SECRET`, `ADMIN_SECRET`, VAPID keys,
   `OPENROUTER_API_KEY`, `REDIS_URL` (if used), affiliate vars,
   `FRAGRANCE_ENGINE_URL`.
2. Lower DNS TTL on `scentbeam.com` records to 300s at the current registrar.
3. Confirm access to Google Cloud Console (OAuth client) — needed in Phase 2.

### Phase 1 — AWS foundation

1. ECR repository `scentbeam-web`.
2. Secrets Manager (or SSM Parameter Store) entries for the Phase 0 secret list.
3. Route 53 hosted zone for `scentbeam.com` (delegate from registrar, or keep DNS at
   the registrar and just CNAME — hosted zone is cleaner long-term).
4. ACM certificate for `scentbeam.com` + `www` (+ `api.scentbeam.com` if kept) in
   `us-east-1` (CloudFront requirement).

### Phase 2 — Deploy the web container (parallel-run, Vercel still live)

1. Build and push the existing `Dockerfile` to ECR. Build args/env to add:
   `VITE_GIT_SHA=$(git rev-parse HEAD)` so the telemetry build tag survives without
   `VITE_VERCEL_GIT_COMMIT_SHA` (`webVitalsTelemetry.ts:25-27`). Frontend build-time
   vars: leave `VITE_API_BASE_URL` **unset/empty** (same-origin) and set
   `VITE_FRAGRANCE_API_URL` only if the SPA should hit the engine directly; otherwise
   it uses `/api/engine` through Express.
2. Create App Runner service from the ECR image:
   - Port 8080, env `PORT=8080` (`index.ts:14-26` throws if unset).
   - Health check: `GET /api/healthz` (`routes/health.ts:6-9`).
   - Env/secrets from Phase 1. Set `OAUTH_PUBLIC_URL=https://scentbeam.com` — this
     short-circuits the `x-forwarded-host` dependency entirely (`oauth.ts:13-41`),
     which is the safest option behind CloudFront.
   - `FRAGRANCE_ENGINE_URL` → the engine's URL (Railway today; AWS after its own
     cutover). Do not rely on the hardcoded Railway default in
     `fragranceEngineProxy.ts:8`.
   - Size: start 1 vCPU / 2 GB (sharp image encoding is the only heavy path;
     `SHARP_CONCURRENCY` can cap it).
3. Create the CloudFront distribution: single origin = App Runner URL; cache policy
   that respects origin `Cache-Control`; forward all methods; forward `Host` via
   origin-request policy is **not** needed (we set `OAUTH_PUBLIC_URL`), but do use the
   managed *AllViewerExceptHostHeader* origin-request policy so cookies/query strings
   pass through. **No custom error responses** — the container already does SPA
   fallback correctly, and a blanket CloudFront 404→index.html rule would reintroduce
   the stale-asset bug that `app.ts:116-119` deliberately prevents.
4. Smoke-test on the CloudFront/App Runner URL: SPA loads, `/api/healthz`, search,
   wardrobe, image pipeline, `/api/engine/*` proxy.
5. Google OAuth: add `https://scentbeam.com/api/auth/google/callback` is already
   registered (domain unchanged) — verify; also add the App Runner/CloudFront test
   URL temporarily if OAuth needs testing pre-cutover. See
   `docs/WARDROBE_SYNC_FAILED_PC_DIAGNOSIS.md:30-35` — this is the known failure mode.

### Phase 3 — Cutover (minutes, reversible)

1. Point `scentbeam.com` (and `www`) at the CloudFront distribution (Route 53
   alias / CNAME).
2. Verify: Google login round-trip, guest search (same-origin `/api`), PWA update
   (`site.webmanifest` and `sw.js` must come back `no-cache`), hashed assets served
   with `immutable`, web-push still delivers (domain unchanged → VAPID subscriptions
   survive).
3. `api.scentbeam.com` can simply CNAME to the same CloudFront/App Runner service or
   be retired — nothing in the SPA needs it once same-origin serving is live.
4. Rollback = flip DNS back to Vercel (keep the Vercel project paused, not deleted,
   for a week).

### Phase 4 — Decommission + repo cleanup (after a quiet week)

1. Delete the Vercel project and the Railway `scast` service.
2. Repo changes (small PR):
   - Delete `vercel.json`, `artifacts/scent-cast/vercel.json`, `middleware.js`,
     `artifacts/scent-cast/middleware.js`.
   - `webVitalsTelemetry.ts`: drop the `VITE_VERCEL_GIT_COMMIT_SHA` fallback (keep
     `VITE_GIT_SHA`/`VITE_APP_VERSION`).
   - `vite.config.ts:182`: replace the hardcoded `scast-production.up.railway.app`
     dev-proxy fallback with the new API origin (or require the env var).
   - Update the five hardcoded `srt-scent-engine-production.up.railway.app` defaults
     (`fragranceEngineProxy.ts:8`, `enrichmentProcessor.ts:31`, `serperService.ts:22`,
     `engineResolve.ts:23`, `engineDiscover.ts:23`) once the engine has moved.
   - Update `CLAUDE.md` deployment-topology section and `.env.example` comments.
3. Delete `railway.json` once Railway is fully off.

### Phase 5 — CI/CD (replaces Vercel/Railway git-push deploys)

Extend `.github/workflows/tests.yml` (currently test-only) with a deploy job on
`main`: build the Docker image (with `VITE_GIT_SHA`), push to ECR (OIDC role, no
long-lived keys), then `aws apprunner start-deployment`. Keep the existing
typecheck/test/Lighthouse gates in front of it.

---

## 4. Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| OAuth redirect mismatch after cutover | High | `OAUTH_PUBLIC_URL` set explicitly; verify callback URL in Google Console; known playbook in `WARDROBE_SYNC_FAILED_PC_DIAGNOSIS.md` |
| PWA clients pinned to stale shell | High | Container already serves shell `no-cache`; verify CloudFront doesn't override; boot-watchdog in `index.html` is a backstop |
| CloudFront caching `/api/*` responses | Medium | Use a cache-disabled behavior for `/api/*` or rely on API responses' no-store headers; verify `set-cookie` paths |
| Keep-alive/idle-timeout 502s | Low | Server keep-alive already 65s (`index.ts:86-87`), above CloudFront's 60s origin idle default |
| Sharp/image pipeline memory on small instance | Low | `SHARP_CONCURRENCY` env; watch App Runner metrics, bump to 4 GB if needed |
| Supabase egress cost shift | Low | Nothing changes — storage/DB stay on Supabase; see `SUPABASE_EGRESS_AUDIT_2026-06-17.md` |

## 5. Rough monthly cost (us-east-1, ballpark)

- App Runner web service (1 vCPU / 2 GB, always-on): ~$25–50
- CloudFront: low single digits at current traffic
- ECR + Secrets Manager + Route 53: ~$3–5
- (Engine service + its DB: see companion plan, ~$30–65)

Comparable to or below the current Vercel Pro + Railway spend, with one fewer vendor.

## 6. Explicitly out of scope / unchanged

- Supabase (app DB + storage) and Firebase storage stay as-is.
- The Python engine's offline Windows enrichment worker stays on the owner's machine
  (see companion plan — it just gets re-pointed).
- No frontend or API code changes beyond the Phase 4 cleanup list.
