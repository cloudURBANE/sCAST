# Poof regression follow-up — what the cc0568c patch did and didn't fix

Companion to `scent-trunk-image-pipeline-edge-cases.md`. Captures the live-DB
investigation done on **2026-05-10** after commit `cc0568c` removed the
`hasOpaqueLightBackground` Poof-success rejection guard from
`artifacts/api-server/src/services/bgService.ts`.

Diagnostic:
`artifacts/api-server/src/scripts/inspect-image-state.ts`

## Verified by the patch

- `hasOpaqueLightBackground(poofBuffer)` no longer rejects valid Poof 200
  responses. `verifyPoofPaths.ts` Case 3 (opaque-white 200 → `removed`) is
  green.
- The patch **is** running on production. Two `image_cache` rows from after
  `15:02 UTC 2026-05-10` (`hermes::cologne`, `maison francis kurkdjian::baccarat
  rouge 540`) have `background_removed=TRUE` and were written *with the new
  bgService in place*. Their `global_fragrances.profile_data.imageUrl` was
  overwritten through the catalog upsert at `routes/scent.ts:420`.
- Frontend is clean: `imageProxy.ts:42` skips `?trim=1` for any
  `/images/processed/` URL (commit `b32aeec`), so processed WebPs pass through
  unchanged. No SPA-side white card paints over the bottle.

## What the patch alone does not heal

### Stale `user_fragrances.fragrance_data.imageUrl`

`user_fragrances.fragrance_data.imageUrl` is a JSONB string baked in at the
time the row is inserted or `PATCH /wardrobe/:id` runs. `hydrateImageUrl`
(`fragrancePayload.ts:51`) only fills in **missing** values — it never replaces
a stale URL. So existing wardrobe rows continue to render whatever processed
storage path they had when the regression was active.

Recovery options:

1. Per-row: user clicks refresh in `Wardrobe.tsx`. The SPA calls
   `POST /api/refresh-image` → `PATCH /wardrobe/:id` with
   `syncImageFromCatalog: true`. `resolveSharedImageUrl` reads the (now-fresh)
   `global_fragrances.profile_data.imageUrl` and writes it back to the user
   row.
2. Bulk: `POST /api/wardrobe/rebuild` (`routes/wardrobe.ts:117`) runs
   `buildProfile` → `flattenProfile` → updates every row in the user's vault.
   The `rebuild-user` script in `scripts/` already wraps this; needs the
   running API server.

### Genuine Poof failures still flow through `trimWhiteAndNormalize`

When Poof returns non-200, an empty buffer, or 5xx, `removeBgBuffer`
(`bgService.ts:218`) hands `rawInput` to `trimWhiteAndNormalize`. The
`packshotTrimCore.sampleEdgeBackground` sampler (`packshotTrimCore.ts:57–112`)
medians edge RGB on a 96×96 thumbnail. For typical e-commerce sources whose
corners are opaque-white, `trimByAlpha=false` (line 199) and the trim runs
against the sampled white-RGB. Sharp removes uniform white but leaves
JPEG-noisy edges, so a residual halo of `(255,255,255,255)` can survive the
trim and be re-encoded into the WebP. This is independent of the original
regression — it is the steady-state Poof-down path.

### Mislabeled-but-real-looking fallbacks

The diagnostic pulls each post-patch `bg=FALSE` WebP and runs
`sharp(buf).stats()` against the alpha channel. Some recent
`dior::sauvage` fallbacks have `alpha.mean ≈ 168` with `min=0/max=255`,
which decodes visually as a real partial-transparency packshot even though
the row is recorded as `backgroundRemoved=false`.

Two plausible explanations, both consistent with the code:

1. **Source already had alpha.** Some Serper candidates are merchant PNGs
   with native transparency. When Poof errors, `trimWhiteAndNormalize` runs
   against the original PNG; `trimByAlpha=true` (corner alpha < 32) and the
   bottle's native alpha is preserved through `ensureAlpha` + the WebP
   encode. The bytes look like a packshot, but `bgService` correctly reports
   `backgroundRemoved=false` because Poof didn't actually run successfully.

2. **Poof returned 200 with low-alpha output that survived the encode.**
   `isEffectivelyTransparent` thresholds at `alpha.max <= 4` or
   `alpha.mean <= 0.5`. A Poof output with even 5% pixel coverage above
   alpha=4 sails through both pre- and post-encode guards. We have no
   in-DB evidence of this firing today (no `processing_status='failed'`
   rows on `2026-05-10`), but the post-encode revert at
   `imagePipeline.ts:199` would mark the row `backgroundRemoved=false` if
   the encoded WebP became fully invisible.

The diagnostic distinguishes the two cases by comparing `alpha.mean` to a
known-good control row (a real Poof packshot has mean ≈ 60–100; an
ensureAlpha'd opaque source with transparent padding has mean ≈ 200+).

## Daily success-rate signal

| Day | bg=true | bg=false | total | success rate |
|-----|--------:|---------:|------:|-------------:|
| 2026-05-07 (pre-regression) | 22 | 2 | 24 | 92% |
| 2026-05-08 | 5 | 3 | 8 | 62% |
| 2026-05-09 (regression) | 15 | 26 | 41 | 37% |
| 2026-05-10 (patch lands mid-day) | 4 | 12 | 16 | 25% |

The headline number on 2026-05-10 is misleading because most of the day's
rows pre-date the patch. After 15:02 UTC the post-patch sample is too small
to declare healed (2/6 ≈ 33%); revisit when there are more reads.

## Next investigation threads

- Watch the post-patch bg=true/bg=false ratio over the next 24h. If it does
  not climb back toward 90%, the dominant driver is genuine Poof
  failure/rate-limit, not the removed guard.
- Add structured logging on the `removeBgBuffer` fallback path — currently
  the `removeBgReason` is in the API response and logger but is not
  persisted into `image_cache`. A column for it would make this diagnostic
  reduce to a single SQL query instead of fetching WebPs and counting alpha.
- Decide on user-row recovery: a one-shot "rebuild every wardrobe row" job
  vs. waiting for users to click refresh per fragrance.
- Audit the local-trim white-RGB path in
  `packshotTrimCore.ts:sampleEdgeBackground` for opaque-white sources;
  consider extending the trim threshold or adding a JPEG noise pass before
  trim.
