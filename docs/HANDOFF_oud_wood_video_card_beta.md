# Handoff: Tom Ford Oud Wood — Video-in-Card Beta

**Repo:** `huge_monorepo/` (React 19 + Vite SPA at `artifacts/scent-cast/`, Express API at `artifacts/api-server/`)  
**Goal:** Drop a Gemini-generated video of the **exact current Oud Wood packshot** into the existing fragrance product card frame — pixel-aligned with how the static image sits today.  
**Scope:** **One fragrance only** (`Tom Ford` / `Oud Wood`). Everything else stays on `<img>` via `BottleImage`.  
**This doc is recon only** — the implementing agent should use it plus the delivered video asset.

---

## Executive summary

Today, every bottle visual flows through a single image-only component (`BottleImage`) backed by a strict CSS “shelf line” layout contract. There is **no video support anywhere** in the frontend or API image routes. The smallest safe beta is:

1. Add a tiny beta gate keyed on `brand === "Tom Ford"` + `name === "Oud Wood"`.
2. Introduce a video-capable wrapper (extend `BottleImage` or add `BottleMedia`) that renders `<video>` with the **same artboard + packshot CSS** as `<img>`.
3. Host the Gemini output as a static asset (recommended: `artifacts/scent-cast/public/beta/oud-wood.mp4`).
4. Wire the gate **only** into the wardrobe grid card render path first (`Wardrobe.tsx` ~L1599). Expand to Share/community only if explicitly requested.

---

## What “the current product image” actually is

Oud Wood appears in multiple places with **different URLs**. The implementing agent must use the image the user sees on **their vault card**, not a seed/catalog placeholder.

| Source | File | URL / note |
|---|---|---|
| Wardrobe row (production) | `user_fragrances.fragrance_data.imageUrl` | Usually `/api/image-objects/images/processed/...webp` from the image pipeline, or a vetted remote URL after add-to-vault |
| API seed catalog | `artifacts/api-server/src/data/fragrances.json` L68–78 | Unsplash placeholder — **not** the live vault image |
| Community seed | `artifacts/scent-cast/src/components/community/communityData.ts` L27 | `https://fimgs.net/mdimg/perfume/375x500.1827.jpg` |
| Search resolver tests | `fragranceNameResolver.test.ts` | Canonical identity: brand `Tom Ford`, name `Oud Wood` |

**For Gemini input:** grab the `imageUrl` from the live card (DevTools → Network, or log `item.imageUrl` in the grid map). If the row uses `/api/image-objects/...`, download that WebP/PNG and feed it to Gemini. Do **not** assume the fimgs.net or Unsplash URLs.

**Identity helper (match existing conventions):**

```ts
function isOudWoodBeta(item: { brand?: string; name?: string; product?: { brand?: string; name?: string } }): boolean {
  const brand = (item.brand || item.product?.brand || '').trim().toLowerCase();
  const name = (item.name || item.product?.name || '').trim().toLowerCase();
  return brand === 'tom ford' && name === 'oud wood';
}
```

Reuse `entryBrand` / `entryName` from `Wardrobe.tsx` (L114–125) instead of duplicating if wiring inside that file.

---

## Layout contract (why the video must match the image)

All bottle visuals share one layout system. A video must honor this or it will “float” or clip wrong inside `.scent-fragrance-card`.

### Component: `BottleImage`

**File:** `artifacts/scent-cast/src/components/BottleImage.tsx`

- Renders only `<img>`.
- Proxies remote URLs through `/api/image-proxy?url=...&trim=1` via `proxiedImageUrl()` (`src/lib/imageProxy.ts`).
- Applies `bottleArtboardClass(variant)` + `bottleImageFillClass()` + optional `bottleImageAdjustmentStyle(adjustment)`.
- Parent **must** give explicit size via `className` (typically `absolute inset-0` inside a flex slot).

### Frame math: `bottleImageFrame.ts`

**File:** `artifacts/scent-cast/src/lib/bottleImageFrame.ts`

| Variant | Artboard inset | Used on |
|---|---|---|
| `grid` | `inset-[6%] sm:inset-[7%]` | **Wardrobe grid cards (primary target)** |
| `featured` | same as grid | Tactical Selection hero |
| `detail` | `inset-3 sm:inset-4` | Detail panel + enlarge modal |
| `card` | same as grid | Community cards |

