# Handoff: Wardrobe image loading — slow / intermittent → production-ready, multi-tenant

_Authored 2026-06-03. For the next agent doing the actual code change._

## 0. TL;DR for the next agent

The wardrobe **data** loads fine; the **bottle images** are slow and sometimes don't
appear. The cause is not the image *pipeline* (processing/storage is healthy) — it's
the **display path**. Every bottle image, including ones we already processed and
uploaded to a CDN-backed bucket, is funnelled through `GET /api/image-proxy` on the
single Railway Express process. There is **no byte cache** on that proxy and **no CDN
in front of it** (the Vercel edge `middleware.js` just forwards `/api/*` with no
caching). So N bottles = N heavy, serialized origin fetches per cold load; any upstream
blip returns `502`, which the UI shows as "Unavailable" after 2 retries.

**The fix, in one sentence:** serve already-processed images to the browser as their
**direct immutable CDN URL** (bypassing the proxy), and reserve `/api/image-proxy` only
for un-processed third-party hotlinked sources — with a real cache and concurrency
guard when it is used.

A measurement harness now exists to prove the before/after:
`pnpm --filter @workspace/scripts run measure:image-load` (see §6).

---

## 1. Complete file inventory (everything that touches this)

### Frontend (SPA) — `artifacts/scent-cast/src/`
| File | Role |
|---|---|
| `components/BottleImage.tsx` | The `<img>` renderer. Wraps `src` in `proxiedImageUrl(...)`, skeleton + 2× retry + "Unavailable" fallback, async decode. **The retry/fallback that users see as broken images lives here.** |
| `lib/imageProxy.ts` | `proxiedImageUrl()` — decides proxy vs passthrough. **Primary edit site for the fix.** Currently only passes `/api/image-objects/` through directly; everything `http(s)` goes to `/api/image-proxy`. |
| `lib/imageProxy.test.ts` | Tests for the above — update alongside. |
| `components/Wardrobe.tsx` | Wardrobe modal/grid; renders many `BottleImage`s. |
| `context/WardrobeContext.tsx` | `loadWardrobe()` fetches `/api/wardrobe`; collapses 401 into a generic error (see §5 auth note). |
| `components/community/BottleMarquee.tsx` | Community page bottle wall — another high-image-count surface. |
| `lib/bottleImageFrame.ts`, `lib/bottleImageAdjustment.ts`, `lib/bottleVideoBeta.ts` | Framing/crop/video — not perf-critical but share the render path. |
| `lib/imageRefreshSolvers.ts` | Manual "refresh image" trigger from the UI. |

### Backend (API) — `artifacts/api-server/src/`
| File | Role |
|---|---|
| `routes/imageProxy.ts` | **`GET /api/image-proxy`** — the hot path. Fetches upstream on *every* request, optional JPEG trim re-encode, sets `Cache-Control: public, max-age=86400`, no byte cache, no dedup, no concurrency cap. **Primary edit site.** |
| `routes/imageObjects.ts` | `GET /api/image-objects/...` — serves local dev objects only. |
| `services/safeImageFetch.ts` | SSRF-hardened fetch (DNS check, private-IP block, 8 MB / 10 s cap). Reused by the proxy. |
| `services/imageObjectStorage.ts` | Firebase / Supabase / local storage. **`getPublicUrl()` already returns a direct CDN URL** (`firebasestorage.googleapis.com/...?alt=media` or Supabase public object URL, optionally via `FIREBASE_STORAGE_PUBLIC_BASE_URL` / `SUPABASE_IMAGE_PUBLIC_URL_BASE`). This is the URL we want the browser to hit directly. |
| `services/imagePipeline.ts` | On-demand processing: cache check → Serper → bg-removal → sharp WebP → upload → `image_cache` upsert. In-flight dedup via `Map<string,Promise>`. |
| `services/imagePipelineCachePolicy.ts` | Cache TTL / version policy. |
| `services/imageCacheService.ts` | Reads/writes `image_cache` rows (metadata only). |
| `services/imageHydration.ts` | `resolveSharedImageReference()` — resolves the best image for a fragrance at response time; returns `{ imageUrl, storagePath, sourceProvider, sourceUrl }`. **`storagePath` is available here and is the key to emitting direct URLs.** |
| `services/imageReference.ts` | `usableImageUrlForResponse()` etc. — what gets emitted in API responses. |
| `services/packshotTrim.ts` | `sharp`-based JPEG trim invoked by the proxy when `trim=1`. CPU cost per request. |
| `routes/wardrobe.ts` | `GET /api/wardrobe` (per-user, `requireAuth`), hydrates each row's `imageUrl`. The response field the browser reads. |
| `routes/scent.ts` | `/api/refresh-image` and scent profile image resolution. |
| `routes/share.ts` | Public share pages (also render bottles, also multi-tenant-sensitive). |
| `routes/index.ts` | Mounts `imageProxyRouter` + `imageObjectsRouter`. |
| `middlewares/auth.ts` | `requireAuth` — bearer = `users.token` UUID. |

