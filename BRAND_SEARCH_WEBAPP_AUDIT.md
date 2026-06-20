# Brand Search — Web App (Frontend + Express) Audit

Audit-only. No source files changed. Scope: the ScentBeam SPA (`@workspace/scent-cast`) and the Express API (`@workspace/api-server`) sides of fragrance search — how the query is built, sent, received, filtered, capped, de-duplicated, ranked, rendered, and cached. The external Python engine (`VITE_FRAGRANCE_API_URL`) is audited separately; this document only establishes what the web side owns.

Branch: `claude/brand-search-audit-2rjemv`. Date: 2026-06-20.

---

## 1. Executive summary — web-owned vs engine-owned

Primary search for a query goes to the **external Python engine** (`GET /api/fragrances/search`, via the same-origin `/api/engine` proxy or a direct `VITE_FRAGRANCE_API_URL`). The Express `/api/fragrances/search` route is only the **supplemental/fallback** source. Between the engine response and the rendered list, the SPA applies **three independent reducing layers** that can shrink a large set:

1. `executeFragranceSearch` → `.filter(hasDisplayableSearchIdentity(query, result))` (`fragranceApi.ts:1479-1481`)
2. `mergeSearchResults` identity dedup (`fragranceApi.ts:1238-1253`)
3. `FragranceCapture` `visibleMatches` House/Gender filters (`FragranceCapture.tsx:477-486`) plus a second `isDisplayableResultName` map-filter (`FragranceCapture.tsx:594-608`)

| # | Symptom | Verdict | Confidence | Primary web-side contributor |
|---|---------|---------|------------|------------------------------|
| 1 | `jean paul gaultier` returns only 2 results | **Shared, web-side filter is a strong suspect** | High that the web filter participates; Medium on it being the sole cause | `hasDisplayableSearchIdentity` → `searchResultMatchesQueryIntent` 0.5 token-coverage gate (`fragranceApi.ts:1207-1236`) + `isBrandOnlyArchiveResult` (`fragranceApi.ts:1175-1192`) drop brand-only/low-overlap rows. Engine breadth also matters. |
| 2 | `torino 21` returns only 1 result "Torino" by Xerjoff | **Mostly engine-owned; web ranking/filtering can demote `21`** | Medium-high | Web does **not** strip the `21` before sending (`executeFragranceSearch:1435-1443`). But `searchRankTokens` discards 1-char/stopword tokens (`fragranceApi.ts:1152-1156`) and `scoreSearchResultForQuery` penalizes extra name tokens (`:1284-1287`), and `21` is a 2-char token that survives but contributes little. Breadth (only 1 candidate) is engine-owned. |
| 3 | `boss bottled night` → "No Olfactory Matches Found" + "BRAND ONLY" | **Shared; the empty-state UI is web-owned, the emptiness is likely engine + web filter** | High on UI ownership | The empty state renders when `matches.length === 0 && !errorStatus` (`FragranceCapture.tsx:1288`). It can fire even when the engine returned rows, if every row was dropped by `hasDisplayableSearchIdentity` / `isDisplayableResultName`. The "Brand only" chip is `runRecoverySearch(brandOnlyQuery)` where `brandOnlyQuery = sanitizedQuery.split(' ')[0]` = `"boss"` (`FragranceCapture.tsx:1051,1309-1316`). |
| 4 | Search feels slower than expected | **Shared; the web side adds measurable serial latency** | High | `executeFragranceSearch` can fire a **second** engine query (sanitized retry, `searchFragrances:1410-1425`) and a **supplemental Express search** (`:1485-1498`), both serial. Engine cold-start retry backoff is disabled for search (`{retryBackoffMs: []}` at `:1442`) but the Vercel `middleware.js` proxy + Express `/api/engine` proxy add two network hops. Detail/image fetches are deferred to selection, so they do not slow the results list. |

