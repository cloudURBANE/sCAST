# Launch Readiness — Systematic Audit, 2026-07-10

**Scope:** both repos (`sCAST` monorepo + `srt-scent-engine`), audited fresh
against the code as of today, plus live CI evidence from GitHub Actions.
**Purpose:** the single source of truth for "where are we, what's left, and how
sure are we" — for every agent and the owner. Supersedes the *status* portions
of `MVP_READINESS_GAPS_2026-07-09.md` (which remains the reference for gap
definitions; its IDs — S1…S9, E1…E9, X1…X4 — are reused here).

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
| **Security posture** | **~90%** | High | Token-hash cutover done, one-time OAuth handoff, rate limits everywhere, verified DB TLS both services, SSRF-hardened fetches; CSP still Report-Only (operator flip) |
| **Deploy pipeline** | **~70%** | High | ⛔ `deploy-frontend` is **failing on `main` right now** — missing GitHub repo variables. Backend + engine deploys healthy |
| **Operations** (monitoring, backups, runbooks) | **~65%** | High | Sentry live both services; runbooks written; but **zero uptime monitoring** and **no restore drill ever performed** on either DB |
| **Ready to USE (10–20 user beta)** | **~85%** | High | Everything above combined; blockers are ~1–2 operator days, not engineering weeks |
| **Ready to USE (open/public, hundreds of users)** | **~78%** | Medium-high | Adds: CSP enforce, E2E smoke, capacity ceilings, monitors under real load |
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

### srt-scent-engine

| Gap | Status | Evidence |
| --- | --- | --- |
| E1 error tracking | ✅ **Closed** | `sentry-sdk[fastapi]==2.20.0` in requirements; DSN-gated init in `api.py:364-371` |
| E2 per-IP rate limits | ✅ **Closed** | `rate_limit.py` + middleware at `api.py:432-439`, env-tunable `RATE_LIMIT_*_PER_MIN`, covers search/details/requeue |
| E3 verified DB TLS | ✅ **Closed** | `db.py:243-255` — `DATABASE_SSL_CA` → `sslmode=verify-full`, boot warning when unverified |
| E4 readiness probe | ✅ **Closed** (code half) | `/readyz` at `api.py:2062`, `railway.toml` `healthcheckPath = "/readyz"`. Branch protection on `main` is a GitHub-settings step — **unverifiable from the repo, owner must confirm** |
| E5 engine DR runbook | ✅ Written / ⛔ drill pending | `docs/DR_RUNBOOK.md` exists with loss-impact table; drill "not yet performed", RPO/RTO TBD |
| E6 dependency scanning | ✅ **Closed** | `.github/dependabot.yml` (pip + actions), pip-audit CI step |
| E8 repo hygiene | ✅ **Closed** | diag scripts moved under `scripts/`, run outputs dropped |
| CI health | ✅ Green | latest `ci` run on `main`: success (2026-07-09) |

### Cross-cutting

| Gap | Status | Evidence |
| --- | --- | --- |
| X2 cross-service contract | ✅ **Closed** | shared `source_coverage` fixtures asserted by both CI suites (engine commit 5a45759) |
| X3 staging definition | ✅ **Closed** (decision doc) | `docs/STAGING.md` — per-layer staging (Railway PR envs + scratch Supabase + local Vite); activation is a ~15-min ops step |
| X4 secrets rotation | ✅ **Closed** | `docs/SECRETS_ROTATION.md` — every credential family, both services, pairings noted |

Also verified healthy and load-bearing (do not regress): PWA manifest +
hand-authored Workbox SW with push and update-prompt; Google OAuth
PKCE + one-time-code handoff; graceful shutdown + fatal handlers; readiness
probes on both services; Beam per-user daily caps (below); legal pages with
Privacy Policy, Terms, and affiliate disclosure (`pages/legal.tsx`).

---

## 3. What is LEFT — blocking a 10–20 user beta

Ordered by severity. **Items 1–5 are operator/dashboard work, not engineering.**
Total effort: roughly **1–2 focused days**, almost none of it code.

### L1 (P0, live now) — the frontend deploy pipeline is broken on `main`
`deploy-frontend` failed on both of today's `main` runs with
`Input required and not supplied: aws-region` (run 29099446131). The workflow
needs GitHub **repo variables** `AWS_REGION`, `FRONTEND_S3_BUCKET`,
`CLOUDFRONT_DISTRIBUTION_ID` and **secret** `AWS_DEPLOY_ROLE_ARN`
(`deploy-frontend.yml:108-161`) — none are set. Since Vercel was decommissioned
(S3 ✅), **this failing workflow is the only way the SPA ships.** Until these
four values are set (from the Terraform outputs in `infra/`), frontend changes
do not reach users. Fix: GitHub → Settings → Secrets and variables → Actions;
values come from `terraform output` per `docs/aws-migration/CUTOVER.md`.

