# Next-Pass Handoff — `huge_monorepo` (web app: SPA + Express API)

> **For:** the agent continuing work in **`huge_monorepo/`** (React SPA `@workspace/scent-cast`
> + Express API `@workspace/api-server`). The companion file for the Python engine is
> `search_engine/HANDOFF_NEXT_PASS_ENGINE.md` — do not do engine work from here.
>
> **Compiled:** 2026-06-15 · **Branch at compile time:** `feat/scentbeam-remediation-pass`
> (the last UI remediation commit `06847e5` landed the Scent Mission panel layout/text fixes).
> **Canonical tree only:** edit under `huge_monorepo/`. Never touch `.deploy-hm/`, `scb_fix2/`,
> `scb_proxy_fix/` (deploy mirrors — see `repo-map`).

---

## 0. Working protocol (non-negotiable — same discipline as the remediation plan)

1. **Load the named skills before you open the target file.** They encode this repo's traps
   (gesture isolation, webkit render budget, device-class layout, the shared-prod-DB guard,
   the cross-service `source_coverage` contract). Skipping them is how regressions ship here.
2. **Re-anchor on symbols, not line numbers.** Every line number below was accurate at compile
   time and **will drift**. Grep for the named symbol/string first (`token-efficient-navigation`),
   then read only that slice. Never read the giant token-trap files whole (`repo-map`).
3. **Use a subagent where a card says `Subagent: REQUIRED`** — to re-confirm anchors against the
   current tree and sanity-check the diff for ripple effects before you edit.
4. **Verify before claiming done** (`verify-without-regression`, cheapest-first):
   `corepack pnpm run typecheck` → `corepack pnpm run build` → the card's targeted check →
   SPA visual/behavior pass on **PC + iPhone + iPhone-SE (320px)** for any FE card.
   Toolchain bootstrap on this Windows box: `$env:Path += ';C:\Program Files\nodejs'; corepack enable`
   then drive pnpm via `corepack pnpm …` (`dev-commands`).
5. **Git** (`git-guardrails`): short-lived branch cut from updated `main`, **rebase don't
   back-merge**, one-direction integration via PR. Push only your own branch.

**Authoritative source docs (read the card before editing):**
`SCENTBEAM_REMEDIATION_PLAN.md` (verified FE+BE remediation cards — trust its file:line over older
audits) and `docs/beam-agent/09-production-readiness-plan.md` (Beam Agent prod-readiness).

---

## 1. Master index — what is left

> **Status reconciliation — 2026-07-12 (verified against the current tree).** Every
> card below except W-6 and W-11 is now **done on `main`**. Evidence per card:
>
> - **W-1 ✅** `pwa/InstallPrompt.tsx` pins to `--mobile-nav-offset` (line ~138).
> - **W-2 ✅** `SEARCH_QUERY_BRAND_ALIASES` carries `tf`, `jpg`, `pdm`, `eldo`, `adp`
>   (+ `atg`) in `lib/fragranceApi.ts`.
> - **W-3 ✅** result card commits one-tap via the same `handlePrimaryAction` →
>   `handleConfirm()` path (`FragranceCapture.tsx`, comment at the card button).
> - **W-4 ✅** `imageProxyCache.ts` emits `s-maxage` mirroring `max-age` on both tiers.
> - **W-5 ✅** per-user daily caps: 60 runs/day AND `BEAM_USER_DAILY_SPEND_USD` ($2)
>   enforced off the usage ledger (`beamAgentRoutes.ts`).
> - **W-6 ➖ superseded as written** — the Vercel edge proxy no longer exists
>   (`middleware.js`/`vercel.json` deleted; CloudFront serves `/api/*` — see
>   `docs/LAUNCH_READINESS_2026-07-10.md` S3). The equivalent concern — SSE
>   buffering through **CloudFront** — remains a post-deploy verify item.
> - **W-7 ✅** run/session state externalized via `beamRunStore.ts` (Redis-backed when
>   `isRedisConfigured()`, in-memory single-replica fallback).
> - **W-8 ✅** answer-consistency gates landed in PR #611 (`answerQualityGates.ts`,
>   mission-state constraints).
> - **W-9 ✅** `CommentThread.tsx` builds a nested tree from `parentCommentId`
>   (`buildCommentTree`) with per-node reply.
> - **W-10 ✅** `pwa/PushPrompt.tsx` consent banner calls `subscribeToPush(authToken)`.
> - **W-11 ⏸ still deferred by design** — `conversations`/`messages` remain
>   off-runtime-schema and tenant-unscoped; the card only applies **if** persistence
>   is built. Nothing to do until then.
> - **W-12 ✅** producer (`routes/fragrances.ts` → `enqueueEnrichmentJob`) and worker
>   (`index.ts` → `startEnrichmentWorker`) are wired, each behind an env flag
>   defaulting OFF (`ENRICHMENT_QUEUE_ENABLED` / `ENRICHMENT_WORKER_ENABLED`).
> - **W-13 ✅** search-query-level in-flight dedup (`inFlightBySearchQuery`,
>   `imagePipeline.ts`).
> - **W-14 ✅** the stale "built, not mounted" claims are gone from the beam-agent docs.
>
> The table below is kept for historical context — do not re-open completed cards.

