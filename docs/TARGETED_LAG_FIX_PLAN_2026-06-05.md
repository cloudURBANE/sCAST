# Targeted Lag Fix Plan - 2026-06-05

## Goal

Find the smallest set of high-confidence changes likely to remove the remaining slow or laggy behavior without turning this into a broad refactor.

This audit used three focused sub-agents:

- Frontend runtime performance: SPA render work, polling, animations, image surfaces.
- Backend/API latency: API routes, image pipeline, catalog/search, DB read/write behavior.
- Cross-cutting performance: build/dev shape, service choreography, route loading.

## Recommended Fix Set

### 1. Move image and source-detail enrichment off hot response paths

**Why this matters**

Several user-facing requests wait on external systems before returning usable profile/detail data. A cache miss can include source reads, LLM extraction, Serper image search, Poof background removal, Sharp encode, storage upload, and DB writes. That creates real perceived lag even when the fragrance identity and notes are already known.

**Evidence**

- `artifacts/api-server/src/services/scentEngineCore.ts:214` awaits `resolveProcessedFragranceImage` while building a profile.
- `artifacts/api-server/src/services/scentEngineCore.ts:229` then tries a manual fallback image path, also inline.
- `artifacts/api-server/src/services/imagePipeline.ts:506` processes image candidates one at a time.
- `artifacts/api-server/src/services/imagePipeline.ts:566` awaits each candidate's download/BG removal/Sharp/upload work.
- `artifacts/api-server/src/services/bgService.ts:156` gives Poof calls a 25 second timeout.
- `artifacts/api-server/src/routes/fragrances.ts:240` awaits `getScentFacts` for source-url details.
- `artifacts/api-server/src/routes/fragrances.ts:250` then awaits `buildProfile`, which can re-enter image work.

**Fix**

- Return a provisional profile/detail immediately when identity, notes, and metadata are available.
- Queue image resolution and source-fact enrichment in the background, then update `global_fragrances` / `user_fragrances` when complete.
- Cache source-detail enrichment by canonical `source_url`, so repeated detail opens do not re-run extraction.
- For explicit `/api/refresh-image`, keep the user-initiated request, but pre-score candidates and cap fresh expensive processing. Use bounded concurrency of 2 or return a job/trace id when no strong candidate finishes quickly.

**Expected impact**

This should remove the worst long-tail waits from add/search/detail flows. The user sees profile content quickly, while image/source enrichment catches up.

**Verification**

- Measure cold and warm p95 for `/api/scent-profile`, `/api/search-scent`, and `/api/fragrances/details`.
- Add tests that provisional detail responses still include stable `source_coverage` / `enrichment` status fields.
- Confirm background completion updates the visible wardrobe row without forcing a full reload.

### 2. Reduce foreground polling, repeated PATCHes, and cache-hit writes

**Why this matters**

The app has periodic foreground work that can cause small but repeated jank: detail refresh polling, full wardrobe polling, per-item PATCHes, and DB writes on image cache reads. These are not single huge stalls; they are recurring pressure.

**Evidence**

- `artifacts/scent-cast/src/context/WardrobeContext.tsx:694` starts a 60 second wardrobe poll.
- `artifacts/scent-cast/src/context/WardrobeContext.tsx:930` starts a 15 second background detail refresh scheduler.
- `artifacts/scent-cast/src/context/WardrobeContext.tsx:946` refreshes up to 3 items serially.
- `artifacts/scent-cast/src/context/WardrobeContext.tsx:958` persists each refreshed detail separately.
- `artifacts/api-server/src/services/imageCacheService.ts:166` writes `hitCount`, `lastUsedAt`, and `updatedAt`.
- `artifacts/api-server/src/services/imageCacheService.ts:204`, `:239`, and `:271` await that write on cache-hit read paths.

**Fix**

- Add per-fragrance backoff metadata in the client refresh scheduler: `nextEligibleAt`, last status, and attempt count. Avoid rechecking rows that are still queued or recently incomplete.
- Batch detail persistence, either with a small `/api/wardrobe/detail-refresh/batch` endpoint or by collecting updates and doing one `setItems` after all successful PATCHes.
- Pause the 15 second detail scheduler for several minutes when no eligible targets are found.
- Make image-cache hit accounting asynchronous, sampled, or batched. Return the cached image first; write hit counters later.

**Expected impact**

Less network churn, fewer provider-tree re-renders, and less DB write pressure on popular cached images.

**Verification**

- In DevTools, confirm no foreground detail refresh requests fire when all items are complete or recently checked.
- Confirm a large wardrobe does not trigger multiple visible re-renders every 15 seconds.
- Check DB write volume before/after for `image_cache` reads.

### 3. Split and defer heavy frontend code and detail panels

