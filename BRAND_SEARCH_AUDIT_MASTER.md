# Brand Search — Master Cross-Repo Audit & Fix Roadmap

**Date:** 2026-06-20
**Branch:** `claude/brand-search-audit-2rjemv` (both repos)
**Repos:** `cloudURBANE/srt-scent-engine` (Python search engine) + `cloudURBANE/sCAST` (React SPA + Express API)
**Status:** AUDIT ONLY — no source files changed. This is the synthesis; the two deep-dive docs carry full file:line evidence.

> **This file is mirrored verbatim in both repos** so each team has the whole picture. Per-repo deep dives:
> - Engine: `srt-scent-engine/BRAND_SEARCH_ENGINE_AUDIT.md`
> - Web app: `sCAST/BRAND_SEARCH_WEBAPP_AUDIT.md`

---

## 0. The four symptoms (from production screenshots)

| # | Query | Observed | Expected |
|---|-------|----------|----------|
| 1 | `jean paul gaultier` | **2** results | Full JPG house catalogue (20–40+) |
| 2 | `torino 21` | **1** result ("Torino" / Xerjoff) | The exact "Torino 21" identity |
| 3 | `boss bottled night` | **"No Olfactory Matches Found"** (0) | ≥1 (Boss Bottled Night, Hugo Boss) |
| 4 | (all) | Search feels **slower** than the optimized target | Cached/brand queries in tens–hundreds of ms |

---

## 1. Root-cause summary — the one-paragraph version

Symptoms 1–3 are **primarily a data-coverage problem owned by the engine**, not a scoring bug: offline reproduction shows every one of these queries scores its correct target at **1.0** and passes the relevance gate — the rows simply **aren't in the engine's durable store** (`fragrance_records`), live discovery (Decodo→Fragrantica) is blocked/slow on Railway, and the only mechanism that would backfill a full brand catalogue (the brand-sweep) runs **as a once-ever background thread that *enqueues* rows for later enrichment rather than returning them to the current request**. On top of that, the **web app independently shrinks whatever the engine does return** (a 0.5 token-coverage gate + identity/house filters) and **renders "No Olfactory Matches" whenever the post-filter count hits zero** — so "few" becomes "2," and "a couple of weak rows" becomes "no matches." Symptom 4 (latency) is **architectural on both sides**: brand-only queries are structurally locked out of the engine's fast cache path so they re-run the full ~18 s live chain every time, and the SPA can fire **up to 3 serial network calls** per search through two buffering proxies.

---

## 2. Ownership split (what each repo must fix)

| Symptom | Engine (`srt-scent-engine`) | Web app (`sCAST`) |
|---|---|---|
| **1 — JPG → 2** | **PRIMARY.** Sparse `fragrance_records` coverage (RC1); single-substring `%query%` SQL with no token-split / brand-alias expansion (RC2); bundled identity cache holding **28 JPG rows** is disabled in prod (RC3); brand-sweep enqueues for later, doesn't return now; hard `max_results=15` cap (RC5). | **AMPLIFIER.** `searchResultMatchesQueryIntent` 0.5 token-coverage gate + `isBrandOnlyArchiveResult` + `isDisplayableResultName` drop borderline rows before render (Layers 1/3a). |
| **2 — torino 21 → 1** | **PRIMARY.** Coverage: exact "Torino 21" identity not stored; live returns the parent "Torino." `21` is **not** over-fuzzed. Edge: a record stored as "Torino21" (no space) would fail to match `{torino,21}`. | **SECONDARY.** Sends `21` verbatim (good), but ranking down-weights extra tokens; can't surface a variant the engine never returned. |
| **3 — boss bottled night → 0** | **PRIMARY (the emptiness).** Pure coverage gap: 0 "boss" rows in identity cache, likely 0 in `fragrance_records`, live discovery blocked → `[]`. | **PRIMARY (the UI).** The "No Olfactory Matches / BRAND ONLY" empty-state fires on `matches.length === 0` **regardless of whether the engine returned rows that were then filtered to zero**. "Brand only" re-searches `boss` (`split(' ')[0]`). |
| **4 — slowness** | **PRIMARY.** Brand-only queries can't hit the strong/warm fast path (RC4: gate requires query∩**name** tokens; brand queries only intersect **brand**) → full live chain (`API_SEARCH_TOTAL_BUDGET=18s`) every time. No durable brand-result cache; Decodo caches are in-process, TTL-less, lost on redeploy (RC6). Single uvicorn worker, 6-slot live semaphore (RC8). | **CONTRIBUTOR.** Up to **3 serial** calls per search (engine → sanitized retry → Express supplemental), each through Vercel + Express buffering proxies; `cache-control: private, no-store` disables CDN caching; only an exact-key localStorage cache, no in-flight dedup. |

---

## 3. Prioritized, regression-proof fix roadmap