Shelf behavior (critical):

- Column flex, `justify-content: flex-end`, `align-items: center`
- Media: `object-fit: contain`, `object-position: center bottom`
- Hover scale uses `origin-bottom` so magnification grows upward from the shelf line

### CSS

**File:** `artifacts/scent-cast/src/index.css` L138–185

Key classes:

- `.bottle-artboard` — flex column, bottom-aligned
- `.bottle-packshot-frame` — transform scale/translate from `imageAdjustment`
- `.bottle-packshot-img` — sizing + `clip-path` crop from adjustment sliders

**Video must inherit `.bottle-packshot-img` rules** (either extend the selector to `video` or duplicate as `.bottle-packshot-video` with identical properties).

### Card chrome

**File:** `artifacts/scent-cast/src/index.css` L508–570 (`.scent-fragrance-card`)

Grid card DOM (Wardrobe):

```
.scent-fragrance-card (min-h-[26rem], overflow-hidden)
  .scent-card-frame (absolute inset, decorative bezel)
  .relative.z-[1].flex.flex-col (padding)
    BrandGoldLabel
    .relative.flex-1.min-h-0          ← bottle slot
      BottleImage.absolute.inset-0    ← must fill this box
    .scent-card-title-row
```

Share page cards use `min-h-[32rem]` and slightly different padding (`SharePage.tsx` L727–755) — out of scope unless explicitly expanded.

---

## Surfaces that render bottle images (touch map)

| Priority | File | Lines (approx) | Variant | Notes |
|---|---|---|---|---|
| **P0 — beta target** | `artifacts/scent-cast/src/components/Wardrobe.tsx` | L1599–1608 | `grid` | Main vault grid cards |
| P1 — optional same beta | `Wardrobe.tsx` | L1524–1533 | `featured` | Only if Oud Wood is the featured item |
| P2 — defer | `Wardrobe.tsx` | L1739–1748, L2248–2256 | `detail` | Detail + enlarge — still image is fine for v1 |
| P2 — defer | `SharePage.tsx` | L736–743, L897+, L1009+ | `grid` / `detail` | Public share view |
| Out of scope | `CommunityFragranceCard.tsx` | L26–33 | `card` | Seed data only |
| Out of scope | `BottleMarquee.tsx` | L210+ | `thumb`-like | Community marquee |
| N/A | `FragranceCapture.tsx` | — | — | Search results are text-only, no bottle thumb |

**Recommended v1:** change **only** the P0 grid `BottleImage` call site (or swap to a new component at that one callsite).

---

## What does NOT exist today (gaps for implementer)

| Gap | Detail |
|---|---|
| No `<video>` anywhere | Grep for `video`, `.mp4`, `webm` in scent-cast → only unrelated `aspect-video` chart class |
| `BottleImage` is image-only | No `videoSrc`, no media-type branching |
| `/api/image-proxy` is image-only | `artifacts/api-server/src/routes/imageProxy.ts` — fetches via `fetchExternalImage`, sets image Content-Type, optional JPEG trim. **Do not route video through it.** |
| `/api/image-objects/` is image-only | `artifacts/api-server/src/routes/imageObjects.ts` — content types hardcoded to webp/png/jpeg |
| No feature-flag infra | No `VITE_*` beta toggles for UI experiments; use a small constant map or env var |
| No DB field for video | `Fragrance.imageUrl` is the only media URL on rows/API types. Beta can hardcode video path client-side |

---

## Recommended implementation plan

### 1. Beta config module

**New file:** `artifacts/scent-cast/src/lib/bottleVideoBeta.ts`

```ts
export const OUD_WOOD_BETA_VIDEO_URL = '/beta/tom-ford-oud-wood.mp4'; // or import.meta.env.VITE_OUD_WOOD_BETA_VIDEO_URL

export function betaVideoUrlForFragrance(item: { brand?: string; name?: string; product?: { brand?: string; name?: string } }): string | null {
  if (!isOudWoodBeta(item)) return null;
  return OUD_WOOD_BETA_VIDEO_URL;
}
```

Optional kill switch: `VITE_OUD_WOOD_VIDEO_BETA=0` to revert to static image without removing code.