Net: **The web app owns the empty-state trigger condition, all post-engine filtering/dedup/ranking, and the multi-request search waterfall.** Result *breadth* (how many candidates exist at all) is owned by the engine, but the SPA can and does reduce that breadth further before render, and can convert "few results" into "No Olfactory Matches" when its identity gate rejects every row.

---

## 2. Per-symptom analysis

### A. How the query is built and sent

Entry point `searchFragrances(query)` (`fragranceApi.ts:1401-1429`):

1. Cache check first: `getCachedFragranceSearch(query)` (`:1405`). Returns early on hit (localStorage cache; see §3).
2. `executeFragranceSearch(query)` (`:1408`, body `:1431-1502`).
3. If `results.length === 0`, builds `sanitizeEngineQuery(query)` and, only when it differs case-insensitively, **re-runs** `executeFragranceSearch(sanitized)` (`:1410-1425`). This is a second serial engine round-trip.

`executeFragranceSearch` (`:1431-1502`):

- `const requestQuery = expandKnownSearchBrandAlias(query)` (`:1435`). Alias map at `:5-14` (`jpg → Jean Paul Gaultier`, `mfk → Maison Francis Kurkdjian`, etc.). `jean paul gaultier` is **not** an alias key, so it is sent verbatim.
- Sends `GET /fragrances/search?q=${encodeURIComponent(requestQuery)}` via `fetchFragranceEngine(..., {retryBackoffMs: []})` (`:1439-1443`).

**Is the query trimmed/normalized/accent-stripped BEFORE the first send?** No. The raw (alias-expanded) query is sent first. Accent/symbol stripping (`sanitizeEngineQuery`, `:1126-1133`) only happens on the **zero-result retry**, never on the first attempt. Verified by test `searchFragrances does not retry when a plain query is genuinely empty` (`fragranceApi.test.ts:905`).

