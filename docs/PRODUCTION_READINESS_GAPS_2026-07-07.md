# Production Readiness Gap Audit — 2026-07-07

Scope: full monorepo sweep — Express API (`artifacts/api-server`), SPA
(`artifacts/scent-cast`), DB layer (`lib/db`), deploy surface (Dockerfile,
`railway.json`, `vercel.json`, `middleware.js`), CI (`.github/workflows/tests.yml`).

This is a **gap list**, not a rewrite plan. Things that are already
production-grade are listed at the end so they don't get "fixed" backwards.

Severity: **P0** = exploitable or outage-shaped today · **P1** = will bite on the
first bad week · **P2** = hygiene / scale readiness.

---

## P0 — Security

### 1. CORS is wide open
`app.ts:40` — `app.use(cors())` reflects any origin with no allowlist. Auth is
bearer-header (not cookies), so credential theft via CORS isn't direct, but any
website can drive the **unauthenticated cost-bearing endpoints**
(`/api/image-proxy`, `/api/scent-profile`, `/api/search-scent`,
`/api/reimagine-bottle-image`, …) from a victim's browser, and any XSS anywhere
can exfiltrate freely.
**Fix:** origin allowlist from env (prod SPA origin + tenant hosts), keep
`Access-Control-Allow-Origin: *` only on the image proxy responses where it's
deliberate.

### 2. No security headers anywhere in the stack
No `helmet` in `app.ts`; `vercel.json` sets only Cache-Control headers;
`index.html` has no CSP meta. Missing: `Content-Security-Policy`,
`Strict-Transport-Security`, `X-Content-Type-Options`, `X-Frame-Options`/
`frame-ancestors`, `Referrer-Policy`, `Permissions-Policy`.
This matters more than usual here because the **bearer token lives in
localStorage** — a single XSS is full account takeover, and CSP is the main
mitigation.
**Fix:** `helmet()` in Express (self-hosted path) + a `headers` block in
`vercel.json` for the SPA; at minimum HSTS, nosniff, frame-ancestors, a
Referrer-Policy, and a real CSP.

