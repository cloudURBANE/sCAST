# ScentBeam Remediation Plan — Verified & Sequenced

> **Companion to:** `scentbeam_ux_architecture_report.md` (the raw audit).
> **This file supersedes that report** for any implementation decision. Every claim
> below has been **ground-truthed against the live code** by two verification
> subagents (frontend surface + backend/DB surface). Where the audit drifted, the
> corrected file:line and behavior are recorded here. **Trust this document's
> file:line over the original report's.**
>
> **Branch context:** `fix/scentcast-search-ux-hardening` · **Verified:** 2026-06-15
> **Canonical tree only:** edit under `huge_monorepo/`. Never touch `.deploy-*`, `scb_fix2/`, `scb_proxy_fix/` (deploy mirrors).

---

## 0. How to use this document (read first — non-negotiable protocol)

You are the **implementing engineer**. You are looking at the live code; this plan is
your map, **not** a substitute for reading the file before you edit it. The plan tells
you *where to look* and *what was verified*; you are expected to do **fine-tuned rework
in the moment** — adapt the exact edit to the code as it actually reads under your
cursor, match surrounding style, and improve the immediate neighborhood when it makes
the change cleaner. Do not paste blindly.

**Mandatory working rules:**

1. **Load the named skills before each task.** Every issue card lists `Skills to load`.
   Invoke them with the Skill tool *before* you open the target file — they encode this
   codebase's traps (gesture isolation, webkit budget, device-class layout, the
   shared-prod-DB guard, the cross-service contract). Skipping them is how regressions
   get shipped here.
2. **You must use a subagent.** For any card marked `Subagent: REQUIRED`, dispatch a
   verification or implementation subagent (general-purpose or Explore) to re-confirm
   the file:line against the *current* working tree before you edit, and to sanity-check
   your diff for ripple effects. Line numbers in this doc were accurate at verification
   time but **will drift as you edit** — re-anchor on the symbol, not the number.
3. **Verify before claiming done.** Run the `verify-without-regression` gate
   (typecheck → build → targeted check → visual/behavior pass) listed on each card.
   Do not report a fix as complete on an unverified change.
4. **Re-anchor on symbols, not line numbers.** Grep for the named symbol/string first
   (`token-efficient-navigation`), then read only that slice. Never read the giant
   token-trap files whole.
5. **Respect the verdicts.** A `LEAVE ALONE` card explains *why* the audit was wrong and
   what breaks if you "fix" it anyway. Honor it. If you believe the verdict is wrong,
   re-verify with a subagent and report back — do not silently override.

**Status vocabulary used below:**

| Verdict | Meaning | Your action |
|---|---|---|
| 🟢 `FIX` | Real issue, well-scoped change | Implement per the card |
| 🔵 `ENHANCE` | Mostly built; a small, safe addition remains | Implement only the delta |
| 🟣 `FEATURE` | Net-new product work on top of working plumbing | Implement only if in scope this pass |
| 🔴 `LEAVE ALONE` | Audit was stale/wrong; code is correct or "fixing" regresses | **Do not edit.** Read the why. |

---

## 1. Master Index

