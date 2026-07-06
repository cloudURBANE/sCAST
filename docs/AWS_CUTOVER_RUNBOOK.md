# AWS Cutover Runbook (web app + engine)

Date: 2026-07-06. This is the **do-it-in-order checklist** to finish the migration.
All repo-side code is already landed (see the implementation-status sections in
`docs/AWS_MIGRATION_PLAN.md` here and in `srt-scent-engine/docs/AWS_MIGRATION_PLAN.md`);
every remaining step is AWS/DNS/dashboard work plus two small post-cutover cleanup PRs.

Nothing here breaks the running site until Step 4 (DNS cutover), and Step 4 is
reversible by flipping DNS back.

---

## Step 0 — One-time AWS foundation (~30 min)

Use one region for everything: **us-east-1** (CloudFront's ACM certs must live there
anyway). You need the AWS CLI v2 logged in with admin credentials (`aws configure`).

### 0.1 Merge the two PRs

- sCAST: PR from `claude/production-critical-impl-odvdqt` (deploy pipeline + VITE_GIT_SHA)
- srt-scent-engine: PR from `claude/production-critical-impl-odvdqt` (Dockerfile + pipeline + plan doc)

Merging is safe: Railway still builds the engine with nixpacks (`railway.toml` pins
the builder) and the new CI deploy jobs stay skipped until you set
`AWS_DEPLOY_ENABLED=true` per repo.

### 0.2 GitHub OIDC provider + deploy role (no long-lived AWS keys)

```sh
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com \
  --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1
```

Save as `trust.json` (this restricts the role to pushes on `main` of your two repos):

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "arn:aws:iam::ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
      "StringLike": { "token.actions.githubusercontent.com:sub": [
        "repo:cloudURBANE/sCAST:ref:refs/heads/main",
        "repo:cloudURBANE/srt-scent-engine:ref:refs/heads/main"
      ]}
    }
  }]
}
```

Save as `deploy-policy.json`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "ecr:GetAuthorizationToken", "Resource": "*" },
    { "Effect": "Allow",
      "Action": ["ecr:BatchCheckLayerAvailability", "ecr:CompleteLayerUpload",
                 "ecr:InitiateLayerUpload", "ecr:PutImage", "ecr:UploadLayerPart",
                 "ecr:BatchGetImage"],
      "Resource": ["arn:aws:ecr:us-east-1:ACCOUNT_ID:repository/scentbeam-web",
                   "arn:aws:ecr:us-east-1:ACCOUNT_ID:repository/srt-scent-engine"] },
    { "Effect": "Allow", "Action": "apprunner:StartDeployment", "Resource": "*" }
  ]
}
```

Replace `ACCOUNT_ID` in both files (`sed -i "s/ACCOUNT_ID/$ACCOUNT_ID/" trust.json deploy-policy.json`), then:

```sh
aws iam create-role --role-name github-deploy --assume-role-policy-document file://trust.json
aws iam put-role-policy --role-name github-deploy --policy-name deploy --policy-document file://deploy-policy.json
```

### 0.3 ECR repositories

```sh
aws ecr create-repository --repository-name scentbeam-web   --region us-east-1
aws ecr create-repository --repository-name srt-scent-engine --region us-east-1
```

### 0.4 GitHub Actions variables

In **each** repo: Settings → Secrets and variables → Actions → **Variables** tab:

| Variable | sCAST | srt-scent-engine |
|---|---|---|
| `AWS_REGION` | `us-east-1` | `us-east-1` |
| `AWS_DEPLOY_ROLE_ARN` | `arn:aws:iam::<ACCOUNT_ID>:role/github-deploy` | same |
| `ECR_REPOSITORY` | `scentbeam-web` | `srt-scent-engine` |
| `AWS_DEPLOY_ENABLED` | `true` | `true` |
| `APPRUNNER_SERVICE_ARN` | *(leave unset until Step 2.3 / 1.4)* | *(same)* |

The moment `AWS_DEPLOY_ENABLED=true` is set, the next push to `main` builds and
pushes the image to ECR. With `APPRUNNER_SERVICE_ARN` still unset the workflow just
pushes the image and stops — that's the intended bootstrap: you need an image in ECR
before App Runner can be created. Re-run the workflow (Actions → re-run) or push any
commit to trigger the first image build.

### 0.5 Lower DNS TTL now

At the current DNS host for `scentbeam.com`: set the TTL on the apex and `www`
records to 300s. Do this a day before Step 4 so caches drain.

---

## Step 1 — Engine to AWS (do this first; web app re-points to it)

### 1.1 New engine database

Two equally fine options (the code only needs a `DATABASE_URL`; `db.init_db()` is
idempotent):

- **Easiest + cheapest: a second Supabase project.** Create project → copy the
  connection string (use the *session pooler* URI, port 5432). No AWS networking
  to configure.
- **All-in-AWS alternative: RDS.** `db.t4g.micro`, 20 GB, publicly accessible =
  yes, security group inbound 5432 restricted as tight as you can (App Runner has
  no fixed egress IPs unless you add a VPC connector — this is why Supabase is the
  easier call).