| ID | Title | Type | Priority | Subagent | Primary file(s) |
|---|---|---|---|---|---|
| W-1 | PWA install banner doesn't follow hidden nav | 🟢 FIX (1-line) | High | optional | `components/pwa/InstallPrompt.tsx` |
| W-2 | Brand-acronym search aliases (tf, jpg, pdm…) | 🟢 FIX (additive) | Medium | optional | `lib/fragranceApi.ts` |
| W-3 | One-tap mobile search-add | 🟢 FIX | Medium | **REQUIRED** | `components/FragranceCapture.tsx` |
| W-4 | Image-proxy shared-CDN cache headers (`s-maxage`) | 🔵 ENHANCE | Medium | optional | `services/imageProxyCache.ts` |
| W-5 | Beam Agent: per-user quota cap | 🔵 ENHANCE | High (cost) | optional | `beam-agent/beamAgentRoutes.ts` |
| W-6 | Beam Agent: verify SSE through Vercel edge proxy | 🟠 VERIFY (infra) | High | optional | `middleware.js`, `beam-agent/beamAgentRoutes.ts` |
| W-7 | Beam Agent: externalize run/session state (multi-instance) | 🟣 FEATURE | High (scale) | **REQUIRED** | `beam-agent/beamAgentRoutes.ts` |
| W-8 | Beam Agent answer consistency: "Top match" vs final pick / hallucinated location | 🔵 ENHANCE (quality) | Medium | optional | `beam-agent/beamAgentLoop.ts` |
| W-9 | Threaded comments (nest by `parentCommentId`) | 🟣 FEATURE | Medium | **REQUIRED** | `components/community/CommentThread.tsx` |
| W-10 | Web-push consent banner | 🟣 FEATURE | Medium | optional | `components/pwa/` + `lib/pushNotifications.ts` |
| W-11 | Conversations/messages tenant-scoping (then persist) | 🟣 FEATURE | Low | **REQUIRED** | `lib/db/src/schema/{conversations,messages}.ts` |
| W-12 | Enrichment queue producer + worker | 🟣 FEATURE | Low | **REQUIRED** | `services/enrichmentQueue.ts` |
| W-13 | Deferred-image build race (search-query-level dedup) | 🔵 ENHANCE (cost) | Low | optional | `services/imagePipeline.ts` |
| W-14 | Doc drift: "agent not mounted" stale claims | 🟢 FIX (docs) | Low | no | `docs/beam-agent/01-current-state.md`, `…/07-experience-improvement-audit.md` |

**Do NOT touch (verified correct / fixing regresses):** nav-bar idle-hide (`AppTopNav.tsx`),
deferred-image placeholder+polling (`WardrobeContext.tsx`), arena battles (`arena/*`), beam-agent
"is dark" claims (it is fully wired end-to-end). See `SCENTBEAM_REMEDIATION_PLAN.md` §Group C for why.

**Suggested order:** W-1 → W-2 → W-4 → W-3 → W-14 → W-5 → W-6 → W-8 → W-9/W-10 → W-7 → W-11/W-12/W-13.

---

## 2. Cards

### W-1 · PWA install banner doesn't ride down with hidden nav 🟢
- **Skills:** `optimize-layout-for-device-class`, `repo-map`
- **What/why:** `components/pwa/InstallPrompt.tsx` pins to the **static**
  `bottom-[calc(var(--bottomnav-h,0px)+0.5rem)]`, so when the nav hides on scroll the banner
  leaves a gap instead of following. The dynamic var `--mobile-nav-offset` (authored only in
  `components/AppTopNav.tsx`, default in `index.css`) is what `FragranceCapture.tsx` already uses.
