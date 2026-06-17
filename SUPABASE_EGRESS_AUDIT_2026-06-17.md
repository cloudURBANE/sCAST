# Supabase Egress Emergency Audit — ScentBeam

**Date:** 2026-06-17
**Scope:** `huge_monorepo/` (React SPA + Express API + Drizzle/Postgres on Supabase, Supabase Storage for images). The Python engine (`search_engine/`) is a separate service and does **not** touch Supabase, so it is out of scope for egress.
**Goal:** find what burned extreme Supabase egress during testing and ship verified, safe fixes. "Upgrade to Pro" is explicitly **not** the fix.

---

## 0. How egress actually flows here (read this first)

Supabase egress = bytes leaving Supabase. There are exactly **two** Supabase surfaces in this app:

1. **Postgres → Express (Railway).** Every Drizzle query result travels Supabase → Railway. This is the metered "Database egress." The browser never talks to Postgres directly (no `supabase-js` in the SPA — verified: zero `.channel()`, `createClient`, or Realtime usage in `artifacts/scent-cast/`). So DB egress is driven entirely by **how often Express queries and how fat each row is.**
2. **Browser → Supabase Storage CDN.** Processed bottle images live in a public Supabase bucket and are served **direct** to the browser (`imageObjectStorage.ts:getPublicUrl`), bypassing Express. This is "Storage egress."

Two important consequences:
- **Express's built-in ETag would NOT save DB egress.** A 304 still runs the full query (Supabase→Express) and only skips Express→browser. The Supabase meter already ticked. Any real DB-egress fix must avoid the *query*, not just the response body.
- **The image path is already well-defended** (see §5). The dominant problem is **Database egress from over-fat rows pulled too often.**

---

## 1. Root-cause ranked list (the egress burners)

| # | Severity | Source | Why it burns egress |
|---|---|---|---|
| 1 | **CRITICAL** | 60s wardrobe poll re-pulling the full-JSONB wardrobe | Recurring, unbounded, runs for the life of every open tab |
| 2 | **HIGH** | `GET /api/wardrobe` returns each row's entire `fragranceData` (incl. `raw_engine_detail.raw.reviews/notes/description`) | Per-request payload is 10–100× larger than the UI needs |
| 3 | **HIGH** | `/api/community/fragrances` selects full JSONB for `limit × 3` rows (≤288) to show name/brand/image | Cold loads pull multi-MB to render ~16 cards |
| 4 | **MEDIUM** | Catalog candidate selects pull full `profileData` for ≤24 rows to score by name+brand | Server-side, on profile builds/rebuild/hydration |
| 5 | **LOW** | 768px WebP served as small grid thumbnails; proxy-fallback re-fetch during CDN outages | Bounded by immutable cache + stable URLs; minor |

---

## 2. Detailed findings (evidence)