### 2. Video-capable bottle component

**Option A (preferred):** extend `BottleImage` with optional `videoSrc?: string | null`.

When `videoSrc` is set:

- Render `<video>` instead of `<img>` inside the same `.bottle-packshot-frame` wrapper.
- Apply `bottleImageFillClass()` to the video element.
- Set `poster={proxiedImageUrl(src, { packshot: true })}` so first frame / fallback matches static image.
- Attributes: `autoPlay`, `loop`, `muted`, `playsInline`, `disablePictureInPicture`, `preload="metadata"` (or `"none"` + play on hover if perf is a concern).
- **`prefers-reduced-motion`:** fall back to `<img>` only (mirror `VaultHeadlineRotation` pattern in `FragranceCapture.tsx` L95–118).
- Skip `proxiedImageUrl` for the video URL itself — serve from `/public` or a direct https CDN URL.
- Do **not** apply `trim=1` to video.

**Option B:** new `BottleMedia.tsx` that wraps `BottleImage` and overlays/replaces with video when beta matches. Slightly more duplication.

### 3. CSS tweak

In `index.css`, extend packshot sizing to video:

```css
.bottle-packshot-img,
.bottle-packshot-video {
  /* existing rules */
}
```

Or add `bottle-packshot-video` class in `bottleImageFillClass()` when rendering video.

**Hover scale:** grid cards pass `imgClassName="... group-hover:scale-[1.035] ..."`. Apply the same classes to `<video>` or to the `.bottle-packshot-frame` wrapper so hover behavior matches neighbors.

### 4. Wire P0 callsite

In `Wardrobe.tsx` grid map (~L1599):

```tsx
<BottleImage
  variant="grid"
  src={item.imageUrl}
  videoSrc={betaVideoUrlForFragrance(item)}
  alt={entryName(item)}
  adjustment={item.imageAdjustment}
  className="absolute inset-0 z-10"
  imgClassName="brightness-[1.1] group-hover:scale-[1.035] ..."
  ...
/>
```

### 5. Asset placement

**Recommended for beta:**

```
artifacts/scent-cast/public/beta/tom-ford-oud-wood.mp4
→ served at /beta/tom-ford-oud-wood.mp4
```

Alternative: upload to Firebase/Supabase storage and use absolute https URL (no proxy needed).

**Do not** put video under `/api/image-objects/` without extending `imageObjects.ts` content-type detection.

---

## Gemini video generation requirements (for asset producer)

To “lay perfectly” inside the card:

| Requirement | Why |
|---|---|
| **Same source frame as live `imageUrl`** | Pipeline-processed WebPs may be trimmed/BG-removed vs raw fimgs.net |
| **Portrait aspect ~ 3:4 to 375:500** | Matches typical packshot ratio; artboard is portrait-biased |
| **Bottle anchored on bottom center** | CSS uses `object-position: center bottom` + shelf flex |
| **Minimal camera drift** | Translation breaks alignment with title/brand chrome |
| **Matching background** | Transparent WebP source → dark/transparent video; opaque source → match tone |
| **Short loop (2–4 s)** | Grid may show many cards; keep file size reasonable |
| **H.264 MP4 + WebM optional** | MP4 + `playsInline` covers iOS; WebM optional for size |

After generation, compare side-by-side: open vault, overlay video on static image in the card slot, tune crop/scale with `imageAdjustment` if needed (stored per-row on `item.imageAdjustment`).

---

## `imageAdjustment` behavior for beta

Wardrobe rows can store per-bottle frame tweaks (`BottleImageAdjustment` in `src/lib/bottleImageAdjustment.ts`): scale, x/y nudge, per-edge crop.

- **v1:** apply the same `adjustment` to the video wrapper (already applied on `.bottle-packshot-frame`) — no new sliders.
- **Do not** expose video-specific tools in the bottle editor panel (`Wardrobe.tsx` L1778+) for this beta.
- If the user's Oud Wood row has non-default adjustment, the video must respect it or beta ignores adjustment — document choice in PR.

---

## What NOT to change

