# Handoff: Wardrobe image loading — Phase 1 shipped, optimize from here

_Authored 2026-06-03. Read `docs/HANDOFF_WARDROBE_IMAGE_LOADING_PRODUCTION.md` first — it is the
original root-cause analysis and the full 4-phase plan. This doc records exactly what Phase 1
changed, why, and how to take it further. Everything below was verified against the code, not
assumed._

## 0. TL;DR

Phase 1 (the "biggest win, lowest risk" step) is **done and verified**. The SPA no longer routes
our own already-processed bottle images through `GET /api/image-proxy`; it renders them straight
from the CDN-backed storage URL the backend already emits. Per the measured baseline this should
take cold first paint of a ~46-bottle wall from ~6.2 s (proxy) toward ~1.65 s (direct), and kill the
long-tail timeouts that showed as "Unavailable".

**It was a frontend-only change.** The backend already emits direct CDN URLs (verified, see §2), so
no API/DB edits were needed or made.

Phases 2–4 from the original plan are **not done** and are where you come in. They are about making
the proxy cheap/safe for the third-party URLs that *still* legitimately use it, edge-caching, and
client-side resilience.

---

## 1. Exactly what Phase 1 changed (4 files)

### `artifacts/scent-cast/src/lib/imageProxy.ts` — the core change
- Added `parseImageCdnBases()` + module const `IMAGE_CDN_BASES` reading a new env var
  `VITE_IMAGE_CDN_BASES` (comma-separated CDN origins/prefixes we control; optional).
- Added exported `isProcessedStorageImageUrl(url, cdnBases = IMAGE_CDN_BASES)`. Returns true when the
  URL is one of our processed objects:
  - path contains `/images/processed/` (Supabase public URLs + local `/api/image-objects/...`), **or**
  - path contains `images%2Fprocessed%2F` (Firebase `?alt=media` percent-encodes slashes), **or**
  - URL origin/prefix-matches an entry in `VITE_IMAGE_CDN_BASES`.
- In `proxiedImageUrl()`, immediately **after** the `if (!/^https?:\/\//i.test(u)) return u;` guard,
  added: `if (isProcessedStorageImageUrl(u)) return u;` — direct passthrough. The full URL (incl. any
  `v=` cache-buster) is preserved; the `packshot`/`trim=1` flag is intentionally **not** applied to
  these (they are processed transparent WebPs; `routes/imageProxy.ts` already skips trim for
  WebP/processed objects, so this matches backend behavior and avoids flattening alpha onto white).

> Why the encoded-path branch matters: the original handoff (§3 Phase 1) only mentioned
> `/images/processed/`. That misses Firebase's `alt=media` URL form, which is
> `…/o/images%2Fprocessed%2F…?alt=media`. If prod ever switches Firebase→default URLs, the literal
> check alone would silently keep proxying every image. The encoded branch + the env allowlist cover
> all three storage backends (`imageObjectStorage.ts`: Firebase, Supabase, local).

### `artifacts/scent-cast/src/lib/imageProxy.test.ts` — tests
Added 4 tests (all green): Supabase direct passthrough in packshot mode; Firebase encoded-path
passthrough; `isProcessedStorageImageUrl` allowlist incl. a spoofed-prefix negative
(`cdn.scentbeam.com.evil.test` must NOT match) and a third-party negative (`fimgs.net`); existing
third-party-still-proxied tests remain.

### `scripts/src/measure-wardrobe-image-load.ts` — kept the harness mirror in sync
The harness contains a hand-copied mirror of `proxiedImageUrl` (its header comment mandates keeping
it in sync). Added the same `isProcessedStorageImageUrl` logic (reading an `IMAGE_CDN_BASES` env, the
non-VITE sibling) so the harness's "proxy path" column now reflects the *new* browser behavior.
Also added `export {};` to make the file a module — this fixed a **pre-existing** `TS2393 duplicate
function implementation` error: it and `rebuild-user-wardrobe.ts` both declared a top-level
`async function main()` in shared global script scope.