### 1.2 Copy the data (5-min quiet window)

1. **Stop the Windows enrichment worker** (close `run_worker.ps1`).
2. From any machine with `pg_dump` 16+:

```sh
pg_dump --no-owner --format=custom "<RAILWAY_DATABASE_URL>" -f engine.dump
pg_restore --no-owner --dbname "<NEW_DATABASE_URL>" engine.dump
```

Keep the worker stopped until 1.5.

### 1.3 Create the App Runner service

Console → App Runner → Create service:

- **Source**: ECR image `srt-scent-engine:latest` (from Step 0.4's first build).
  ECR access role: "Create new service role" (default AppRunnerECRAccessRole).
- **Deployment trigger: Manual** (CI calls `start-deployment`).
- **Port**: `8000`. **Health check**: HTTP, path `/health`.
- **Instance**: 1 vCPU / 2 GB. **Auto scaling: create a custom config with
  min = max = 1** — the engine's in-memory clearance sessions and concurrency caps
  assume a single instance.
- **Environment variables** (audit the Railway dashboard side-by-side so nothing
  set only there is lost):
  - `DATABASE_URL` = the new DB from 1.1
  - `FRONTEND_ORIGINS` = `https://scentbeam.com,https://www.scentbeam.com` — **CORS
    fails closed to localhost if you forget this**
  - `PUBLIC_BASE_URL` = the App Runner URL (update if you add a custom domain)
  - `ENRICHMENT_WORKER_TOKEN`, all `DECODO_*`, `RESEND_API_KEY`/`RESEND_FROM`/
    `ADMIN_ALERT_EMAIL`, any `API_*` / `ENRICHMENT_*` tuning overrides from Railway
  - Do **not** set `RAILWAY_*`, `BASENOTES_CHROMIUM_HEADLESS`, `DISABLE_CHROMIUM_MINT`,
    or `DRISSION_FORCE_ORIGIN` — the image bakes the right values in.

### 1.4 Verify the engine (gates — do not proceed on failure)

```sh
BASE=https://<apprunner-url>
curl $BASE/health                        # {"ok":true}
# MANDATORY (unverifiable from the dev sandbox): Chromium clearance mint
curl -X POST $BASE/api/diagnostics/basenotes/clearance \
  -H "Authorization: Bearer <ENRICHMENT_WORKER_TOKEN>"
# Cold search on a NEVER-cached fragrance (cached results prove nothing):
curl "$BASE/api/fragrances/search?q=<some obscure new fragrance>"
```

The cold-search bar is the `engine-live-verify` skill in the engine repo: results
must not be empty / Basenotes-only / Unknown-family.

Then set `APPRUNNER_SERVICE_ARN` (from the service's details page) as a variable in
the engine repo so future merges auto-deploy.

### 1.5 Re-point the engine's consumers

1. **Windows worker**: set `SCENT_API_BASE_URL=https://<engine-url>` (env var, or
   edit `run_worker.ps1`), start it, and confirm a job claim/complete round-trip in
   the logs.
2. **Web app (still on Railway for now)**: on the Railway `scast` service set
   `FRAGRANCE_ENGINE_URL=https://<engine-url>`.
3. **Vercel** (if `VITE_FRAGRANCE_API_URL` is set there): update it to the new
   engine URL and redeploy — or leave it; after Step 4 the SPA uses `/api/engine`
   same-origin anyway.
4. Optional but recommended: App Runner → Custom domains → `engine.scentbeam.com`,
   then use that everywhere so future moves don't touch consumers.

Railway engine service stays up (idle fallback) until Step 5.

---

## Step 2 — Web app to AWS (parallel-run; Vercel still serves production)

### 2.1 First image

Merging the sCAST PR with the Step 0.4 variables set already pushed
`scentbeam-web:latest` to ECR (with `VITE_GIT_SHA` baked in).

### 2.2 Create the App Runner service

Console → App Runner → Create service:

- **Source**: ECR `scentbeam-web:latest`. **Deployment trigger: Manual.**
- **Port**: `8080`. **Health check**: HTTP, path `/api/healthz`.
- **Instance**: 1 vCPU / 2 GB (bump to 4 GB later if sharp/image-pipeline memory
  shows pressure; `SHARP_CONCURRENCY` env can cap it).
- **Environment variables** — copy values from Railway + Vercel dashboards against
  `.env.example`. Minimum for prod parity:
  - `DATABASE_URL` (the existing Supabase app DB — unchanged)
  - `OAUTH_PUBLIC_URL=https://scentbeam.com` — **required**; this is what makes
    OAuth work behind CloudFront without forwarded-host games
  - `FRAGRANCE_ENGINE_URL=https://<engine-url from Step 1>`
  - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ADMIN_SECRET`
  - Storage: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_IMAGE_*`
    and/or `FIREBASE_STORAGE_*`
  - `SERPER_API_KEY`, `REMOVE_BG_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`,
    `OPENROUTER_API_KEY`, `WEATHER_API_KEY`, VAPID keys, affiliate vars,
    `REDIS_URL` if used
  - Do **not** set `VITE_*` here — those are build-time and already baked in.

Then set `APPRUNNER_SERVICE_ARN` as a variable in the sCAST repo.

### 2.3 CloudFront + certificate

1. ACM (us-east-1) → Request certificate for `scentbeam.com` + `www.scentbeam.com`
   → validate via the DNS records ACM shows you.
2. CloudFront → Create distribution:
   - Origin: the App Runner URL (HTTPS only).
   - Alternate domain names: `scentbeam.com`, `www.scentbeam.com`; attach the cert.
   - Default behavior: **allow ALL HTTP methods**;
     cache policy = managed **UseOriginCacheControlHeaders-QueryStrings**
     (the container already emits the exact right `Cache-Control` per path);
     origin request policy = managed **AllViewerExceptHostHeader**.
   - **No custom error responses** — the container does SPA fallback itself, and a
     CloudFront 404→index.html rule would reintroduce the stale-asset bug.

### 2.4 Smoke test on the CloudFront URL (gates)

- SPA loads; `/api/healthz` returns ok.
- Guest search works (same-origin `/api`); a fragrance detail loads (`/api/engine/*`).
- Image pipeline: add a fragrance that isn't cached, image appears.
- `curl -I https://<cf-domain>/sw.js` → `Cache-Control: no-cache` (NOT cached);
  `curl -I` a hashed `/assets/*.js` → `immutable`.
- OAuth needs the real domain; it's verified right after cutover instead. (If you
  want to pre-test: temporarily add the CloudFront URL's callback in Google Console.)

---

## Step 3 — Cutover (minutes, reversible)

1. Google Cloud Console → OAuth client: confirm
   `https://scentbeam.com/api/auth/google/callback` is among the authorized
   redirect URIs (domain is unchanged, so it should already be there).
2. DNS: point `scentbeam.com` and `www` at the CloudFront distribution
   (ALIAS/ANAME for apex, CNAME for www — CloudFront gives you the target).
3. Verify immediately:
   - Google login round-trip on `https://scentbeam.com`
   - Guest search + fragrance detail
   - PWA update: hard-refresh an installed PWA; `sw.js` and `site.webmanifest`
     must come back `no-cache`
   - A web-push notification still delivers (domain unchanged → subscriptions survive)
4. `api.scentbeam.com`: CNAME it to the same CloudFront distribution or retire it —
   nothing in the SPA needs it after same-origin serving.
5. **Rollback** = point DNS back at Vercel. Keep the Vercel project **paused, not
   deleted**, for one quiet week.

---

## Step 4 — Decommission + the two cleanup PRs (after one quiet week)

1. Delete: Vercel project, Railway `scast` service, Railway engine service +
   Railway Postgres.
2. **sCAST cleanup PR** (the pre-scoped Phase 4 list):
   - Delete `vercel.json`, `artifacts/scent-cast/vercel.json`, `middleware.js`,
     `artifacts/scent-cast/middleware.js`, `railway.json`.
   - `webVitalsTelemetry.ts`: drop the `VITE_VERCEL_GIT_COMMIT_SHA` fallback.
   - `artifacts/scent-cast/vite.config.ts` (~line 182): replace the hardcoded
     `scast-production.up.railway.app` dev-proxy fallback with the new API origin.
   - Replace the five hardcoded `srt-scent-engine-production.up.railway.app`
     defaults: `fragranceEngineProxy.ts:8`, `enrichmentProcessor.ts:31`,
     `serperService.ts:22`, `engineResolve.ts:23`, `engineDiscover.ts:23`.
   - Update `CLAUDE.md` deployment topology + `.env.example` comments.
3. **Engine cleanup PR**:
   - Delete `railway.toml`, `nixpacks.toml` (keep `Procfile` for local reference
     if you like).
   - Update the hardcoded default URL in `scripts/enrichment_worker.py` (~line 69)
     and `run_worker.ps1` (~line 70) to the new engine URL.
   - Update `DEPLOY.md`.

Done: one vendor (AWS) + Supabase, CI-gated deploys on `main`, no Vercel, no Railway.

---

## Quick reference — what was already done in the repos

| Repo | Landed |
|---|---|
| sCAST | `Dockerfile` `ARG VITE_GIT_SHA`; gated `deploy` job in `.github/workflows/tests.yml` |
| srt-scent-engine | `Dockerfile` (chromium/xvfb, `DRISSION_FORCE_ORIGIN=1`, `GIT_COMMIT` arg), `.dockerignore`, gated `.github/workflows/deploy.yml`, migration plan doc |

Both deploy jobs: skipped until `AWS_DEPLOY_ENABLED=true`; push image tagged
`latest` + commit SHA; call `apprunner start-deployment` only when
`APPRUNNER_SERVICE_ARN` is set.
