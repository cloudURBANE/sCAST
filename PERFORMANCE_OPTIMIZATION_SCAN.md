# Performance & Responsiveness Optimization Scan — 2026-06-25

Repo-wide audit of code that is **not production-grade for snappiness/responsiveness**, run as five parallel domain passes (React render, bundle/build, WebKit/CSS rendering, backend API, DB/data layer). This document is the consolidated research deliverable; the **Implemented** section lists the surgical fixes already applied on this branch.

> **Headline:** the app is already well-engineered in most layers — lazy routes + Suspense, a tiered WebKit render-budget system, bounded image-proxy LRU + semaphore, upstream timeouts, cursor pagination, ETag/SQL-projection on the wardrobe, and a hand-tuned service worker. The remaining wins are concentrated, not systemic. The brief's assumption that `App.tsx` re-scores the whole wardrobe every render was **incorrect** — that path is memoized and event-driven.

---

## ✅ Implemented on this branch (backend + data layer, low-risk)

All changes are additive, no new runtime dependencies, typecheck clean, existing tests green (weather 12/12, serper 7/7).

| # | Change | File | Why |
|---|--------|------|-----|
| 1 | **Index `users.token`** (hit on *every* authenticated request) + composite index on `(oauth_provider, oauth_subject)` for login | `lib/db/src/schema/users.ts` | Token lookup ran with no managed index — a sequential scan on every authed request. The index existed only in the disaster-recovery SQL, not the live schema. |
| 2 | **pg Pool tuning** — `max` (default 10), `connectionTimeoutMillis` (10s), `idleTimeoutMillis` (30s), all env-overridable | `lib/db/src/index.ts` | Pool was untuned; a burst could open unbounded connections against shared Supabase, and a stuck connection could hang a request forever. |
| 3 | **Weather payload TTL cache** (5 min, per ~1km geo bucket, live results only) + `Cache-Control: public, max-age=300, stale-while-revalidate=600` on `GET /api/weather` | `services/weatherService.ts`, `routes/scent.ts` | Only the city *label* was cached; every SPA poll triggered a live ~8s upstream round-trip. |
| 4 | **HTTP keep-alive agents** for the axios upstreams (Serper, Open-Meteo, OpenWeatherMap, engine image search) | new `lib/keepAliveAgent.ts`, `services/serperService.ts`, `services/weatherService.ts` | axios opened a fresh TCP+TLS handshake per call; the fetch-based callers already pool via undici. |
| 5 | **Server keep-alive/header timeouts** — `keepAliveTimeout=65s`, `headersTimeout=66s` | `artifacts/api-server/src/index.ts` | Node's 5s default races the Railway/Vercel ~60s proxy idle timeout → sporadic 502s. |

> ⚠️ **Item 1 requires a guarded schema push to take effect** (`ALLOW_PROD_DB_PUSH=yes pnpm --filter @workspace/db run push`). The schema source-of-truth is updated; the index is not live until pushed. Push was intentionally NOT run from this session (shared Supabase project; owner decision per `db-schema-safety`).

---

## Domain 1 — React render / runtime (frontend)

The two 3,000-line components each hold ~34 `useState` hooks, so any single state change (a search keystroke, a streaming token) re-renders the whole subtree, and the per-item children in their list loops are **not** memoized.