### `.env.example` — documented `VITE_IMAGE_CDN_BASES` (optional; leave blank to rely on the path
heuristic).

---

## 2. Load-bearing facts I verified (so you don't re-derive them)

- **Backend already emits direct CDN URLs.** `routes/wardrobe.ts:GET /api/wardrobe` →
  `services/fragrancePayload.ts:batchHydrateImageUrls` → `imageUrl` comes from
  `image_cache.public_url` via `usableImageUrlForResponse`. `image_cache.public_url` is written by
  `imageObjectStorage.ts:getPublicUrl()`, which returns the direct Supabase/Firebase URL in prod
  (or `/api/image-objects/...` only when local storage is enabled). So no hydration change was
  needed — the only thing re-wrapping these in the proxy was the SPA.
- **Production storage is Supabase** (per the original handoff's measured baseline: harvested
  `/images/processed/*.webp` objects from `GET /api/community/fragrances`). Firebase + local are also
  supported code paths.
- **All processed objects live under `images/processed/`** — enforced server-side by
  `assertSafeStorageKey` in both `imageObjectStorage.ts` and `imageReference.ts`. This is what makes
  the path heuristic safe and stable.
- **SSRF protection is unchanged.** `routes/imageProxy.ts` still calls
  `parseAndValidateExternalImageUrl` + `fetchExternalImage` (`services/safeImageFetch.ts`: DNS check,
  private-IP block, 8 MB / 10 s cap) for everything it fetches. Phase 1 only *removes* our own URLs
  from the proxy; it never widens what the proxy will fetch.
- **`BottleImage.tsx` retry is still 2×300 ms then "Unavailable"** (`handleError`, lines ~104–115).
  Unchanged by Phase 1. Direct Supabase public URLs work with `referrerPolicy="no-referrer"` (already
  set on the `<img>`) — the baseline measured 0% direct-fetch failures, so Phase 1 is safe without a
  fallback. But see Phase 4 risk note below.

---

## 3. Verification already run (re-run before you build on this)

```powershell
# imageProxy unit tests — 6/6 pass
cd artifacts/scent-cast; node --experimental-strip-types --test src/lib/imageProxy.test.ts

corepack pnpm --filter @workspace/scent-cast run typecheck   # clean
corepack pnpm --filter @workspace/scent-cast run build       # clean (vite, ~8s)
corepack pnpm --filter @workspace/scripts run typecheck      # clean (fixed pre-existing dup main)
```

**Known pre-existing, UNRELATED failure:** `src/lib/fragranceApi.test.ts` has failing tests asserting
fragrance-engine retry counts (3 engine calls vs expected 1 before app fallback). It touches nothing
in the image path. Don't let it block you; don't conflate it with this work. (Also still separate:
the 401/auth wardrobe-sync bug in `docs/WARDROBE_SYNC_FAILED_PC_DIAGNOSIS.md`.)

**Prove the win** against the documented baseline (proxy p95 1174 ms → direct ~298 ms):
```powershell
$env:COMPARE_DIRECT="1"
$env:IMAGE_URLS="<comma-sep processed .webp urls, e.g. harvested from /api/community/fragrances>"
$env:TARGET_BASE="https://scentbeam.com"
corepack pnpm --filter @workspace/scripts run measure:image-load
```
After Phase 1 the harness's "proxy (/api/image-proxy)" summary should now be ≈ the "direct CDN"
summary for processed objects, because the mirror passes them through directly too.

---

## 4. Your job — optimize further (Phases 2–4), in risk order

### Phase 2 — make the proxy cheap & safe for the URLs that STILL use it
The proxy is now only for genuinely third-party hotlink sources (search candidates, raw
Fragrantica/Basenotes thumbnails). `routes/imageProxy.ts` today: no byte cache, no in-flight dedup,
no concurrency cap, flat `Cache-Control: public, max-age=86400`, per-request `sharp` trim re-encode
on the event loop. Add:
- In-process **LRU byte cache** keyed by normalized `url + trim` (e.g. 256 MB / TTL). Mirror the
  pipeline's existing dedup pattern (`services/imagePipeline.ts` uses a `Map<string,Promise>`).