| ID | Title | Verdict | Priority | Primary file(s) |
|---|---|---|---|---|
| [F-1.1](#f-11--nav-bar-idle-hide-double-tap) | Nav bar idle-hide double-tap | 🔴 LEAVE ALONE | — | `AppTopNav.tsx` |
| [F-1.2](#f-12--pwa-install-banner-offset) | PWA install banner offset | 🟢 FIX | High (1-line) | `pwa/InstallPrompt.tsx` |
| [F-1.3](#f-13--brand-acronym-search-aliases) | Brand acronym search aliases | 🟢 FIX | Medium | `lib/fragranceApi.ts` |
| [F-1.4](#f-14--deferred-image-placeholder--polling) | Deferred image placeholder/polling | 🔴 LEAVE ALONE | — | `context/WardrobeContext.tsx` |
| [F-1.5](#f-15--one-tap-mobile-search-add) | One-tap mobile search-add | 🟢 FIX | Medium | `components/FragranceCapture.tsx` |
| [B-2.1](#b-21--conversationsmessages-tenant-scoping) | Conversations/messages tenant-scoping | 🟣 FEATURE | Low | `lib/db/src/schema/{conversations,messages}.ts` |
| [B-2.2](#b-22--enrichment-queue-producerworker) | Enrichment queue producer/worker | 🟣 FEATURE | Low | `services/enrichmentQueue.ts` |
| [B-2.3](#b-23--deferred-image-build-race) | Deferred-image build race | 🔵 ENHANCE | Low (cost) | `services/imagePipeline.ts` |
| [B-2.4](#b-24--edge-cache-headers-for-image-proxy) | Edge cache headers for image proxy | 🔵 ENHANCE | Medium | `services/imageProxyCache.ts` |
| [P-3.1](#p-31--arena-battles) | Arena battles | 🔴 LEAVE ALONE | — | `arena/*` |
| [P-3.2](#p-32--threaded-comments) | Threaded comments | 🟣 FEATURE | Medium | `community/CommentThread.tsx` |
| [P-3.3](#p-33--beam-agent-frontend-exposure) | Beam-agent frontend exposure | 🔴 LEAVE ALONE | — | `beam-agent/*` |
| [P-3.4](#p-34--web-push-consent-banner) | Web push consent banner | 🟣 FEATURE | Medium | `pwa/` + `lib/pushNotifications.ts` |

**At-a-glance:** Genuinely actionable now → **F-1.2, F-1.3, F-1.5, B-2.4**. Optional features → **P-3.2, P-3.4, B-2.1, B-2.2, B-2.3**. Do-not-touch → **F-1.1, F-1.4, P-3.1, P-3.3**.

---

## 2. Verified reality you must internalize before editing

These facts override stale assumptions in the original report and in `CLAUDE.md`:

- **`lib/db/src/schema/index.ts` now re-exports 18 tables**, not the subset documented in
  `CLAUDE.md`. It includes `tenants`, `pushSubscriptions`, `enrichmentJobs`,
  `apiUsageLedger`, `researchCache`, `fragranceReviewSummaries`, and 6 `community*`
  tables. **Only `conversations` and `messages` remain off-runtime.** When reasoning about
  what `drizzle push` will touch, trust `index.ts`, not the doc.
- **The DB is a SHARED prod Supabase** holding another app's tables. `drizzle push` is
  scoped by `tablesFilter` in `drizzle.config.ts`, and the glob `./src/schema/*.ts` means
  push picks up a schema file **even before** it's re-exported from `index.ts`. Any
  new/altered table must be inside `tablesFilter` before you push. (Skill: `db-schema-safety`.)
- **The beam agent is fully wired end-to-end** (SSE route live, frontend consumes it). The
  audit's "agent is dark / no SSE route" premise is **factually wrong** — see [P-3.3](#p-33--beam-agent-frontend-exposure).
- **The cross-service `source_coverage` contract is load-bearing.** Anything touching
  search/detail responses must keep both sides aligned (Skill: `cross-service-contract`).

---

## 3. Issue cards

Cards are grouped by verdict so you act on the real work first and don't waste a pass on
already-solved items.

### Group A — Actionable now (🟢 FIX / 🔵 ENHANCE)

---

#### F-1.2 · PWA install banner offset
**Verdict: 🟢 FIX (one-line)** · **Subagent: optional** · **Skills to load:** `optimize-layout-for-device-class`, `repo-map`

**Ground truth (verified):**
- The dynamic nav offset var is `--mobile-nav-offset`, **set only** in
  `artifacts/scent-cast/src/components/AppTopNav.tsx:178-183` (toggles between
  `var(--bottomnav-h)` and `0px` on `navVisible`).
- Static default lives in `artifacts/scent-cast/src/index.css:55-56`.
- The **correct consumption pattern already in use** is
  `artifacts/scent-cast/src/components/FragranceCapture.tsx:1119` →
  `bottom-[calc(var(--mobile-nav-offset,var(--bottomnav-h))+0.4rem)]`.
- The bug: `artifacts/scent-cast/src/components/pwa/InstallPrompt.tsx:113` pins to the
  **static** `bottom-[calc(var(--bottomnav-h,0px)+0.5rem)]`, so the banner does **not**
  ride down when the nav hides on scroll — it leaves a gap. (The report's "detaches /
  floats above empty space" framing is inverted; it *fails to follow*.)

**Change:** Swap the InstallPrompt offset to the dynamic var, matching FragranceCapture:
`bottom-[calc(var(--mobile-nav-offset,var(--bottomnav-h))+0.5rem)]`.

**Alignment / ripple:** `--mobile-nav-offset` is authored in exactly one place
(`AppTopNav.tsx:180`); the `var(…,fallback)` form already covers the case where AppTopNav
is unmounted. Banner has `md:bottom-4`, so the change only affects the phone class.

**Fine-tune in the moment:** Confirm the trailing `+0.5rem` reads sensibly next to
FragranceCapture's `+0.4rem`; align spacing if the two stack visually.

**Verify:** typecheck → run SPA → on a phone viewport, scroll down to hide nav and confirm
the banner descends with it; scroll up and confirm it returns.

---

#### F-1.3 · Brand acronym search aliases
**Verdict: 🟢 FIX (additive)** · **Subagent: optional** · **Skills to load:** `cross-service-contract`, `repo-map`

**Ground truth (verified):**
- `artifacts/scent-cast/src/lib/fragranceApi.ts:5-8` defines
  `SEARCH_QUERY_BRAND_ALIASES: ReadonlyArray<readonly [string, string]>` with `mfk` / `ysl`.
- Consumed at `:1102-1117` (`expandKnownSearchBrandAlias`): query is normalized
  (lowercase, strip accents/punctuation), tokenized, and the alias is matched as a
  **prefix** of the token list, then the full brand is prepended to the remainder.
  Multi-word aliases work (`alias.split(" ")`).

**Change:** Add lowercase, normalized tuples at `:6-7`:
`["tf","Tom Ford"]`, `["jpg","Jean Paul Gaultier"]`, `["pdm","Parfums de Marly"]`,
`["eldo","Etat Libre d'Orange"]`, `["adp","Acqua di Parma"]`, `["atg","Aaron Terence Hughes"]`.

**Contract safety:** This is a **client-side query rewrite** before
`GET /api/fragrances/search?q=…`. It does **not** change request/response shape — the
Python engine just receives an expanded `q`. No engine-side change. (Verified against
`cross-service-contract`.)

**Fine-tune in the moment:** Keep aliases brand-distinctive. The only risk is a 2-3 letter
alias colliding with a real fragrance token and mis-expanding — if any new alias looks
collision-prone, note it inline and prefer the safer expansion.

**Verify:** typecheck → run SPA → search each new acronym, confirm results resolve to the
expected house.

---

#### F-1.5 · One-tap mobile search-add
**Verdict: 🟢 FIX** · **Subagent: REQUIRED** · **Skills to load:** `fix-playbooks`, `isolate-touch-interaction-gestures`, `optimize-layout-for-device-class`

**Ground truth (verified) — `artifacts/scent-cast/src/components/FragranceCapture.tsx`:**
- Result button `:1398-1439`; `onClick={() => setSelectedId(key)}` at `:1401` — **first tap
  only selects.**
- Desktop CTA `:1463-1472` → `handlePrimaryAction`. Mobile fixed action bar `:1112-1140`
  (portaled to escape the panel's `overflow:hidden`, comment `:1446-1449`), rendered via
  `AnimatePresence` `:1523`, `disabled={!hasSelectedMatch}` `:1135`.
- Commit path: `handlePrimaryAction` (`:506-511`) → `handleConfirm()` (`:628`).
- So mobile = two taps (select, then tap the distant add bar). Claim **CONFIRMED.**

**Change (design intent):** Add a one-tap add affordance **on the result card itself**
(`:1398-1439`) — e.g. a "+" overlay, or make a second tap on an already-selected card
commit. Route any new commit through `handlePrimaryAction` → keep `handleConfirm` (`:628`)
as the **single commit path**.

**Critical gotchas (do not skip):**
- **`fix-playbooks` Playbook A:** `handleConfirm` triggers the secondary detail fetch that
  can transiently fail with "Couldn't find fragrance." A one-tap add **must** still surface
  `setErrorStatus` and keep the Express-fallback path in
  `fragranceApi.ts:getFragranceDetails` intact. **Do not bypass `handleConfirm`.**
- **Gesture isolation:** the result list is a vertical grid (`:1392`) inside a scrollable
  panel. A tap-to-add must not fire on scroll-momentum taps — apply the tap-vs-scroll
  isolation pattern from `isolate-touch-interaction-gestures`, or keep select-then-commit
  but move the commit affordance onto the card.
- Preserve the existing `aria-pressed`/`is-selected` state (`:1402-1405`), the in-vault
  badge (`:1407-1412`), and the "already in vault → View in vault" branch (`:1470`).

**Subagent task:** Re-confirm the line anchors above against the current file, and review
your diff specifically for (a) error surfacing parity with the two-tap path and (b) no
accidental commit-on-scroll.

**Verify:** typecheck → run SPA on iPhone/iPhone-SE viewport → add a fragrance with one tap;
confirm scroll does not auto-add; confirm a transient detail-fetch failure still shows the
error and the fallback still works.

---

#### B-2.4 · Edge cache headers for image proxy
**Verdict: 🔵 ENHANCE (largely already done)** · **Subagent: optional** · **Skills to load:** `repo-map`, `token-efficient-navigation`

**Ground truth (verified):**
- The proxy **already sets Cache-Control**: `artifacts/api-server/src/routes/imageProxy.ts:103`
  via `cacheControlForImageTarget(target)` (`:55`), plus in-memory cache + in-flight dedup
  (`imageProxyCache.getOrLoad`, `:76`).
- Single source of truth for the header values:
  `artifacts/api-server/src/services/imageProxyCache.ts:325-328` — immutable targets
  (`/images/processed/` or `?v=`) → `public, max-age=31536000, immutable`; else →
  `public, max-age=86400, stale-while-revalidate=86400`. **No `s-maxage`/`cdn-cache-control`**,
  so shared-CDN caching isn't explicitly opted into.
- `middleware.js` does **not** strip these for image proxy: image responses carry no
  Set-Cookie, so they survive `applyApiCacheSafetyHeaders` (`middleware.js:59-70`, called
  `:130`) unmodified. (The cookie branch *would* strip `cdn-cache-control` — but it doesn't
  apply here.)

**Change:** Add `s-maxage` (and optionally `cdn-cache-control`) **in
`cacheControlForImageTarget` (`imageProxyCache.ts:325`)** — the single source of truth.
Do **not** edit the route, and **do not** touch the middleware's `private, no-store`
default (it's a deliberate safety net for non-image API responses).

**Fine-tune in the moment:** Match `s-maxage` to the existing `max-age` per target tier
(immutable → 31536000; mutable → 86400). Keep `stale-while-revalidate` on the mutable tier.

**Verify:** typecheck → build api-server → `curl -I` the proxy route locally and confirm the
new shared-cache directives appear on both target tiers; confirm no `Set-Cookie` on the
response.

---

### Group B — Optional features on working plumbing (🟣 FEATURE)

> Implement these only if they're in scope for this pass. The plumbing is real and these
> are net-new work, not bug fixes. Each notes its DB-safety constraints.

---

#### P-3.2 · Threaded comments
**Verdict: 🟣 FEATURE** · **Subagent: REQUIRED** · **Skills to load:** `unify-card-layouts-and-grids`, `optimize-layout-for-device-class`, `cross-service-contract`

**Ground truth (verified) — corrects the report's path:**
- Flat render confirmed: `artifacts/scent-cast/src/components/community/CommentThread.tsx:84-124`
  — a single `comments.map(...)` rendering each comment as a top-level `<article>`. Grep for
  `parentCommentId|reply|nested|depth` in that file → **zero matches.**
- Nesting column lives in **`lib/db/src/schema/communityComments.ts:16`**
  (`parentCommentId: uuid("parent_comment_id")`) — **NOT** in `communityPosts.ts:61` as the
  report claimed. Schema is already live (re-exported).
- Per-comment reactions already attach (`ReactionBar`, `:110-118`).

**Change:** Group comments by `parentCommentId` and render nested, hooking the tree build at
the `.map` (`:85`). The **API response must include `parentCommentId` per comment** for the
SPA to build the tree — confirm the detail/list payload exposes it (cross-service step).

**Device gotcha:** Deep indentation overflows a 320px iPhone SE fast — **cap nesting depth**
or use a flattened "reply to @x" style instead of deep indentation. Keep reactions per-node.

**DB-safety:** No schema change (`parentCommentId` already exists). Work is FE + payload wiring.

**Verify:** typecheck → run SPA → post nested replies; confirm tree renders and does not
overflow at 320px.

---

#### P-3.4 · Web push consent banner
**Verdict: 🟣 FEATURE (plumbing complete; only a banner is missing)** · **Subagent: optional** · **Skills to load:** `optimize-layout-for-device-class`, `optimize-webkit-rendering-budget`

**Ground truth (verified):**
- **Client lib complete:** `artifacts/scent-cast/src/lib/pushNotifications.ts`
  (`getPushSupport` `:17-22`, `subscribeToPush` calling `Notification.requestPermission()`
  `:63` + `pushManager.subscribe` `:71`, plus unsubscribe). Talks to
  `/api/push/public-key|subscribe|unsubscribe`.
- **Backend complete:** `artifacts/api-server/src/services/pushService.ts`
  (`saveSubscription`, `sendPushToUser`, `sendPushToAll`, VAPID config, dead-endpoint
  pruning). End-user route `routes/push.ts` is **opt-in only** (no send). Admin broadcast is
  secret-gated (`routes/admin.ts:80`). Schema `pushSubscriptions.ts` is tenant+user scoped
  and live.
- **The only opt-in today is a settings toggle**, not a banner:
  `ProfileSettingsModal.tsx:166-189` (`handleTogglePush`). **No consent banner exists**
  anywhere.

**Change:** Add a consent banner that calls `subscribeToPush(authToken)` (mirroring
`ProfileSettingsModal.tsx:176`). Reuse the `pwa/InstallPrompt.tsx` banner pattern.

**Gotchas:**
- Gate on `getPushSupport` (`:17-21`) — hide on unsupported browsers (iOS Safari only
  supports web push for **installed** PWAs).
- Show only to signed-in users (`subscribeToPush` requires `authToken`).
- **Must not visually stack with `InstallPrompt.tsx`** — both target the same
  bottom-of-viewport phone slot at `z-[100]`. Reuse the `--mobile-nav-offset` positioning
  from [F-1.2](#f-12--pwa-install-banner-offset) and coordinate which banner wins.

**Auto-trigger note:** "Send a push when X happens" (weather change, comment, enrichment
done) is **separate, additive backend work** — call `sendPushToUser`; no schema change.
Out of scope unless explicitly requested.

**Verify:** typecheck → run SPA → confirm banner appears only for signed-in, supported,
not-yet-subscribed users; confirm it doesn't overlap the install prompt.

---

#### B-2.1 · Conversations/messages tenant-scoping
**Verdict: 🟣 FEATURE (intentional deferral — security-sensitive)** · **Subagent: REQUIRED** · **Skills to load:** `db-schema-safety`

**Ground truth (verified):**
- `conversations`/`messages` are **NOT** re-exported in `lib/db/src/schema/index.ts` (the
  only two tables still off-runtime). `conversations.ts:5-9` = `id,title,createdAt`;
  `messages.ts:7-15` = `id,conversationId,role,content,createdAt`. **No `userId`/`tenantId`.**
- `services/scentMissionService.ts:30-33` documents the deliberate deferral verbatim:
  persistence is off because the tables aren't tenant/user-scoped.
- **Security hazard CONFIRMED:** wiring as-is = cross-tenant read/write of chat threads.

**Change (only if building persistence):** Add `tenantId uuid` FK → `tenants.id` and
`userId uuid` FK → `users.id` (+ indexes) **from the start** — mirror `pushSubscriptions.ts:22-25`.
Then re-export in `index.ts` and wire `/api/scent-mission` to persist.

**DB-safety (critical):** The schema glob `./src/schema/*.ts` means `drizzle push` will try
to create these on the **shared prod Supabase** as soon as they're valid — **confirm both
table names are inside `tablesFilter`** before any push. Create them tenant-scoped on the
first cut (a later add is a drop+add under push).

**Verify:** typecheck → build → (local DB only) push and confirm scoping; never push to prod
without the shared-DB guard (`db-schema-safety`).

---

#### B-2.2 · Enrichment queue producer/worker
**Verdict: 🟣 FEATURE (intentional Pass-1 scaffolding)** · **Subagent: REQUIRED** · **Skills to load:** `cross-service-contract`, `db-schema-safety`

**Ground truth (verified):**
- Schema `enrichmentJobs.ts` is **live/re-exported** (`index.ts:9`), keyed on `fg_url`/job_key,
  **not** user-scoped (correct — it's a global catalog queue).
- `services/enrichmentQueue.ts:8-10` header: *"Pass 1 scope: foundation only… No production
  endpoint calls it automatically yet."* `enqueueEnrichmentJob` (`:242`) has **no producer**.
- **No consumer/worker** (`claimNextJob`/`FOR UPDATE SKIP LOCKED` does not exist). The only
  background task is `startEnrichmentFailedJobRetrySweeper` (`:156-167`) which **reopens
  stale failed jobs to pending — it does not process them.**
- `GET /api/enrichment/status` (`routes/enrichment.ts:19`) returns
  `{ status:"not_found", requested_count:0, message }` (`enrichmentQueue.ts:296-302`).

**Change (only if building):** A producer should call `enqueueEnrichmentJob` off the engine's
**`source_coverage` incomplete signal** (`fragranceApi.ts:isSourceCoverageComplete`). The
service header explicitly warns: *"do not invent that signal here"* — read the contract first.
A worker doing `UPDATE … status` is behaviorally additive; **ensure it doesn't compound with
the existing sweeper's `setInterval`** (both mutate `status`).

**DB-safety:** Table already live → no schema change for a producer/worker.

**Verify:** typecheck → build → enqueue/claim cycle against a local DB; confirm sweeper and
worker don't race the same row.

---

#### B-2.3 · Deferred-image build race
**Verdict: 🔵 ENHANCE (real but narrow; cost not correctness)** · **Subagent: optional** · **Skills to load:** `repo-map`, `token-efficient-navigation`

**Ground truth (verified):**
- `services/scentEngineCore.ts:378-409` (`buildProfileWithDeps`): when
  `imageResolution === "deferred" && !processedImage`, it fires `void resolveImageNow().then(…)`
  (`resolveImageNow` `:239-270`). Fire-and-forget confirmed.
- Downstream dedup `imagePipeline.ts:113` `inFlightBySource` is keyed on
  `${sourceUrlHash}:${removeBackground}` and only checked in `processCandidate` (`:356-358`)
  — i.e. **after** Serper has resolved a candidate URL.
- The query-level guard `getLatestReadyCachedImageBySearchQueryHash` (`imagePipeline.ts:481-487`)
  is a **DB read**, only hitting if a prior request already *completed and persisted*. So two
  genuinely concurrent first-time requests both miss it, both call
  `searchSerperImageCandidates` (`:493`), and only converge once they independently hash to the
  same source URL.
- **Verdict:** duplicated work = one extra Serper call + redundant downloads up to the join
  point; Poof/sharp/upload is already protected. Idempotent writes → **not a correctness bug.**

**Change (if addressed):** Add a **search-query-level in-flight Map** keyed on
`searchQueryHash:removeBackground` at the `resolveProcessedFragranceImage` entry
(`imagePipeline.ts:~481`), mirroring `inFlightBySource`. **Do NOT** await the deferred promise
in `scentEngineCore` — that re-blocks the request "deferred" mode exists to unblock.

**DB-safety:** None (`image_cache` writes already idempotent).

**Verify:** typecheck → build → fire concurrent first-time requests for the same new fragrance;
confirm a single Serper search.

---

### Group C — Do not touch (🔴 LEAVE ALONE)

> The audit was stale or wrong on these. Read the why; "fixing" them regresses working code.

---

#### F-1.1 · Nav bar idle-hide double-tap
**Verdict: 🔴 LEAVE ALONE — audit is STALE and inverted.**

The 1500ms idle-**hide** timer the report describes **no longer exists.** The current
`setTimeout` at `AppTopNav.tsx:208-211` is a **320ms settle-REVEAL** timer — it brings the bar
*back* when scrolling settles (`setNavVisible(true)`). The spec comment at `:155-164` documents
that the old idle-hide caused the double-tap bug and **was already removed.** There are also
`touchstart`/`pointerdown` reveal listeners (`:219-220`) and a route-change reveal (`:231-233`).

**If you follow the report and "remove the setTimeout," you re-break single-tap reachability.**
Do not edit. `navVisible` here drives `--mobile-nav-offset` (see F-1.2) — leave that intact.

---

#### F-1.4 · Deferred image placeholder & polling
**Verdict: 🔴 LEAVE ALONE — already built.**

The report's premise (bare 60s poll, no skeleton, no backoff) is outdated:
- `WardrobeContext.tsx`: global poll `REFRESH_MS = 60_000` (`:1021-1031`) — that part's true.
- **But** a decaying backfill burst already exists: `POLL_SCHEDULE_MS = [6000,12000,20000,32000,48000]`
  (`:858-901`) with a hard give-up at +4000ms (`:893-898`) that clears the syncing affordance,
  triggered on empty-`imageUrl` save via `scheduleImageBackfillRehydrate` (`:1101-1107`).
- **Per-card skeleton already exists:** `BottleImage.tsx:62,96,253` — `isSyncing` drives a bounded
  "Fetching" placeholder.

If anything, this is *tuning*, not building. **Read `:849-903` before any change** — the give-up
timer (`:893-898`) is the safety net against the old perpetual-spinner bug; don't remove it, and
respect the `authTokenRef.current !== token` abandon guard.

---

#### P-3.1 · Arena battles
**Verdict: 🔴 LEAVE ALONE — fully built.**

Vote-switch UI exists (`arena/ArenaBattleSide.tsx:64-87`, clickable switch + accent bar +
"Switch pick to…" aria-label). Skip-reasons persist to **both** localStorage **and** server
(`ArenaBattleStage.tsx:45-50,91-93,100-106`; reason synced via `voteMutation`). DB `reason`
field present (`communityVotes.ts:23`). Reason picker is `ArenaReasonPicker.tsx`. The feature the
report says to "realize" is already wired client+server. No action.

---

#### P-3.3 · Beam-agent frontend exposure
**Verdict: 🔴 LEAVE ALONE — audit is WRONG. Agent is fully wired end-to-end.**

The "backend-only / frontend still scripted / no SSE route" premise does not match code:
- **SSE route is LIVE:** `beam-agent/beamAgentRoutes.ts` mounts at `/api/beam-agent`
  (`:444-446`): `POST /runs` (`:256`) → `202 {runId,sessionId,eventsUrl}`;
  **`GET /runs/:id/events` (`:348`)** is a real `text/event-stream` with heartbeat + buffered
  replay; `POST /runs/:id/stop` (`:423`). (Path is `/api/beam-agent/runs/:id/events`, not the
  report's guessed `/api/runs/:id/events`.)
- `app.ts:8` imports + `:55` calls `mountBeamAgent(app)`; `:61-68` logs a provider canary.
- **Frontend consumes it (dual-engine):** `lib/beamAgentClient.ts:150,166` POSTs then opens SSE
  via `fetch` (native `EventSource` can't carry the bearer). `ScentMissionPanel.tsx`:
  `runAgentTurn` (`:1091`, live, auth-only) vs `runResolution` (`:1244`, scripted
  `/api/scent-mission`); dispatcher `:1402-1434` tries the **live agent first**, scripted is the
  **fallback** (guest, fast-mode, timeout, `model_unavailable`).

In-memory run state (`runs` Map, `:79`, 30-min TTL) with a single-replica pin is **intentional**
(Phase 5 moves it to Postgres per the header). **Any plan built on "agent is dark" is false** —
do not implement an SSE route or BeamAgentPanel "from scratch"; they exist. (Matches the
`beam-agent-dual-engine` project memory.)

---

## 4. Suggested execution order

1. **F-1.2** (1-line offset swap) — fastest win, unblocks correct positioning that **P-3.4** reuses.
2. **F-1.3** (alias entries) — additive, isolated.
3. **B-2.4** (edge cache headers) — single-source-of-truth change, no FE coupling.
4. **F-1.5** (one-tap add) — needs gesture/playbook care + subagent review.
5. **P-3.2 / P-3.4** (threaded comments / push banner) — features; do only if in scope. P-3.4 depends on F-1.2's positioning.
6. **B-2.1 / B-2.2 / B-2.3** — backend features/cost; **B-2.1 and B-2.2 require the shared-prod-DB discipline** and a subagent re-verify before any push.
7. **F-1.1, F-1.4, P-3.1, P-3.3** — no work. If a stakeholder insists, re-verify with a subagent and report the contradiction rather than editing.

---

## 5. Final verification gate (run before claiming the pass done)

Per `verify-without-regression`, cheapest-first:

1. `pnpm run typecheck` (whole workspace).
2. `pnpm run build` (catches lib/project-reference breakage).
3. Targeted check per card (the card's **Verify** line).
4. **SPA visual/behavior pass** on PC + iPhone + iPhone-SE (320px) for every frontend card —
   confirm no layout regression and no banner/nav overlap.
5. For any DB card: **never** `drizzle push` to the shared prod DB without the `db-schema-safety`
   guard; local DB only unless explicitly authorized.
6. Git: short-lived branch, rebase (don't back-merge), one-direction integration via PR
   (`git-guardrails`).

---

*Compiled from two parallel verification subagents (frontend + backend/DB surfaces) on
2026-06-15. File:line anchors were accurate at compile time; re-anchor on symbols as you edit.*