Ordered by leverage. Each item names the owning repo, the change, and the **regression guard** that must stay green.

### P0 — Restore brand/coverage breadth (fixes 1, 2, 3 emptiness)
1. **[engine] Serve the bundled identity cache (or import it) for brand-only queries in prod.** `fg_cache/fg_identity_cache_v2.json` already holds 28 JPG + 12 Xerjoff rows with real FG URLs but is disabled when `DATABASE_URL` is set (`api.py:116-122`). Either enable it as a read-through tier for brand-only queries or one-time import it into `fragrance_records`. **Guard:** extend `test_bundled_identity_cache_rescues_deploy_repros` (`test_search_relevance.py:1224`) with `boss bottled night` / `torino 21`.
2. **[engine] Alias-aware brand SQL (RC2).** When `query_is_brand_only`/`canonical_brand_query` resolves a house, query `fragrance_records` by canonical house + all `IdentityTools.brand_forms` (`house ILIKE ANY(brand_forms)`) instead of `%phrase%`. **Guard:** new DB-fallback variant of `test_multi_token_brand_only_query_keeps_whole_house` asserting all seeded JPG rows return (incl. rows under alias `JPG`/`Gaultier`).
3. **[engine] Make the brand-sweep populate durable coverage** (or run the offline enrichment-worker brand-sweep) so houses backfill without live FG, and **raise `max_results` to ~40–60 for brand-only queries** (RC5, `…:11389`). **Guard:** coverage-count assertions on `_cache_search_fallback`.
4. **[engine] Mainstream-designer seed list** imported into `fragrance_records` (Hugo Boss, Dior, Chanel, JPG, Versace, Xerjoff…) so popular houses are never empty cold (fixes 3). **Guard:** seed test for `boss bottled night`.

### P1 — Stop the web app from shrinking/hiding valid results (fixes 1, 3 UI)
5. **[web] Loosen / instrument the post-engine filters.** The 0.5 `searchResultMatchesQueryIntent` gate (`fragranceApi.ts:1207-1227`) + `isDisplayableResultName` (`FragranceCapture.tsx:270-276`) silently drop brand rows with weak house strings. Add diagnostics, then relax for brand-intent queries so genuine house members aren't cut. **Guard:** new `fragranceApi.test.ts` case — multi-token brand query with weak-house rows keeps the rows.
6. **[web] Distinguish "engine returned 0" from "we filtered to 0."** The empty-state (`FragranceCapture.tsx:1288`) should only claim "No Olfactory Matches" on a true engine-zero; if rows were filtered out, surface them or a different message. **Guard:** test that empty-state is NOT shown when ≥1 engine row should survive.

### P2 — Latency (fixes 4)
7. **[engine] Brand-only fast path + brand-result cache (RC4/RC6).** When a brand resolves and ≥1 cached row exists, serve from `fragrance_records` **without acquiring `_LIVE_SEARCH_SEMAPHORE`**, optionally kicking a background refresh; add a bounded TTL/LRU keyed on `_brand_sweep_key`. Convert Decodo in-process caches to bounded TTL. Lower `API_SEARCH_TOTAL_BUDGET` to ~12 s once cold spell-repair is confirmed fast. **Guard:** extend `test_search_total_budget.py` with a "brand-only served from cache without touching the live semaphore" assertion.
8. **[web] Cut the serial waterfall + add in-flight dedup.** Avoid firing the Express supplemental when the first response is already broad (`shouldSupplementWithAppSearch:1321-1331`); add a `Map<key,Promise>` to coalesce concurrent identical searches; cache the alias-expanded `requestQuery` so `jpg`/`jean paul gaultier` share an entry. **Guard:** `fragranceApi.test.ts` supplement + caching cases.

### P3 — Dirty-data hygiene (cross-cutting)
9. **[engine] Apply safe `dirty_data` name/brand normalizers at read-time** inside `_search_result_to_dict`/`_recover_candidate_identity` (HTML-unescape, whitespace collapse, strip embedded year, drop self-duplication) — presentation-only, idempotent. Add a `fragrance_records`-scoped sanitize sweep (mirror `heal_duplicate_house_names.py`). **Guard:** new test — name `"Hugo Boss Boss Bottled Night 2010 "` → `name="Boss Bottled Night"`, `house="Hugo Boss"`.
10. **[web] `cleanDisplayString` at the `normalizeFragranceSearchResult` boundary** for `name`/`house`/`brand` (decode entities, collapse whitespace, drop literal "Unknown") — kept separate from dedup keys so matching is unaffected; bump cache version key to evict stale dirty strings. **Guard:** test that display sanitization doesn't change dedup keys.

> **Two-DB caution (both teams):** the engine reads `fragrance_records`; the web/Supabase side has its own `global_fragrances`/wardrobe DB. Cleanup/seed scripts mostly target one or the other — cleaning one does not clean the other. Confirm which DB a given "dirty artifact" actually came from before patching.