### Database — `lib/db/src/schema/`
| Table | Role |
|---|---|
| `image_cache` (`imageCache.ts`) | Metadata-only processed-image cache: `source_url_hash`, `storage_provider`, `storage_path`, `public_url`, `pipeline_version`, `background_removed`, `processing_status`, `hit_count`. **`public_url` + `storage_path` already exist — no migration needed to emit direct URLs.** |
| `user_fragrances` | Per-user wardrobe rows (`fragrance_data` JSONB, with `imageUrl`). |
| `global_fragrances` | Shared catalog (`profile_data` JSONB). |

### Edge / deploy
| File | Role |
|---|---|
| `middleware.js` (root) | Vercel Edge: forwards `/api/*` → `BACKEND_ORIGIN` (Railway). **No caching of any kind** — confirmed. |
| `vercel.json`, `railway.json` | Deploy config. |
| `ScentCast.env`, `.env.example` | `PUBLIC_APP_URL`, `BACKEND_ORIGIN`, `VITE_API_BASE_URL`, storage + CDN base vars. |

### Existing context docs (read these)
- `IMAGE_PIPELINE_AUDIT.md`, `IMAGE_STORAGE_CACHE_PLAN.md` — how processing/storage works today.
- `docs/IMAGE_PIPELINE_HANDOFF.md`, `docs/FIREBASE_CACHE_MAP.md`.
- `docs/WARDROBE_SYNC_FAILED_PC_DIAGNOSIS.md` — the **separate** 401/auth issue (do not conflate; see §5).

### New in this handoff
- `scripts/src/measure-wardrobe-image-load.ts` + `pnpm --filter @workspace/scripts run measure:image-load` — the timing harness (§6).

---

## 2. Why it's slow / sometimes blank (root cause, ranked)

1. **Double/triple network hop for already-CDN'd images.** Wardrobe `imageUrl` is a
   Firebase/Supabase public URL served `immutable, max-age=1yr`. Instead of the browser
   fetching it directly from the CDN, the SPA requests
   `…/api/image-proxy?url=<that CDN url>&trim=1`, so the path is
   **browser → Vercel edge → Railway Express → `fetch` → storage CDN → back → back → browser.**
   That is the dominant, avoidable latency.
2. **No proxy-side byte cache + single origin.** Each request re-downloads from upstream
   inside the Node process. A wardrobe of 20 bottles fires ~20 fetches that contend for
   one Railway instance's event loop + sockets → head-of-line blocking, long tails.
3. **Per-request `sharp` trim re-encode** (`trim=1` on non-WebP JPEGs) is CPU-bound and
   blocks the same event loop that's serving the other images.
4. **DNS lookup + redirect validation on every request** (`safeImageFetch.ts`) — correct
   for untrusted hosts, wasteful for our own storage bucket.
5. **No CDN in front of the origin.** `middleware.js` does zero caching, so even a repeat
   visitor's first paint re-hits the origin until the browser's own `max-age=86400` warms.
