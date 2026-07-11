# Launch Readiness — Systematic Audit, 2026-07-10

**Scope:** both repos (`sCAST` monorepo + `srt-scent-engine`), audited fresh
against the code as of today, plus live CI evidence from GitHub Actions.
**Purpose:** the single source of truth for "where are we, what's left, and how
sure are we" — for every agent and the owner. Supersedes the *status* portions
of `MVP_READINESS_GAPS_2026-07-09.md` (which remains the reference for gap
definitions; its IDs — S1…S9, E1…E9, X1…X4 — are reused here).

**Last reconciled:** 2026-07-10 22:47 UTC. This revision incorporates merged
monitoring/Sentry work, production deployment evidence, and the completed
database restore validations. AWS/Terraform ownership remained out of scope.

**Addendum (same day, PR #600):** the AWS/Terraform-owned gaps called out
below are now implemented in-repo: CSP `report-uri` plumbing
(`infra/variables.tf` → `csp_report_uri`), a `web` monitor probe through the
canonical CloudFront `/api/*` path, a post-deploy Chromium smoke in
`deploy-frontend`, and the missing `VITE_SENTRY_DSN` pass-through to the AWS
frontend build (see the S4/L2/L6 and sCAST-Sentry notes below).

**Two different finish lines** (the owner asked for these to be separated):

- **Ready to USE** — a real user can install the PWA / open the site, sign in,
  search, build a wardrobe, get recommendations, day after day, without the
  product falling over or silently degrading. This is a *reliability +
  operations* bar.
- **Ready to SELL** — the product can *make money and not lose money per user*:
  revenue rails exist and are attributable, per-user costs are capped and
  measured, and the unit economics of "one more user" are known. This is a
  *business-infrastructure* bar. A product can be 100% ready to use and 0%
  ready to sell.

---

## 1. Scoreboard

| Dimension | Readiness | Confidence in the number | Basis |
| --- | --- | --- | --- |
| **Product functionality** (search, wardrobe, recommendations, images, Beam, community, arena) | **~95%** | High | Feature-complete for the intended MVP; both CI suites green on `main`; self-heal + contract fixtures on both sides |
| **PWA / distribution surface** | **~95%** | High | Manifest, Workbox SW (precache, offline shell, push, update-prompt), icons, zoom-lock fix (#585) all verified in-repo |
| **Security posture** | **~90%** | High | Token-hash cutover done, one-time OAuth handoff, rate limits everywhere, verified DB TLS both services, SSRF-hardened fetches; CSP is Report-Only but lacks a collector |
| **Deploy pipeline** | **~95%** | High | `deploy-frontend` main run `29128275763` succeeded for merge `c4ff605`; `scentbeam.com` now responds through CloudFront/AmazonS3; Railway deployments for API and engine are healthy |
| **Operations** (monitoring, backups, runbooks) | **~90%** | High | Three Sentry projects are live; repository readiness monitoring runs every five minutes; both DB restore paths were validated. External phone/SMS escalation and CSP collection remain open |
| **Ready to USE (10–20 user beta)** | **~95%** | High | Core launch engineering and repository operations are live; remaining blockers are dashboard confirmation and alert-channel work |
| **Ready to USE (open/public, hundreds of users)** | **~85%** | Medium-high | CSP collection plumbing shipped (PR #600) but not applied/verified; external escalation and capacity evidence remain; browser smoke ships with PR #600 |
| **Ready to SELL** | **~55%** | Medium | Affiliate rails are coded and legally disclosed, but no payment infra exists, affiliate program approvals are unverifiable from the repo, and revenue attribution is minimal |

**How to read the confidence column:** "High" = every claim in that row was
verified against code, migrations, CI runs, or workflow logs today (evidence
cited below). "Medium" = partially depends on state that lives outside the
repos (dashboards, affiliate accounts, Railway env) that a code audit cannot
see — the owner must confirm those in §6.

---

## 2. What is verifiably DONE (evidence-checked today)

The 2026-07-09 gap audit listed 9 monorepo gaps, 9 engine gaps, and 4
cross-cutting gaps. The "readiness gap fixes" PRs (sCAST #581/#582, engine
#140/#141) closed most of them. Verified line-by-line today:

### sCAST monorepo

| Gap | Status | Evidence |
| --- | --- | --- |
| S2 plaintext bearer tokens | ✅ **Closed** | `lib/db/migrations/0002_user_token_sessions.sql`; `middlewares/auth.ts` — hash-only lookups against `user_tokens`, explicit "NO plaintext users.token fallback" |
| S3 Vercel decommission | ✅ **Closed** | `vercel.json` and `middleware.js` deleted from repo root; CloudFront/S3 is the single frontend path |
| S1 CSP code blocker | ✅ **Closed** (code half) | inline `onload=` removed from `artifacts/scent-cast/index.html`; `csp_enforce` still `default = false` (`infra/variables.tf:79-82`) — the flip is an **operator** step after a violation-free bake |
| S4 tenant isolation test | ✅ **Closed** (integration half) | `test-support/wardrobeQueries.integration.test.ts` — multi-tenant isolation against real Postgres (pglite) with versioned migrations applied |
| S6 SPA lint gate | ✅ **Closed** | `eslint.config.mjs` now scopes `artifacts/scent-cast/src/**` |
| S7 blocking dependency audit | ✅ **Closed** | `tests.yml:53-54` — `pnpm audit --prod --audit-level=high`, no `\|\| true` |
| S9 legacy token expiry | ✅ **Closed** | `0002` migration backfills via `COALESCE(token_issued_at, now())` |
| S8 Redis optional at 1 replica | ✅ Accepted | unchanged, documented, trigger-based revisit |
| Reimagine cost exposure (June image-cost audit) | ✅ **Closed** | `routes/scent.ts:684-701` — per-IP `reimagineRateLimit`, `ENABLE_REIMAGINE` kill-switch, busy-server 429, usage ledger |
| sCAST Sentry | ⚠️ **API closed / SPA half-open** | [sCAST PR #594](https://github.com/cloudURBANE/sCAST/pull/594) (`2967b62`), Railway deployment `a93b22b6-e8b3-4ddf-bb02-6e573b37644a`, API startup log, React project `4511713045381121`, API project `4511713056063488`, and both synthetic ingestion checks returned HTTP 200. **However:** synthetic ingestion proves the Sentry *projects* accept events, not that the deployed SPA sends them — #594 passed the DSN only through the Dockerfile (Railway self-host path), `deploy-frontend` (which builds the bundle CloudFront serves) did not, and the live `assets/index-*.js` contains no ingest URL. PR #600 adds `VITE_SENTRY_DSN` (repo variable) to that build; **owner: set the variable** to the React project's DSN |
| S5 database restore | ✅ **Functional restore verified** | 2026-05-06 restored backup validation: `users=4`, `user_fragrances=23`, `user_settings=4`, `global_fragrances=36`, with clean orphan/duplicate checks. Historical RTO was not timed; see `docs/DR_RUNBOOK.md` |

### srt-scent-engine

| Gap | Status | Evidence |
| --- | --- | --- |
| E1 error tracking | ✅ **Closed and production-verified** | [engine PR #149](https://github.com/cloudURBANE/srt-scent-engine/pull/149) (`d3e6c96`) extracted/tested DSN-gated initialization, disabled request-body/default-PII capture, and covered daemon workers. Sentry project `scentbeam-engine`; Railway deployment `4b777e86-57df-4264-bb5c-b96836b12370`; synthetic store event `f56964a0da12413b917cfb44360eb9e3` accepted HTTP 200 |
| E2 per-IP rate limits | ✅ **Closed** | `rate_limit.py` + middleware at `api.py:432-439`, env-tunable `RATE_LIMIT_*_PER_MIN`, covers search/details/requeue |
| E3 verified DB TLS | ✅ **Closed** | `db.py:243-255` — `DATABASE_SSL_CA` → `sslmode=verify-full`, boot warning when unverified |
| E4 readiness + branch protection | ✅ **Closed** | `/readyz` is the Railway health gate. GitHub API verified strict `main` protection requiring the `test` check (app id `15368`) |
| E5 engine DR | ✅ **Closed** | [engine PR #148](https://github.com/cloudURBANE/srt-scent-engine/pull/148) (`74b0aa4`): 6.3 MB dump, 9 tables and 5,061 public rows matched, 19.4s dump/restore, ~8 minutes end-to-end, restored `/readyz` HTTP 200 |
| E6 dependency scanning | ✅ **Closed** | `.github/dependabot.yml` (pip + actions), pip-audit CI step |
| E8 repo hygiene | ✅ **Closed** | diag scripts moved under `scripts/`, run outputs dropped |
| CI health | ✅ Green | post-merge `ci` run `29128279083` on `main`: success (2026-07-10) |

### Cross-cutting

| Gap | Status | Evidence |
| --- | --- | --- |
| X2 cross-service contract | ✅ **Closed** | shared `source_coverage` fixtures asserted by both CI suites (engine commit 5a45759) |
| X3 staging definition | ✅ **Closed** (decision doc) | `docs/STAGING.md` — per-layer staging (Railway PR envs + scratch Supabase + local Vite); activation is a ~15-min ops step |
| X4 secrets rotation | ✅ **Closed** | `docs/SECRETS_ROTATION.md` — every credential family, both services, pairings noted |
| X1 repository uptime monitoring | ✅ **Closed** | [sCAST PR #598](https://github.com/cloudURBANE/sCAST/pull/598) (`c4ff605`), five-minute workflow, exact JSON contracts, one deduplicated issue per service, auto-close on recovery, and failing workflow notifications. [Manual main run `29128285938`](https://github.com/cloudURBANE/sCAST/actions/runs/29128285938) passed |

Also verified healthy and load-bearing (do not regress): PWA manifest +
hand-authored Workbox SW with push and update-prompt; Google OAuth
PKCE + one-time-code handoff; graceful shutdown + fatal handlers; readiness
probes on both services; Beam per-user daily caps (below); legal pages with
Privacy Policy, Terms, and affiliate disclosure (`pages/legal.tsx`).

---

## 3. Current launch status and remaining beta blockers

The remaining items are now bounded dashboard/operations work. No AWS or
Terraform files were changed during this reconciliation.

### L1 — deploy pipeline
✅ **Resolved.** Main run `29128275763` completed successfully at merge
`c4ff605`; the API and engine also completed their Railway health gates.

### L2 — uptime monitoring
✅ **Repository monitor live.** `.github/workflows/readiness-monitor.yml` checks
`https://api.scentbeam.com/api/readyz` and
`https://srt-scent-engine-production.up.railway.app/readyz` every five minutes,
including the distinct JSON contracts. It opens/reopens one stable incident per
service, closes it after recovery, and fails the run for Actions notifications.
Main dispatch run `29128285938` passed. PR #600 adds a third `web` probe —
the same Express contract through the canonical CloudFront `/api/*` proxy —
so a CDN/proxy breakage is distinguishable from a Railway outage.
**External SMS/phone escalation remains
owner-blocked**: connect an external monitor or notification integration and
test the escalation channel without deliberately taking production down.

### L3 — database restore drills
✅ **Complete for functional recovery.** The sCAST restored snapshot has exact
row/integrity evidence in `docs/DR_RUNBOOK.md`; its historical wall-clock RTO
was not recorded. The engine's 2026-07-10 scratch Railway drill has full row
parity, 19.4s restore time, ~8 minute end-to-end time, and healthy `/readyz`.
Do not rerun either expensive/destructive exercise merely for confirmation.

### L4 — operator launch checklist (`docs/USER_LAUNCH_SETUP.md`)
The remaining verified dashboard blocker is Google OAuth. The available browser
session reached Google Cloud sign-in, so the authorized redirect URI could not
be inspected. **Owner action:** sign in to Google Cloud Console → APIs & Services
→ Credentials, open the production web client, and confirm
`https://scentbeam.com/api/auth/google/callback` is an authorized redirect URI.

Affiliate program state is also owner-only: confirm Rakuten, CJ, and Amazon
Associates application/approval status, then verify production `affiliate_links`
rows use approved live program URLs. Do not invent credentials or program links.

### L5 — engine `main` branch protection
✅ **Complete.** The GitHub protection API reports strict required status checks
and requires the Actions `test` check on `main`.

### L6 — CSP collection before enforcement
⛔ **Collection is not configured.** At 2026-07-10 22:35 UTC the production
response carried `Content-Security-Policy-Report-Only`, but the policy had no
`report-uri`/`report-to`, and the response had no `Reporting-Endpoints` or
`Report-To` header. There is therefore no collection endpoint to test or recent
violation stream to inspect. Keep enforcement off. The collector plumbing now
exists in-repo (PR #600): `infra/variables.tf` takes `csp_report_uri`, appended
to the policy as a `report-uri` directive (recipe for deriving the Sentry
security endpoint from the React project's DSN is in
`terraform.tfvars.example`). **Owner:** set it in `terraform.tfvars`,
`terraform apply`, confirm accepted reports, then bake at least one
violation-free week before considering enforcement.

### Explicitly NOT blocking the beta (do during/after)
- **Playwright E2E smoke** (S4 remainder) — ✅ browser half shipped in PR #600:
  every `main` deploy now ends in a real-Chromium smoke (SPA mounts on `/` and
  `/arena` with no page errors; readyz contract holds through the CloudFront
  proxy). The login → wardrobe round-trip stays manual (real Google account).
- **Engine Chromium pin refresh** (E7) — mitigated by `DISABLE_CHROMIUM_MINT=1`
  on the web service; verify that flag in Railway config when walking L4.
- **Redis / multi-replica** (S8) — single replica is correct at this scale.
- **Engine capacity ceiling docs** (E9) — record the scale-out trigger; the
  GIL-bound single worker is fine for 10–20 users.

---

## 4. Ready to SELL — the honest picture

### 4.1 What exists today (verified in code)

**Revenue rails — affiliate only.** There is **no payment infrastructure** in
either repo: no Stripe/PayPal/LemonSqueezy, no subscription model, no
entitlements, no paywall. What exists:

- Affiliate provider chain **Rakuten → CJ → Amazon → plain link**
  (`AMAZON_AFFILIATE_MINI_TASK.md` design, implemented in the affiliate
  services), `affiliate_links` table, and a hardened redirect endpoint with
  SID tracking (`routes/cjRedirect.ts` — https-only, sanitized sid,
  click-count increment).
- Legal compliance for it: affiliate disclosure in both Privacy Policy and
  Terms (`pages/legal.tsx:153,261`) — FTC-disclosure-shaped. ✅

**Cost containment — good and real.** Per-user marginal cost is capped:

| Cost driver | Guard | Evidence |
| --- | --- | --- |
| Beam concierge (LLM) | per-user **60 runs/day AND $2/day USD cap**, 20 runs/5min limiter; default model is cheap tier (Haiku), strong tier opt-in | `beamAgentRoutes.ts:103-122,493-498`; `claudeProvider.ts:25,40` |
| Decodo (engine SERP/scrape spend) | `DECODO_DAILY_REQUEST_CAP` kill-switch + per-IP rate limits | engine `api.py`, `rate_limit.py`, `SECRETS_ROTATION.md` |
| Reimagine (OpenAI gpt-image-2) | per-IP hourly limit + `ENABLE_REIMAGINE` kill-switch + busy-429 + usage ledger | `routes/scent.ts:684-701`, `apiUsageLedger.ts` |
| Serper / Poof (images) | key pools + `image_cache` and `global_fragrances` caches make each fragrance a **one-time** cost that amortizes across all users | image pipeline, `imageCacheService.ts` |
| Engine proxy | Express-side cost guard capping anon callers | `routes/engineProxyCostGuard.ts` |

**Rough cost envelope at 10–20 beta users** (estimate, medium confidence):
fixed infra (2 Railway services + Supabase free/pro + CloudFront/S3) ≈
**$20–50/mo**; marginal per-active-user (Beam at Haiku prices, occasional cold
searches, a few reimagines) ≈ **$0.10–0.50/mo** typical, hard-capped at $2/day
by the Beam ceiling. **A beta cannot surprise-bankrupt the project** — the
caps make worst case bounded. This is the strongest part of the sell-side
story.

### 4.2 What's missing for "ready to sell"

1. **No way to charge anyone.** If the $1k/mo target is subscription-shaped
   (e.g. a premium tier for Beam/strong-model/reimagine quota), Stripe +
   entitlements is net-new work: ~1–2 weeks including webhooks, billing
   portal, and gating. **Decision needed before building: affiliate-first or
   subscription-first** (recommendation in §5).
2. **Affiliate program state is outside the repo.** Rakuten/CJ/Amazon
   Associates require applications, approvals, and (Amazon) qualifying sales
   within 180 days. The code is ready; whether the *accounts* are approved and
   the `affiliate_links` table is populated with live program links is
   owner-confirmable only (§6).
3. **Revenue attribution is thin.** Clicks are counted per link; conversions
   happen on the merchant side and only appear in partner dashboards. No
   in-app revenue dashboard, no per-user LTV. Fine for beta; needed before
   scaling spend.
4. **Per-user cost attribution is partial.** The usage ledger records
   reimagine spend app-wide (`userId = null` by design for the anon flow) and
   Beam spend per-user. Good enough to see totals; not yet a per-user margin
   statement.
5. **Business/legal wrapper.** Entity, tax handling for affiliate income,
   and — flagged honestly — the engine's Fragrantica/Basenotes scraping is a
   ToS-risk that gets sharper the moment the product charges money. Not a
   code item; it should be a conscious, recorded decision before "sell."

### 4.3 The $1k/mo question — with stated uncertainty

The owner asked how confident we can be about hitting numbers. Being straight:
**a repo audit can verify capability, not demand.** What the code supports:

- **Affiliate-only path:** fragrance affiliate commissions run roughly 2–10%;
  on an $80–150 average bottle that's ~$3–12 per converted purchase. $1k/mo ≈
  **100–250 purchases/mo**, which at typical click→purchase rates implies
  **thousands of monthly active users**. Reachable given the Reddit/fragrance-
  community wedge, but it is a *traffic* game, not a switch to flip.
  Confidence that the *rails* work when traffic arrives: **high**. Confidence
  in any specific timeline to $1k via affiliate alone: **low — depends on
  audience growth no audit can predict.**
- **Subscription path:** $5/mo premium → **200 subscribers** for $1k/mo. With
  a genuinely differentiated product (nothing else does weather-aware scent
  recommendation + AI concierge), converting 200 paying users from an engaged
  fragrance community is a much shorter lever — but requires the Stripe work
  first and, more importantly, **retention proof from the beta**.

**Recommended read:** the beta's job is not revenue, it's *retention data*.
10–20 users for 2–4 weeks → do they come back daily/weekly? That number
decides which revenue path to build. Don't build Stripe before it.

---

## 5. Launch sequence (the plan)

**Phase 0 — repository and service operations:** ✅ deploy pipeline, repository
monitor, three Sentry projects, engine branch protection, and both functional
restore drills are complete. Remaining operator work: Google OAuth redirect
confirmation, external phone/SMS escalation, affiliate-account verification,
and a CSP collection endpoint owned by AWS/Terraform.

**Phase 1 — closed beta (10–20 users, 2–4 weeks):**
Invite from the fragrance communities only after the Google OAuth redirect is
confirmed. Watch: Sentry error rate, engine
completeness self-heal behavior under real cold searches, Beam usage ledger,
uptime. During the window: configure CSP collection and begin the Report-Only
bake (do not flip yet), add the one
Playwright smoke, verify affiliate links click through with live SIDs. Exit
metric: **week-2 return rate** — this is the number that picks the revenue
model.

**Phase 2 — open up (hundreds):**
CSP enforced; E2E smoke on main; revisit S8 (Redis) and E9 (engine workers)
only if traffic trips their documented triggers; populate affiliate catalog
coverage; start the revenue build chosen by Phase 1 data (subscription →
Stripe + entitlements ≈ 1–2 weeks; affiliate-first → catalog + conversion
dashboards).

**Phase 3 — $1k/mo:** grind the chosen lever with attribution in place.

---

## 6. Owner confirmation checklist (state the repo cannot see)

The percentage claims in §1 assume the remaining owner actions are completed:

- [x] `deploy-frontend` green on `main` — run `29128275763`
- [x] Railway web/API Sentry configured and synthetic API/web events accepted
- [x] Railway engine Sentry configured; deployment `4b777e86-57df-4264-bb5c-b96836b12370`; synthetic event accepted HTTP 200
- [x] Engine repo `main` protection strictly requires the `test` check
- [x] Repository five-minute uptime monitor active; main run `29128285938`
- [x] Both database restore paths functionally verified; engine timing recorded, sCAST historical RTO unavailable
- [ ] **Owner:** verify Google OAuth production redirect URI in Google Cloud Console, then hand smoke-test sign-in → search → add-to-wardrobe → reload on the live domain
- [ ] **Owner:** connect and test external SMS/phone escalation (repository monitoring is complete)
- [ ] **Owner:** set the `VITE_SENTRY_DSN` repo variable (React project DSN) so the CloudFront-served bundle actually initializes Sentry — the build wiring lands with PR #600
- [ ] **Owner:** set `csp_report_uri` in `infra/terraform.tfvars` + `terraform apply` (plumbing in PR #600), verify accepted reports, and inspect a real bake before enforcement
- [ ] **Owner:** confirm Rakuten/CJ/Amazon Associates approvals and populate/verify approved live `affiliate_links`
- [ ] **Owner (per the cutover runbook):** raise DNS TTLs back to 3600 after 1–2 stable days; rotate the Porkbun + AWS keys that passed through chat; decommission Vercel per `CUTOVER.md` §7 only after ≥7 stable days

---

## 7. Method + accuracy statement

Every ✅ added by the reconciliation was checked against repository code,
GitHub APIs/runs, Railway deployment state, production HTTP responses, Sentry
ingestion HTTP responses, or the dated restore evidence. Secrets and DSNs were
never printed. The unresolved items are deliberately not inferred from code:
Google OAuth and affiliate state require owner dashboard access; external phone
escalation requires a chosen provider/channel; CSP requires the AWS/Terraform
owner to add a collector. Percentages remain judgment calls, while the evidence
ledger above is the authoritative completion record.