- **In-flight dedup** so a burst of identical requests collapses to one upstream fetch.
- **Global concurrency limiter** (~8) around `fetchExternalImage`. Note: `pnpm-workspace.yaml` pins
  deps in a `catalog:` and enforces `minimumReleaseAge: 1440` — prefer a tiny inline limiter or a
  catalog-pinned `p-limit` rather than a fresh unpinned dep.
- Differentiated cache headers: content-addressed/processed → `immutable, max-age=31536000`; volatile
  third-party → shorter. (Most trims disappear post-Phase-1; if trim is still needed, cache the
  trimmed bytes.)

### Phase 3 — edge / CDN in front of the origin
Either point `SUPABASE_IMAGE_PUBLIC_URL_BASE` / `FIREBASE_STORAGE_PUBLIC_BASE_URL` at a real CDN
domain (then add it to `VITE_IMAGE_CDN_BASES` so the SPA treats it as direct), **or** make the root
Vercel `middleware.js` (currently a dumb `/api/*` passthrough, zero caching) cache image-proxy
responses. Add `<link rel="preconnect">` to the CDN origin and `fetchpriority="high"` on the
above-the-fold hero bottle (Wardrobe already threads `fetchPriority` into `BottleImage`).

### Phase 4 — client resilience (also de-risks Phase 1)
In `BottleImage.tsx`: replace the fixed 2×300 ms retry with jittered backoff, and **on a failed
direct CDN URL, fall back to the proxy once** before showing "Unavailable". This is the safety net
for the one Phase-1 risk: a URL that matched `isProcessedStorageImageUrl` but transiently 403s
(referrer/CDN policy) currently goes straight to "Unavailable" with no proxy fallback. Also emit a
lightweight client metric (load ms / failure) so regressions show up in prod, not just the harness.

---

## 5. Invariants you must not break (carried from the original §4)

- **Tenant isolation:** processed objects are content-addressed, non-guessable, and *intentionally
  shared catalog-wide* — direct CDN URLs leak no per-user data. Never put per-user private imagery on
  the public `images/processed/` path.
- **Don't widen the proxy** to fetch arbitrary hosts; the `safeImageFetch.ts` guards must stay.
- **No base64 in JSONB:** `persistenceGuards` / check-constraints stay; direct URLs are http(s) only.
- **Keep `v=` threading** so a re-processed image (new hash) busts caches cleanly.
- **Graceful local dev:** if no storage env is set, the local `/api/image-objects/...` path must keep
  working — it's already on the passthrough list (`/images/processed/` matches it).
- **Keep the harness mirror in sync** with `proxiedImageUrl` if you touch SPA proxy logic again.

---

## 6. Key files (quick map)

| File | Role |
|---|---|
| `artifacts/scent-cast/src/lib/imageProxy.ts` | **Edited.** `proxiedImageUrl` + new `isProcessedStorageImageUrl`. |
| `artifacts/scent-cast/src/lib/imageProxy.test.ts` | **Edited.** Tests. |
| `artifacts/scent-cast/src/components/BottleImage.tsx` | `<img>` renderer + retry/fallback. Phase 4 edit site. |
| `artifacts/api-server/src/routes/imageProxy.ts` | Proxy hot path. Phase 2 edit site. |
| `artifacts/api-server/src/services/safeImageFetch.ts` | SSRF-hardened fetch. Keep guards. |
| `artifacts/api-server/src/services/imageObjectStorage.ts` | `getPublicUrl()` → direct CDN URL. |
| `artifacts/api-server/src/services/fragrancePayload.ts` | `batchHydrateImageUrls` (wardrobe hydration). |
| `scripts/src/measure-wardrobe-image-load.ts` | **Edited.** Timing harness (mirror of proxiedImageUrl). |
| `middleware.js` (root) | Vercel edge `/api/*` passthrough; Phase 3 edit site. |
| `.env.example` | **Edited.** Documents `VITE_IMAGE_CDN_BASES`. |
