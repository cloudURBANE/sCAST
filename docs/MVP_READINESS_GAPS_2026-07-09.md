# MVP Production-Readiness Gap Audit — 2026-07-09

Scope: **both repos** that make up the product —

1. `sCAST` monorepo (Express API, React SPA, DB layer, Docker/Railway/CloudFront
   deploy surface, CI), and
2. `srt-scent-engine` (the external Python FastAPI fragrance engine on Railway
   that the SPA calls directly via `VITE_FRAGRANCE_API_URL`) — **never covered
   by any prior readiness audit**.

Relationship to prior work: `docs/PRODUCTION_READINESS_GAPS_2026-07-07.md`
enumerated 23 gaps and `docs/PRODUCTION_READINESS_PLAN_2026-07-07.md` planned
the fixes (workstreams A–H). This audit **re-verified every one of those items
against the code as of today** and found the large majority already landed.
Part 1 is the verified ledger (so nobody re-fixes closed gaps); Part 2 is what
actually remains in the monorepo; Part 3 is the engine repo (all-new findings);
Part 4 is cross-cutting launch operations.

Severity: **P0** = exploitable or outage-shaped · **P1** = bites in the first
bad week · **P2** = hygiene / scale readiness.

---

## Part 1 — Verified ledger of the 2026-07-07 audit (evidence-checked)

| Plan item | Status | Evidence |
| --- | --- | --- |
| A1 trust proxy hops | ✅ Done | `app.ts:26-43` — `TRUST_PROXY_HOPS`, default 1 |
| A2 graceful shutdown | ✅ Done | `index.ts:157-198` — SIGTERM drain, worker stops, pool end, 10s watchdog |
| A3 fatal process handlers | ✅ Done | `index.ts:207-216` — pino fatal + Sentry flush + exit(1) |
| A4 readiness probe + platform healthcheck | ✅ Done | `routes/health.ts` `/readyz` (DB fatal, Redis reported), `railway.json` `healthcheckPath: /api/readyz` |
| A5 admin email out of source | ✅ Done | `lib/adminAccess.ts` — env-only allowlist, hardcoded address gone |
| A6 console → pino sweep | ✅ Done | enforced by `no-console` in `eslint.config.mjs` (api-server scope) |
| A7 scoped body limits | ✅ Done | `app.ts:114-123` — 256 KB default, 5 MB only on the two data-URL routes |
| B1 CORS allowlist | ✅ Done | `app.ts:99-105` — `CORS_ALLOWED_ORIGINS`, `origin:false` default |
| B2 security headers | ⚠️ Partial | helmet in `app.ts:60-71`; CloudFront policies carry HSTS/nosniff/DENY/referrer + **CSP still Report-Only** (see gap S1) |
| B3 verified DB TLS | ✅ Done (staged) | `lib/db/src/index.ts` + `sslConfig.ts` — `DATABASE_SSL_CA` → `rejectUnauthorized:true`; no-CA mode warns at boot |
| C1 token hashing | ⚠️ Partial | `migrations/0001_token_security.sql`, hash-first lookup in `middlewares/auth.ts:92-107` — **plaintext `users.token` column still live as dual-read fallback** (gap S2) |
| C2 token expiry + last_used | ✅ Done | `middlewares/auth.ts:117-126` — `evaluateTokenExpiry`, throttled `token_last_used_at` refresh |
| C3 OAuth one-time-code handoff | ✅ Done | `routes/oauth.ts:494-500` `?oauth_code=`, `POST /auth/exchange` (line 559); token & email no longer in URLs |
| C4 auth/write rate limits | ✅ Done | `oauthRateLimit` on exchange; `wardrobeWriteRateLimit` / `communityWriteRateLimit` on all wardrobe/community/review writes |
| D1 error tracking | ✅ Mostly | Sentry server (`lib/sentry.ts`, wired into error handler + fatal handlers) and SPA (`main.tsx:32-38`, DSN-gated dynamic import); vitals endpoint exists (`routes/metrics.ts`). **Uptime monitor undocumented** (gap X2) |
| E1 versioned migrations | ✅ Done | `lib/db/migrations/` (baseline + token_security), `RUN_MIGRATIONS_ON_BOOT` in `index.ts:95-103`, CI migration guard in `tests.yml` |
| E2 DR runbook + drill | ⚠️ Partial | `docs/DR_RUNBOOK.md` exists — **restore drill explicitly not performed; RPO/RTO/PITR fields all TBD** (gap S5) |
| F1 test discovery by glob | ✅ Done | both `package.json` test scripts use `--test "src/**/*.test.ts"` |
| F2 CI hardening | ✅ Mostly | Node 22 parity, `pnpm run lint`, dependabot (npm + actions), `docker-build.yml`, migration guard. **`pnpm audit` still non-blocking** (gap S7) |
| F3 integration + E2E seeds | ⚠️ Partial | pglite harness + `authQueries.integration.test.ts` exist; **no tenant-scoping or wardrobe round-trip integration test, zero Playwright E2E** (gap S4) |
| G1 multi-stage non-root Dockerfile | ✅ Done | multi-stage, `pnpm prune --prod`, `USER node`, `HEALTHCHECK`, dual entrypoint |
| G2 zod env validation | ✅ Done | `lib/env.ts` via `validateEnv()` at boot (`index.ts:31-42`); Vite-side keys asserted in `vite.config.ts` |
| G3 AWS cutover completion | ❌ Open | **`vercel.json` + `middleware.js` still in repo**; OIDC trust-subject cleanup unverifiable from repo; WAF decision unrecorded (gap S3) |
| H1 multi-replica | ✅ Accepted | `numReplicas: 1` documented + deliberate; trigger-based revisit stands |
| H2 governance files | ✅ Done | `SECURITY.md`, `CODEOWNERS`, `.github/pull_request_template.md`, dependabot |