- Image pipeline (`imagePipeline.ts`, `imageHydration.ts`, Firestore `bg_cache`) — static image remains source of truth.
- Wardrobe API schema / PATCH payloads — no `videoUrl` on `fragrance_data` for v1.
- `proxiedImageUrl` / `image-proxy` route.
- Other fragrances' card rendering.
- Community seed data (`communityData.ts`) unless explicitly requested.
- Bottle frame editor, reimagine flow, search/add flow.

---

## Testing checklist

- [ ] Add Tom Ford Oud Wood to vault (or use existing row).
- [ ] Grid card: video fills same slot as static image; baseline aligned with adjacent cards.
- [ ] Hover: card lift + bottle scale match neighboring static cards.
- [ ] `prefers-reduced-motion: reduce` → static image only.
- [ ] Slow 3G / lazy shelf: no layout shift (poster frame or skeleton).
- [ ] iOS Safari: autoplay works (`muted` + `playsInline`).
- [ ] Detail panel + enlarge: still static image (if P2 deferred).
- [ ] Any other fragrance: unchanged static `<img>`.
- [ ] Share page (if touched): Oud Wood video, others static.
- [ ] Toggle beta env off → reverts to image with no errors.

---

## Files the implementer will likely touch

| Action | Path |
|---|---|
| **New** | `artifacts/scent-cast/src/lib/bottleVideoBeta.ts` |
| **Edit** | `artifacts/scent-cast/src/components/BottleImage.tsx` (or new `BottleMedia.tsx`) |
| **Edit** | `artifacts/scent-cast/src/index.css` (video packshot selector) |
| **Edit** | `artifacts/scent-cast/src/components/Wardrobe.tsx` (P0 grid callsite) |
| **New asset** | `artifacts/scent-cast/public/beta/tom-ford-oud-wood.mp4` |
| Optional | `ScentCast.env` / `.env` — `VITE_OUD_WOOD_BETA_VIDEO_URL`, `VITE_OUD_WOOD_VIDEO_BETA` |
| Optional P1 | `Wardrobe.tsx` featured block (~L1524) |
| Optional P2 | `SharePage.tsx` grid/detail |

---

## Reference snippets

**Grid card bottle slot (primary hook point):**

```1591:1608:artifacts/scent-cast/src/components/Wardrobe.tsx
                      <div className="scent-fragrance-card w-full h-full min-h-[26rem] ...">
                        ...
                          <div className="relative flex-1 w-full mt-3 sm:mt-4 mb-3 sm:mb-4 min-h-0">
                            <BottleImage
                              variant="grid"
                              src={item.imageUrl}
                              alt={entryName(item)}
                              adjustment={item.imageAdjustment}
                              className="absolute inset-0 z-10"
                              imgClassName="brightness-[1.1] group-hover:scale-[1.035] ..."
                            />
                          </div>
```

**Packshot CSS shelf line:**

```171:185:artifacts/scent-cast/src/index.css
.bottle-packshot-img {
  display: block;
  width: auto;
  max-width: 100%;
  height: auto;
  max-height: 100%;
  margin-inline: auto;
  object-fit: contain;
  object-position: center bottom;
  clip-path: inset(...);
}
```

**Image-only proxy (videos must bypass):**

```48:82:artifacts/scent-cast/src/lib/imageProxy.ts
export function proxiedImageUrl(url: string | undefined | null, options?: ProxiedImageOptions): string {
  ...
  const base = `${apiUrl("/api/image-proxy", apiBaseUrl)}?url=${encodeURIComponent(u)}...`;
  if (options?.packshot) return `${base}&trim=1`;
  return base;
}
```

---

## Open decisions for product owner (defaults suggested)

| Question | Suggested default |
|---|---|
| Which surfaces get video? | Wardrobe grid only (P0) |
| Autoplay always vs hover-to-play? | Autoplay muted loop (matches “living card” intent) |
| Detail/enlarge modal? | Keep static image in v1 |
| Share page public link? | Defer |
| Community page seed Oud Wood? | Defer |
| Kill switch? | `VITE_OUD_WOOD_VIDEO_BETA=0` |

---

## Related docs

- `docs/IMAGE_PIPELINE_HANDOFF.md` — how `imageUrl` is resolved/hydrated (do not mutate for this beta)
- `docs/HANDOFF_page_transition_overlay.md` — example handoff format / file placement convention
