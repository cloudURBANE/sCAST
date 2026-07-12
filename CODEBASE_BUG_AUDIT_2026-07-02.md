# Codebase Bug Audit & Remediation Blueprint — 2026-07-02

> **Purpose.** This is a *reference/blueprint* for follow-up teams, not a fix log. It
> maps the two coupled repositories (`sCAST` web app + `srt-scent-engine` Python
> engine), records every **verifiable** latent defect found during a diligent
> evidence-based audit, and explicitly lists candidates that were **refuted** so no
> team re-burns time on them. Each finding names an owning area and a one-line fix
> direction only. **Status note (2026-07-02):** all Part A findings (A1–A5) have since
> landed on `main` via PR #508 — see the per-finding status lines. **Status note
> (2026-07-04):** Part B is now closed too — B1 (open portion), B2, B3, B4, and B6
> fixed on `claude/skills-spawn-gaps-l87tdx`, guarded by `test_audit_gap_closures.py`;
> B5 confirmed working-as-designed (no change). See the per-finding status lines.
>
> **How to use this.** Pick a finding, open the exact `file:line`, reproduce the
> failure scenario, then fix under the repo's own doctrine (`CLAUDE.md`,
> `large-repo-investigation` → `safe-edit-verify` → `commit-discipline`). Update the
> status column when you take one.

## Confidence & severity legend

- **Confirmed** — proven by static evidence in-tree (exact line + logic). Safe to action now.
- **Plausible** — logic gap is real in code; the *exploit/impact* needs a runtime repro to fully size. Verify before/while fixing.
- **Refuted** — investigated and found **not** to be a bug. Documented so it is not re-opened.

Severity is user/security impact if triggered: **Critical / High / Medium / Low**.

## Methodology

Two independent verification passes (one per repo) cross-checked a seed list of
candidate defects and hunted further, each required to produce `file:line` +
concrete failure scenario + evidence. Headline Confirmed findings were then
re-verified by hand against source. Refutations were required to cite the guard that
makes the candidate safe. Tests referenced are the in-repo `*.test.ts` / `test_*.py`.

---

## Part A — `sCAST` (web app: React SPA + Express API + libs)

### A1. Unauthenticated SSRF via TOCTOU / DNS-rebinding in the image proxy — **Confirmed · High**