6. **Failure → blank.** Any upstream timeout/blip → proxy `502` → `BottleImage` retries
   twice (300 ms apart) then shows "Unavailable". Under load (#2) this is exactly when
   timeouts spike, so images intermittently vanish.

---

## 3. The fix (phased; do them in order, ship after each)

### Phase 1 — Stop proxying our own processed images (biggest win, lowest risk)
- In `lib/imageProxy.ts:proxiedImageUrl`, **pass through directly** any URL that is a
  known processed-storage object — i.e. matches our Firebase/Supabase public base
  (`VITE_IMAGE_CDN_BASES`, comma-sep) **or** contains `/images/processed/`. Only fall
  back to `/api/image-proxy` for genuinely third-party hosts (search candidates, raw
  Fragrantica/Basenotes thumbnails) that block hotlinks.
- Backend must actually emit those direct URLs. `imageHydration.ts` already has
  `storagePath` + `public_url`; ensure `GET /api/wardrobe` (and `/api/share`, scent
  profile) hydrate `imageUrl` to the **direct CDN public URL** for processed objects,
  not a bare path that forces the proxy.
- Keep `referrerPolicy="no-referrer"` on the `<img>` (already set) — required so the CDN
  doesn't reject on referrer.
- Acceptance: harness `COMPARE_DIRECT=1` shows proxy p95 ≈ direct p95 for processed
  objects, and the proxy is no longer in the path for them.

### Phase 2 — Make the proxy cheap & safe for the cases that still need it
- Add an in-process **LRU byte cache** (keyed by normalized url+trim, e.g. 256 MB / TTL)
  and **in-flight dedup** (`Map<key,Promise>`) so a burst of identical requests collapses
  to one upstream fetch — mirror the pipeline's existing dedup pattern.
- Add a **global concurrency limiter** (e.g. p-limit ~8) around `fetchExternalImage` so a
  wardrobe burst can't exhaust sockets / block the loop.
- Move/aim trim re-encode off the hot path: prefer serving the already-processed WebP
  (Phase 1 removes most trims); if trim is still needed, cache the trimmed result.
- Set strong, correct caching headers on proxy responses for cacheable upstreams
  (`public, max-age=31536000, immutable` for content-addressed processed objects;
  shorter for volatile third-party). Today it's a flat `max-age=86400`.

### Phase 3 — Edge caching / CDN in front of the origin
- Either: front the storage buckets with a real CDN base (set
  `FIREBASE_STORAGE_PUBLIC_BASE_URL` / `SUPABASE_IMAGE_PUBLIC_URL_BASE` to a CDN domain)
  so Phase-1 direct URLs are edge-cached globally; **or** add `s-maxage` + `stale-while-
  revalidate` and let Vercel/Cloudflare cache `/api/image-proxy` responses at the edge
  (requires `middleware.js` to stop being a dumb passthrough for image routes, or move
  the proxy to a cacheable function route).
- Add `<link rel="preconnect">` to the CDN origin and `fetchpriority="high"` on the
  above-the-fold hero bottle (Wardrobe already threads `fetchPriority`).

### Phase 4 — Resilience polish
- Replace the fixed 2×300 ms retry in `BottleImage` with a small jittered backoff and a
  one-time fallback to the proxy if a direct CDN URL fails (so a transient CDN 403 still
  recovers instead of going "Unavailable").
- Emit a lightweight client metric (image load ms / failure) so regressions are visible
  in prod, not just in the harness.

---

## 4. Multi-tenant correctness, safety & reliability (must hold after the change)

- **Tenant isolation:** processed images live under a content-addressed, non-guessable
  key (`images/processed/{provider}/{lookupKeySlug}/{sourceUrlHash}-{pipelineVersion}.webp`)
  and are *intentionally shared* across users (catalog-level), so direct CDN URLs leak no
  per-user data. **Do not** put per-user private imagery on this public path. `image_cache`
  has `user_id`/`fragrance_id` for telemetry only — keep public objects user-agnostic.
- **SSRF stays intact:** `/api/image-proxy` must keep `safeImageFetch.ts` guards for any
  third-party URL it still fetches. When you add the direct-passthrough allowlist in
  `proxiedImageUrl`, the allowlist is the **CDN bases we control** — never widen the proxy
  to fetch arbitrary hosts without the existing validation.
- **No base64 regressions:** the `persistenceGuards` / check-constraints that block
  `data:image/%` in JSONB must stay; direct URLs are http(s) only.
- **Cache-busting:** processed keys are content-addressed and immutable; the `v=` param
  threading in `proxiedImageUrl` must be preserved so a re-processed image (new hash)
  invalidates cleanly. Don't cache by fragrance identity alone.
- **Graceful degradation:** if storage/CDN env is unset (e.g. local dev), the local
  `/api/image-objects/...` path must keep working — don't hard-require a CDN base.
- **Cost/loop guards:** keep the existing refresh caps (3 auto / 10 session) and
  failed-URL recording in `image_cache` so the proxy/pipeline can't be driven into
  repeated Serper/Poof calls.

---

## 5. Do NOT conflate with the auth/401 bug

`docs/WARDROBE_SYNC_FAILED_PC_DIAGNOSIS.md` documents a *separate* failure: stale
`scent_token` → `401` on `/api/wardrobe` → wardrobe doesn't load at all (shown as "sync
failed"). That is an **auth/redirect-URI** problem (dashboard env + 401 recovery in
`WardrobeContext.tsx`), not image latency. This handoff is strictly about the **image
display path once the wardrobe data has loaded.** If the harness's `GET /api/wardrobe`
returns 401, fix that first (or pass `IMAGE_URLS=` to test images directly).

---

## 6. The test / how to prove it's fixed