### L2 (P0) — no uptime monitoring on either service (X1, unchanged)
Still nothing watches `https://<web>/api/readyz` or `https://<engine>/readyz`.
First outage detector is currently a user. 20 minutes on UptimeRobot/Better
Stack (free tier) with email+phone alerts. Do this before inviting anyone.

### L3 (P0) — restore drill never performed, on either database (S5 + E5)
Both runbooks exist; both say "drill not yet performed; RPO/RTO TBD."
Until one timed restore of the shared Supabase project **and** one of the
engine's Railway PG has actually happened, backups are an assumption. A few
hours total, following the written runbooks. The scratch Supabase project from
`STAGING.md` doubles as the drill target.

### L4 (P1) — operator launch checklist (`docs/USER_LAUNCH_SETUP.md`)
The non-code steps only the owner can do: Railway env for the API (storage
trio is **mandatory** — missing storage creds break every fragrance image;
`DATABASE_SSL_CA`; `TRUST_PROXY_HOPS=2`; enrichment flags), Google OAuth
redirect URI for the canonical host, applying migrations to prod, engine
`FRONTEND_ORIGINS`. Much may already be done in the dashboards — the repo
can't see it. **Walk the checklist and initial each line.**

### L5 (P1) — engine `main` branch protection (E4, op half)
Railway deploys the engine on push independent of CI. Turn on branch
protection requiring the `ci` check (GitHub settings — 2 minutes), or a red
`main` can still ship.

### L6 (P1) — CSP flip (S1, final step)
Code blocker is gone. Confirm violation reports are actually being collected,
bake ≥1 violation-free week of Report-Only under real beta traffic, then set
`csp_enforce = true` in tfvars and apply. Target: during the beta, before
public open-up.

### Explicitly NOT blocking the beta (do during/after)
- **Playwright E2E smoke** (S4 remainder) — integration tests + green CI cover
  the beta; add one browser smoke on `main` merges during the beta window.
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

**Phase 0 — unblock (1–2 operator days):**
L1 deploy variables → L2 uptime monitors → L4 launch checklist walk →
L5 branch protection → L3 restore drills. Exit: green `deploy-frontend` on
`main`, both monitors alerting, both drills logged with real RPO/RTO.

**Phase 1 — closed beta (10–20 users, 2–4 weeks):**
Invite from the fragrance communities. Watch: Sentry error rate, engine
completeness self-heal behavior under real cold searches, Beam usage ledger,
uptime. During the window: CSP Report-Only bake (→ flip, L6), add the one
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

The percentage claims in §1 assume these are answered. Initial each:

- [ ] GitHub repo vars/secrets for `deploy-frontend` set (L1) — **currently NOT set (CI proves it)**
- [ ] Railway web-service env matches `USER_LAUNCH_SETUP.md` §1 (esp. image-storage trio, `DATABASE_SSL_CA`, `TRUST_PROXY_HOPS=2`)
- [ ] Railway engine env: `FRONTEND_ORIGINS`, `DATABASE_SSL_CA`, `DECODO_DAILY_REQUEST_CAP`, `DISABLE_CHROMIUM_MINT=1`, Sentry DSN
- [ ] Google OAuth redirect URI registered for the canonical prod host
- [ ] Engine repo branch protection requires `ci` (L5)
- [ ] Uptime monitors created and alerting (L2)
- [ ] Restore drills performed, timings written into both DR runbooks (L3)
- [ ] Affiliate accounts: Rakuten / CJ / Amazon Associates application status; `affiliate_links` rows populated with live program links
- [ ] Sentry DSNs actually set in both prod services (code is DSN-gated)
- [ ] CSP violation reports confirmed collecting (pre-flip requirement)

---

## 7. Method + accuracy statement

Every ✅ in §2 was verified today by reading the current code, migrations, CI
workflow definitions, and live GitHub Actions run results — not by trusting
prior audit docs. The one **live** P0 (L1) was found from today's failing
`main` runs, not from any document. Percentages are judgment calls over that
evidence: high-confidence rows are bounded by verified facts; the sell-side
numbers are explicitly demand-dependent and marked accordingly. The biggest
category of remaining uncertainty is dashboard state (Railway, GitHub
settings, affiliate programs, Supabase backup tier) — §6 exists to close it.