### 3. Auth token delivered in the redirect URL
`routes/oauth.ts:444` — the callback redirects to `/?oauth_token=<users.token>&oauth_email=…`.
That token is the user's permanent credential and it lands in browser history,
Vercel/Railway request logs, and (absent a Referrer-Policy, see #2) potentially
`Referer` headers to third parties.
**Fix:** hand off via a short-lived one-time code exchanged for the token over
POST, or at minimum use a URL `#fragment` (not sent to servers) + immediate
`history.replaceState` scrub (verify the SPA scrubs today).

### 4. Bearer tokens never expire and are stored in plaintext
`users.token` is a non-expiring UUID, stored plaintext in Postgres, rotated only
on explicit logout (`POST /auth/logout`). Consequences: any DB read (backup
leak, SQLi anywhere, shared-Supabase mishap — the DB is documented as a shared
project) is an instant, silent takeover of **every** account; no idle/absolute
session expiry; no "log out everywhere" except the single-token rotation.
**Fix:** store a hash (SHA-256) of the token and compare hashes on lookup;
add `last_used_at` + absolute/idle expiry; keep the opaque-token design.

### 5. `trust proxy: true` makes per-IP rate limits spoofable
`app.ts:19` trusts the entire `X-Forwarded-For` chain, so `req.ip` is the
**leftmost** (client-supplied) value. All the per-IP caps on cost-bearing
endpoints (`REIMAGINE_RATE_LIMIT_PER_HOUR`, `SCENT_PROFILE_RATE_LIMIT`, …)
key on `req.ip` (`rateLimit.ts:54`) and can be bypassed by sending a random
`X-Forwarded-For` per request.
**Fix:** set `trust proxy` to the actual hop count (`1` on Railway; `2` behind
Vercel middleware → Railway), or a custom function validating known proxy IPs.

### 6. Database TLS does not verify the server certificate
`lib/db/src/index.ts` — any `sslmode` short of `disable` resolves to
`{ rejectUnauthorized: false }`, and `.env.example:14` actively recommends
`DATABASE_SSL_REJECT_UNAUTHORIZED=false`. Encrypted but unauthenticated TLS =
MITM-able DB connection carrying every token and user row.
**Fix:** ship the provider CA (Supabase publishes one), default to
`rejectUnauthorized: true` + `ca`, keep the override for local dev only.

---

## P0 — Reliability

### 7. No graceful shutdown in the API server
`index.ts` installs no `SIGTERM`/`SIGINT` handler (the Beam MCP entrypoint
`mcpMain.ts` does — the API forgot). Every Railway deploy/restart hard-kills
in-flight requests (visible as 502/ECONNRESET), never drains the pg pool, and
can kill an enrichment job mid-write.
**Fix:** on SIGTERM: stop accepting (`server.close()`), stop the enrichment
worker/sweeper, `await pool.end()`, exit; with a hard timeout (~10s).

### 8. No last-resort process error handlers
No `process.on("uncaughtException" | "unhandledRejection")`. Node 22 kills the
process on an unhandled rejection with only a default stderr trace — no
structured pino line, no flush. `restartPolicyType: ON_FAILURE` restarts it,
but you lose the evidence and drop all in-flight traffic.
**Fix:** log via pino then exit(1) from both handlers; pair with #7.

### 9. Health check is a constant; no deploy healthcheck configured
`routes/health.ts` returns `{status:"ok"}` unconditionally — it proves the
event loop is alive, nothing else. `railway.json` sets no `healthcheckPath`
(so deploys cut traffic over without any check) and the Dockerfile has no
`HEALTHCHECK`. Runtime DB loss (or Redis loss) is invisible to the platform.
**Fix:** keep `/healthz` as liveness; add `/readyz` doing `SELECT 1` (+ Redis
ping when configured) with a short timeout; set `healthcheckPath` in
`railway.json`.

---

## P1 — Observability

### 10. No error tracking, metrics, tracing, or alerting
Grep confirms zero Sentry/OTel/Prometheus/Datadog anywhere. Production
visibility is pino stdout on Railway (good structure, but log-only) — no
aggregation of error rates, no alert when 500s spike, no client-side error
reporting (the SPA has an `ErrorBoundary` but it reports to nobody). The
Web-Vitals/image-metrics beacon hooks exist but their endpoints
(`VITE_WEB_VITALS_URL`, `VITE_IMAGE_METRICS_URL`) default to unset.
**Fix (minimum viable):** Sentry (server + SPA, one DSN each), an uptime
monitor on `/readyz`, and point the vitals beacon somewhere.

### 11. `console.log` bypasses structured logging
34 non-test `console.log/warn` call sites in `api-server/src` (e.g.
`adminSecret.ts`) escape pino's levels, redaction, and JSON shape.
**Fix:** sweep to `logger.*`; optionally lint-ban `console` (see #17).

---

## P1 — Data & schema management

### 12. Schema changes ride `drizzle-kit push`, not versioned migrations
The documented workflow is diff-and-apply `push` against a **shared** Supabase
project. Guards exist (tablesFilter, `ALLOW_PROD_DB_PUSH` gate) and are good,
but push has no history, no ordering, no rollback, and no review artifact. The
codebase already carries scar tissue proving the cost: the 42703
missing-column fallback in `middlewares/auth.ts` and the boot-time
`ensureTenantBaseline()` self-heal both exist to survive "schema and code
deployed out of order."
**Fix:** move to `drizzle-kit generate` + committed SQL migrations applied as
a deploy step (the `lib/db/migrations/` folder already exists with 3 ad-hoc
files — make it the only path).

### 13. No backup / restore / DR runbook
Nothing in-repo documents backup cadence, restore procedure, or RPO/RTO for
the shared Supabase DB, Firebase/Supabase image buckets, or Redis. Supabase
auto-backups may exist at the provider level, but an untested restore is not a
backup story.
**Fix:** document + test a restore once; note that `image_cache` rows and
storage objects must stay consistent (or be rebuildable — they are, via the
pipeline, which is worth stating).

---

## P1 — CI / supply chain

### 14. CI has no lint, no audit, no Docker build check
`tests.yml` = typecheck + unit tests + SPA build + LHCI. Missing:
- **No ESLint anywhere in the repo** (only Prettier). No unused-import,
  no-floating-promises, or `console` bans — for a codebase this async-heavy,
  `@typescript-eslint/no-floating-promises` alone pays for itself.
- **No dependency vulnerability scanning**: no Dependabot/Renovate config, no
  `pnpm audit` step. `minimumReleaseAge: 1440` protects against fresh-package
  supply-chain attacks but does nothing for known CVEs in pinned versions.
- **Docker image is never built in CI** — Dockerfile breakage is discovered at
  deploy time on Railway.
- **Node version skew:** CI runs Node 24, Dockerfile runs `node:22`, engines
  say `>=22.6`. Tests should run on the version production runs.

### 15. Hand-enumerated test file lists
`api-server` and `scent-cast` `test` scripts are giant literal lists of test
files (70+ entries). A new `*.test.ts` that isn't appended **silently never
runs** — in CI or anywhere. This is the single most likely way a regression
suite quietly rots.
**Fix:** `node --test "src/**/*.test.ts"` glob (Node ≥22 supports globs), or a
tiny script that discovers files.

### 16. No integration or E2E layer
All tests are unit tests of extracted cores. Nothing exercises: an Express
route end-to-end (supertest), the auth middleware against a real/pglite DB,
the OAuth callback flow, or a browser flow (Playwright is even pre-installed
in the dev environment). The riskiest code paths (auth, tenant scoping,
wardrobe writes) are exactly the ones only integration tests cover.

---

## P1 — Deploy surface

### 17. Dockerfile: single-stage, root, dev deps in prod image
Single `node:22-bookworm-slim` stage keeps devDependencies (TypeScript, Vite,
LHCI…), full TS sources, and pnpm store in the runtime image; the container
runs as **root**; no `HEALTHCHECK`. Bigger attack surface, slower cold pulls.
**Fix:** multi-stage (build → `pnpm deploy --prod` or prune → runtime), add
`USER node`, add `HEALTHCHECK CMD wget -qO- localhost:8080/api/healthz`.

### 18. No env validation at boot; config drift already visible
Env is read ad hoc per service; almost everything "degrades gracefully," which
means a typo'd var name degrades **silently** (the Beam provider warning is
the only startup canary). Concrete drift found: `.env.example` sets
`ENRICHMENT_WORKER_ENABLED=true` but never mentions `ENRICHMENT_QUEUE_ENABLED`
(the producer flag) — following the example yields a worker consuming a queue
nothing feeds; the OpenRouter/Anthropic key block appears twice.
**Fix:** one zod-validated env module loaded from `env-bootstrap.ts` that
warns (or fails, per var) at startup and is the single source of truth;
dedupe `.env.example`.

### 19. Admin email hardcoded in source
`lib/adminAccess.ts` string-concatenates `dkyleaustin@gmail.com` into the
`ADMIN_EMAILS` allowlist. It cannot be revoked by config, ships PII in the
repo, and grants admin on **every tenant/deployment** of this code.
**Fix:** move it into the actual `ADMIN_EMAILS` env value.

---

## P2 — Scale & hardening

### 20. Single-replica pin / process-local state
`railway.json` pins `numReplicas: 1` because the Beam SSE run registry is
in-process; Redis is optional and default-off, so rate limits and Beam session
memory also reset on every deploy. Documented and deliberate — but it means no
horizontal scaling and no zero-downtime deploys until the run registry moves
to Redis. (The Redis-backed rate limiter half is already built.)

### 21. 10 MB global JSON body limit
`app.ts:41-42` applies 10 MB to every route. Only the admin image upload
plausibly needs it; every other endpoint gets a cheap memory-amplification
vector. Scope the big limit to the upload route; default to ~100 KB.

### 22. Rate limiting doesn't cover auth or write endpoints
Limits exist on the cost-bearing endpoints (good), but `POST /auth/logout`,
OAuth start/callback, wardrobe writes, community posts/reviews have none —
brute-force pressure on `Authorization: Bearer <uuid>` is bounded only by the
128-bit token space (fine cryptographically, but DB-load-wise a scan hammers
`users_token_idx` unthrottled).

### 23. No SECURITY.md / CODEOWNERS / PR template
`.github/` contains only the workflow. No vulnerability-disclosure contact, no
enforced review routing.

---

## Already production-grade (do not regress)

- **SSRF defense** on the image proxy is genuinely strong: DNS resolved once,
  private/reserved ranges rejected, socket pinned to the validated IP
  (TOCTOU-safe), MIME allowlist (`safeImageFetch.ts`).
- **OAuth login CSRF / code-injection defense**: random `state` + PKCE S256
  bound to an HttpOnly SameSite=Lax cookie.
- **Timing-safe admin secret** compare; 503-when-unconfigured semantics.
- **Rate limiter** with Redis-shared window and clean in-memory fail-open.
- **Bounded pg pool** with connect timeout; libvips concurrency capped;
  keep-alive timeouts tuned above the proxy idle window (502 class fixed).
- **pino** with authorization/cookie redaction; structured request logs.
- **Supply-chain**: `minimumReleaseAge: 1440`, frozen lockfile, pnpm-only gate.
- **Serper/RemoveBG key pooling** with auto-rotation; graceful degradation of
  every optional integration; Beam model-provider startup canary.
- **Logout rotates the bearer token** server-side.
- Error handler returns generic messages (no stack/internals leakage).

## Suggested order of attack

1. Week 1 (small diffs, big risk retired): #5 trust proxy, #7 SIGTERM drain,
   #8 process handlers, #9 `/readyz` + `healthcheckPath`, #19 admin email,
   #11 console sweep, #21 body limits.
2. Week 2: #1 CORS allowlist, #2 helmet + vercel.json headers (+ CSP staged in
   report-only), #6 DB CA verification, #15 test glob, #14 CI additions
   (eslint bootstrap, `pnpm audit`, docker build job, Node 22 in CI, dependabot).
3. Week 3+: #3/#4 token handoff + hashing/expiry (one auth workstream),
   #10 Sentry + uptime, #12 migrations, #16 supertest/Playwright seed,
   #17 multi-stage Dockerfile, #18 env module.