Harness: `scripts/src/measure-wardrobe-image-load.ts`. It reproduces the browser exactly
(same `proxiedImageUrl`, same per-origin concurrency of 6, caches disabled), pulls the
real wardrobe, times every bottle (TTFB, full-body, status, bytes), and prints
p50/p95/p99/max + failure rate + total wall-clock. `COMPARE_DIRECT=1` also times the
underlying CDN URL so you can quantify the proxy hop. It exits non-zero on SLO breach so
it can gate a pre-deploy check.

```powershell
# Against production with a real bearer token (users.token UUID from localStorage 'scent_token')
$env:TARGET_BASE="https://scentbeam.com"; $env:SCENT_TOKEN="<uuid>"; $env:COMPARE_DIRECT="1"
pnpm --filter @workspace/scripts run measure:image-load

# Against local dev
$env:TARGET_BASE="http://localhost:3000"; $env:SCENT_TOKEN="<uuid>"
pnpm --filter @workspace/scripts run measure:image-load

# No token? Test specific image URLs directly:
$env:IMAGE_URLS="https://…/images/processed/…webp,https://…"; $env:TARGET_BASE="https://scentbeam.com"
pnpm --filter @workspace/scripts run measure:image-load
```

Knobs: `CONCURRENCY` (default 6), `RUNS` (average N cold passes), `SLO_P95_MS`
(default 1500), `SLO_FAIL_RATE` (default 0.02), `TIMEOUT_MS` (default 15000).

### MEASURED PRODUCTION BASELINE (2026-06-03, scentbeam.com)

Captured against **46 real processed images** harvested from the public
`GET /api/community/fragrances` endpoint (no token/PII needed — these are the same
Supabase `/images/processed/*.webp` objects the wardrobe serves). 3 cold runs,
concurrency 6, caches disabled. Same bytes both paths (~32 KB avg); the only
difference is the Railway proxy hop.

| Path | p50 | p95 | p99 | max | cold wall-clock (46 imgs) | warm wall-clock |
|---|---|---|---|---|---|---|
| **`/api/image-proxy`** (today) | 288 ms | **1174 ms** | 2169 ms | 2343 ms | **6169 ms** | ~1.8–2.0 s |
| **Direct Supabase CDN** (the fix) | 44 ms | **298 ms** | 668 ms | 723 ms | 1650 ms | **~320 ms** |

**The proxy adds ~876 ms at p95 and ~6.5× the p50.** Cold first paint of a 46-bottle
wall is **6.2 s through the proxy vs 1.65 s direct.** This is the slowness users feel,
and the long tail (p99 > 2 s, max 2.3 s) is where individual bottles hit the
`BottleImage` retry path and intermittently show "Unavailable." Failure rate was 0 % in
this sample, so the "sometimes doesn't load" symptom is the timeout/retry tail under
real wardrobe concurrency, not the CDN dropping objects.

> Reproduce: `node scripts harvest of /api/community/fragrances` → `IMAGE_URLS=… COMPARE_DIRECT=1 RUNS=3 pnpm --filter @workspace/scripts run measure:image-load`.

### Acceptance criteria (SLOs anchored to the baseline above)
1. ~~Capture baseline~~ — **done, see table above.**
2. After Phase 1: processed-image **p95 total ≤ 600 ms** on a warm CDN, **failure rate
   ≤ 0.5 %**, and proxy-vs-direct delta ≈ 0 for processed objects.
3. Wall-clock to load a 20-bottle wardrobe **≤ 1.5 s** at concurrency 6.
4. Harness `RESULT: PASS` wired into a pre-deploy check (optional CI step).

> Note: the harness measures network transfer, not browser decode/layout. For a true
> "time to bottles painted" number, optionally add a Playwright pass later that reads the
> Resource Timing API; not required to validate the proxy fix. No browser driver is
> currently installed in the repo.

---

## 7. Suggested PR sequence
1. `feat(images): serve processed wardrobe images via direct CDN URL` (Phase 1) — edit
   `imageProxy.ts` passthrough allowlist + ensure `wardrobe.ts`/`imageHydration.ts` emit
   direct `public_url`; update `imageProxy.test.ts`. Capture before/after harness numbers.
2. `perf(image-proxy): LRU byte cache + in-flight dedup + concurrency limit` (Phase 2).
3. `perf(images): CDN/edge caching + preconnect + hero fetchpriority` (Phase 3).
4. `fix(BottleImage): jittered retry + proxy fallback + load metric` (Phase 4).

Ship 1 alone first — it should resolve the user-visible slowness on its own.