### Finding #1 — CRITICAL: 60s wardrobe poll (the multiplier)
- **File:** [WardrobeContext.tsx:1066-1087](artifacts/scent-cast/src/context/WardrobeContext.tsx#L1066-L1087)
- **Component/hook:** `WardrobeProvider` background-poll `useEffect`.
- **Supabase object:** `user_fragrances` (Postgres) via `GET /api/wardrobe`.
- **Frequency:** every **60s** while the tab is visible, **plus** an extra fetch on every `visibilitychange → visible`.
- **Trigger:** continuous, for the entire session of any signed-in tab.
- **Response size:** the full wardrobe — see Finding #2 for per-row weight. For a 20-item vault with enriched rows this is on the order of **0.5–2 MB per tick**.
- **Proof:** `window.setInterval(tick, REFRESH_MS)` with `REFRESH_MS = 60_000`; `tick` → `loadWardrobe(authToken)` → `fetch('/api/wardrobe')` ([WardrobeContext.tsx:787-837](artifacts/scent-cast/src/context/WardrobeContext.tsx#L787-L837)).
- **Why this is THE burner:** a tester leaving a tab (or several devices) open for hours pulls the entire fat wardrobe ~60×/hour/tab with no change-detection. 20 items × ~50 KB × 60/hr ≈ **60 MB/hr/tab**, indefinitely. Multiply by test tabs/devices and you reach GBs without any "real" traffic — exactly the reported symptom.
- **Good news already in place:** the poll is gated on `document.visibilityState` (hidden tabs skip), and `reconcileWardrobeItems` ([wardrobeReconcile.ts](artifacts/scent-cast/src/lib/wardrobeReconcile.ts)) strips the `v=` cache-buster before diffing and preserves the current image URL — so the poll does **not** churn image re-downloads. The cost is purely the DB payload.

### Finding #2 — HIGH: wardrobe rows carry the full engine blob
- **Files:** server [wardrobe.ts:85-97](artifacts/api-server/src/routes/wardrobe.ts#L85-L97) (`db.select()` = all columns), [fragrancePayload.ts:93-95](artifacts/api-server/src/services/fragrancePayload.ts#L93-L95) (`sanitizeFragrance` only strips base64 + stamps schema version — it does **not** trim the blob); client persist path [WardrobeContext.tsx:1390](artifacts/scent-cast/src/context/WardrobeContext.tsx#L1390) stores `raw_engine_detail: detail`.
- **Supabase object:** `user_fragrances.fragrance_data` (jsonb).
- **What's in the blob:** the entire `FragranceDetail` under `raw_engine_detail`, including `raw.reviews` (full scraped review text — the heaviest part, [fragranceApi.ts:1706](artifacts/scent-cast/src/lib/fragranceApi.ts#L1706)), `raw.notes`, `raw.description`, plus `derived_metrics` **duplicated** both at top level and inside `raw_engine_detail`.
- **What the list view actually needs:** display fields, `derived_metrics`, `source_coverage`, `enrichment`, and `raw.source_urls` (for the enrichment-refresh poll). Reviews are consumed **only in the detail modal, one item at a time** ([Wardrobe.tsx:2801](artifacts/scent-cast/src/components/Wardrobe.tsx#L2801)), yet every list/poll response ships every item's full reviews.
- **Severity:** HIGH — this is the per-request multiplier behind Finding #1 and #3.

### Finding #3 — HIGH: community feed over-fetch
- **File:** [community.ts:90-138](artifacts/api-server/src/routes/community.ts#L90-L138).
- **Supabase object:** `user_fragrances.fragrance_data` (joined to `users`, `user_settings`).
- **Behavior:** `fetchLimit = limit × 3` (default 48, max 288). Selects the **full `fragranceData` JSONB** for every candidate row, then trims to `limit` after hydration. The SPA requests `limit=16` ([communityData.ts:44](artifacts/scent-cast/src/components/community/communityData.ts#L44)) → **48 full blobs pulled to render 16 cards.**
- **Frequency:** client react-query `staleTime: 5min`, `refetchOnWindowFocus: false` ([communityData.ts:135-145](artifacts/scent-cast/src/components/community/communityData.ts#L135-L145)); response is `Cache-Control: public, s-maxage=60, stale-while-revalidate=300`. So it's **lower frequency** than the wardrobe poll, but each cold/edge-miss load is multi-MB from Supabase to render a handful of cards.
- **Severity:** HIGH per-load, MEDIUM overall (cached).

### Finding #4 — MEDIUM: catalog candidate selects pull full `profileData`
- **File:** [catalogService.ts:91-96 & 130-135](artifacts/api-server/src/services/catalogService.ts#L91-L96).
- **Supabase object:** `global_fragrances.profile_data` (jsonb).
- **Behavior:** `searchCatalogCandidates` / `searchCatalogBrandCandidates` `db.select()` (all columns) for ≤24 rows to **score by brand+name**, then use ≤10. The full `profileData` blob is pulled for all 24 even though scoring needs only two text columns.
- **Frequency:** server-side, on scent-profile builds, wardrobe rebuild, and image hydration — not on the hot 60s path. Bounded by `MAX_CATALOG_CANDIDATES = 24` and `.limit()`.
- **Severity:** MEDIUM.

### Finding #5 — LOW: image bytes (already well-defended)
- Processed images are 768×768 WebP, served **direct from the Supabase public bucket** with `Cache-Control: public, max-age=31536000, immutable` ([imageObjectStorage.ts:29](artifacts/api-server/src/services/imageObjectStorage.ts#L29)).
- The SPA renders our own processed objects **directly** (skips `/api/image-proxy`) via `isProcessedStorageImageUrl` ([imageProxy.ts:87-122](artifacts/scent-cast/src/lib/imageProxy.ts#L87-L122)); only third-party hotlinks (Fragrantica `fimgs.net`, etc.) go through the proxy — and those egress from Fragrantica, **not** Supabase.
- `<BottleImage>` uses `loading="lazy"`, `decoding="async"`, bounded retries, and a single proxy-fallback ([BottleImage.tsx](artifacts/scent-cast/src/components/BottleImage.tsx)).
- **Residual (low) costs:** (a) the 768px master is used even for small grid thumbnails — a smaller variant would cut Storage egress on grid-heavy views; (b) the `forceProxy` fallback re-fetches our Supabase object through Railway when a direct CDN hit fails (e.g. the Supabase Storage 402 outage) — but during a 402 those fail fast with tiny bodies.

---

## 3. Things that are NOT the problem (ruled out, so we don't chase them)
- **No Supabase Realtime / `.channel()` / websockets** anywhere in the SPA.
- **No `supabase-js` in the browser** — no direct client→Supabase reads, so RLS-bypassing over-fetch from the front end is not possible.
- **React Query is used sparingly and correctly** (community feed: 5-min staleTime, no focus refetch).
- **No `select('*')` mis-use that returns the whole catalog unbounded** — the broad selects that exist are all `.limit()`-bounded.
- **Image URLs are stable across polls** (reconcile strips `v=`), so polling does not re-download images.
- **`GET /api/me/app-state`** is cheap (a `count(*)` + two tiny column selects) — [me.ts:20-79](artifacts/api-server/src/routes/me.ts#L20-L79).

---

## 4. Safe patch plan (staged by risk)

### ✅ Stage 1 — shipped in this pass (lowest risk, highest leverage)
**Reduce the wardrobe poll multiplier.** [WardrobeContext.tsx:1066-1096](artifacts/scent-cast/src/context/WardrobeContext.tsx#L1066-L1096): raised the blanket interval `60_000 → 5 × 60_000` (5 min) while keeping the visibility/focus tick. Net effect:
- An idle open tab now pulls the full wardrobe **~5× less often** (≈12 MB/hr/tab vs ≈60 MB/hr/tab in the 20-item example).
- **No UX regression:** the user's own edits are already optimistic; new-item images come from the dedicated `scheduleImageBackfillRehydrate` burst (independent of this poll); and the focus tick still refreshes the instant a user returns to the tab. Only *cross-device* edits made while a tab sits in the foreground wait up to 5 min — and a focus event resolves even that.
- Pure client change, reversible, typecheck-clean.

### Stage 2 — server payload trim (high impact, medium risk; needs a focused PR + test)
Stop shipping per-item scraped reviews/notes/description in **list** responses. Two safe sub-steps:
1. Add a `slimWardrobeRow()` projection used by `GET /api/wardrobe` and `/api/community/fragrances` that keeps display fields + `derived_metrics` + `source_coverage` + `enrichment` + `raw.source_urls`, and **drops `raw.reviews`, `raw.notes`, `raw.description`** (notes already live in `derived_metrics`).
2. Make the detail modal fetch fresh reviews on open (it already has `getFragranceDetails` + the enrichment-refresh path), so stripping reviews from the list does not blank the modal. **This is the regression-sensitive step** — gate it behind the modal refetch landing first. Respect `cross-service-contract` (do not change `source_coverage`/`derived_metrics` shapes) and `db-schema-safety`.
- Expected effect: cuts the per-request size in Findings #1–#3 by ~10–100× depending on how review-heavy rows are.

### Stage 3 — community SQL projection (medium)
Replace the full-blob select in [community.ts:96-116](artifacts/api-server/src/routes/community.ts#L96-L116) with `->>'`-projected columns (name, brand, image, family, `imageAdjustment`, `imageProperties`, and the three note paths). Keeps `batchHydrateImageUrls` (needs name+brand only). Removes the `× 3` full-blob fan-out.

### Stage 4 — conditional GET to kill idle-poll egress entirely (medium; needs schema)
Add `updated_at` to `user_fragrances` (it currently has only `created_at` — [userFragrances.ts](lib/db/src/schema/userFragrances.ts)), then make `GET /api/wardrobe` compute a cheap version key from `SELECT count(*), max(updated_at)` and return `304` when the client's `If-None-Match` matches — **before** the heavy select + hydration. This drops idle-poll DB egress to a few bytes per tick. Requires a guarded prod `drizzle push` (`ALLOW_PROD_DB_PUSH=yes`, see root `CLAUDE.md`) — schedule deliberately, since the deploy does not auto-push.

### Stage 5 — thumbnails (low)
Generate/serve a small (e.g. 256px) WebP variant for grid tiles; reserve the 768px master for the detail/hero view. Cuts Storage egress on grid-heavy screens (wardrobe, community).

### Stage 6 — guardrails & diagnostics (recommended)
- **Dev request-budget log:** a dev-only fetch wrapper that counts calls per endpoint and `console.warn`s when an endpoint is hit > N times/min — catches future render loops early.
- **Admin usage panel:** `routes/usage.ts` + `apiUsageLedger` already exist; surface per-endpoint call counts + approximate bytes behind the existing `isAdmin` flag.
- **Graceful failure UI:** the wardrobe loader already toasts on failure and the image component degrades to a placeholder — keep, and ensure a Supabase 402/5xx shows a non-looping error state (no auto-retry storm).

---

## 5. Constraints honored
- **No production data mutated.** Stage 1 is a client constant; all heavier changes are staged, not auto-applied.
- **No secrets touched/logged.** Service-role keys, DB passwords, and bearer tokens are untouched; this report contains none.
- **Old Supabase project not deleted.**
- **Cross-service & schema guardrails respected:** Stages 2–4 explicitly defer the shape/schema-sensitive steps and call out `cross-service-contract` / `db-schema-safety`.

---

## 6. One-line takeaway
The egress was **not** images and **not** "needs Pro" — it was the **60s wardrobe poll re-pulling fat full-JSONB rows forever on open test tabs**. Stage 1 (shipped) cuts that ~5× safely; Stage 2 (trim per-item reviews from list responses) is the structural follow-up that removes the bulk of the bytes.