Also spot-checked and healthy (do not regress): SSRF-hardened image fetch,
PKCE + state OAuth, timing-safe admin secret, pg pool bounds + idle-error
swallow, pino redaction, engine-proxy cost guard, account deletion
(`DELETE /api/me` with cascading deletes), legal page in the SPA, pnpm
`minimumReleaseAge` supply-chain gate.

---

## Part 2 — Remaining gaps: sCAST monorepo

### S1 (P0-adjacent) — CSP is still Report-Only, and an inline handler blocks enforcement
The CloudFront HTML policy ships
`Content-Security-Policy-Report-Only` until `csp_enforce = true`
(`infra/cloudfront.tf:194-196`, `infra/variables.tf:79-81`). Until it enforces,
the localStorage bearer token's primary XSS mitigation is inactive. Two
concrete blockers, both stated in the tf variable's own description:

1. `artifacts/scent-cast/index.html:169` still carries an **inline
   `onload="this.media='all'"`** on the Google Fonts stylesheet link — it
   violates `script-src 'self'` and will break the page the moment CSP
   enforces. Replace with a tiny external script or the standard
   `<link rel="preload" as="style">` pattern.
2. ≥1 week of violation-free Report-Only telemetry from real traffic must be
   confirmed (needs the report endpoint actually collecting — verify where
   reports go today).

Additionally the CSP references Google Fonts origins — confirm
`font-src`/`style-src` cover `fonts.googleapis.com` / `fonts.gstatic.com`, or
self-host the fonts (also removes a third-party runtime dependency).

### S2 (P0) — Plaintext bearer tokens still at rest (C1 unfinished)
`users.token` (plaintext uuid) remains a live, indexed, dual-read fallback
(`lib/db/src/schema/users.ts:17-22`, `middlewares/auth.ts:107`). A DB dump of
the **shared** Supabase project is still a full account-takeover artifact.
Finish the planned sequence: backfill `token_hash` for all rows → remove the
plaintext fallback read → null-out → drop the column via migration 0002. The
migration workflow it depends on (E1) is live, so this is now unblocked.