1. **HIGH** — `components/Wardrobe.tsx:2170-2218` + `components/VaultCard.tsx:63`: the vault grid re-renders every card on any Wardrobe state change; `VaultCard` is a plain function (no `React.memo`) and each tile gets inline `onClick`/`onMouseEnter` closures. **Fix:** wrap `VaultCard` in `React.memo`; extract a memoized `VaultGridTile` taking stable `onOpen(item)`/`onPrefetch(item)` `useCallback` refs.
2. **HIGH** — `components/ScentMissionPanel.tsx:2675`: the full chat transcript renders inline in `messages.map` with inline `BeamCard` props; every streaming token/keystroke reconciles all prior messages (cost grows with conversation length). **Fix:** extract a `React.memo`'d `MissionMessageRow` keyed by `message.id` with stabilized callbacks + a derived `Set` for the `added` flag.
3. **MED** — neither list is virtualized (`Wardrobe.tsx:2162`, `ScentMissionPanel.tsx:2675`). **Fix:** do the memoization first (higher ROI); add lightweight render-on-visible windowing only if production sizes are large — no new dependency.
4. **MED** — `Wardrobe.tsx:2177-2180`: per-card inline Framer Motion `whileInView`/`viewport`/`transition` object literals allocated per render. **Fix:** hoist static objects to module constants (subsumed by #1).
5. **LOW/MED** — `Wardrobe.tsx:1684-1697`: minor derived scalars recomputed each render; the expensive ones are already `useMemo`'d. No change needed beyond #1.

**Healthy (no action):** `WardrobeContext` value is correctly `useMemo`'d with `items` split into its own context; home recommendation scoring is event-driven (`WardrobeContext.tsx:1963-1973`); weekly-outlook loop memoized on `[forecast, items]`; `App`/`AppContent` memoized; lazy routes; WebVitals deferred via `requestIdleCallback`; `NotePyramid`, `PostCard`, `BottleImage` all memoized.

## Domain 2 — Bundle / build / network (frontend)

Loading is already well-optimized (lazy route views with chunk recovery, production-grade SW runtime caching, `loading="lazy"`/`decoding="async"` images, dynamically-imported `web-vitals`, `manualChunks` vendor split). Remaining issues are entry-bundle weight. *(Byte figures are estimates — `node_modules`/`dist` not built at scan time.)*

1. **HIGH** — `index.html:106`: render-blocking Google Fonts stylesheet (4 families, many weights). **Fix:** load non-blocking via `media="print" onload="this.media='all'"` with `<noscript>` fallback, and/or trim unused weights. *(Per guardrails: load strategy only, no font-stack change.)*
2. **MED-HIGH** — `App.tsx:9`: framer-motion (~100KB gz) parsed on first paint via always-mounted shell animations. **Fix:** migrate shell animations to framer-motion's `LazyMotion`/`m` API.
3. **MED-HIGH** — `App.tsx:35`: `FragranceCapture` (1569 lines, pulls in `fragranceApi.ts` 1870 lines) eagerly bundled despite being a user-triggered modal. **Fix:** `React.lazy` it like the sibling modals — largest easy TTI win.
4. **MED** — `vite.config.ts:117`: no `build.target` / `chunkSizeWarningLimit`. **Fix:** pin `target: ['es2020','safari14']`, add `chunkSizeWarningLimit: 600`.
5. **LOW-MED** — `ScentNotesInfographic.tsx` + `NotePyramid.tsx` + `noteAccordTaxonomy.ts` risk duplication across route chunks. **Fix:** add a `manualChunks` rule after verifying duplication with a build.

## Domain 3 — WebKit / CSS rendering budget (frontend)

Already heavily optimized: a real tiered render-budget system (`platform.ts` → `useRenderBudget.ts` → body perf classes), backdrop-blur stripped under perf modes, the topbar backdrop-filter deliberately removed as a documented scroll-jank source, passive + rAF-coalesced scroll handler, `no-projected-gold-glow` compliance. `pages/ipad-freeze-lab.tsx` is a DEV-only diagnostic harness (ships nothing to prod). Residual findings are narrow and additive-CSS only:

1. **MED** — `index.css:431-447`: `content-visibility: auto` disabled for the *entire* `scent-ipad-safari-perf` class + all phones to fix one marquee clip. **Fix:** scope the opt-out to a `.scent-deferred-section--fluid` modifier on that one section.
2. **MED** — `Wardrobe.tsx:2162-2170`: large card grid, no `contain`/`content-visibility`. **Fix:** add `contain: layout paint;` to the card/shelf-row wrapper so each card is an independent paint boundary.
3. **LOW** — `index.css:2413-2449`: full-viewport `scent-lava-fallback-drift` animates `background-position` + `filter` (non-compositable), gated only by reduced-motion. **Fix:** freeze it under `.scent-touch-perf`.
4. **LOW** — `index.css:2571-2582`: four infinite `background-position` shimmers gated only by reduced-motion. **Fix:** extend perf-mode selectors to freeze them.
5. **LOW** — `index.css:790-806`: `filter: blur(20px)` pedestal glow stripped on iPad-perf but not phones. **Fix:** add a `.scent-touch-perf` override.

## Domain 4 — Backend API runtime

Unusually well-tuned already (bounded image-proxy LRU + `Semaphore(8)`, upstream timeouts everywhere, ETag/SQL-projection/batch-hydrate on wardrobe, cursor pagination, dataset loaded once). Genuine gaps — **items 2, 4, 5 implemented above**:

1. **HIGH** — no response **compression** anywhere (`app.ts:40-42`). Every JSON/static response ships uncompressed. **Fix:** add `compression` middleware after `pino-http`. *(Not implemented: adds a runtime dependency — flagged for owner sign-off. Highest single backend win.)*
2. **HIGH** — `/weather` had no payload cache / `Cache-Control` (`routes/scent.ts`, `weatherService.ts`). **✅ Implemented.**
3. **MED** — main image pipeline `sharp` path has no concurrency limiter unlike the proxy path (`imagePipeline.ts:291-340`). **Fix:** wrap `processCandidate`/`processSourceToWebp` with the existing `Semaphore`; optionally `sharp.concurrency(2)`. *(Not implemented: needs runtime validation that throttling doesn't regress cold-image latency.)*
4. **MED** — axios upstreams used no keep-alive agent (`serperService.ts`, `weatherService.ts`). **✅ Implemented.**
5. **MED** — no server keep-alive/header timeout tuning (`index.ts:53`). **✅ Implemented.**

## Domain 5 — DB / data layer

The Supabase egress-audit stages (poll throttle, SQL trim, community projection, 304 conditional GET) and the historical image-hydration N+1 fix are all present; community/arena/image_cache/enrichment tables are fully indexed; no DB-level N+1 loops remain. Gaps — **items 1, 2 implemented above**:

1. **HIGH** — `users.token` unindexed, queried every authed request (`schema/users.ts`, `middlewares/auth.ts:51-66`). **✅ Implemented** (schema; needs guarded push).
2. **MED** — pg Pool untuned (`lib/db/src/index.ts:55-61`). **✅ Implemented.**
3. **MED** — catalog candidate select hauls full `profile_data` JSONB for ≤24 rows just to score on name+brand (`services/catalogService.ts:97-118`; egress audit Finding #4, still open). **Fix:** two-phase select — light columns to score, then fetch `profileData` for the ≤10 winners via `inArray`.
4. **MED** — `oauth_subject` lookup unindexed (`routes/oauth.ts:54-56`). **✅ Implemented** (composite index added; needs guarded push).
5. **LOW** — Beam/buy-link/share wardrobe reads pull full un-slimmed `fragrance_data` (`services/buyLinks.ts:53-64`, `beam-agent/mcp/beamServiceDeps.ts`). **Fix:** apply the existing `slimListFragranceData(...)`.

---

## Recommended next steps (not yet done)

Ranked by impact ÷ risk:

1. **Add `compression` middleware** (Domain 4 #1) — biggest single backend win; needs a dependency add + owner OK.
2. **`React.lazy(FragranceCapture)`** (Domain 2 #3) — biggest easy TTI win.
3. **Memoize `VaultCard` / `MissionMessageRow`** (Domain 1 #1, #2) — removes the most visible interaction jank; verify with a React Profiler trace first.
4. **Push the new DB indexes** via the guarded path once owner-approved.
5. Non-blocking Google Fonts load (Domain 2 #1), then the additive CSS perf-mode tweaks (Domain 3).