- **Change:** swap to `bottom-[calc(var(--mobile-nav-offset,var(--bottomnav-h))+0.5rem)]`. Phone-only
  (`md:bottom-4` already guards desktop).
- **Verify:** typecheck → SPA on a phone viewport → scroll to hide nav, banner descends; scroll up, returns.
- Full card: `SCENTBEAM_REMEDIATION_PLAN.md#f-12`.

### W-2 · Brand-acronym search aliases 🟢
- **Skills:** `cross-service-contract`, `repo-map`
- **What/why:** `lib/fragranceApi.ts` has `SEARCH_QUERY_BRAND_ALIASES` (`mfk`, `ysl`) consumed by
  `expandKnownSearchBrandAlias` — a **client-side query rewrite** before `GET /api/fragrances/search`.
  No response-shape change, so no engine coupling.
- **Change:** add lowercase/normalized tuples: `["tf","Tom Ford"]`, `["jpg","Jean Paul Gaultier"]`,
  `["pdm","Parfums de Marly"]`, `["eldo","Etat Libre d'Orange"]`, `["adp","Acqua di Parma"]`. Keep
  aliases brand-distinctive (2-3 letter aliases can collide with real tokens — note any risky one).
- **Verify:** typecheck → search each acronym, confirm it resolves to the expected house.
- Full card: `SCENTBEAM_REMEDIATION_PLAN.md#f-13`.

### W-3 · One-tap mobile search-add 🟢 (Subagent REQUIRED)
- **Skills:** `fix-playbooks`, `isolate-touch-interaction-gestures`, `optimize-layout-for-device-class`
- **What/why:** in `components/FragranceCapture.tsx` the result button first tap only **selects**;
  commit needs a second tap on the distant mobile action bar. Add a one-tap add affordance on the
  result card itself, but **route all commits through `handlePrimaryAction` → `handleConfirm()`**
  (the single commit path that surfaces `setErrorStatus` and keeps the Express-fallback detail fetch).
- **Gotchas:** do not bypass `handleConfirm` (it owns the "Couldn't find fragrance" error + fallback,
  see `fix-playbooks` Playbook A); apply tap-vs-scroll isolation so a scroll-momentum tap doesn't
  auto-add; preserve `aria-pressed`, the in-vault badge, and the "already in vault → View in vault" branch.
- **Verify:** typecheck → SPA on iPhone/iPhone-SE → one-tap add works, scroll never auto-adds, a
  transient detail-fetch failure still shows the error and falls back.
- Full card: `SCENTBEAM_REMEDIATION_PLAN.md#f-15`.

### W-4 · Image-proxy shared-CDN cache headers 🔵
- **Skills:** `repo-map`, `token-efficient-navigation`
- **What/why:** the proxy already sets `Cache-Control` from the single source of truth
  `services/imageProxyCache.ts` (`cacheControlForImageTarget`) — immutable tier
  `public, max-age=31536000, immutable`, mutable tier `…max-age=86400, stale-while-revalidate=86400`
  — but **no `s-maxage`/`cdn-cache-control`**, so shared-CDN caching isn't opted into.
- **Change:** add `s-maxage` (match each tier's `max-age`) in `cacheControlForImageTarget` **only**.
  Do not edit the route, and do not touch `middleware.js`'s `private, no-store` default (deliberate
  safety net for non-image API responses; image responses carry no `Set-Cookie` so they pass through).
- **Verify:** typecheck → build api-server → `curl -I` the proxy route, confirm directives on both tiers, no `Set-Cookie`.
- Full card: `SCENTBEAM_REMEDIATION_PLAN.md#b-24`.

### W-5 · Beam Agent — per-user quota cap 🔵
- **Skills:** `db-schema-safety` (if you add a ledger table), `repo-map`
- **What/why:** the synthesis turn adds one extra model call per tool-using run. Today there is only a
  per-**IP** in-memory rate limit (20 / 5 min, `beam-agent/beamAgentRoutes.ts`); token usage **is**
  recorded per run, but there is **no per-user cap and no daily spend metric**. This is the guardrail
  against a runaway loop or abusive user becoming a billing event.
