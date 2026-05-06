# Firebase Cache Map

## Initialization

File: `artifacts/api-server/src/services/firebaseCache.ts`

The backend lazily initializes Firebase Admin with:

- `FIREBASE_PROJECT_ID`
- `FIREBASE_CLIENT_EMAIL`
- `FIREBASE_PRIVATE_KEY`

If any value is missing, cache is disabled gracefully and the app continues.

## Collection

| Collection | Document ID | Fields | Used By |
|---|---|---|---|
| `bg_cache` | SHA-256 of normalized `brand::name` | `cleanImage`, `brand`, `name`, `createdAt` | `getOrCreateCachedImage`, `scentEngine`, `imageHydration` |

Key normalization:

- trim brand/name
- lowercase
- collapse internal whitespace
- concatenate as `brand::name`
- SHA-256 hash

The cache is intentionally independent of Supabase user IDs. It is a shared bottle-image cache by fragrance identity, not a per-user cache.

## Read/Write Flow

1. `scentEngine.buildProfile` checks `global_fragrances` first.
2. If image missing, it calls `getOrCreateCachedImage`.
3. `firebaseCache.ts` checks `bg_cache`.
4. On miss, it runs image search/background removal callback.
5. Valid PNG data URIs are written back to Firestore.
6. `imageHydration.resolveSharedImageUrl` can read Firestore as a fallback after catalog lookups.

## Staleness Risks

- A stale image can appear if the same normalized `brand::name` was cached before better catalog data existed.
- Firestore does not determine login. It can make bottle images look "restored" or "broken", but cannot fix missing `public.users` or `user_fragrances`.
- Cached data is not tied to `users.id`, so clearing it does not delete wardrobe ownership.

## Could Firebase Hide The Real Supabase Failure?

Partially. If Postgres `global_fragrances` is missing but Firestore has `bg_cache`, some images may still hydrate, making the catalog look healthier than it is. It cannot hide failures in:

- `/api/auth/google/callback`
- `/api/wardrobe`
- `/api/share-settings`
- `public.users` token lookup
- `public.user_fragrances` ownership lookup

## Safe Cache-Clearing Steps

Only clear cache after the staging restore and Postgres validation are complete.

1. Confirm login and wardrobe rows work from Postgres.
2. Pick one affected fragrance and compute/locate its `bg_cache` key by `brand::name`.
3. Delete only the single bad `bg_cache` document.
4. Refresh image through the app to repopulate.
5. Avoid bulk-clearing `bg_cache` unless image corruption is widespread.