**Why this matters**

The SPA eagerly imports routes and heavy visual/detail modules up front. Then opening a fragrance detail modal mounts several animated data panels at once. That makes both first load and detail open heavier than they need to be.

**Evidence**

- `artifacts/scent-cast/src/App.tsx:3` eagerly imports the dashboard, wardrobe, share page, community page, iPad lab, modals, and motion-heavy visuals.
- `artifacts/scent-cast/src/App.tsx:780` routes those eagerly imported views.
- `artifacts/scent-cast/src/components/Wardrobe.tsx:1712` opens the full-screen detail portal.
- `artifacts/scent-cast/src/components/Wardrobe.tsx:1762`, `:1771`, and `:1782` mount score, accord, and notes panels in the same tap.
- `artifacts/scent-cast/src/components/Wardrobe.tsx:2234` mounts reviews.
- `artifacts/scent-cast/src/components/ScentNotesInfographic.tsx:16` imports `NotePyramid`, with reveal/animation work later in that component.

**Fix**

- Use `React.lazy` / `Suspense` for `/community`, `/share/:userId`, and `/debug/ipad-freeze`.
- Consider a lazy boundary around the detail-only notes/reviews visuals.
- On detail open, paint the shell, title, and bottle first; defer accord, notes, and reviews until `requestIdleCallback` or after the first stable paint.
- Keep the existing constrained-detail mode, but make the deferral path the normal path for tablet/mobile and any low-render-budget session.

**Expected impact**

Lower initial JS parse/evaluation cost and a smoother first frame when opening fragrance details.

**Verification**

- Compare Vite build chunks and initial JS payload before/after.
- Use a performance trace around the detail-open tap and confirm the first modal frame lands before heavy panels mount.
- Run the existing frontend tests and manually verify route navigation/loading states.

### 4. Add an indexed catalog search path

**Why this matters**

Catalog fuzzy search currently uses leading-wildcard `ILIKE` on composite expressions. As `global_fragrances` grows, this becomes a repeated scan and sort on search/profile paths.

**Evidence**

- `artifacts/api-server/src/services/catalogService.ts:78` builds a brand/name composite expression.
- `artifacts/api-server/src/services/catalogService.ts:80` to `:82` use `%query%` `ILIKE`.
- `artifacts/api-server/src/services/catalogService.ts:89` sorts by `length(name)`.
- `lib/db/src/schema/globalFragrances.ts:5` defines only the unique `lookup_key`; no search index exists for fuzzy lookup.
- `artifacts/api-server/src/routes/scent.ts:203` calls catalog search in `/search-scent`.
- `artifacts/api-server/src/services/scentEngineCore.ts:160` can call catalog search during profile builds.

**Fix**

- Add a normalized generated search column or explicit normalized `brand`, `name`, and composite search fields.
- Add a Postgres trigram GIN index or full-text index for the fuzzy path.
- Keep exact `lookup_key` lookup first, then use the indexed fuzzy operator only when needed.

**Expected impact**

Search and profile cache lookup stay stable as the catalog grows, instead of gradually becoming slower.

**Verification**

- Run `EXPLAIN ANALYZE` for representative catalog queries before and after.
- Confirm exact lookup behavior remains unchanged.
- Add a regression test for flanker/near-name matching to preserve the existing confidence gate.

## Watch List, Not First-Pass Fixes

- `ThreadBackground` does per-frame DOM transform/opacity work across 28 elements, but `isLowRenderBudget()` already disables it on iPad/coarse touch/reduced-motion sessions. Revisit only if desktop route/scroll traces still show animation cost.
- `BottleMarquee` duplicates image surfaces for seamless community scrolling. It is worth simplifying if `/community` remains janky after route splitting.
- `fragranceEngineProxy` buffers upstream responses and has no timeout. This is a good hardening fix, but less central than removing synchronous enrichment and image work from the main flows.
- The API dev script rebuilds before start, and Vite can fall back to production. Useful for developer experience, but not the primary runtime lag path.

## First Implementation Order

1. Prototype provisional detail/profile response plus background enrichment for one path: source-url detail or `/api/scent-profile`.
2. Add client backoff/batching for background detail refresh.
3. Add route-level lazy loading and defer detail modal heavy panels.
4. Add catalog search indexing once query volume or table growth justifies migration work.

## Definition Of Done

- Cold profile/detail responses no longer wait on image processing when usable text/profile data exists.
- Background refresh does not fire every 15 seconds for rows that are not eligible.
- Detail modal opens with bottle/title first, then heavier panels arrive after first paint.
- Catalog fuzzy search has an indexed query plan.
- The final fix set remains small; avoid unrelated visual redesigns or broad data-model rewrites.