- **Change:** add a per-user (not just per-IP) cap and a daily spend metric off the already-captured
  `usage`. `apiUsageLedger` is already a live schema table — prefer it over a new table.
- **Verify:** typecheck → api-server tests → exercise the cap path. Ref: prod-readiness P1-2.

### W-6 · Beam Agent — verify SSE through the Vercel edge proxy 🟠 (infra/staging)
- **What/why:** prod proxies `/api/*` through `middleware.js` (`return new Response(upstream.body…)`).
  Express sets `X-Accel-Buffering: no` + `no-transform`, but Edge-runtime buffering can defeat
  long-lived SSE, turning "live preview" into "frozen then dumps at end." **Unverified in staging.**
- **Action:** test SSE end-to-end through a real Vercel→Railway deploy. If buffered, either hit the
  Railway origin directly for `GET /runs/:id/events` or accept the non-stream `completed` fallback
  (which already works). Ref: prod-readiness P0-3. Heartbeat (P0-4) is already in place.

### W-7 · Beam Agent — externalize run/session state 🟣 (Subagent REQUIRED)
- **Skills:** `db-schema-safety`, `repo-map`
- **What/why:** `runs` and `sessions` are module-level `Map`s in `beam-agent/beamAgentRoutes.ts`. The
  flow is two HTTP calls (`POST /runs` then `GET /runs/:id/events`); on >1 Railway instance (or a
  redeploy mid-conversation) the events request can land on an instance that never saw the run → **404,
  nondeterministically.** Interim: enforce single instance / sticky sessions at the proxy **and say so**.
  Real fix (Phase 5): move run+session state to Postgres or Redis.
- **DB-safety:** new tables hit the **shared prod Supabase** as soon as the `./src/schema/*.ts` glob
  sees them — confirm names are inside `tablesFilter` before any push, and create them tenant-scoped on
  the first cut. Ref: prod-readiness P0-2.