> **Status: FIXED on `main`** (`9f63538`, PR #508). `safeImageFetch` now resolves once
> via a pinned custom `lookup`, rejects private addresses, and connects only to the
> validated addresses. Fixed together with A2.

- **Where:** `artifacts/api-server/src/services/safeImageFetch.ts:263` (validate) vs `:267`
  (`fetch(current.toString())`); reachable anonymously through
  `artifacts/api-server/src/routes/imageProxy.ts:61` (`GET /api/image-proxy?url=…`),
  mounted with **no auth** at `routes/index.ts:38` (`router.use(imageProxyRouter)`).
- **Symptom:** `assertPublicDnsTarget(hostname)` resolves and rejects private IPs, then
  `fetch()` re-resolves the same hostname independently — the connected-to address is
  never pinned to the validated one. An attacker controlling `evil.example` DNS (low
  TTL) returns a public IP for the validation lookup and a private IP (e.g.
  `169.254.169.254` metadata, `127.0.0.1`, an internal service) for the connection.
  `redirect: "manual"` re-validates each hop but every hop still re-resolves, so the
  window persists across the ≤4 redirects.
- **Evidence:** two separate `lookup`/`fetch` calls, no shared/pinned socket; `fetch`
  receives a hostname string, not an IP. Endpoint has no `requireAuth`/`optionalAuth`.
- **Owner / fix:** API-server platform-security. Resolve once, connect to the validated
  IP (custom `lookup` / undici `Agent` pinned to the address, or an allowlist), then
  re-check the post-connection remote address.

### A2. IPv4-mapped IPv6 private ranges bypass the SSRF guard — **Confirmed · High**

> **Status: FIXED on `main`** (`9f63538`, PR #508). IPv4-mapped IPv6 is normalized to
> its embedded IPv4 and run through the IPv4 predicate; missing ranges added.

- **Where:** `artifacts/api-server/src/services/safeImageFetch.ts:128-140`
  (`isPrivateIpAddress`, IPv6 branch).
- **Symptom:** The IPv4 branch correctly blocks `169.254.0.0/16` (metadata),
  CGNAT, multicast, etc. The **IPv6 branch only maps** `::ffff:127.`, `::ffff:10.`,
  `::ffff:192.168.`, `::ffff:172.(16-31).` — it **omits `::ffff:169.254.`**
  (cloud-metadata `169.254.169.254`), `::ffff:100.64/10`, mapped `0.0.0.0/8`, and
  multicast. A literal URL `http://[::ffff:169.254.169.254]/…` (or an AAAA record
  returning that mapped form) passes **both** the sync check (`:165`) and
  `assertPublicDnsTarget` (`:188`) with **no rebinding required**.
- **Evidence (hand-verified):** `net.isIPv6("::ffff:169.254.169.254") === true`; none
  of the `startsWith`/regex cases at `:136-139` match it → returns `false` ("public").
- **Owner / fix:** normalize IPv4-mapped IPv6 to its IPv4 form and run the IPv4
  predicate; add the missing ranges. **Fix A1 + A2 together** — they compound into one
  exploitable, unauthenticated internal-metadata SSRF.

### A3. Google OAuth has no `state` / PKCE → login-CSRF — **Confirmed · Medium**

> **Status: FIXED on `main`** (`cd7ae87`, PR #508). `/auth/google` now mints a random
> `state` + PKCE S256 challenge, carried in short-lived httpOnly SameSite=Lax cookies
> and verified constant-time on the callback.

- **Where:** `artifacts/api-server/src/routes/oauth.ts:222-240` (`/auth/google`),
  `:242-361` (callback).
- **Symptom:** The authorization request carries no `state` (nor PKCE
  `code_challenge`), and the callback never generates/validates one (hand-verified:
  grep for `state`/`pkce`/`nonce` in `oauth.ts` matches only an unrelated comment).
  This permits login-CSRF / authorization-code injection — an attacker can force a
  victim's browser to complete the callback with the attacker's `code`.
- **Note:** account-*rebinding* hijack is well-defended (`WHERE oauth_subject IS NULL`
  at `:97`, `coalesce(...)` upsert `:136-137`, different-subject refusal `:319-326`).
  The gap is specifically CSRF `state`, not rebinding.
- **Owner / fix:** issue a signed/opaque `state` (ideally + PKCE), store in a
  short-lived cookie, verify on callback.

### A4. Community search `q` allows LIKE-wildcard injection — **Confirmed · Low**

> **Status: FIXED on `main`** (`b6edaf0`, PR #508). LIKE metacharacters are escaped
> before the pattern is built.

- **Where:** `artifacts/api-server/src/routes/communityPosts.ts:890-913`.
- **Symptom:** `` `%${q}%` `` interpolates the raw query into an `ILIKE` pattern
  without escaping `%`, `_`, `\`. Not SQL injection (values are parameterized), but a
  user searching `%`/`_` gets over-broad matches and pathological patterns over the
  `EXISTS` subqueries can be needlessly expensive. `q` is capped at 120 chars (`:748`),
  limiting blast radius. Keyset cursor pagination itself is correct.
- **Owner / fix:** escape LIKE metacharacters before building the pattern (or `ESCAPE`).

### A5. Engine-proxy forwards original `content-type` on re-serialized body — **Plausible · Low**

> **Status: FIXED on `main`** (`4a61ec0`, PR #508). `content-type: application/json`
> is set unconditionally when the body is re-serialized.

- **Where:** `artifacts/api-server/src/routes/fragranceEngineProxy.ts:53-66`.
- **Symptom:** For a non-GET request whose original `content-type` is not JSON, the
  header-copy loop forwards the original `content-type` while the body is always
  re-serialized as `JSON.stringify(req.body ?? {})`; the `if (!headers.has(...))`
  guard won't overwrite it. Cosmetic for this engine (reads JSON), not a security
  issue. **Credential leak and content-length mismatch were refuted** (see A-Refuted).
- **Owner / fix:** set `content-type: application/json` unconditionally when
  re-serializing.

### A-Refuted (do not re-investigate)

- **Enrichment-queue timer reentrancy / double-processing** — *Refuted.* Worker guards
  overlapping ticks with a `tickRunning` flag (`enrichmentQueue.ts:371-379`), both
  intervals are `unref()`d, callbacks catch rejections; `claimNextEnrichmentJob` uses
  `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED)` (`:238-253`). Also env-gated
  OFF by default.
- **scent-weather-engine scoring (NaN / divide-by-zero / empty-reduce / off-by-one)** —
  *Refuted.* Heavily defended: `spray_count` clamps + asserts the band invariant
  (`scentWeatherEngine.ts:732-746`); cosine denominators guarded
  (`weeklyOutlook.ts:302`); empty-candidate handled (`:365-366`); short arrays use
  `?? 0`. (One theoretical note: the `spray_count` invariant is a hard `throw` inside
  the per-item vault loop — not reachable with current constants, but a future bounds
  edit could fail the whole recommendation instead of one item.)
- **`source_coverage` completeness predicate / self-heal** — *Refuted.*
  `isSourceCoverageComplete` (`fragranceApi.ts:794-803`) matches the documented
  contract exactly; `normalizeSourceCoverage` recomputes `complete` from copied
  coverage and never loosens it.
- **`imagePipeline` in-flight dedup Map leak/collision** — *Refuted.* Every `.set` is
  paired with a `finally` `.delete` on the same key; keys are variant-isolated.
- **`wardrobe` conditional-GET ETag staleness** — *Refuted.* Excluding image hydration
  from the ETag key is documented and intentional (`wardrobe.ts:95-100`).

---

## Part B — `srt-scent-engine` (FastAPI Python engine)

### B1. Orphaned `processing` jobs after a worker crash are never auto-reclaimed — **Plausible · Medium**

> **Status: FIXED** (2026-07-04). Verification found the claim path already
> reclaims expired leases (`db.claim_job` lease-stealing, worker auto-approve
> reclaim — PR #69); the remaining open portion was `recover_or_enqueue_job`
> preserving `processing` unconditionally. It now preserves a processing row
> only under a live (non-NULL, unexpired) `claim_expires_at` lease, so an
> orphan reopens to `pending` on the next `/details` view or heal sweep, and
> `list_jobs(status="pending")` flips expired-lease orphans back to pending
> before listing — so even a plain `--process-pending` drain (no dashboard,
> no `/details` view) reclaims them. Guarded by `test_audit_gap_closures.py`.

- **Where:** `db.py:863-919` (`claim_job` reclaims by id only), `db.py:820-846` /
  `api.py:6023-6035` (`list_jobs` defaults to `status="pending"`), `db.py:671-770`
  (`recover_or_enqueue_job` preserves `processing`, CASE at `:701-705`).
- **Symptom:** A worker dying mid-job leaves the row `processing` with an expired
  `claim_expires_at`. Workers poll `list_jobs(status='pending')`, which excludes it;
  there is **no sweeper and no `WHERE claim_expires_at <= now()` reset query**. Worse,
  the read-time self-heal `recover_or_enqueue_job` explicitly *preserves* `processing`,
  so even a fresh `/details` for that fragrance reports `enrichment_status="processing"`
  forever and never re-queues — recovery needs a manual `POST …/requeue`. Directly
  produces the "app isn't improving even though drains ran" class of report.
- **Owner / fix:** enrichment/backend. Add a periodic (or claim-time) query flipping
  expired-lease `processing` → `pending`, or have `recover_or_enqueue_job` treat an
  expired-lease `processing` row as reopenable.

### B2. DB failure while reopening an incomplete job is masked as `"completed"` — **Plausible · Medium**

> **Status: FIXED** (2026-07-04). `_recover_incomplete_enrichment_job` now
> returns a non-None error state on a raised DB error (normalizing to
> `"unavailable"`), and the `/details` stored-payload branch degrades
> `unavailable` → `"completed"` only when no job state exists at all — the
> raised case surfaces `"unavailable"` so the SPA keeps retrying. Guarded by
> `test_audit_gap_closures.py`.

- **Where:** `api.py:5073-5079` (details stored-payload branch),
  `api.py:4957-4987` (`_recover_incomplete_enrichment_job` swallows all exceptions →
  `None`), `api.py:4912-4921` (`_enrichment_status_from_job_state(None)` → `"unavailable"`).
- **Symptom (hand-verified):** for a cached-but-metrics-incomplete detail, if the DB
  reopen upsert throws (transient Supabase error), the `except Exception` at
  `api.py:4981` returns `None` → maps to `"unavailable"` → the details handler rewrites
  it to `enrichment_status = "completed"` (`:5078-5079`). The SPA is told a genuinely
  partial tile is complete **and** no heal job was enqueued, silently stalling self-heal
  until a hard refresh.
- **Owner / fix:** distinguish "recover returned no row because ignored/terminal"
  (legit → may degrade to completed) from "recover raised" (should surface a retryable
  status, never "completed").

### B3. Threadpool capacity (40) exceeds DB pool (15); cheap DB endpoints are ungated — **Plausible · Medium**

> **Status: FIXED** (2026-07-04). The pool now bounds connection acquisition
> (`DB_POOL_ACQUIRE_TIMEOUT`, default 5s) instead of psycopg's 30s default,
> and an app-level handler maps `psycopg_pool.PoolTimeout` to the same
> retryable 503 + `Retry-After` the scrape gates use. Saturation degrades
> fast instead of hanging a thread 30s and 500ing. Guarded by
> `test_audit_gap_closures.py`.

- **Where:** `db.py:56` (`DEFAULT_DB_POOL_MAX_SIZE=15`), `db.py:244-264` (pool + `_conn`);
  all sync routes; `mobile.py:607-620` (dashboard polls `/api/m/overview` every ~4s).
- **Symptom:** Sync `def` routes run in anyio's default 40-token threadpool (no custom
  `CapacityLimiter`). The two semaphores gate only the *expensive scrape* paths
  (`_LIVE_SEARCH_SEMAPHORE=6`, `_DETAIL_FETCH_SEMAPHORE=8`); the many cheap DB-only
  endpoints (cache pre-checks in `search`, `/api/enrichment/status`, `list_jobs`, the
  4-second mobile poll) are ungated. With >15 such requests in flight, the 16th blocks
  in `_pool.connection()` (psycopg default 30s) → `PoolTimeout` → HTTP 500, while still
  holding a threadpool thread; up to 40 threads pile behind 15 connections.
- **Owner / fix:** raise `DB_POOL_MAX_SIZE` toward the concurrent-DB ceiling, or lower
  the anyio limiter to match the pool, or add a short pool-acquire timeout that degrades
  to 503 (as the scrape gates already do) instead of a 30s hang → 500.

### B4. Unbounded growth of `_DERIVED_METRICS_LOCKS` (slow memory leak) — **Confirmed · Low–Medium**

> **Status: FIXED** (2026-07-04). Replaced the per-record dict with 256
> fixed lock stripes selected by `crc32(key)`; a stripe collision merely
> serializes two records' metric fills. No growth, no guard lock. Guarded by
> `test_audit_gap_closures.py`.

- **Where:** `api.py:240` (dict), `api.py:4530-4542` (`_derived_metrics_lock_for`).
- **Symptom (hand-verified):** a per-record `threading.Lock` is inserted keyed by
  `record_key || canonical_fg_url || bn_url || "house|name|year"` and **never removed**
  (only `.get`/assignment at `:4538`/`:4541`; no `del`/`pop`/prune anywhere). Every
  distinct fragrance adds a permanent str+Lock entry — monotonic leak on a long-lived
  Railway process over a large catalog.
- **Owner / fix:** bound it (LRU / periodic prune of unlocked entries) or key locks by a
  hashed bucket of fixed cardinality.

### B5. `get_scraper()` builds a fresh session per request — **Confirmed · Low (throughput)**

> **Status: NO CHANGE (2026-07-04, deliberate).** Re-verified unchanged; the
> per-request session is the design that makes shared-scraper thread-safety a
> non-issue. Left as-is per the audit's own note.

- **Where:** `fragrance_parser_full_rewrite_fixed.py:6026-6033`.
- **Note:** every `search`/`details`/brand-sweep builds a new cloudscraper/requests
  Session (new urllib3 pool). This is *why* there is no shared-scraper thread-safety bug
  (a design plus), but forgoes connection reuse. Not a leak. Throughput note only.

### B6. Diagnostics mint executor can leave a thread running past timeout — **Confirmed · Low**

> **Status: FIXED** (2026-07-04). Both mint-diagnostic sites now run the mint
> on a gated daemon thread (`_run_mint_bounded`): at most one in-flight mint
> per site, overlapping calls get an immediate honest "busy" instead of
> queueing behind a stuck mint, and a mint outliving the 90s budget can no
> longer strand a thread per call nor block interpreter shutdown. Guarded by
> `test_audit_gap_closures.py`.

- **Where:** `api.py:3559-3581` (sibling at `:3918`).
- **Symptom:** on `future.result(timeout=90)` TimeoutError,
  `executor.shutdown(wait=False, cancel_futures=True)` cannot cancel an already-started
  `_mint_basenotes_clearance`, so that worker thread runs until the mint completes.
  Bounded (single-shot admin/diagnostics endpoint) — minor.

### B-Refuted (do not re-investigate)

- **`async def` route blocking the event loop** — *Refuted.* All 30 `api.py` + 13
  `mobile.py` routes are plain sync `def`; the only `async def` is `_lifespan`
  (`api.py:340`). FastAPI runs sync routes in the threadpool.
- **DB connection-pool leak** — *Refuted.* 45 `_conn()` sites, each immediately followed
  by `try/finally` `ctx.__exit__(None,None,None)`; inner `with conn.transaction()`
  handles rollback before release.
- **Enrichment job-claim double-claim race** — *Refuted.* `claim_job` uses
  `SELECT … FOR UPDATE` on a specific id inside a transaction and re-checks status
  before UPDATE; the loser gets `already_processing`. (Residual gap is orphan reclaim →
  B1.)
- **f-string SQL injection** — *Refuted.* Every f-string SQL fragment interpolates only
  **static module constants** (`_ENRICHMENT_JOB_COLUMNS` at `db.py:2381`,
  `_FRAGRANCE_RECORD_SEARCH_COLUMNS`, `_DETAIL_CACHE_SEARCH_COLUMNS`, a boolean guard
  literal). All user/scraped values go through `%s` params.
- **Parser `int()` / regex catastrophic-backtracking hazards** — *Refuted.*
  `derived_metrics_adapter._to_int` is guarded; `int(star)` wrapped in try/except;
  `year_resolver` `int()` only on regex-matched `\d{2,4}`; percentage `int()`s guarded
  by `total > 0`; reviewed regexes use flat alternations, no nested unbounded quantifiers.

---

## Part C — System inventory & suggested team scoping

Use this to assign parallel teams without overlap. Each row lists the canonical owning
tree (per `repo-map`) and the findings that land there.

| Team / domain | Canonical files | Findings |
| --- | --- | --- |
| **Platform security (API)** | `api-server/src/services/safeImageFetch.ts`, `routes/imageProxy.ts`, `routes/oauth.ts` | A1, A2, A3 |
| **API — community/social** | `api-server/src/routes/communityPosts.ts` (1826 lines), `community.ts`, `reviews.ts` | A4 |
| **API — cross-service proxy** | `api-server/src/routes/fragranceEngineProxy.ts`, `engineProxyCostGuard.ts`, root `middleware.js` | A5 |
| **Enrichment pipeline (cross-repo)** | Engine `db.py`, `api.py` (`_recover_incomplete_enrichment_job`, `_enqueue_enrichment_job`); SPA `fragranceApi.ts` self-heal; API `services/enrichment*.ts` | B1, B2 |
| **Engine — runtime/infra** | Engine `db.py` (pool), `api.py` (threadpool, `_DERIVED_METRICS_LOCKS`, diagnostics executor) | B3, B4, B6 |
| **Engine — scraper throughput** | `fragrance_parser_full_rewrite_fixed.py` | B5 |

### Reference: subsystem map (for teams new to the repos)

- **SPA (`artifacts/scent-cast/src`)** — components: `Wardrobe`, `ScentMissionPanel`,
  `NotePyramid`, `BeamCard/BeamMessage`, `arena/`, `community/`, `threads/`, `pwa/`,
  `ui/`. lib: `fragranceApi.ts` (external-engine client + `source_coverage` contract),
  `beam*` (concierge client/contract/format), `scentMissionClient`, `wardrobe*`,
  `noteAccord*`. Auth in `context/AuthContext.tsx`.
- **API (`artifacts/api-server/src`)** — routes (`communityPosts`, `scent`,
  `fragrances`, `wardrobe`, `me`, `oauth`, `imageProxy`, `fragranceEngineProxy`,
  `enrichment`, `admin`); services (image pipeline ~40 files incl. `imagePipeline`,
  `bgService`, `serperService`, `imageObjectStorage`; `scentEngine`; `enrichment*`);
  `beam-agent/` (loop, providers, tools, mcp, research); middlewares (`auth`, `tenant`).
- **Libs** — `db` (Drizzle schema + pool), `api-spec`/`api-client-react`/`api-zod`
  (Orval codegen — edit `openapi.yaml` then regenerate, never hand-edit generated),
  `scent-weather-engine` (shared client+server scoring), `integrations-gemini-ai`.
- **Engine (`srt-scent-engine`)** — `api.py` (FastAPI HTTP surface), `db.py` (Postgres:
  `enrichment_jobs` queue + `fg_detail_cache` + `fragrance_records`),
  `fragrance_parser_full_rewrite_fixed.py` (scraper/parser, 11.7k lines), `parfinity.py`,
  `year_resolver.py`, `concentration_grabber.py`, `derived_metrics_adapter.py`,
  `enrichment_facts.py`, `mobile.py` (dashboard).
- **Deploy** — Vercel edge `middleware.js` (proxies `/api/*` → `BACKEND_ORIGIN`),
  `vercel.json`, `railway.json`/`railway.toml`, `Dockerfile`, engine `Procfile`/`nixpacks.toml`.

---

## Priority order (recommended)

1. **A1 + A2** — unauthenticated internal/metadata SSRF (fix as one change). *High.*
2. **A3** — OAuth `state`/PKCE (login-CSRF). *Medium.*
3. **B1 + B2** — silent job orphaning and partial-tile-reported-complete; the two most
   likely causes of "the app isn't improving" reports. *Medium.*
4. **B3** — pool/threadpool mismatch (500s under load). *Medium.*
5. **B4, A4, A5, B5, B6** — leaks / hardening / hygiene. *Low.*

_Fixes are intentionally NOT applied in this pass. This document is the blueprint;
each finding should be taken under the repo's investigate → surgical-patch → verify →
commit doctrine._