**Does the web app strip the `21` from `torino 21`?** No, not before sending — `executeFragranceSearch` sends `torino 21` verbatim. The `21` survives sanitization too (it's alphanumeric). It is only **down-weighted in ranking**: `searchRankTokens` keeps tokens with `length > 1` and not in `SEARCH_RANK_IGNORED_TOKENS` (`:1152-1156`), so `21` is kept; but `scoreSearchResultForQuery` adds penalty `-extraNameTokens * 7` for name tokens not in the query (`:1284-1287`) and rewards name coverage — so a result literally named "Torino" scores well and any "Torino 21"-style variant is not specially boosted. Conclusion: the `torino 21` → 1 result symptom is **breadth (engine) first**, with web ranking unable to surface a "21" variant the engine didn't return.

### B. Result filtering / dedup / rendering (the reducing layers)

This is the most load-bearing area for symptoms 1 and 3.

**Layer 1 — engine-response identity filter** (`executeFragranceSearch:1477-1481`):
```
results: rawResults
  .map((result) => normalizeFragranceSearchResult(result, requestQuery, "srt"))
  .filter((result) => result !== null && hasDisplayableSearchIdentity(query, result)),
```
`hasDisplayableSearchIdentity(query, result)` (`:1229-1236`) drops a row unless ALL hold:
- has both `name` and `house`/`brand` (`:1230-1232`)
- name and house are not `looksLikeGeneratedToken` (`:1233`, `:1202-1205` — 6–12 char alnum with both letters+digits)
- not `isBrandOnlyArchiveResult` (`:1234`, `:1175-1192` — source-less rows where `name === house`, including base64 opaque-id placeholders)
- passes `searchResultMatchesQueryIntent(query, result)` (`:1235`).

`searchResultMatchesQueryIntent` (`:1207-1227`) is the key relevance gate:
```
const matched = queryTokens.filter((token) => combined.includes(token)).length;
return matched / queryTokens.length >= 0.5;
```
For a 3-token brand query like `jean paul gaultier`, a result must contain at least 2 of the 3 tokens in its `house + name + initials` blob. A row whose house abbreviates differently, or whose engine `house` field is missing/garbled, can fall under 0.5 and be silently dropped. This is a plausible contributor to "only 2 results" for a major brand: the engine may return more rows, but rows with weak/missing house strings get cut here.

**Layer 2 — dedup** (`mergeSearchResults:1238-1253`, used only when supplementing): dedup key is `fragranceIdentityKey` = `normalizeForDedupe(house)::normalizeForDedupe(name)` (`:1164-1169`). Two flankers that normalize to the same house+name collide and one is dropped. For a brand with name variants this can merge legitimately distinct entries if their normalized house+name coincide. Note: the **primary** engine path does NOT dedup unless `shouldSupplementWithAppSearch` fires (`:1485`).

**Layer 3a — second component-level filter** (`FragranceCapture.tsx:593-608`): the component maps results again and drops any whose name fails `isDisplayableResultName` (`:270-276`, rejects names starting with `and/&/by/de/du/di/et`) or that lack both `id` and `source_url`.

**Layer 3b — House/Gender chip filters** (`visibleMatches`, `FragranceCapture.tsx:477-486`): default `houseFilter`/`genderFilter` are `null`, so by default `visibleMatches === matches` — no reduction unless a chip is active. The header shows `${visibleMatches.length} of ${matches.length}` only when filters are active (`:1344-1346`). **So the "2" the owner saw is `matches.length`, i.e. the count AFTER layers 1, 2, 3a but with no chip filter applied.** This points the finger at layers 1/3a, not the chips.

**No hard numeric cap on the SPA primary path.** There is no `.slice(0, N)` on the engine result set in the SPA. The only cap is on the **Express fallback** (`routes/fragrances.ts:597` `.slice(0, 16)`) and the engine itself. So "2 results" is the product of filtering, not a slice.

### C. The "No Olfactory Matches Found" / "BRAND ONLY" owner (symptom 3)

Owner: `FragranceCapture.tsx:1288-1321`. Render condition (`:1288`):
```
hasSearched && matches.length === 0 && !uploading && !errorStatus
```
- `hasSearched` set true at `:624` after the search resolves.
- `matches` set at `:639` from `nextMatches`, which is the engine results after Layer 3a, OR a single local-fallback match (`:619-622`).
- Critically, if a transport/engine error occurred, `errorStatus` is set and a different banner shows instead (`:625-636`); the empty state is suppressed. So "No Olfactory Matches" specifically means **a successful search that yielded zero displayable rows** — which includes the case where the engine returned rows but every one was filtered out by `hasDisplayableSearchIdentity` (Layer 1) or `isDisplayableResultName` (Layer 3a) or `searchLocalFallback` returned null.

Copy: `"Try removing accents, symbols, or extra words..."` (`:1294-1296`).

"Brand only" button (`:1309-1316`): only shown when `canBrandOnlyQuery` (`:1054-1055`): `brandOnlyQuery = sanitizedQuery.split(' ')[0]` (`:1051`) and it must be ≥2 chars and differ from the full sanitized query. For `boss bottled night`, `brandOnlyQuery = "boss"`; clicking it runs `runRecoverySearch("boss")` (`:1056-1059`) which re-searches with just `boss`. "Remove symbols" chip (`:1300-1307`) shown when `canSanitizeQuery` (`:1052-1053`).

This empty-state UI does **not** consult `isSourceCoverageComplete` / `source_coverage`. Source-coverage gating only affects the **detail** view's "partial details" notices (`resolveSourceStatus:824-863`, `isSourceCoverageComplete:781-790`), not the search results list. So the contract in CLAUDE.md about `source_coverage` is unrelated to the search-result count symptom.

### D. Latency (web side)

Round-trip structure for a single user search:

1. Cache check (sync, local). 
2. **Engine search #1** — through Vercel `middleware.js` proxy → Railway, or Express `/api/engine` proxy → engine (two proxy hops if same-origin). `retryBackoffMs: []` (`:1442`) so no cold-start retry on the *search* request (good for latency, but means a cold engine surfaces as a fallback rather than a retried success).
3. If empty → **engine search #2** (sanitized retry, `:1414`). Serial.
4. If breadth degraded or `< SUPPLEMENTAL_SEARCH_MIN_RESULTS (8)` with a house match → **Express supplemental search** (`shouldSupplementWithAppSearch:1321-1331`, fired at `:1485-1498`). Serial after #2.
5. On engine 5xx/transport/empty-body → **Express app search** fallback (`:1445-1466`).

So a worst-case brand search that comes back small can issue **up to 3 serial network calls** before the list renders. Each engine call traverses `middleware.js` (Vercel Edge buffers the body, `middleware.js:97-108`) and, for `/api/engine`, the Express proxy (`fragranceEngineProxy.ts:35-78`) which `await upstream.arrayBuffer()` (full buffering, `:68`) before responding. Both proxies are buffering (not streaming) for these JSON bodies — adds a small constant per hop, not a major factor versus the engine itself.

Detail and image fetches are **not** part of the results-list latency: details are fetched on selection (`getFragranceDetails`, `:1548`) and images are deferred (`imageResolution: "deferred"` in the Express identity path, `fragrances.ts:256,367`). So the "slow search" the owner feels is dominated by (a) engine response time and (b) the serial supplemental/retry chain, not by per-result fanout.

**Baseline established (this environment):**
- Frontend unit tests: `node --experimental-strip-types --test src/lib/fragranceApi.test.ts` → **43 pass / 0 fail** (run from `artifacts/scent-cast`). Baseline is clean.
- `tsc -p tsconfig.json --noEmit` for scent-cast → fails only with `TS2688: Cannot find type definition file for 'node'` and `'vite/client'`, i.e. **dependencies are not installed in this environment** (no `node_modules`/`@types`). This is an environment limitation, not a code regression; the test run via native strip-types confirms the source compiles/executes. The fix team should run `pnpm install` then `pnpm --filter @workspace/scent-cast run typecheck`.
- Live latency could not be measured here (no running engine/network). Repro steps below.

**Repro steps for live timing (fix team):**
1. `pnpm install` at repo root.
2. Set `VITE_FRAGRANCE_API_URL` (or rely on `/api/engine` with `FRAGRANCE_ENGINE_URL`/default Railway origin in `fragranceEngineProxy.ts:6`).
3. `pnpm --filter @workspace/api-server run dev` and `pnpm --filter @workspace/scent-cast run dev`.
4. In DevTools Network, search `jean paul gaultier`, `boss bottled night`, `torino 21`. Count the requests to `/fragrances/search` (expect 1; up to 2 on empty + 1 Express supplemental). Record each request's TTFB and total. The serial chain is the web-owned latency to attack.

### E. Dirty-data artifacts in rendering

Where raw engine strings reach the DOM:

- **Search result name**: `{m.name}` rendered directly (`FragranceCapture.tsx:1469`) with `title={m.name}` (`:1467`).
- **Search result brand**: `truncateMatchLine(m.brand || 'House unavailable', MATCH_LINE_MAX_CHARS)` (`:1476`), `title={m.brand || 'House unavailable'}` (`:1474`).

`m.name`/`m.brand` come from `normalizeFragranceSearchResult` (`fragranceApi.ts:473-556`). That function picks the first non-empty string via `firstNonEmptyString` (`:211-218`) which only `.trim()`s — it does **not** decode HTML entities, collapse internal whitespace, strip "Unknown", or de-duplicate repeated house names. So:
- `firstNonEmptyString` trims leading/trailing whitespace only; an engine string like `Boss&nbsp;Bottled` or `Hugo  Boss` (double space) or `&amp;` reaches the DOM as-is.
- `normalizeForDedupe` (`:1105-1113`) and `vaultIdentityKey` (`FragranceCapture.tsx:240-251`) do aggressive normalization, but those are only used for **keys/dedup/matching**, never for **display**.
- `matchMonogram` (`:207-219`) strips non-alnum for the monogram only.
- The detail view's title/house come straight off the detail payload via `firstNonEmptyString`-style picks too (no entity decoding).

**Sanitization gap:** there is no display-time normalizer that (a) decodes HTML entities, (b) collapses internal whitespace, (c) suppresses literal "Unknown"/"N/A", or (d) removes a brand name duplicated inside the fragrance name (e.g. name = "Jean Paul Gaultier Le Male" under house "Jean Paul Gaultier"). Any of those artifacts present in the engine response will render verbatim. Recommended direction: a single `cleanDisplayString` helper applied at the `normalizeFragranceSearchResult` boundary for `name`/`house`/`brand` (decode entities, collapse whitespace, drop "unknown"), kept separate from the dedup normalizer so matching keys are unaffected. This is regression-safe because it only touches display fields, not ids/keys.

### F. Express API role

- **Search**: `routes/fragrances.ts:520-602` `GET /fragrances/search`. It is NOT the SPA's primary search — the SPA hits the external engine first and only calls Express when (i) the engine 5xx/transport-fails (`fragranceApi.ts:1445-1466`), or (ii) the engine result is empty/degraded/under 8 and supplementing is warranted (`:1485-1498`). Express composes candidates from: catalog (`searchCatalogCandidates`, limit 5, `:531`), local dataset (`searchDatasetFragrances`, `:537`), external scent sources within a 1200ms budget (`SOURCE_SEARCH_RESPONSE_BUDGET_MS`, `:41,500-518,547`), a broad source fallback when empty (`:560-574`), and brand expansion when `< 16` and a known brand signal (`:578-593`). Final response `dedupeCandidates(candidates).slice(0, 16)` (`:597`) — **hard cap of 16** on the Express side. So when the SPA falls back to Express for a brand, it can receive at most 16, then the SPA re-applies Layers 1/3a.
- **Engine proxy**: `routes/fragranceEngineProxy.ts` mounts `ALL /engine/*` and forwards to `${ENGINE_BASE}/api${path}` (`:36-39,80`). Default origin `https://srt-scent-engine-production.up.railway.app` (`:6`). Buffers the full body (`:68`). Strips `content-encoding` (`:32`) to avoid `ERR_CONTENT_DECODING_FAILED`.
- **Details**: `POST /fragrances/details` (`:604-649`) handles `source_url` and identity ids, building provisional details and queuing background source enrichment (`pendingSourceDetailFromUrl`, `queueSourceDetailEnrichment`). Has its own 24h in-memory `sourceDetailCache` (`:42,51`). Not on the search-count path.
- **Caps/caching summary**: Express search caps at 16 and has no result-list cache (only the per-source-URL detail cache). The engine-proxy adds no cache.
- The Vercel `middleware.js` proxy applies `cache-control: private, no-store` to API responses (`middleware.js:59-70`), so **CDN caching of `/api/.../search` is intentionally disabled** — every search is a fresh origin hit. This reinforces that caching for speed must live in the SPA (§3).

---

## 3. Caching findings + recommended brand-search cache design

**What exists (SPA, `fragranceApi.ts`):**
- localStorage search cache: key `scentcast.fragranceSearchCache.v4` (`:1`), max age **7 days** (`:2`), max **100** entries (`:3`). Key normalization `fragranceSearchCacheKey` = trim/lowercase/collapse-whitespace (`:397-399`). Read at `getCachedFragranceSearch` (`:432-460`), written at `cacheFragranceSearch` (`:462-471`) — **only non-empty responses are cached** (`:464`), and entries are re-normalized through `normalizeFragranceSearchResult` on read (`:445-451`).
- `searchFragrances` checks this cache first and returns on hit (`:1405-1406`). So a repeated identical brand query is instant.
- Review summaries: in-memory Map + sessionStorage (`:1648-1730`). Unrelated to search.

**There is NO React Query around fragrance search.** Search is a direct imperative call from `FragranceCapture.handleSearch` (`:591`). React Query (TanStack) exists in the repo for the generated API-client hooks but is not used for the engine search path. So there is no `staleTime`/`gcTime` to tune for search; the only search cache is the localStorage one above.

**Gaps / recommendations (regression-proof direction):**
1. **Brand-prefix reuse**: the cache is exact-key only. `jean paul gaultier` and `jean paul gaultier le male` are separate entries. A brand-aware cache could store the brand-expanded superset under the brand key and serve sub-queries client-side. Lower risk: keep exact-key cache but also cache the alias-expanded `requestQuery` (`:1435`) so `jpg` and `jean paul gaultier` share an entry.
2. **In-flight dedup**: two rapid identical searches both hit the network (the abort logic in `handleSearch:564-569` only aborts the *previous* search, it does not coalesce). A `Map<key, Promise>` in `searchFragrances` (mirroring the image pipeline's in-flight map described in CLAUDE.md) would coalesce concurrent identical brand searches.
3. **Cache the empty/partial decision separately**: currently empty responses are never cached (`:464`), so a brand that legitimately returns few results re-pays the full 3-call chain every time. Consider caching a short-TTL negative/low-count result to avoid repeated supplemental fan-out — but gate carefully so a transient engine outage doesn't poison the cache (only cache when no `primarySearchError`).
4. Bump the cache version key when display-time sanitization (§E) lands, so stale dirty strings are evicted.

---

## 4. How to verify after a fix (regression-proof)

**Commands (run from repo root after `pnpm install`):**
- `pnpm --filter @workspace/scent-cast run test` — runs the existing `fragranceApi.test.ts` suite (43 tests). Must stay green.
- `pnpm --filter @workspace/scent-cast run typecheck` — must be clean (this audit confirmed only missing-deps errors locally; install fixes them).
- `pnpm --filter @workspace/api-server run test` — exercises `fragranceApiCore.test.ts`, `fragranceNameResolver.test.ts`, etc., if the Express search candidate logic changes.
- `pnpm run typecheck` and `pnpm run build` for a full cross-package check before push.

**Existing tests to extend (do not rewrite):** `artifacts/scent-cast/src/lib/fragranceApi.test.ts` already covers `sanitizeEngineQuery` (`:22-33`), brand-alias expansion (`:737`), exact-name ranking (`:795`), sanitized retry (`:843`), supplement (`:949`), 502 fallback (`:1036`), caching (`:1095`), and archive-row dropping (`:1193,1245,1312`). Add cases that assert:
- a multi-token brand query (`jean paul gaultier`) with N engine rows whose house strings are weak does NOT lose rows that genuinely belong to the brand (pins the `searchResultMatchesQueryIntent` 0.5 threshold behavior).
- the empty-state is NOT shown when the engine returned ≥1 row that should survive filtering (guards Layer 1/3a over-filtering).
- display-time sanitization (if added) decodes entities / collapses whitespace without changing dedup keys.

**Manual UI repro per symptom (DevTools Network open):**
1. `jean paul gaultier`: confirm engine response row count vs rendered `Search Results · N`. If engine returned >2 but UI shows 2, log which rows `hasDisplayableSearchIdentity` rejected (instrument `executeFragranceSearch:1479`).
2. `torino 21`: confirm engine breadth (1 vs many). If engine returns 1, this is engine-owned; if it returns more and the SPA shows 1, check ranking/filter.
3. `boss bottled night`: confirm whether the engine returned 0 (engine-owned) or returned rows that all got filtered (web-owned). The empty-state at `FragranceCapture.tsx:1288` plus "Brand only"=`boss` chip should appear only in the true-zero case.
4. Latency: count `/fragrances/search` requests and total time; verify no extra serial supplemental call fires when the first response is already broad (`shouldSupplementWithAppSearch:1321-1331`).

---

## 5. Appendix — key file:line references

**SPA — `artifacts/scent-cast/src/lib/fragranceApi.ts`**
- Cache constants: `:1-3`. Brand aliases: `:5-14`. Rank-ignored tokens: `:15-27`.
- localStorage cache read/write: `getCachedFragranceSearch :432-460`, `cacheFragranceSearch :462-471`, key fn `:397-399`.
- `normalizeFragranceSearchResult :473-556` (display fields, trim-only via `firstNonEmptyString :211-218`).
- `sanitizeEngineQuery :1126-1133`. `expandKnownSearchBrandAlias :1135-1150`.
- `searchRankTokens :1152-1156`. `scoreSearchResultForQuery :1255-1290`. `rankSearchResultsByQuery :1292-1304`.
- `fragranceIdentityKey :1164-1169`. `mergeSearchResults :1238-1253`.
- `isBrandOnlyArchiveResult :1175-1192`. `looksLikeGeneratedToken :1202-1205`.
- `searchResultMatchesQueryIntent :1207-1227` (0.5 token-coverage gate `:1225-1226`).
- `hasDisplayableSearchIdentity :1229-1236`.
- `shouldSupplementWithAppSearch :1321-1331`. `SUPPLEMENTAL_SEARCH_MIN_RESULTS = 8 :4`.
- `searchFragrances :1401-1429` (cache-first `:1405`, zero-result sanitized retry `:1410-1425`).
- `executeFragranceSearch :1431-1502` (send `:1439-1443`, filter `:1477-1481`, supplement `:1485-1498`, rank `:1500`).
- `searchAppFragrances :1504-1537` (Express fallback).
- `getFragranceDetails :1548-1609` (routes to Express when origin app / id catalog:/dataset:/local: `:1553-1557`).
- `fetchFragranceEngine :1043-1085` (retry backoff `ENGINE_RETRY_BACKOFF_MS :1008`; search disables it `:1442`).
- `getFragranceEngineApiBase :927-941`, proxy detection `usesFragranceEngineProxy :943-946`.
- `isSourceCoverageComplete :781-790`, `resolveSourceStatus :824-863` (detail-only gating, not search count).

**SPA — `artifacts/scent-cast/src/components/FragranceCapture.tsx`**
- `firstString :44`. `truncateMatchLine :201-205`. `matchMonogram :207-219`. `matchKey :227-229`. `vaultIdentityKey :240-251`. `genderLabel :254-264`. `isDisplayableResultName :270-276`. `searchLocalFallback :301-320`.
- `availableHouses :459-466`, `availableGenders :468-475`, `visibleMatches :477-486`.
- `handleSearch` search exec + component-level filter `:591-608`; local fallback `:619-622`; empty/error branching `:624-639`.
- Empty-state recovery vars `:1049-1059`. Empty-state UI `:1288-1321` ("No Olfactory Matches" `:1293`, copy `:1294-1296`, Remove symbols chip `:1300-1307`, Brand only chip `:1309-1316`).
- Results header / count `:1339-1348` (`N of M` only when filters active `:1344-1346`). Result card name `:1469`, brand `:1476`.

**Express — `artifacts/api-server/src/routes/fragrances.ts`**
- `GET /fragrances/search :520-602`; candidate sources `:531,537,545-558,560-574,578-593`; **`.slice(0,16)` cap `:597`**; source budget `SOURCE_SEARCH_RESPONSE_BUDGET_MS=1200 :41,500-518`.
- `POST /fragrances/details :604-649`; per-URL detail cache `:42,51,63-71`.

**Express — `artifacts/api-server/src/routes/fragranceEngineProxy.ts`**
- Engine origin `:6-14`; proxy handler `:35-78` (full buffering `:68`); mount `:80`.

**Vercel — `middleware.js`**
- Matcher `/api/:path* :9-11`; body buffering `:97-108`; `cache-control: private, no-store` on API `:59-70`; content-encoding strip `:128-129`.

**Tests / baseline**
- `artifacts/scent-cast/src/lib/fragranceApi.test.ts` (43 tests, all passing here).
- `artifacts/scent-cast/package.json` scripts: `test`, `typecheck` `:` (test runner is node `--experimental-strip-types --test`, no framework).