### S3 (P1) — AWS cutover decommission not finished (G3)
`vercel.json` and `middleware.js` still exist at the repo root. Per
`docs/aws-migration/CUTOVER.md` §7: after verified cutover, delete both, remove
the Vercel project/env, and **remove the temporary migration-branch OIDC trust
subject** from the deploy role (`infra/iam_oidc.tf` builds subjects from a
`refs` variable — confirm the applied tfvars lists only `main`). Two frontends
deployable from one repo with divergent header policies (vercel.json has *no*
security headers) is drift waiting to happen. Also record the WAF
decision (plan recommends "defer") so it stops being an open question.

### S4 (P1) — No browser E2E; integration coverage is one file
The pglite harness exists with a single auth-queries test. Missing, in risk
order: (a) tenant-scoping integration test (host A must not read host B's
wardrobe rows — this is the multi-tenant data-isolation guarantee and nothing
executes it today), (b) a wardrobe write→read round-trip, (c) one Playwright
smoke (load SPA → login (mocked or staging) → search → add to wardrobe →
reload → persists) run on `main` merges. Auth/tenancy/persistence regressions
are currently detectable only in production.

### S5 (P1) — Backups are still an untested assumption
`docs/DR_RUNBOOK.md` says it plainly: drill **not yet performed**, backup
type/retention/PITR all TBD. Until one timed restore of the shared Supabase
project into a scratch project has actually happened, RPO/RTO are unknown and
the runbook is aspiration, not capability. This is a few hours of work and the
single highest-value remaining reliability item.

### S6 (P2) — ESLint covers only the API server
`eslint.config.mjs` deliberately ignores `artifacts/scent-cast/**`. The SPA —
where an un-awaited promise or stray console most often ships — has no lint
gate. Expand scope package-by-package as planned (scent-cast next), keeping the
narrow-rules approach.

### S7 (P2) — Dependency audit is non-blocking
`tests.yml` runs `pnpm audit --prod --audit-level=high || true`. Triage the
current findings, then drop the `|| true` so new high-severity CVEs actually
fail PRs.

### S8 (P2) — Redis remains optional in prod
With `REDIS_URL` unset: rate-limit windows and Beam session memory are
in-process (correct at 1 replica, announced at boot). Fine today; becomes a
real gap the moment H1's multi-replica trigger fires. Recorded here so the
dependency chain (Redis → multi-replica → zero-downtime deploys) isn't
rediscovered later.

### S9 (P2) — Legacy token rows never expire until next login
`middlewares/auth.ts:117-119`: rows with NULL `token_issued_at` (pre-migration)
bypass expiry until re-login stamps them. Acceptable transitional behavior —
but add a one-shot backfill (stamp `token_issued_at = now()` for NULL rows) so
the expiry policy actually covers the whole population within one TTL window.

---

## Part 3 — srt-scent-engine (all-new; never audited)

The engine is directly exposed to browsers (the SPA calls it cross-origin at
`VITE_FRAGRANCE_API_URL`) and it spends money per request (Decodo/SERP billed
fetches). It has real strengths already: CORS allowlist via `FRONTEND_ORIGINS`
(`api.py:380-399`), bearer-token-gated worker/diagnostics endpoints with
constant-time compare (`api.py:258-294`), bounded DB pool with saturation→503
mapping (`api.py:357-376`), scrape-concurrency semaphores, hardened mobile
cookies (`secure`/`httponly`/`samesite=strict`, bcrypt, hashed magic links),
pinned requirements, and offline-deterministic CI (compileall + full suite).
The gaps:

### E1 (P0) — Zero error tracking or alerting
No Sentry (or any) error reporting anywhere in the engine (`grep` clean across
`api.py`/`db.py`). Production visibility is Railway stdout logs only; nothing
aggregates error rates or pages anyone when scraping, the DB, or Decodo auth
starts failing. The SPA's self-heal loop can mask a degrading engine for days.
Minimum: `sentry-sdk[fastapi]` DSN-gated exactly like the web app, plus an
uptime check on `/health`.

