# Scent Trunk: Image pipeline & edge-case resolution

This document maps **visual failure modes** to **solver functions** and **API payload mutations** for [Serper](https://serper.dev) (image search) and [Poof](https://poof.bg) (background removal). It is the working spec for a **clarify-and-repair** layer on top of the current automated pipeline.

---

## Integration map (this repo)

| Concern | Location | Notes |
|--------|------------|--------|
| Serper image search | `artifacts/api-server/src/services/serperService.ts` | Posts to `SERPER_IMAGE_API_URL` or `https://google.serper.dev/images`. Every query is **suffix-refined** with bottle/packshot hints before the HTTP call. |
| Search entry point | `artifacts/api-server/src/services/imageService.ts` | Thin wrapper around `searchSerperImageUrl`. |
| Poof background removal | `artifacts/api-server/src/services/bgService.ts` | Posts multipart `image_file` + `size`, `format`, `channels` to `https://api.poof.bg/v1/remove`. **No `type` field is sent today** — see Edge Case 6 / 8. |
| Profile build + cache | `artifacts/api-server/src/services/scentEngine.ts` | Default search query: `` `${brand} ${name} single fragrance bottle no box HQ` `` → `searchImageUrl` → `removeBg`. |
| Candidate scoring | `serperService.ts` | Host/text blocklists and trusted-host boosts overlap several edge cases below (e.g. stock hosts, gift set / sample text). |
| Bottle rendering | `artifacts/scent-cast/src/components/BottleImage.tsx` | Placeholder for broken/missing images; `imgClassName` can host Edge Case 15 styles. |

**Implementation gap:** The **Refresh > 2** rule, **Clarify** UI, named **solver functions**, and **dynamic query routing** are specified here but are **not yet wired** end-to-end. Existing behavior is a single search strategy plus Poof + local trim fallback.

---

## Core rule: `refreshCount > 2` (“clarify path”)

**State:** Per image-query session, maintain `refreshCount` (user-driven refreshes or failed attempts — product-defined).

**When `refreshCount > 2`:** Assume standard Serper query parameters are failing (visual or catalog edge case).

1. Stop normal automated Serper polling for that session.
2. Show a **Clarify** control in the UI.
3. On activate: either collect an explicit issue label from the user **or** parse free-text conversation.
4. Dispatch to the **solver** below and **mutate the next** Serper and/or Poof payloads accordingly.

---

## Edge-case matrix & solver functions

Base token **`[Fragrance]`** means the resolved search phrase (typically `brand + product name` after any LLM cleanup).

| # | Edge case | Solver | Serper query mutator (`q`) | Poof / other |
|---|-----------|--------|---------------------------|----------------|
| 1 | Low contrast / white-on-white washout | `solveLowContrast()` | `"[Fragrance] bottle dark background OR black background"` | — |
| 2 | Retail box dominates results | `solveBoxInterference()` | `"[Fragrance] -box -packaging -sealed glass bottle"` | — |
| 3 | Verbatim / conversational query | `solveAbstractQuery()` | Pre-parse with a small LLM: extract `[Brand] [Fragrance]`, map complaint → solver, then run that solver’s mutators | — |
| 4 | Group shots / flanker lineups | `solveGroupShot()` | `"[Fragrance] single bottle isolated"` | — |
| 5 | Heavy watermarks / stock | `solveWatermark()` | `"[Fragrance] -stock -watermark -alamy -getty"` | Aligns with `BLOCKED_HOST_HINTS` in `serperService.ts` for several aggregators |
| 6 | Transparent glass erased by removal | `solveTransparentGlass()` | — | Set Poof JSON field **`type`: `"product"`** (spec; not sent by current `bgService`) — today code uses only file + `size` / `format` / `channels` |
| 7 | Tester / missing cap | `solveTesterBottle()` | `"[Fragrance] -tester \"with cap\""` | — |
| 8 | Hand / grip in frame | `solveHandInterference()` | `"[Fragrance] -hand -holding"` | Poof: **`type`: `"product"`** (same caveat as 6) |
| 9 | Extreme reflections / mirror | `solveStudioReflection()` | `"[Fragrance] matte lighting OR white studio background -mirror"` | — |
| 10 | Splash / liquid props | `solveLiquidSplash()` | `"[Fragrance] -splash -water -drops -floating"` | — |
| 11 | Gift sets & bundles | `solveGiftSet()` | `"[Fragrance] -set -lotion -wash -bundle -gift"` | Overlaps `BLOCKED_TEXT_HINTS` (`gift set`, `bundle`, …) |
| 12 | Tilted / lying bottle | `solveOrientation()` | `"[Fragrance] \"standing upright\" \"front profile\""` | — |
| 13 | Refill / travel / canister | `solveRefillFormat()` | `"[Fragrance] -refill -travel -vial -canister -pouch"` | — |
| 14 | Promotional text / ads | `solveTextOverlay()` | `"[Fragrance] -ad -poster -text -promotional"` | — |
| 15 | Dark bottle vanishes on dark UI | `solveDarkEdgeBleed()` | *(no API change)* | Frontend: e.g. `filter: drop-shadow(0 0 8px rgba(255,255,255,0.15))` or SVG stroke on the bottle `<img />` — use `BottleImage` `imgClassName` or frame tokens |
| 16 | Clone / dupe bottles | `solveDupeInterference()` | `"\"[Exact Brand] [Exact Fragrance]\" -inspired -clone -type -impression"` | — |
| 17 | Decants & sample vials | `solveDecant()` | `"[Fragrance] -decant -sample -ml -split"` | Overlaps blocked hints like `sample`, `decant` |
| 18 | Cropped / macro only | `solveCroppedImage()` | `"[Fragrance] \"full bottle\" -macro -closeup"` | — |
| 19 | Niche / sparse catalog | `solveNicheScraping()` | Restrict domains, e.g. `"[Fragrance] site:parfumsdemarly.com OR site:fragrantica.com"` (adjust per brand) | — |
| 20 | Poof mask repeatedly broken | `solveManualFallback()` | Suspend Poof | Serve **raw** image into a manual crop UI **or** glassmorphic placeholder with fragrance name |

---

## Design notes for implementers

1. **Serper `q` vs current suffix:** Today `searchSerperImageUrl` always appends a long fixed suffix (`single fragrance bottle bottle only no box …`). Solvers should either **replace** that default with an alternate refinement strategy on the clarify path or **merge** mutators so negative keywords are not overridden by conflicting positives — decide one policy and keep it consistent.
2. **Poof `type`:** Confirm Poof’s documented `type` values (`auto` vs `product`) before sending; extend `removeBgByFile` / `FormData` to include `type` when the solver requires it.
3. **Telemetry:** Logging `solverId`, `refreshCount`, and final `q` (redacted if needed) will make Edge Cases 3 and 20 debuggable in production.
4. **Safety:** User-authored text for Edge Case 3 must be sanitized before becoming a search query (length limits, no raw URLs if undesired).

---

## Related environment variables

- `SERPER_API_KEY`, optional `SERPER_IMAGE_API_URL`
- `REMOVE_BG_API_KEY` (Poof)

See `.env.example` in the repo root for canonical names.