### W-8 · Beam Agent — answer consistency & context honesty 🔵 (quality)
- **Skills:** `repo-map`, `token-efficient-navigation`
- **What/why:** carried from the 2026-06-15 UI review (items #6/#7). The reasoning trail can show
  `Top match · Gabrielle` while the final synthesized answer recommends a different bottle ("Sauvage
  Elixir"), and the prose can assert context the user never gave ("cool London evenings" for a bare
  "Night out"). Both originate in the agent loop's synthesis, **not** the SPA renderer (the renderer
  fix in `06847e5` only addressed spacing/"unknown family"). Investigate `beam-agent/beamAgentLoop.ts`
  (synthesis prompt + how the scored top-match is or isn't passed into synthesis) and the weather/
  context inputs. Aim: the headline pick should match the scored top match, or the prose should
  explain the override; don't assert location/weather context that wasn't supplied.
- **Verify:** api-server tests + a manual mission run. Treat as quality hardening; do not regress the
  dual-engine fallback (`beam-agent-dual-engine` memory).

### W-9 · Threaded comments 🟣 (Subagent REQUIRED)
- **Skills:** `unify-card-layouts-and-grids`, `optimize-layout-for-device-class`, `cross-service-contract`
- **What/why:** `components/community/CommentThread.tsx` renders a flat `comments.map(...)`. The
  nesting column already exists: `lib/db/src/schema/communityComments.ts` `parentCommentId` (live,
  re-exported). **No schema change** — build the tree at the `.map`. The API list/detail payload must
  expose `parentCommentId` per comment (cross-service step — confirm it does).
- **Device gotcha:** deep indentation overflows 320px fast — **cap nesting depth** or use a flattened
  "reply to @x" style. Keep per-node reactions (`ReactionBar`).
- Full card: `SCENTBEAM_REMEDIATION_PLAN.md#p-32`.

### W-10 · Web-push consent banner 🟣
- **Skills:** `optimize-layout-for-device-class`, `optimize-webkit-rendering-budget`
- **What/why:** client lib (`lib/pushNotifications.ts`) and backend (`services/pushService.ts`,
  `routes/push.ts`, live `pushSubscriptions` schema) are **complete**; the only opt-in is a settings
  toggle (`ProfileSettingsModal.tsx handleTogglePush`). Add a consent banner calling
  `subscribeToPush(authToken)`, reusing the `pwa/InstallPrompt.tsx` pattern.
- **Gotchas:** gate on `getPushSupport` (iOS Safari only supports web push for **installed** PWAs);
  signed-in users only; **must not visually stack with InstallPrompt** (same bottom slot, `z-[100]`) —
  reuse W-1's `--mobile-nav-offset` positioning and decide which banner wins. Auto-send triggers are
  separate backend work, out of scope. Full card: `SCENTBEAM_REMEDIATION_PLAN.md#p-34`.

### W-11 · Conversations/messages tenant-scoping 🟣 (Subagent REQUIRED — security-sensitive)
- **Skills:** `db-schema-safety`
- **What/why:** `conversations`/`messages` are the **only two** off-runtime schema files (not
  re-exported in `lib/db/src/schema/index.ts`) and have **no `userId`/`tenantId`**.
  `services/scentMissionService.ts` documents the deliberate deferral. Wiring persistence as-is =
  cross-tenant read/write of chat threads. **Only if building persistence:** add `tenantId`/`userId`
  FKs (+ indexes) from the start (mirror `pushSubscriptions.ts`), re-export, then wire
  `/api/scent-mission`. Confirm both names are in `tablesFilter` before any push (shared prod DB).
- Full card: `SCENTBEAM_REMEDIATION_PLAN.md#b-21`.

### W-12 · Enrichment queue producer + worker 🟣 (Subagent REQUIRED)
- **Skills:** `cross-service-contract`, `db-schema-safety`
- **What/why:** `services/enrichmentQueue.ts` is Pass-1 scaffolding — `enqueueEnrichmentJob` has **no
  producer**, there is **no consumer/worker** (no `claimNextJob`/`FOR UPDATE SKIP LOCKED`), and the only
  background task (`startEnrichmentFailedJobRetrySweeper`) just reopens stale failed jobs. `enrichmentJobs`
  is already live. A producer should fire off the engine's `source_coverage` incomplete signal
  (`fragranceApi.ts:isSourceCoverageComplete`) — read the contract; the service header warns "do not
  invent that signal here." A worker's `UPDATE … status` **must not race the existing sweeper's
  `setInterval`** (both mutate `status`). NOTE: this is the *web-app's own* queue and is **separate**
  from the Python engine's `enrichment_jobs` worker (see the engine handoff) — don't conflate them.
- Full card: `SCENTBEAM_REMEDIATION_PLAN.md#b-22`.

### W-13 · Deferred-image build race 🔵 (cost, not correctness)
- **Skills:** `repo-map`, `token-efficient-navigation`
- **What/why:** `services/scentEngineCore.ts buildProfileWithDeps` fires `void resolveImageNow()` for
  deferred images; the in-flight dedup (`imagePipeline.ts inFlightBySource`) only kicks in **after**
  Serper resolves a candidate URL, so two concurrent first-time requests both call Serper before
  converging. Writes are idempotent → not a correctness bug. **If addressed:** add a search-query-level
  in-flight `Map` keyed on `searchQueryHash:removeBackground` at `resolveProcessedFragranceImage` entry,
  mirroring `inFlightBySource`. **Do NOT** await the deferred promise in `scentEngineCore` (that re-blocks
  the request "deferred" exists to unblock). Full card: `SCENTBEAM_REMEDIATION_PLAN.md#b-23`.

### W-14 · Doc drift 🟢
- One-line status corrections: `docs/beam-agent/01-current-state.md` and `…/07-experience-improvement-audit.md`
  still say the Claude loop is "built, not mounted." It **is** mounted (`api-server/src/app.ts` calls
  `mountBeamAgent(app)`). Fix so the next reader isn't misled. Ref: prod-readiness P2-4.

---

## 3. Cross-service note (don't break the boundary)
Anything touching search/detail responses must keep both sides of the `source_coverage` contract
aligned (`cross-service-contract`): a detail is "complete" only when
`basenotes && fragrantica && (complete || derived_metrics ∈ {complete,completed,full})`. The engine's
own recommendation is that the SPA **gate "save"/treat-as-complete on `source_coverage.complete`** —
confirm `fragranceApi.ts:isSourceCoverageComplete` (and its callers) still enforce that before changing
anything nearby. The engine-side family/concentration backfill is tracked in
`search_engine/HANDOFF_NEXT_PASS_ENGINE.md`.