---

## 4. Latency baseline (established this audit)

**Engine, offline (regression guard — must stay green):**
- `python -m pytest test_search_relevance.py -q` → **68/68 pass (~4.6 s)** (proves 1–3 are not scoring regressions)
- `python test_search_total_budget.py` → **6/6 pass**; live chain bounded at the configured ceiling (e.g. `overall_budget_bounds_chain` 3.00 s under a 3 s budget)
- Configured prod budgets: `API_INITIAL_TIMEOUT=5.5`, `API_FG_TIMEOUT=4.5`, `API_SPELL_REPAIR_BUDGET=4.0`, `API_SEARCH_TOTAL_BUDGET=18.0` → cold worst case ≈ 18 s; cached fast path = tens of ms.

**Web, offline (regression guard):**
- `node --experimental-strip-types --test src/lib/fragranceApi.test.ts` (from `artifacts/scent-cast`) → **43/43 pass**
- `tsc` fails only on missing `@types/node`/`vite/client` (deps not installed in this sandbox) — **not** a code regression; fix team runs `pnpm install` then `pnpm --filter @workspace/scent-cast run typecheck`.

**Live numbers NOT obtainable here** (no network to Railway/Decodo/Postgres). Exact repro commands are in §7 of each deep-dive doc — run them to capture the pre-fix live baseline (`diagnostics.timing.total_search`, `cache_source`, `live_search_skipped`, and DevTools request counts) **before** changing code, then re-run after.

---

## 5. Caching design (target end-state, cross-layer)

- **Engine Tier 1 (durable):** `fragrance_records`, indexed by a canonical `brand_key`, queried alias-aware so one brand lookup returns the whole house. Reuse the `brand_sweeps` claim table's `found_count` to know a house is fully swept.
- **Engine Tier 2 (hot):** bounded `TTLCache`/LRU keyed on `_brand_sweep_key(brand)` (alias-collapsed, so `jpg`/`JPG`/`jean paul gaultier` share one entry), TTL 15–60 min, invalidated on `mark_brand_sweep_done` / `_persist_search_results`. Serve hits **without** the live semaphore.
- **Engine Decodo caches:** convert in-process unbounded dicts to bounded TTL (caps memory; the documented leak class).
- **Web:** keep the localStorage cache but also key by alias-expanded query; add in-flight dedup; consider a short-TTL low-count cache **only** when there was no engine error (don't poison on transient outages); bump the cache version when display sanitization lands.
- **CDN:** `middleware.js` deliberately sets `private, no-store` — speed caching must live in the engine + SPA, not the edge.

---

## 6. Verification matrix (regression-proof acceptance)

| Symptom | Pass criteria | How to check |
|---|---|---|
| 1 | `jean paul gaultier` returns ≥ ~20 JPG rows in the UI | engine curl (deep-dive §7B) returns full catalogue; SPA renders the same count (instrument `executeFragranceSearch:1479` to confirm no rows dropped) |
| 2 | Results include the exact "Torino 21" identity | engine curl shows "Torino 21"; verify "Torino21" no-space storage edge |
| 3 | ≥1 row, **never an empty body / "No matches"** | engine curl `boss bottled night` ≥1; SPA shows results, empty-state only on true engine-zero |
| 4 | 2nd identical brand query is fast & cache-served | engine `live_search_skipped: true` / `cache_source` set, `total` < 1 s; DevTools shows 1 search request, no serial supplemental |
| dirty | No stray whitespace/HTML/embedded year/dup-house in `name`/`house` | `scripts/db_audit_export.py` before/after fewer flags; spot-check responses |

**Must-stay-green before any push:** engine `test_search_relevance.py` (68) + `test_search_total_budget.py` (6); web `fragranceApi.test.ts` (43) + `pnpm --filter @workspace/scent-cast run typecheck` + `pnpm run build`.

---

## 7. Concurrency / state notes (for the fix team)
- Engine: single uvicorn worker, sync endpoints on the ~40-thread pool, `_LIVE_SEARCH_SEMAPHORE=6`, DB pool max 15, **no request-level dedup** of identical concurrent searches; brand-sweep/warm-refresh share the live semaphore (good — speculative work can't starve users).
- Web: search is an imperative call (no React Query); `handleSearch` aborts the *previous* search but does not coalesce concurrent identical ones.

---

## 8. Pointers to evidence
Every claim above is backed by file:line in the two deep-dive docs:
- **`BRAND_SEARCH_ENGINE_AUDIT.md`** — RC1–RC8, per-symptom code paths, offline scoring proofs, caching table, concurrency, dirty-data, appendix.
- **`BRAND_SEARCH_WEBAPP_AUDIT.md`** — the three reducing layers, empty-state owner, latency waterfall, web caching, dirty rendering, Express role, appendix.