### E2 (P0) — Unauthenticated, unthrottled cost-bearing endpoints
There is **no per-IP rate limiting at all** — only global concurrency
semaphores. `GET /api/fragrances/search` triggers live Decodo-billed SERP
fetches, and `POST /api/fragrances/details/requeue` (`api.py:5404`) lets any
anonymous caller enqueue enrichment jobs for arbitrary attacker-supplied
URLs/identities. Idempotent upsert dedupes repeats of the *same* URL, but
nothing bounds *distinct* junk jobs per caller, which burns worker quota and
billed re-fetches. CORS does not protect against non-browser callers. Add
per-IP token-bucket limits on `search`, `details`, and especially `requeue`
(the web app's limiter semantics — fail-open, env-tuned — are the model), or
move requeue behind the same bearer scheme as the worker API and proxy it
through the Express API's cost guard.

### E3 (P1) — Database TLS is whatever the URL says
`db.py` passes `DATABASE_URL` straight to `ConnectionPool` with no ssl
handling. Unless the URL carries `sslmode=verify-full` + a CA cert, the
connection is unverified (psycopg's `require` does not check the server cert)
— the exact MITM gap the web app just closed (B3). Mirror it: support a
`DATABASE_SSL_CA` env → `sslmode=verify-full sslrootcert=...`, warn at boot
when running unverified.

### E4 (P1) — Deploys are not gated by CI, and there's no readiness probe
Per `ci.yml`'s own banner, Railway deploys from git push independently of the
workflow — a red `main` still ships. Enable branch protection requiring the
`ci` check before merge (and/or Railway's "wait for CI" toggle).
Separately, `railway.toml` healthchecks `/health`, which returns `{ok:true}`
unconditionally (`api.py:2008-2011`) — a deploy whose DB pool cannot connect
still passes and takes traffic. Add a `/readyz` that pings the pool when
`db.ENABLED` (keep it lenient when DATABASE_URL is unset by design) and point
`healthcheckPath` at it.

### E5 (P1) — Engine DB has no backup/DR story
The sCAST `DR_RUNBOOK.md` covers only the Supabase wardrobe DB. The engine's
own Postgres (enrichment jobs, detail cache, magic links, accounts) has no
documented backup cadence, restore procedure, or owner. The
`wardrobe-completeness-heal` doctrine explicitly treats the two DBs as separate
systems — the DR story must too.

### E6 (P2) — No dependency scanning
Requirements are pinned (good) but nothing ever bumps or audits them: no
Dependabot config (`.github/` has only `workflows/`), no `pip-audit` step.
`cloudscraper`/`curl_cffi`/`DrissionPage` are exactly the kind of
fast-moving scraping deps that accumulate CVEs. Add `dependabot.yml` (pip +
github-actions) and a non-blocking `pip-audit` CI step to start.

### E7 (P2) — Stale pinned Chromium in the build image
`nixpacks.toml` pins a Feb-2024 nixpkgs archive delivering Chromium 122 —
two years of unpatched browser CVEs. Mitigated because the web service sets
`DISABLE_CHROMIUM_MINT=1` (Chromium only runs in offline/worker contexts,
driven against hostile pages by design), but the pin should be refreshed
deliberately, and the mitigating flag's presence verified in the actual
Railway service config, not just the file default.

### E8 (P2) — Repo hygiene: diagnostics and cache artifacts committed
Tracked at the repo root: `_diag_*.py`, `_diag_all_failed.txt`,
`_inspect_failed_jobs*.py`, `_triage_failed_jobs.py`, five
`decodo_scraper_*.json` smoke outputs, `production_verification_results.json`,
and `fg_cache/*.json` (multi-MB runtime caches). Spot-checks show no secrets,
but run-output artifacts in git rot fast, bloat clones, and one day someone
commits one *with* a credential. Move diag scripts under `scripts/`, gitignore
run outputs and `fg_cache/` (the warm script regenerates it).

### E9 (P2) — Single-process capacity ceiling is undocumented
One uvicorn worker (no `--workers`), GIL-bound, with anyio's ~40-thread pool
for sync routes; the pool never closes on shutdown (no lifespan teardown —
harmless on SIGTERM, but worth one line). Fine at MVP traffic; record the
scale-out trigger (CPU-bound search latency) and the plan (uvicorn workers vs.
Railway replicas — replicas require the in-process semaphores/caches to be
re-examined) so it isn't decided during an incident.

---

## Part 4 — Cross-cutting launch operations

### X1 (P1) — No synthetic/uptime monitoring on either service
Nothing in either repo documents an external monitor. Minimum: uptime checks
on `https://<prod>/api/readyz` (web) and `https://<engine>/health` (engine,
upgrade to `/readyz` per E4) alerting to email/phone. Without this, the first
detector of an outage is a user.

### X2 (P1) — Cross-service contract has tests on only one side
The `source_coverage` predicate contract (`fragranceApi.ts:isSourceCoverageComplete`
↔ engine `_source_coverage`) is load-bearing for the SPA's self-heal loop and
documented in both CLAUDE.md files, and the engine has contract tests — but
nothing in sCAST CI would catch the engine changing shape (or vice versa; the
repos deploy independently). Cheapest fix: a small shared fixture set — the
engine CI asserts it produces them, the SPA CI asserts `isSourceCoverageComplete`
accepts them.

### X3 (P2) — Staging environments undefined
Multiple plan items say "verify on staging," but neither repo documents a
staging deployment (Railway environments, a second CloudFront distro, or a
scratch Supabase). Decide and write down what "staging" concretely is for each
service — even if the answer is "a Railway PR environment + local SPA against
it."

### X4 (P2) — Secrets rotation runbook
Credentials now span Railway (2 services), GitHub OIDC/AWS, Supabase, Firebase,
Serper/RemoveBG key pools, Decodo, OpenRouter/Anthropic, Google OAuth, and
`ENRICHMENT_WORKER_TOKEN`. No document says how to rotate any of them or which
are paired (e.g., worker token is shared by engine + worker). One page in
`docs/` listing each secret, where it lives, and its rotation procedure turns a
leaked-key incident from an evening into minutes.

---

## Suggested order of attack

1. **Now (hours):** S5 restore drill · E4 branch protection + engine `/readyz`
   · X1 uptime monitors · S9 issued_at backfill.
2. **Week 1:** E2 engine rate limits (+ requeue guard) · E1 engine Sentry ·
   S2 finish token-hash cutover (backfill → drop plaintext) · S1 remove inline
   onload, verify report collection.
3. **Week 2:** S3 Vercel decommission + OIDC cleanup · E3 engine DB TLS ·
   S4 tenant-scoping integration test + one Playwright smoke · E6 engine
   dependabot/pip-audit · S7 flip audit to blocking.
4. **Week 3+:** S1 flip `csp_enforce` after the bake · E5 engine DR runbook ·
   E8 repo hygiene · X2 contract fixtures · X3/X4 docs · S6 lint expansion.

## Exit criteria for "production-grade MVP"

- [ ] CSP enforcing in prod; no inline handlers in `index.html`.
- [ ] No plaintext bearer credential in any database (column dropped).
- [ ] Both services: error tracking live, uptime monitor paging, CI-gated
      deploys, readiness-gated traffic cutover.
- [ ] Engine cost-bearing endpoints rate-limited per IP; requeue not
      anonymously drivable.
- [ ] One timed restore drill completed **per database** (Supabase + engine),
      RPO/RTO written down.
- [ ] Single deploy path per frontend (Vercel artifacts deleted, OIDC = main
      only).
- [ ] A tenant-isolation regression fails CI before it reaches prod.
- [ ] Both repos: dependency scanning on, audit steps blocking.
