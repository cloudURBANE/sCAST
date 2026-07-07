# Production Readiness Remediation Plan — 2026-07-07

Companion to `docs/PRODUCTION_READINESS_GAPS_2026-07-07.md` (the audit). The
audit enumerated 23 gaps; **this document plans the solution to each one** —
concrete design, files to touch, acceptance criteria, verification, risk, and
sequencing — so any gap can be picked up as a self-contained task.

Gap numbers (#1–#23) refer to the audit. Severity labels carry over
(**P0** exploitable/outage-shaped · **P1** first-bad-week · **P2** hygiene).

## What changed since the audit was written

The audit predates the **Vercel → AWS S3 + CloudFront migration** (PR #544,
`infra/` + `.github/workflows/deploy-frontend.yml` + `docs/aws-migration/`).
That migration changes the *shape* of three fixes and adds cutover-completion
tasks:

- **#2 (security headers):** the audit's "headers block in `vercel.json`" is
  obsolete for prod. Headers now belong in the **CloudFront response-headers
  policies** (`infra/cloudfront.tf` — the existing policies set only
  Cache-Control today) plus `helmet` in Express for the self-hosted path.
- **#5 (trust proxy):** the prod hop chain becomes CloudFront → Railway edge →
  Express for `/api/*`. The hop count must be configurable, not hardcoded,
  because self-hosted (0–1 hops) and prod (2 hops) differ.
- **#14 (CI):** `deploy-frontend.yml` already runs typecheck/test/build as a
  deploy gate on `main` — new CI additions should slot into `tests.yml` so PRs
  get them too, without duplicating the deploy gate.
- **New tasks (WS-G):** finish the migration's own checklist — post-cutover
  removal of `vercel.json` + `middleware.js`, removal of the temporary
  migration-branch OIDC trust subject, and WAF decision — per
  `docs/aws-migration/CUTOVER.md` §7 and `SECURITY.md`.

Everything else in the audit still holds; all file:line anchors below were
re-verified against `main` (4272e6b) on 2026-07-07.

---

## Workstream index

| WS | Theme | Gaps | Target |
| --- | --- | --- | --- |
| A | Small-diff, big-risk (do first) | #5 #7 #8 #9 #19 #11 #21 | Week 1 |
| B | Edge & transport security | #1 #2 #6 | Week 2 |
| C | Auth token lifecycle | #3 #4 #22 | Week 3 |
| D | Observability | #10 (+#11 done in A) | Week 2–3 |
| E | Data: migrations & DR | #12 #13 | Week 3 |
| F | CI & test infrastructure | #15 #14 #16 | Week 2 (15/14), rolling (16) |
| G | Deploy surface & AWS cutover | #17 #18 + cutover tasks | Week 2–3 |
| H | Scale & hygiene | #20 #23 (+#21/#22 in A/C) | Backlog w/ triggers |

Workstreams are independent except where a **Depends on** line says otherwise.
Within a workstream, items are in execution order.

---

## WS-A — Small-diff, big-risk (Week 1)

Seven changes, each an afternoon or less, each retiring a P0/P1. Ship as
small separate PRs (or one PR with isolated commits) so any one can be
reverted alone.

### A1. Fix spoofable rate limits — `trust proxy` (#5, P0)

**Design.** Replace `app.set("trust proxy", true)` (`app.ts:19`) with a
count read from a new env var:

```ts
// app.ts — TRUST_PROXY_HOPS: number of trusted reverse-proxy hops in front of
// Express. Prod (CloudFront → Railway): 2. Railway direct: 1. Local: 0.
const hops = Number(process.env.TRUST_PROXY_HOPS);
app.set("trust proxy", Number.isInteger(hops) && hops >= 0 ? hops : 1);
```

Default `1` (Railway direct) is the safe middle: worst case a mis-set value
makes limits *stricter* (keys on the proxy IP), never spoofable. Update the
comment in `rateLimit.ts:54-57` (`clientKey`) which currently asserts the old
behavior, and document the var in `.env.example` + `docs/aws-migration/ENV_MAPPING.md`.

**Acceptance.** A request with a forged `X-Forwarded-For: 1.2.3.4, <real>`
chain longer than the trusted hop count does not change `req.ip`.
**Verify.** Unit test on an express app with `trust proxy` set to 1/2 asserting
`req.ip` picks the right hop; manual `curl -H "X-Forwarded-For: 9.9.9.9"`
against staging confirming the rate-limit key doesn't move.
**Risk.** Setting hops too low keys all clients to one proxy IP → shared
rate-limit bucket (over-limiting, visible immediately in 429 rates). Rollback:
env change only, no deploy.

### A2. Graceful shutdown (#7, P0)

**Design.** In `index.ts` (which today installs no signal handlers — the Beam
MCP entrypoint `mcpMain.ts` already does), add after `app.listen`:

1. On `SIGTERM`/`SIGINT`: log once, `server.close()` (stops new connections,
   lets in-flight finish), call `stopEnrichmentWorker()`/sweeper stop handles
   (the `startEnrichment*` functions must return/expose a stop function if they
   don't already — check `services/enrichmentQueue.ts`), then `await pool.end()`
   (`pool` exported from `@workspace/db`), then `process.exit(0)`.
2. Hard deadline: `setTimeout(() => process.exit(1), 10_000).unref()` so a hung
   keep-alive socket can't block the deploy. Note `server.close()` waits for
   keep-alive sockets on idle; Node ≥18.2 also needs `server.closeIdleConnections()`
   called after `close()` to release the 65s keep-alive sockets (`index.ts:86`
   sets `keepAliveTimeout = 65_000`, longer than the 10s deadline).
3. Beam SSE runs: in-process run registry (see #20) means active SSE streams
   die with the process regardless; closing idle connections is still correct.
   Emitting a terminal SSE event on shutdown is a nice-to-have, not required.

**Acceptance.** `kill -TERM <pid>` during an in-flight slow request: request
completes, pool drains, process exits 0 within 10s; Railway deploys stop
producing ECONNRESET/502 blips.
**Verify.** Unit-testable core (extract `createShutdownHandler({server, pool, stops})`
per the repo's extracted-core test convention); manual: local run, start a
slow request, SIGTERM, observe ordered log lines.
**Risk.** Double-shutdown on repeated signals — guard with a `shuttingDown`
flag. Rollback: revert commit.

### A3. Last-resort process error handlers (#8, P0)

**Design.** In `index.ts`, before `start()`:

```ts
process.on("unhandledRejection", (reason) => {
  logger.fatal({ err: reason }, "Unhandled promise rejection — exiting");
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "Uncaught exception — exiting");
  process.exit(1);
});
```

Exit deliberately (state is unknown); Railway `restartPolicyType: ON_FAILURE`
restarts. Do **not** attempt to keep serving. pino writes synchronously to
stdout by default, so no explicit flush dance is needed; if a transport is
ever added, revisit. Optionally route through the A2 shutdown path with a
short (1–2s) deadline to drain the pool.

**Acceptance.** A `setTimeout(() => Promise.reject(new Error("x")))` smoke
produces a structured `fatal` pino line before exit(1).
**Verify.** Manual smoke locally; grep Railway logs after a week for
`fatal`-level lines that would previously have been bare stack traces.

### A4. Real readiness probe + platform healthcheck (#9, P0)

**Design.**
1. Keep `GET /api/healthz` as pure liveness (constant, no dependencies).
2. Add `GET /api/readyz` in `routes/health.ts`: `SELECT 1` through the pg pool
   with a ~2s timeout; if `isRedisConfigured()`, a Redis `PING` with the same
   timeout, **reported but non-fatal** (Redis is optional-by-design — rate
   limits fail open, Beam memory degrades; a Redis blip must not take the API
   out of rotation). Response: `200 {status:"ready", db:"ok", redis:"ok"|"skipped"|"degraded"}`
   or `503` when the DB check fails.
3. `railway.json`: add `"healthcheckPath": "/api/readyz"` (+ `healthcheckTimeout`)
   so deploys only cut over when the new instance can reach the DB.
4. Dockerfile `HEALTHCHECK` — fold into the G1 multi-stage rewrite rather than
   patching the current single-stage file twice (Railway uses `healthcheckPath`,
   not the Docker directive; the directive only matters for non-Railway hosts).

**Acceptance.** With `DATABASE_URL` pointed at a dead host, `/api/readyz`
returns 503 within ~2s while `/api/healthz` stays 200; a Railway deploy of a
misconfigured build no longer receives traffic.
**Verify.** Route test with a stubbed pool (resolve/reject/timeout cases);
one staged deploy on Railway observing the healthcheck gate.
**Risk.** A flapping DB turns readiness into a traffic gate — that's the
point, but keep the timeout short and don't add retries that mask it.

### A5. Admin email out of source (#19, P1)

**Design.** `lib/adminAccess.ts:13` currently appends
`",dkyleaustin@gmail.com"` to the env allowlist. Delete the concatenation so
`ADMIN_EMAILS` env is the only source; set the email in Railway variables
before deploying (coordinate the two — env first, then deploy). Update
`.env.example` to show `ADMIN_EMAILS=`.

**Acceptance.** Grep for the literal email returns nothing outside git
history; admin routes still work for the address once env is set.
**Verify.** Existing `adminAccess` unit tests updated (drop the hardcoded-email
case, keep env-parse cases); manual admin-route probe on staging.
**Risk.** Deploying before setting the env var locks the admin out (recover
via Railway env + redeploy — minutes, not an incident).

### A6. `console.*` → pino sweep (#11, P1)

**Design.** Replace the ~34 non-test `console.log/warn/error` call sites in
`artifacts/api-server/src` (e.g. `middlewares/adminSecret.ts`) with
`logger.info/warn/error` and structured fields (`logger.warn({ ctx }, "msg")`).
Leave scripts/ and test files alone. Then ban regression: this is one of the
first ESLint rules F2 turns on (`no-console` scoped to `api-server/src`,
excluding `*.test.ts`) — the sweep lands first so the rule starts green.

**Acceptance.** `rg "console\." artifacts/api-server/src --glob '!*.test.ts'`
returns zero (allow an explicit eslint-disable for any deliberate stdout use,
none known).
**Verify.** Typecheck + existing tests; eyeball one Railway deploy's logs for
shape regressions.

### A7. Scope the 10 MB body limit (#21, P2 but trivial here)

**Design.** `app.ts:41-42` applies `express.json({ limit: "10mb" })` globally.
Change the global default to `200kb` (largest routine JSON bodies are Beam
conversation turns and wardrobe writes — audit payload sizes before final
number; 100–200 KB is the target band) and mount a
`express.json({ limit: "10mb" })` instance **only** on the admin image-upload
route (locate via `rg "upload" artifacts/api-server/src/routes` — the only
consumer that plausibly needs it, per audit). Keep `urlencoded` at the small
default too. Return shape for oversize stays Express's 413.

**Acceptance.** A 1 MB POST to a normal API route gets 413; the admin upload
route still accepts large payloads; no legitimate endpoint regresses (watch
413 counts in logs for a week).
**Verify.** Two supertest-style route tests (oversize rejected globally,
accepted on upload route); grep SPA code for any large-body senders
(`JSON.stringify` of wardrobe bulk ops) before picking the final limit.
**Risk.** Underestimating a legit payload → user-visible 413s. Mitigate by
logging body sizes at `debug` for a few days first if unsure, or start at
500 KB and ratchet down.

---

## WS-B — Edge & transport security (Week 2)

### B1. CORS allowlist (#1, P0)

**Design.** Replace `app.use(cors())` (`app.ts:40`) with:

```ts
const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean);
app.use(cors({
  origin: allowedOrigins.length > 0 ? allowedOrigins : false,
  credentials: false,
}));
```

- Prod value: the CloudFront domain(s) + any custom domain + tenant hosts
  (the tenant middleware `middlewares/tenant.ts` knows the host list — if
  tenant hosts are DB-driven, provide a function-form `origin` that consults
  the same source, cached).
- **Important nuance:** in the target topology the SPA and API are
  *same-origin* (CloudFront proxies `/api/*`), so browsers send no CORS
  preflight at all — the allowlist exists purely to stop *third-party*
  websites driving the cost-bearing endpoints from victims' browsers. An
  empty/unset var → `origin: false` (no CORS headers, same-origin still
  works) is therefore a safe default, with a boot-time `logger.warn`.
- Image proxy: `routes/imageProxy.ts` responses may keep explicit
  `Access-Control-Allow-Origin: *` if cross-origin `<img>`/canvas use needs
  it (verify what the SPA does with proxied images — only add if actually
  needed for canvas/CORS-enabled image reads).

**Acceptance.** `curl -H "Origin: https://evil.example" -i` on
`/api/scent-profile` shows no `Access-Control-Allow-Origin`; SPA (same-origin)
and any legitimately allowed origin unaffected.
**Verify.** Route test asserting header presence/absence per origin; full SPA
click-through on staging (search, details, wardrobe write, Beam turn, image
load) because CORS breakage is runtime-only.
**Risk.** Forgetting a legitimate origin (staging URL, PWA install origin,
localhost dev). Enumerate first: `rg -i "origin" artifacts/scent-cast/src/lib/fragranceApi.ts`
+ deployment docs; include `http://localhost:*` guidance for dev in
`.env.example`.
**Depends on:** nothing, but land B2's CloudFront work in the same window so
the "same-origin via CloudFront" assumption is true in prod before tightening.

### B2. Security headers — CloudFront + helmet (#2, P0)

**Design.** Two layers, one source of truth for values:

1. **CloudFront (prod SPA path):** extend the three
   `aws_cloudfront_response_headers_policy` resources in
   `infra/cloudfront.tf` (`immutable_assets`, `browser_short`,
   `no_cache_html`) with a shared `security_headers_config` block:
   - `strict_transport_security`: `max-age=31536000; includeSubDomains` (add
     `preload` only after a month of confidence).
   - `content_type_options: nosniff`, `frame_options: DENY`,
     `referrer_policy: strict-origin-when-cross-origin`.
   - `Permissions-Policy` via `custom_headers_config`:
     `camera=(), microphone=(), geolocation=()`.
   - **CSP staged:** start `Content-Security-Policy-Report-Only` on the
     `no_cache_html` (HTML) policy. Draft from the SPA's actual needs:
     `default-src 'self'; connect-src 'self' <VITE_FRAGRANCE_API_URL origin> <vitals/metrics endpoints>; img-src 'self' data: blob: <storage CDN origins: Firebase/Supabase public URLs>; style-src 'self' 'unsafe-inline'; script-src 'self'`.
     Enumerate real origins first: `rg -o "https://[a-z0-9.-]+" artifacts/scent-cast/src -g '!*.test.*' | sort -u`
     plus the runtime env values. Watch report volume (report-to a Sentry CSP
     endpoint once D1 lands, or a simple beacon), then flip to enforcing.
2. **Express `helmet` (self-hosted path + defense-in-depth on `/api/*`):**
   `helmet()` in `app.ts` with `contentSecurityPolicy: false` initially (CSP
   is driven from the CloudFront/report-only rollout; enable in helmet for
   self-hosted once the policy is proven) and `crossOriginEmbedderPolicy: false`
   (COEP breaks cross-origin images unless every image source sends CORP —
   the proxied fragrance images won't). HSTS from helmet only when the
   self-hosted deployment terminates TLS itself; behind CloudFront the edge
   header wins anyway.

**Acceptance.** `curl -sI https://<prod>/` shows HSTS, nosniff, frame/DENY,
Referrer-Policy, Permissions-Policy, and CSP-Report-Only; after the bake
period, enforcing CSP with zero legit-traffic violations; `securityheaders.com`
grade A-range.
**Verify.** `terraform plan` diff review; report-only violation monitoring ≥1
week including a full SPA regression pass (PWA install, share images, Beam
SSE — SSE uses `connect-src`); helmet covered by a route test asserting
header presence.
**Risk.** Enforcing CSP too early bricks the SPA for real users — the
report-only stage is mandatory, not optional. HSTS is semi-irreversible
(browser-pinned for max-age) — be certain all subdomains serve TLS before
`includeSubDomains`.
**Why it's P0-adjacent:** the bearer token lives in localStorage (see WS-C);
until C-work lands, CSP is the primary XSS→account-takeover mitigation.

### B3. Verified DB TLS (#6, P0)

**Design.** `lib/db/src/index.ts:23-39` resolves any `sslmode` to
`{ rejectUnauthorized: false }` and `.env.example` recommends the insecure
override. Change to:

1. New env `DATABASE_SSL_CA` (path or inline PEM). When set:
   `ssl = { rejectUnauthorized: true, ca }`.
2. Supabase publishes its CA cert (project settings → Database → SSL). Commit
   it under `lib/db/certs/supabase-ca.pem`? **No** — provider CA rotates and
   differs per environment; deliver via Railway env (inline PEM with `\n`
   escapes, decoded at boot) and document the retrieval step.
3. Default behavior change, staged: when `sslmode` is present but no CA and no
   explicit override, keep today's relaxed mode **but log a `warn` at boot**
   for one release; the following release flips the default to
   `rejectUnauthorized: true` using the system trust store (works if the
   provider chain is publicly rooted — test against the actual Supabase
   endpoint first; theirs is typically a self-signed project CA, hence step 1).
4. `.env.example`: replace the `DATABASE_SSL_REJECT_UNAUTHORIZED=false`
   recommendation with the CA instructions; keep the `false` override
   documented as local-dev-only.

**Acceptance.** Prod boots with `rejectUnauthorized: true` + CA and serves
traffic; connecting through a MITM proxy (or wrong CA) fails loudly at boot,
not silently.
**Verify.** Staging boot against the real Supabase URL with CA set; unit tests
on `resolveSslConfig` for the new matrix (already a pure function — extend the
existing pattern).
**Risk.** Wrong/expired CA = total outage at deploy. Mitigate: readiness probe
(A4) gates the cutover, and the env-var change is instant to roll back.
**Depends on:** A4 (deploy healthcheck) strongly recommended first.

---

## WS-C — Auth token lifecycle (Week 3, one coherent PR series)

The three gaps here are one design problem: the credential is long-lived,
plaintext at rest, delivered via URL, and unthrottled. Do them as a unit.

### C1. Hash tokens at rest (#4 part 1, P0)

**Design.** Keep the opaque-UUID scheme (no JWT). Store `sha256(token)`:

1. Add `users.token_hash` (text, unique index) alongside existing `token`.
2. Dual-read migration path (this is the flagship user of E1's migration
   workflow): write both on token rotation; lookup by hash first, fall back to
   plaintext column; backfill job hashes existing tokens; after backfill,
   null-out the plaintext column, then drop it in a later migration. The
   client-held UUID never changes — **no user is logged out** by this
   migration.
3. Lookup change in `middlewares/auth.ts` (single choke point — verify with
   `rg "users.token" artifacts/api-server lib scripts` for stragglers; the
   `rebuild-user` script path goes through the admin route, not tokens).
4. SHA-256, not bcrypt: the token is a 122-bit random UUID, not a human
   password — preimage resistance is what matters, and hashing must stay
   cheap because it runs on every request. Plain SHA-256 keeps the indexed
   equality lookup.

**Acceptance.** DB dump contains no usable bearer credentials; existing
sessions survive the rollout end-to-end.
**Verify.** Auth middleware integration test against pglite (seeded hashed
user) — this is the first F3 integration test; staged rollout on staging with
a real logged-in browser across the backfill.

### C2. Token expiry + `last_used_at` (#4 part 2, P0)

**Design.**
1. Add `users.token_issued_at`, `users.token_last_used_at`.
2. Policy via env: `TOKEN_ABSOLUTE_TTL_DAYS` (suggest 90) and
   `TOKEN_IDLE_TTL_DAYS` (suggest 30). Expired → 401; SPA already handles 401
   by clearing `scent_token` and showing signed-out state (verify the exact
   handler in `App.tsx` — if it only handles 401 on some calls, fix that as
   part of this task).
3. `token_last_used_at` updated at most once per hour per user (guard with a
   `WHERE token_last_used_at < now() - interval '1 hour'` update) to avoid a
   write per request.
4. Re-auth is Google OAuth one-click; 90-day absolute expiry is low-friction.
   Rotation on each login already exists implicitly (callback issues the
   stored token) — confirm the callback rotates rather than reuses; if it
   reuses, make login rotate.

**Acceptance.** A token idle >30d or older than 90d gets 401 and the SPA
lands on signed-out state cleanly; active users never notice.
**Verify.** Middleware unit tests with clock injection; one manual expiry
smoke (set TTL to minutes on staging).

### C3. OAuth callback token handoff (#3, P0)

**Design.** Today `routes/oauth.ts:437` redirects with
`?oauth_token=…&oauth_email=…`; the SPA scrubs it via
`history.replaceState` (`App.tsx:1049-1052`), so residual exposure = browser
history until scrub, CloudFront/Railway access logs, and Referer (mitigated by
B2's Referrer-Policy). Close it with a one-time code:

1. Callback generates `code = randomUUID()`, stores
   `{codeHash → userId, expires: now+60s, used: false}` — in Redis when
   configured, else the existing in-memory pattern (single replica, #20, makes
   in-memory correct today; the Redis path future-proofs it).
2. Redirect becomes `/?oauth_code=<code>` (email no longer in URL either —
   PII in logs today).
3. New `POST /api/auth/exchange { code } → { token, email }`, single-use,
   burns the code, rate-limited (C4).
4. SPA: on seeing `oauth_code`, POST exchange, store token, `replaceState`
   scrub (reuse the existing scrub path).
5. Keep accepting the legacy `oauth_token` param for one release (SPA deploys
   are decoupled from API deploys via CloudFront), then delete.

**Acceptance.** No bearer token or email appears in any URL, log line, or
`document.referrer`; a replayed/expired code yields 401.
**Verify.** Route tests (happy, expired, replayed, malformed); manual OAuth
round-trip on staging; grep staged CloudFront/Railway logs for `oauth_token`.

### C4. Rate limits on auth & writes (#22, P2)

**Design.** The in-repo limiter (`lib/rateLimit.ts`, Redis-shared window,
fail-open) is already built — apply it: OAuth start/callback and
`POST /api/auth/exchange` (per-IP, e.g. 20/10min), `POST /auth/logout`
(per-token), wardrobe writes and community posts/reviews (per-user,
generous — protect the DB, don't throttle real use; start 120/hour and watch).
Env-tunable like the existing `*_RATE_LIMIT_*` vars.

**Acceptance.** Burst-scripting the exchange endpoint hits 429 quickly;
normal SPA usage never sees one (watch 429 counts for a week).
**Verify.** Reuse existing rate-limit test pattern per route.
**Depends on:** A1 (trust proxy) — per-IP limits are spoofable until it lands.

---

## WS-D — Observability (Week 2–3)

### D1. Error tracking + uptime + vitals (#10, P1)

**Design.** Minimum-viable, three pieces:

1. **Sentry server:** `@sentry/node` in `api-server`, initialized in
   `env-bootstrap.ts` ordering-safe position (before app import), DSN via
   `SENTRY_DSN`, disabled when unset (keeps the degrade-gracefully doctrine).
   Hook: the A3 process handlers and the `app.ts` errorHandler both
   `Sentry.captureException` before their existing behavior. Scrub:
   `beforeSend` drops `Authorization`/cookies (mirror pino's redaction list);
   set `tracesSampleRate: 0` initially — errors first, tracing later.
2. **Sentry SPA:** `@sentry/react` init in `main.tsx` gated on
   `VITE_SENTRY_DSN`; wire the existing `ErrorBoundary` (which currently
   reports to nobody) via `Sentry.captureException` in its catch; sample
   sessions low (errors 100%, replays off). Mind bundle size — use the
   browser SDK's tree-shaken init, and check the LHCI budget in CI still
   passes.
3. **Uptime:** external monitor (UptimeRobot/Better Stack — free tier fine)
   on `https://<prod>/api/readyz` (A4) + the CloudFront root; alert to email.
   Not in-repo, but document endpoint + expected body in
   `docs/aws-migration/README.md`.
4. **Vitals:** the SPA's Web-Vitals/image-metrics beacons exist but point
   nowhere (`VITE_WEB_VITALS_URL` unset). Cheapest real option: a tiny
   `POST /api/metrics/vitals` route that logs a structured pino line
   (rate-limited, 1 KB body cap) — Railway log search becomes the query
   surface. Defer a real metrics store until there's a question the logs
   can't answer.

**Acceptance.** Forced server error and forced SPA render error both appear
in Sentry with release tags and no bearer tokens; uptime alert fires on a
staged `/readyz` failure.
**Verify.** Staging DSN smoke both sides; redaction asserted by a unit test
on the `beforeSend` scrubber.
**Cost note:** Sentry free tier suffices at current traffic; revisit at 5k
errors/mo.

*(#11 — console sweep — lands in A6; the CSP report endpoint from B2 can
point at Sentry's CSP ingestion once this is live.)*

---

## WS-E — Data: migrations & DR (Week 3)

### E1. Versioned migrations replace prod `push` (#12, P1)

**Design.** Keep `drizzle-kit push` for local dev velocity; make prod
migration-only:

1. `drizzle-kit generate` on schema change → SQL files in
   `lib/db/migrations/` (exists with 3 ad-hoc files — reconcile: generate a
   baseline migration from current prod schema, mark the ad-hoc files as
   pre-history in a README, and start the journal from the baseline;
   drizzle's `__drizzle_migrations` table records applied state).
2. Apply step: `pnpm --filter @workspace/db run migrate` script using
   drizzle-orm's `migrate()` — run **as a deploy step before traffic cutover**.
   Railway options: `preDeployCommand` in railway.json if available on the
   plan, else first statement of `pnpm start` gated by
   `RUN_MIGRATIONS_ON_BOOT=true` (single replica #20 makes boot-time safe
   today — no concurrent migrators; revisit when replicas > 1: move to a
   release-phase job or advisory-lock the migrator, which drizzle does via
   its migrations table lock).
3. Keep the existing safety rails: `tablesFilter` scoping and
   `ALLOW_PROD_DB_PUSH` gate stay; add a CI check that fails when
   `lib/db/src/schema/**` changed without a new migration file
   (`git diff --name-only` in `tests.yml`).
4. The audit's "scar tissue" (42703 fallback in `middlewares/auth.ts`,
   `ensureTenantBaseline()` boot self-heal) **stays** — they're now
   defense-in-depth rather than the primary mechanism. Do not remove in this
   pass.
5. Shared-Supabase caution carries over: migrations must never touch foreign
   tables — generated SQL is reviewable in PR, which is precisely the point.

**Acceptance.** A schema change reaches prod only via a committed, reviewed
SQL file; `ALLOW_PROD_DB_PUSH` is never used again (log/alarm if it is);
out-of-order deploy scenario (code before schema) is prevented by the deploy
step ordering.
**Verify.** Dry-run the baseline + one no-op migration against a Supabase
branch/staging DB; the C1 token_hash migration is the first real user.
**Depends on:** nothing, but sequence *before* C1 (which needs it).

### E2. Backup / restore / DR runbook (#13, P1)

**Design.** A documentation + one-drill task, `docs/DR_RUNBOOK.md`:

1. **Inventory state:** Supabase Postgres (source of truth: users, wardrobes,
   catalog, image_cache, enrichment_jobs), object storage buckets
   (Firebase/Supabase — **rebuildable** from the image pipeline, worth losing
   at worst re-processing cost), Redis (ephemeral by design — rate limits,
   Beam session memory; documented-acceptable loss), localStorage tokens
   (client-side, users re-auth).
2. **Verify + document provider backups:** confirm the shared Supabase
   project's PITR/daily-backup tier and retention; record RPO (target ≤24h,
   PITR if the plan allows) and RTO (target ≤4h) as decisions, not
   aspirations.
3. **Run one restore drill:** restore to a scratch Supabase project, point a
   local api-server at it, click through login + wardrobe. Record actual
   timing in the runbook. This is the deliverable that turns "backups exist"
   into a backup story.
4. **Consistency note:** `image_cache` rows referencing missing storage
   objects self-heal through the pipeline (re-process on miss) — state this
   and verify once by deleting a test object.
5. Shared-project blast radius: the DB hosts another app's tables — the
   runbook must name who owns restore decisions for the shared instance and
   the escalation path.

**Acceptance.** Runbook exists with tested timings; restore drill completed
once; RPO/RTO stated.
**Verify.** The drill *is* the verification. Calendar a 6-month re-drill.

---

## WS-F — CI & test infrastructure

### F1. Test discovery by glob (#15, P1 — do first, 30 minutes)

**Design.** Replace the hand-enumerated file lists in
`artifacts/api-server/package.json` and `artifacts/scent-cast/package.json`
`test` scripts with globs — Node ≥22 `node --test` accepts glob args:
`node --experimental-strip-types --test "src/**/*.test.ts"` (quote it — the
shell must not pre-expand on Linux CI, and Windows shells don't expand at
all, same reasoning as the drizzle glob note in CLAUDE.md). Diff the
discovered set against the current literal lists before merging
(`node --test --test-reporter=dot` count vs. `rg -l --files -g "*.test.ts" src | wc -l`)
to catch any test that was deliberately excluded (if one was, mark it
`.skip` with a comment instead of silently re-including).

**Acceptance.** A new `foo.test.ts` runs in CI with no package.json change;
discovered-count matches file-count.

### F2. CI hardening: lint, audit, Docker build, Node parity (#14, P1)

**Design.** All in `tests.yml` (PR-time), keeping `deploy-frontend.yml`'s gate
as-is:

1. **Node parity:** `node-version: 24` → `22` to match the Dockerfile
   (`node:22-bookworm-slim`) and engines (`>=22.6`). Single change, do it
   first.
2. **ESLint bootstrap:** flat config at root; start with
   `typescript-eslint` recommended-type-checked *scoped to
   `artifacts/api-server/src`* with two rules promoted to error:
   `@typescript-eslint/no-floating-promises` and `no-console` (post-A6).
   Expand package-by-package (scent-cast next) fixing or explicitly
   disabling as you go — do **not** turn on the world and drown in 4k
   warnings. Add `pnpm run lint` root script + CI step.
3. **Dependency scanning:** `.github/dependabot.yml` (npm weekly,
   grouped minor/patch, plus `github-actions` ecosystem) — note Dependabot
   PRs will sit 1 day before `minimumReleaseAge: 1440` lets pnpm resolve
   fresh versions; that's fine, they're complementary. Add
   `pnpm audit --prod --audit-level=high` as a **non-blocking** CI step
   first (report-only); flip to blocking after the initial findings are
   triaged/ignored-with-reason.
4. **Docker build check:** separate job, `docker build .` with GH Actions
   layer cache (`docker/build-push-action` with `push: false`,
   `cache-from/to: gha`). Catches Dockerfile breakage at PR time instead of
   Railway deploy time. Run on PRs touching `Dockerfile`, `pnpm-lock.yaml`,
   or any `package.json` (path filter) to keep CI minutes sane.

**Acceptance.** PR with a floating promise fails lint; PR breaking the
Dockerfile fails before merge; Dependabot opens its first PRs; CI runs Node 22.

### F3. Integration & E2E seed (#16, P1 — rolling)

**Design.** Not a big-bang suite; two seeds that grow with WS-C:

1. **Route-level integration (supertest + pglite):** harness in
   `artifacts/api-server/src/test-support/` that builds the express app
   against an in-memory `@electric-sql/pglite` DB with the drizzle schema
   applied (E1's migrations make this trivial: run them against pglite).
   First tests (highest-risk paths per audit): auth middleware
   (valid/expired/hashed token → C1/C2 acceptance), tenant scoping (host A
   cannot read host B's wardrobe rows), one wardrobe write round-trip, OAuth
   exchange endpoint (C3).
2. **Browser E2E (Playwright, pre-installed):** one spec, staging URL or
   local self-hosted build: load SPA → mock-or-real login → search → open
   detail → add to wardrobe → reload → still there. Run on `main` merges
   (not every PR) + nightly against staging. Keep it to smoke depth —
   the CLAUDE.md doctrine against broad scenario suites applies.

**Acceptance.** The C-series auth changes each land with an integration test;
the E2E smoke goes red when login or wardrobe persistence breaks.
**Depends on:** F1 (globs pick the new tests up), E1 (migrations for pglite).

---

## WS-G — Deploy surface & AWS cutover completion (Week 2–3)

### G1. Multi-stage, non-root Dockerfile (#17, P1)

**Design.** Three stages:

1. `base`: `node:22-bookworm-slim` + corepack/pnpm pin (as today).
2. `build`: full source copy, `pnpm install --frozen-lockfile`, `pnpm run
   build` + `beam:mcp:build` (both bundles, as today).
3. `runtime`: from `base`, copy the built `dist/` outputs +
   `pnpm deploy --filter @workspace/api-server --prod /app` (produces a
   pruned, prod-only node_modules; **verify** it correctly links the
   workspace deps `@workspace/db` etc. — if `pnpm deploy` fights the
   workspace-protocol graph, fall back to copying the full workspace and
   `pnpm prune --prod`), `USER node`, `HEALTHCHECK CMD node -e
   "fetch('http://localhost:8080/api/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"`
   (no wget in slim images), same `CMD`.
4. Constraint: the image must still serve **both** entrypoints (API default
   CMD + the Beam MCP service's overridden start command) — keep
   `dist-beam/` and the `start:beam-mcp` script path working from the
   runtime stage.
5. Sharp/libvips: prod deps include prebuilt sharp binaries — confirm the
   runtime stage carries `sharp`'s platform package (it will via prod
   node_modules; just don't strip `optionalDependencies`).
6. Check self-hosted mode: `frontendStaticDir` (`artifacts/scent-cast/dist/public`)
   must be present in the runtime stage if the image is used self-hosted —
   copy it in (it's built anyway by `pnpm run build`).

**Acceptance.** Image runs as non-root (`docker inspect` user = node), size
drops substantially (expect >50% — measure before/after), both service
entrypoints boot on Railway, F2's Docker CI job builds it.
**Verify.** F2's CI job + one Railway staging deploy of both services.
**Risk.** pnpm workspace pruning is the fiddly part — timebox the `pnpm
deploy` approach and fall back to copy+prune. Rollback: previous Dockerfile
is one git revert; Railway rebuilds from repo.

### G2. Zod-validated env module (#18, P1)

**Design.** One module, `artifacts/api-server/src/lib/env.ts`, loaded from
`env-bootstrap.ts` (which already owns pre-app dotenv ordering):

1. A zod schema over every env the api-server reads (enumerate via
   `rg "process\.env" artifacts/api-server/src -o | sort -u` — expect ~60).
   Three tiers: **required** (DATABASE_URL, PORT — fail boot with a clear
   message), **optional-integration** (keys — parse, log one structured
   boot line listing which integrations are on/off; this generalizes the
   existing Beam provider canary), **flags** (booleans via a strict
   `z.enum(["true","false"]).optional()` — catches `ENRICHMENT_WORKER_ENABLED=yes`
   silently meaning false).
2. Export typed getters; migrate call sites incrementally (the module
   validates everything at boot immediately even before call sites migrate —
   boot-time validation is the value, typed access is the cleanup).
3. Unknown-var detection: warn on `SCENT_*`/`BEAM_*`/known-prefix vars that
   match nothing in the schema (catches typos like the audit's drift).
4. Fix `.env.example` drift in the same PR: add `ENRICHMENT_QUEUE_ENABLED`
   next to `ENRICHMENT_WORKER_ENABLED` with the producer/consumer pairing
   explained; dedupe the doubled OpenRouter/Anthropic block; add the new
   vars from this plan (TRUST_PROXY_HOPS, CORS_ALLOWED_ORIGINS,
   DATABASE_SSL_CA, SENTRY_DSN, TOKEN_*_TTL_DAYS, ADMIN_EMAILS).
5. SPA side: Vite envs are build-time — add a small assert in `main.tsx` (or
   a build-time check in `vite.config.ts`) that `VITE_FRAGRANCE_API_URL` is
   set, failing the **build** rather than throwing per-search at runtime
   (`fragranceApi.ts:getFragranceEngineApiBase` currently throws per call).

**Acceptance.** Boot with a typo'd var name → visible warning naming the
suspect; boot without DATABASE_URL → one clear fatal line; `.env.example`
copied verbatim produces a working, internally-consistent dev config.
**Verify.** Unit tests on the schema (each tier); boot smoke.

### G3. AWS cutover completion (new — from PR #544's own checklist)

Not in the audit (it predates the migration); required to finish what #544
started. Per `docs/aws-migration/CUTOVER.md` §7 and `SECURITY.md`:

1. Execute the cutover runbook if not yet done (DNS to CloudFront, verify,
   DNS-only rollback stands ready).
2. Post-verification: **delete `vercel.json` and `middleware.js`**, remove
   Vercel project/env, per the documented decommission step.
3. **Remove the temporary OIDC trust subject** for
   `claude/vercel-aws-migration-mb8vae` from `infra/iam_oidc.tf` so only
   `main` can deploy.
4. Decide WAF (SECURITY.md §3 leaves it optional): recommend **defer** —
   the app-level rate limits + A1 make WAF marginal at current traffic;
   revisit with D1's data.
5. B2's CloudFront header work rides the same Terraform surface — coordinate
   the applies.

**Acceptance.** Prod serves from CloudFront; repo contains no Vercel files;
OIDC trust lists exactly one ref; `terraform plan` is clean.

---

## WS-H — Scale & hygiene (backlog with explicit triggers)

### H1. Multi-replica readiness (#20, P2 — trigger-based, don't do now)

**Position:** single-replica is documented, deliberate, and correct today.
Plan the *trigger*, not the work: revisit when (a) sustained CPU >70% or
event-loop lag alarms (D1 gives visibility), or (b) zero-downtime deploys
become a business requirement. The prerequisite work is already half-built:
Redis-backed rate limiting exists; the remaining blockers are the in-process
Beam SSE run registry (needs Redis pub/sub or sticky routing) and boot-time
migrations (E1 step 2 notes the revisit). Record this as a one-pager in
`docs/beam-agent/` when triggered. Until then, A2 (graceful shutdown) + A4
(healthcheck) shrink the single-replica deploy blip to near-zero, which is
the actual pain today.

### H2. Repo governance files (#23, P2 — one hour)

`SECURITY.md` (disclosure contact — the user's real security email, 90-day
disclosure window), `CODEOWNERS` (`* @cloudURBANE` minimum; route `infra/`
and `lib/db/` explicitly), `.github/pull_request_template.md` (checklist:
tests updated, migration included if schema changed, env vars documented in
`.env.example`). Dependabot config lands in F2.

---

## Sequencing summary

```
Week 1  WS-A (A1→A7)                                  ~7 small PRs
Week 2  B1+B2 (CORS+headers, CSP report-only starts)   F1, F2, G3
        D1 (Sentry both sides, uptime)
Week 3  E1 (migrations) → C1→C2→C3→C4 (auth series)    G1, G2, E2
Week 4  CSP flip to enforcing · F3 seeds · H2          bake + verify
Trigger H1 (multi-replica) · WAF                       when data says so
```

Cross-cutting dependencies, restated: **A1 before C4** (limits spoofable
until trust proxy is right) · **A4 before B3** (healthcheck gates the DB-TLS
cutover) · **E1 before C1** (token-hash migration is migration #1) ·
**A6 before F2's no-console rule** · **B2 report-only ≥1 week before
enforcing CSP** · **G3 coordinates with B2** (same Terraform).

## Definition of production-ready (exit checklist)

- [ ] No P0 open: CORS allowlisted, headers + enforcing CSP live, tokens
      hashed + expiring + never in URLs, DB TLS verified, rate limits
      unspoofable, graceful shutdown + fatal handlers + readiness-gated
      deploys.
- [ ] A forced 500 shows up in Sentry and a downed `/readyz` pages someone.
- [ ] A schema change can only reach prod as a reviewed SQL migration.
- [ ] One restore drill completed and written down.
- [ ] CI fails on: lint (floating promises), missing migration, broken
      Docker build, undiscovered tests can't exist (glob).
- [ ] Docker image is non-root, prod-deps-only, healthchecked.
- [ ] Boot fails loud on missing required env; warns on unknown vars.
- [ ] Vercel fully decommissioned; OIDC trust = `main` only.
- [ ] The "Already production-grade" list in the audit still passes — no
      regressions to SSRF defense, PKCE, timing-safe compares, redaction,
      pool bounds, or supply-chain rails.
