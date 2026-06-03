# Loading Experience Audit - 2026-06-03

Original audit scope: read-only audit of user-visible loading points in the ScentBeam web app, with light runtime/API probes through Vite on `http://localhost:5200`. No code fixes were applied during the audit phase.

## Implementation Update - 2026-06-03

Low-risk fixes applied after the audit:

- Engine search and detail calls now skip primary engine retries when app fallback exists, so 5xx/transport failures fall through immediately instead of waiting through the 500 ms and 1200 ms retry backoff. Requeue still keeps retry behavior.
- `/api/fragrances/search` now puts a 1200 ms response budget around external source expansion and returns catalog/dataset candidates with `diagnostics.source_lookup_timeout` when source discovery overruns the budget.
- Public share and community routes now reuse `batchHydrateImageUrls` instead of per-row `hydrateImageUrl` calls.
- Public share buy-link loading now uses a single batch endpoint, `/api/share/:userRef/buy-links?ids=...`, with public Rakuten resolution kept cache-only.
- `/api/usage/total` now scopes totals to the authenticated user instead of returning global ledger totals.
- `BottleImage` clears pending retry timers on source changes, successful load, and unmount.
- `WeatherContext` starts the default `/api/weather` fetch immediately, then upgrades with coordinate weather if geolocation succeeds.

Verification after fixes:

- `corepack pnpm --filter @workspace/api-server test`: pass, 161/161.
- `corepack pnpm --filter @workspace/scent-cast test`: pass, 75/75.
- `corepack pnpm --filter @workspace/api-server typecheck`: pass.
- `corepack pnpm --filter @workspace/scent-cast typecheck`: pass.

Still needs work:

- Detail source URL enrichment can still be long-running when the app detail endpoint is the primary path. The safer larger fix is optimistic save plus background detail/image enrichment updates tied to the authenticated user's row.
- The app fallback search now has a response budget, but it still needs proper background enrichment/rate limiting so timed-out source discovery can continue safely outside the request.
- Community gallery remains a global public aggregation. Product needs to decide whether this is intentionally global or should be tenant/host scoped before multi-tenant rollout.
- Public buy-link batching removes browser fanout, but deeper server-side batching or cached buy-link status embedded in `/api/share/:userRef` would reduce backend DB work further.
- Image proxy SSRF protections should stay as-is; performance work remains CDN caching, URL-hash cache keys, and possible `stale-while-revalidate`.
- Usage totals are user-scoped now. Any future tenant/admin aggregate view still needs explicit role and tenant authorization.

## Verification Summary

- `corepack pnpm --filter @workspace/api-server test`: pass, 161/161.
- `corepack pnpm --filter @workspace/api-server typecheck`: pass.
- `corepack pnpm --filter @workspace/scent-cast typecheck`: pass.
- `corepack pnpm --filter @workspace/scent-cast test`: fail, 72/74. Both failures show engine fallback now retries the engine three times before app fallback.
- Runtime probes through Vite proxy:
  - `/api/weather`: 200 in 539 ms.
  - `/api/community/fragrances`: 200 in 1,622 ms, 30.5 KB.
  - `/api/fragrances/search?q=Dior%20Sauvage`: 200 in 14,696 ms.
  - `/api/engine/fragrances/search?q=Dior%20Sauvage`: 200 in 428 ms.
  - `/api/fragrances/details` for Dior Sauvage source URL: 200 in 16,832 ms.
  - `/api/image-proxy?url=http://localhost/secret.png`: 400 in 277 ms, confirming SSRF rejection.
  - `/api/reviews/summarize` with empty reviews: 200 in 300 ms.
  - `/api/usage/total` without auth: 401 in 271 ms.

## Findings

1. Search fallback waits through multiple engine retries before app fallback.
   - Code: `artifacts/scent-cast/src/lib/fragranceApi.ts:932`, `:970`, `:1167`.
   - Test: frontend test suite failed two fallback tests; actual request list contains three engine attempts before app fallback.
   - User impact: when the engine proxy returns 5xx or transport errors, the search overlay can feel stuck for about 1.7s before useful fallback even starts.
   - Easy fix: make retry policy context-aware: one retry for direct engine-origin calls, zero or one retry for same-origin proxy 5xx when an app fallback exists.
   - Tenant/security note: safe to change client behavior; no tenant data is broadened.

2. Search app fallback path can be slow because it performs sequential source expansion.
   - Code: `artifacts/api-server/src/routes/fragrances.ts:203`.
   - Test: `/api/fragrances/search?q=Dior%20Sauvage` took 14,696 ms, while `/api/engine/fragrances/search?q=Dior%20Sauvage` took 428 ms in the same session.
   - User impact: users see "Researching Fragrance..." for a long time when app fallback performs catalog, dataset, Jina/Serper/DuckDuckGo source lookup, and broad fallback work.
   - Easy fix: put a hard response budget around external source search and return catalog/dataset hits first, with background enrichment queued separately.
   - Tenant/security note: public endpoint should get IP/request rate limits before multi-tenant scale because it can trigger external lookups.

3. Detail fetch for source URLs is long-running and blocks vault sync.
   - Code: `artifacts/scent-cast/src/components/FragranceCapture.tsx:489`, `artifacts/scent-cast/src/lib/fragranceApi.ts:1272`, `artifacts/api-server/src/routes/fragrances.ts:277`.
   - Test: `/api/fragrances/details` for a Dior Fragrantica source URL took 16,832 ms.
   - User impact: "Fetching Fragrance Intelligence..." can sit for many seconds before the item is saved.
   - Easy fix: save the selected result optimistically, then update details asynchronously when source facts/image profile complete.
   - Tenant/security note: detail building is public and expensive; add abuse throttling and avoid saving any detail payload unless attached to the authenticated user's row.

