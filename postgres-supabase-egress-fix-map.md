# Postgres / Supabase egress — files to change

This repo talks to Supabase **as managed Postgres** (`DATABASE_URL` + Drizzle). Billable egress is roughly “bytes moved between Postgres and your API runtime.” Below maps **where traffic is generated** and **which files to edit** to reduce it.

---

## Highest impact (fix first)

### 1. Full-table read of all users (share links by `@handle`)

**File:** `artifacts/api-server/src/routes/share.ts`  
**Function:** `resolveShareUser` — when `userRef` is **not** a UUID, the code runs `db.select().from(usersTable)` with **no `WHERE`**, loads **every user row** into Node, then scans in memory to match the derived handle from email.

**Edits:** Add a stable **`share_handle`** (or similar) column + unique index in schema/migrations; resolve handles with `WHERE share_handle = $1` (plus optional case-folding). Alternatively compute handle in SQL with a functional index if you refuse a new column.

**Also touch:**

- `lib/db/src/schema/users.ts` — define the new column.
- New migration via Drizzle (`pnpm --filter @workspace/db` / your usual migration flow).

---

### 2. Catalog / wardrobe hydration multiplies reads per HTTP request

**Pattern:** `hydrateImageUrl` → `resolveSharedImageUrl` can query **`global_fragrances` twice per fragrance** (exact `lookup_key`, then fuzzy `searchCatalog`) whenever `imageUrl` is empty.

**Files:**

- `artifacts/api-server/src/services/fragrancePayload.ts` — entry point `hydrateImageUrl`.
- `artifacts/api-server/src/services/imageHydration.ts` — `resolveSharedImageUrl` orchestrates exact + fuzzy reads.
- **Consumers that loop over all wardrobe rows:**
  - `artifacts/api-server/src/routes/wardrobe.ts` — `GET /wardrobe` maps every row through `hydrateImageUrl`.
  - `artifacts/api-server/src/routes/share.ts` — `GET /share/:userRef` does the same for each visible fragrance.

**Edits:** Batch or cache catalog lookups per request; skip fuzzy when exact hit exists; add Redis/in-memory TTL cache keyed by `lookup_key`; or store resolved `imageUrl` on `user_fragrances.fragrance_data` so reads don’t hit `global_fragrances` on every list. Project **`profile_data` JSONB only when needed** (today `catalogService` uses `select()` which pulls the whole row).

---

### 3. Debug audit route (N× heavy catalog queries)

**Files:**

- `artifacts/api-server/src/routes/debug.ts` — for **each** wardrobe row: exact catalog select + fuzzy catalog select; full `select()` on large JSONB `profile_data`; plus `COUNT(*)` on entire `global_fragrances`.
- `artifacts/api-server/src/routes/index.ts` — mounts `debugRouter` (always on unless you branch).

**Edits:** Gate behind env (`NODE_ENV`, `ENABLE_DEBUG_ROUTES`), IP allowlist, or remove mount in production builds.

---

## Medium impact

### 4. Loading entire wardrobe JSON just to patch/delete one row

**File:** `artifacts/api-server/src/routes/wardrobe.ts`  
**Function:** `findUserRow` — `db.select().from(userFragrancesTable).where(eq(userId))` pulls **all** rows for every `PATCH`/`DELETE` / image-sync path, then scans in JS.

**Edits:** Prefer targeted queries: `WHERE id = $1 AND user_id = $2` when param is UUID; only fall back to legacy `fragrance_data->>'id'` query when necessary.

---

### 5. Large JSONB payloads on every select

**Files:**

- `lib/db/src/schema/userFragrances.ts` — `fragrance_data` JSONB (often includes `scent_vector`, nested profile).
- `lib/db/src/schema/globalFragrances.ts` — `profile_data` JSONB.

**Files that always pull full rows:**

- `artifacts/api-server/src/routes/wardrobe.ts` — wardrobe list/update paths.
- `artifacts/api-server/src/routes/share.ts` — share payload.
- `artifacts/api-server/src/services/catalogService.ts` — `getCatalogEntry`, `searchCatalog` use `select()` without narrowing columns.

**Edits:** Use Drizzle column picks (e.g. only `profile_data` for catalog, or split “summary vs heavy blob” columns); strip redundant fields before persistence so rows shrink.

---

### 6. Hot paths that hit `global_fragrances` frequently

**Files:**

- `artifacts/api-server/src/services/catalogService.ts` — all catalog SQL (exact + fuzzy `ILIKE`).
- `artifacts/api-server/src/services/scentEngine.ts` — `buildProfile` calls `getCatalogEntry` then optionally `searchCatalog`.
- `artifacts/api-server/src/routes/scent.ts` — `/scent-profile`, `/search-scent`, refresh-image flows call catalog / `buildProfile`.

**Edits:** Ensure btree index on `lookup_key` (already unique); add trigram/GiNN indexes **only if** fuzzy stays and profiling proves sequential scans; prefer exact key + application cache over repeated fuzzy.

---

### 7. Automatic wardrobe rebuild (multiplies DB + catalog work)

**File:** `artifacts/scent-cast/src/App.tsx` — triggers `POST /api/wardrobe/rebuild` when legacy rows lack flat name/brand (`wardrobeNeedsLegacyRebuild`).

**Edits:** Rate-limit, run once per user server-side, or gate behind explicit user action so rebuild storms don’t hammer Postgres during deploys.

---

## Lower impact but relevant

### Auth paths (small rows; still worth tightening)

**Files:**

- `artifacts/api-server/src/routes/auth.ts`
- `artifacts/api-server/src/routes/oauth.ts`

**Edits:** Replace `select()` with explicit columns if `users` grows wide later; currently rows are small.

---

### Connection pooling / SSL

**File:** `lib/db/src/index.ts` — `pg.Pool` config.

**Edits:** Tune `max`, idle timeout, and ensure API replicas don’t open excessive pools (each connection has baseline chatter). Co-locate API region with Supabase region where possible (operational, not always in-repo).

---

## Schema-only / unused in API today

**Files:** `lib/db/src/schema/conversations.ts`, `lib/db/src/schema/messages.ts` — defined but **no API-server imports** showed up in repo search; unlikely egress source unless another worker uses them.

---

## Verification (outside code edits)

- Supabase dashboard: egress breakdown vs Postgres vs Storage vs Edge (confirm it’s database egress).
- Log slow queries / row counts for `share`, `wardrobe`, `global_fragrances` fuzzy searches.

---

## Quick priority checklist

1. `share.ts` — eliminate `select().from(usersTable)` without filter.  
2. `wardrobe.ts` + `share.ts` — reduce per-row catalog reads from hydration.  
3. `debug.ts` + `routes/index.ts` — disable debug mount in production.  
4. `wardrobe.ts` — narrow `findUserRow` queries.  
5. `catalogService.ts` — selective columns + caching.  
6. `App.tsx` — soften automatic `/wardrobe/rebuild` behavior.