4. Public share page uses N+1 buy-link requests after the vault payload.
   - Code: `artifacts/scent-cast/src/components/SharePage.tsx:622`.
   - Test: code inspection plus public missing-share probe. The page fetches `/api/share/:userId`, then one `/buy-link` request per fragrance via `Promise.all`.
   - User impact: a large shared vault causes request fanout and delayed buy-link buttons.
   - Easy fix: add a batch endpoint such as `/api/share/:userRef/buy-links?ids=...` or include cached buy-link status in `/api/share/:userRef`.
   - Tenant/security note: keep public resolver constrained to visible rows for the resolved user; do not enable live affiliate lookups on public batch.

5. Share/community image hydration is per-row even though wardrobe has a batch hydrator.
   - Code: `artifacts/api-server/src/routes/share.ts:54`, `artifacts/api-server/src/routes/community.ts:113`, existing batch helper in `artifacts/api-server/src/services/fragrancePayload.ts:166`.
   - Test: `/api/community/fragrances` returned in 1,622 ms for 30.5 KB; code shows `hydrateImageUrl` per item on share/community, while `/wardrobe` uses `batchHydrateImageUrls`.
   - User impact: public pages do extra DB/cache work as visible item count grows.
   - Easy fix: reuse `batchHydrateImageUrls` after normalizing rows, then attach `_dbId`/community fields.
   - Tenant/security note: batching is safe if the initial row query remains scoped by user for share and explicitly public/tenant-filtered for community.

6. Community gallery aggregates across all users without tenant filtering.
   - Code: `artifacts/api-server/src/routes/community.ts:90`.
   - Test: code inspection; route joins all `user_fragrances` with `users`, filters only share-hidden/hide-images, and orders globally.
   - User impact: in a multi-tenant app, one tenant's shared images may appear in another tenant's community gallery.
   - Easy fix: add tenant filtering from request host/tenant context, or explicitly name this endpoint as global public community and document that product policy.
   - Tenant/security note: this is the biggest multi-tenancy policy question found.

7. Usage totals are global even though the endpoint is authenticated.
   - Code: `artifacts/api-server/src/routes/usage.ts:8`, `artifacts/api-server/src/services/apiUsageLedger.ts:132`.
   - Test: unauthenticated probe returned 401, but code inspection shows authenticated users receive totals across all `api_usage_ledger` rows.
   - User impact: authenticated users opening image tools may see global spend/count, not their own usage.
   - Easy fix: pass `req.user.id` into `getUsageTotals(userId)` and filter by `apiUsageLedgerTable.userId`.
   - Tenant/security note: for multi-tenant admin views, add role/tenant authorization before exposing aggregate totals.

8. Image proxy is secure but can do expensive on-demand buffering/trimming.
   - Code: `artifacts/api-server/src/routes/imageProxy.ts:15`, `artifacts/api-server/src/services/safeImageFetch.ts:139`.
   - Test: invalid localhost URL rejected with 400 in 277 ms. Code confirms DNS/private-IP checks, MIME allowlist, byte limit, timeout, and redirect cap.
   - User impact: third-party image tiles may still wait on backend fetch + optional Sharp trim, especially with many first-time images.
   - Easy fix: keep processed storage URLs bypassing proxy, add CDN caching in front of `/api/image-proxy`, and consider `stale-while-revalidate`.
   - Tenant/security note: do not relax SSRF checks; cache by URL hash, not user-provided raw URL text alone.

9. BottleImage retries broken image loads client-side without clearing pending timers.
   - Code: `artifacts/scent-cast/src/components/BottleImage.tsx:104`.
   - Test: code inspection. Each error schedules a 300 ms retry up to two times; source changes reset state synchronously but do not cancel already scheduled retry timers.
   - User impact: a stale retry can update state after image source changes, causing extra requests or brief skeleton flicker.
   - Easy fix: store retry timer in a ref and clear it on source changes/unmount.
   - Tenant/security note: purely client-side reliability fix.

10. Weather load waits up to 10s on browser geolocation before falling back.
    - Code: `artifacts/scent-cast/src/context/WeatherContext.tsx:57`, `artifacts/api-server/src/services/weatherService.ts:3`.
    - Test: `/api/weather` fallback/API path returned in 539 ms, but client code waits on `navigator.geolocation.getCurrentPosition(..., { timeout: 10000 })` before the fallback fetch when geolocation is unavailable/slow.
    - User impact: atmosphere bar can stay in pending placeholders on first visit if browser geolocation hangs.
    - Easy fix: fetch default weather immediately, then upgrade with coordinate weather if geolocation succeeds.
    - Tenant/security note: avoid storing precise coordinates; current implementation only passes them to the weather API request.

## Highest-Value Easy Fixes

1. Reduce engine retry attempts before fallback in `fetchFragranceEngine`.
2. Batch share/community image hydration using the existing helper.
3. Return search/detail partial results within a fixed budget and move slow enrichment into background updates.
4. Scope usage totals by user or tenant.
5. Add explicit tenant policy/filtering to community gallery before multi-tenant rollout.
