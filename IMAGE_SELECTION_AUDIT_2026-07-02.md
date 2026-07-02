# Image Selection Audit — Wrong Picture Picks & "Find image" Solver Failures

Audit date: 2026-07-02. Scope: the full fragrance bottle-image flow — automatic
resolution on add, the background backfill, the manual "Find image" solver flow
in the detail editor, and the admin replace-image tools.

Companion docs: `IMAGE_PIPELINE_AUDIT.md` (2026-05-06) covered storage/cost
(base64 bloat — remediated); `BUGS_search_select_image.md` (Bug 5) and
`fragrance_search_and_image_issues.md` (Issue 2) cover the *timing* gap
("No image" on save). This audit covers the *correctness* gap — why the image
that eventually arrives is often the wrong picture, and why most "Find image"
solver options appear to do nothing.

---

## 1. Complete logic flow (as implemented today)

### 1a. Automatic path (add-to-vault / profile build)

```
POST /api/scent-profile (routes/scent.ts:118)
  └─ buildProfile(..., { imageResolution: "deferred" })
       └─ scentEngineCore.ts:buildProfileWithDeps
            1. resolveFragranceIdentity(brand, name)      ← may REWRITE brand/name (fuzzy ≥0.82)
            2. catalog hit? → reuse stored catalog image   (scentEngineCore.ts:262-278)
            3. deferred: resolveCachedImage() only         (scentEngineCore.ts:443-446)
               → new fragrance = no cache = imageUrl:""    (the documented "No image" gap)
            4. background resolveImageNow() (scentEngineCore.ts:432-438):
               a. engine-crawled fallback.imageUrl FIRST   (scentEngineCore.ts:386-407)
                  → processed via sourceUrl/"manual" path  → ACCEPTED WITH NO SCORING (see W1)
               b. else Serper search with query:
                  "{brand} {name} single fragrance bottle no box HQ product photo studio no plants"
                  (scentEngineCore.ts:358) + 40-word SERPER_SUFFIX_DEFAULT appended
                  (serperService.ts:92,111-117)            → ~60 words total (see W2)
            5. winner written to image_cache + global_fragrances catalog
               → hydrated to every user's tile via batchHydrateImageUrls
```

### 1b. Manual path — "Find image" with a solver (the detail editor / admin flow)

```
Wardrobe.tsx:1441 handleRefreshImage(item, solverId)      ← button at Wardrobe.tsx:2639
  └─ POST /api/refresh-image (routes/scent.ts:376)
       1. resolveFragranceIdentity()                       ← same fuzzy rewrite risk
       2. server-side throttle (scent.ts:513-524):
          refreshAttemptCounter per (req.ip | brand | name), 1h window
          → 429 after 10 prior attempts REGARDLESS of solver (refreshImageThrottle.ts:16)
       3. resolveRefreshSerperInput() (imageSolvers.ts:57)
          → solver-specific query + refine mode ("default" | "solver" | "none")
       4. resolveProcessedFragranceImage({ allowLookupCache: false, maxCandidates: 6 })
            └─ imagePipeline.ts:585
               - lookup-key + query caches SKIPPED (allowLookupCache: false) ✓
               - Serper search → rankImageCandidates (pre-score, serperCandidateScoring.ts)
               - per-candidate loop:
                   identity skip (<0.34 coverage) → download → Poof BG removal
                   → sharp 1024px WebP → upload → score
                 BUT: processCandidate FIRST checks getReadyCachedImageBySourceHash
                 (imagePipeline.ts:431) → same source URL = SAME OLD IMAGE back (see S2)
               - early-accept: total ≥17 AND identityCoverage ≥0.66 → stop (imagePipeline.ts:55,63,805-819)
       5. result → pendingPreview in UI; catalog upsert on save
```

### 1c. Other manual paths (these work, for contrast)

- **Reimagine** (`/api/reimagine-bottle-image`, `reimagineService.ts`) — OpenAI
  image-edit of the *current* image; no Serper. Requires an existing image.
- **Admin replace** (`routes/adminImages.ts`) — file upload / paste URL /
  source-page extract → `processAdminBottleImage`. No search, no scoring; the
  admin IS the curator. This path is sound.

---

## 2. Why the pipeline picks the WRONG picture (automatic path)

Ranked by impact. W = "wrong image" finding.

### W1 — The engine-crawled fallback image is accepted with ZERO validation (highest impact)

`resolveImageNow()` tries `effectiveFallback.imageUrl` (the image the Python
engine / the SPA's selected search result carried, typically a
`fimgs.net` Fragrantica asset) **before** Serper
(`scentEngineCore.ts:432-438`). It is processed through the
`sourceUrl`/"manual" branch of the pipeline, and in `imagePipeline.ts:755-765`
**any non-serper candidate returns immediately after processing — no identity
coverage check, no concentration check, no candidate scoring of any kind.**
The only gate is the 200px minimum edge.

So whatever image the engine's search result happened to carry — the wrong
flanker on a shared Fragrantica page, a low-res 375×500 `fimgs.net/mdimg`
thumbnail, a generic brand visual — becomes the stored catalog image for that
fragrance, for every user. This is the direct mechanism behind "it's generating
the image from Fragrantica and it doesn't pick the right picture."

### W2 — Composed Serper queries exceed Google's 32-word limit, so the "refinement" mostly never reaches Google

Google (which Serper mirrors) hard-truncates queries at **32 words**. Measured
compositions:

| Path | Composition | Words |
|---|---|---|
| Auto backfill | base + 11-word mid (scentEngineCore.ts:358) + 40-word `SERPER_SUFFIX_DEFAULT` | **~60** |
| Manual refresh, no solver | base + 25-word `DEFAULT_REFRESH_QUERY_SUFFIX` (imageSolvers.ts:43) + 40-word `SERPER_SUFFIX_DEFAULT` **(double suffix)** | **~74** |
| Solver refresh | base + solver tokens + 11-word `SERPER_SUFFIX_SOLVER` | ~20–30 ✓ |

Everything past word 32 is silently dropped, so on the two default paths the
bulk of "no box no tester no sample…" is dead weight — Google effectively sees
the brand/name plus a generic packshot phrase, and returns whatever ranks for
the brand. The no-solver manual refresh applying BOTH suffixes
(`imageSolvers.ts:64` already appends the route suffix, then
`applySerperRefinement` with mode "default" appends the Serper suffix again)
is plainly unintended.

### W3 — Early-accept lets the wrong flanker win at candidate #1

`EARLY_ACCEPT_PROCESSED_SCORE = 17` with `identityCoverage ≥ 0.66`
(imagePipeline.ts:55,63). A trusted-host candidate (fragrantica/sephora/…,
+5) with a bottle-signal title (+4), decent dimensions, and identity bonus
(coverage × 12) trivially clears 17. For a 3-token target like
"Dior / Homme Intense" → tokens [dior, homme, intense], a plain **"Dior
Homme"** packshot scores coverage 2/3 = 0.667 — exactly at the early-accept
line — and short-circuits the loop before the *correct* candidate is even
downloaded.

### W4 — The identity tokenizer erases the words that distinguish variants

`IMAGE_TOKEN_STOPWORDS` (imageCandidateRanking.ts:9-39) removes `edp, edt,
parfum, extrait, elixir, cologne, eau, toilette…` from BOTH the target and the
candidate before coverage is computed. Concentration conflicts are handled
separately (`concentrationConflict.ts`) — but only as a −10/−3 *penalty*, and
the whole parfum family (Parfum/Extrait/Elixir/EDP) is deliberately "soft"
(ambiguous, −3). Net effect: "Sauvage" vs "Sauvage Elixir" vs "Sauvage
Parfum" are near-indistinguishable to the ranker; a −3 demotion rarely
overcomes a +5 trusted host on the wrong bottle.

### W5 — Substring token matching inflates coverage

`hay === token || hay.includes(token) || token.includes(hay)`
(imageCandidateRanking.ts:146-148): "rose" matches "rosewood", "oud" matches
"loud", "noir" matches "noire/renoir". Wrong-product candidates get credit for
tokens they don't actually contain as words.

### W6 — Identity canonicalization can silently swap the fragrance being searched

Both routes call `resolveFragranceIdentity(brand, name)`
(fragranceNameResolver.ts, fuzzy accept at `0.82`) and use the *corrected*
identity for the image search. A near-miss dataset entry (niche/vintage names,
e.g. "Creed Vintage Tabarome" vs "Tabarome") redirects the entire search to a
different product. It logs (`"refresh-image canonicalized fragrance
identity"`, scent.ts:398-409) but the user is never shown what it searched for.

### W7 — Wrong images are sticky once stored

The winner is written to `image_cache` (keyed by lookup key AND source hash)
and upserted into `global_fragrances`; `GET /api/wardrobe` hydrates every
user's tile from the catalog. Every subsequent automatic request serves the
cached wrong image (`getLatestReadyCachedImageByLookupKey`,
imagePipeline.ts:600-606). Only a *successful* manual refresh writes a newer
row — which is exactly the flow that's broken below.

---

## 3. Why "Find image" appears to work ONLY for "Multiple bottles / lineup"

S = solver finding. The 19 dropdown options (`imageRefreshSolvers.ts:28`) map
to server query shapes in `imageSolvers.ts:57-124`. They fail for four
different, compounding reasons:

### S1 — The solver suffix re-adds the exact words the solver negates → contradictory query → empty SERP

`applySerperRefinement` (serperService.ts:111-117) appends
`SERPER_SUFFIX_SOLVER = "single fragrance bottle packshot isolated product
photo **no sample no tester**"` AFTER the solver's tokens. Four solvers emit
`-sample` / `-tester` negatives, producing queries that both exclude and
include the same term (Google treats `-tester … tester` as contradictory and
returns few or zero image results):

| Solver | Negatives that collide with the suffix |
|---|---|
| `low_contrast` | `-sample -tester` |
| `tester_bottle` | `-tester -sample` |
| `text_overlay` | `-sample -tester` |
| `decant` | `-sample` (plus `-ml`, see S4) |

Zero candidates → `resolveProcessedFragranceImage` returns null →
**404 "No image found for this fragrance"** (scent.ts:580-583). These options
literally cannot succeed as composed.

### S2 — Solvers that DO return results usually return the SAME top image URL → cached identical image → perceived no-op

`allowLookupCache: false` skips the lookup/query caches, but
`processCandidate` still short-circuits on the **per-source-URL cache**
(`getReadyCachedImageBySourceHash`, imagePipeline.ts:431). Google's image
ranking barely moves for suffix tweaks like `-hand -holding`, so the #1
candidate is very often the same URL that produced the current (bad) image.
The pipeline instantly returns the previously processed WebP — same
`imageUrl`, same `imageHash` — the preview looks identical to what's already
on the tile, and the user concludes the option "doesn't work."

**Why `group_shot` is the exception:** its query (`"{base} single bottle
isolated"`) has no negatives (no S1 contradiction) and its *positive* re-phrase
genuinely reshuffles Google's image ranking, surfacing new URLs that aren't in
the per-source cache. It's the only option whose click reliably produces a
visibly different image — matching the reported behavior exactly.

Also in this class: `transparent_glass`, `dark_edge_bleed`, `manual_fallback`,
and `abstract_query` are **designed** to send the *unchanged* default query
(imageSolvers.ts:71-80) — combined with S2 they are guaranteed no-ops on the
search side.

### S3 — The throttle exhausts mid-experiment

`REFRESH_MAX_ATTEMPTS = 10` per (IP, brand, name) per rolling hour
(refreshImageThrottle.ts:16, scent.ts:513-524). There are 19 options. A user
(or admin) methodically trying options hits the hard 429 ("Too many image
regeneration attempts for this session") on attempt 12 — from then on **every**
option fails for that fragrance for up to an hour, indistinguishable (to the
user) from "this option is broken."

### S4 — Several solver queries are over-restrictive for image search

- `orientation`: requires BOTH exact phrases `"standing upright"` AND
  `"front profile"` in the doc — near-zero image results.
- `cropped_image`: exact phrase `"full bottle"`.
- `dupe_interference`: exact phrase `"{brand} {name}"` — fails whenever the
  page title styles the name differently.
- `decant`: `-ml` excludes practically every retail listing (titles almost
  always contain "ml").

### S5 — Post-search filters throw away what the solver asked for

After the solver-shaped SERP comes back, the *same* generic gates apply:
pre-score `-Infinity` for candidates without a bottle-word in the title unless
the host is "trusted" (serperCandidateScoring.ts:225), the same
`BLOCKED_TEXT_HINTS`, and the identity skip. A solver that successfully pulls
different-looking results (dark-background artistic shots, etc.) often has all
of them filtered before processing → 404 again.

---

## 4. What the audit did NOT find

- Serper keys/pool: healthy design (`serperService.ts:102-109`), pool
  rotation with retire/cooldown is correct. Not a cause.
- `trust proxy` is enabled (`app.ts:19`) so the throttle key is genuinely
  per-client, not shared.
- The deferred "No image on save" behavior is by design and already
  documented; the self-heal poll works.
- The admin upload/paste-URL path (`adminImages.ts`) is correct and is
  currently the only reliable way to force a specific image.
- Storage/caching layers (content-hash keys, variant isolation, negative-cache
  classifier) are well built; the problem is *what* gets stored, not *how*.

---

## 5. Improvement plan (prioritized)

### Tier 1 — direct bug fixes (small, surgical, high confidence)

1. **Fix suffix composition** (S1, W2): in `applySerperRefinement`, drop
   `no sample no tester` from `SERPER_SUFFIX_SOLVER` (the scorer's
   `BLOCKED_TEXT_HINTS` already handles testers/samples) — or strip any suffix
   token the solver query already negates. Cap ALL composed queries at 32
   words; stop double-appending `DEFAULT_REFRESH_QUERY_SUFFIX` +
   `SERPER_SUFFIX_DEFAULT` on the no-solver refresh path.
2. **Make manual refresh actually produce a new image** (S2): on the
   `/refresh-image` path, pass the item's current `sourceUrlHash`/`imageHash`
   (or an `excludeSourceHashes` list) into the pipeline and skip candidates
   that resolve to the already-displayed image; optionally add a
   `bypassSourceCache` flag for solver runs so a re-processed candidate can
   still differ (e.g. with new Poof options).
3. **Throttle UX** (S3): raise the solver-path ceiling (e.g. 20 with solver),
   return `attemptsRemaining` in the JSON, and show it in the editor so
   exhaustion is legible instead of looking like breakage.
4. **Score the crawled/engine fallback URL** (W1): route the "manual"
   provider through the same identity-coverage + concentration gate before
   accepting (keep unconditional accept ONLY for genuinely user-supplied
   URLs: admin upload, paste-URL, stripBgOnly).

### Tier 2 — ranking correctness

5. **Tighten early-accept** (W3): require `identityCoverage ≥ 0.85` or a
   full-name `phraseBonus` hit for multi-token names before short-circuiting;
   otherwise score all fetched candidates (they're capped at 6 anyway).
6. **Variant-aware identity** (W4): stop stripping concentration/variant
   words from coverage, or add a flanker-conflict check (intense / elixir /
   extrait / noir / sport / absolu…) mirroring `concentrationsConflict`, with a
   hard skip on confident mismatch.
7. **Word-boundary token matching** (W5): replace bidirectional
   `includes()` with exact or prefix-only matching (min length 4 for prefix).
8. **Surface canonicalization** (W6): return `resolvedIdentity` in the
   refresh response and show "Searched as: {brand} {name}" in the editor so a
   silent identity swap is visible and correctable.

### Tier 3 — the "tenfold" curation upgrade

9. **Candidate picker UI** (biggest UX win): add a mode where
   `/refresh-image` returns the top N *raw* Serper candidates (thumbnail URL +
   title + host + score, no processing cost), the user/admin taps the right
   one, and only THAT candidate goes through Poof + sharp + storage via the
   existing `stripBgOnly`/sourceUrl path. This converts 19 guess-based solvers
   into one deterministic "pick the correct bottle" flow and reuses the entire
   existing processing path. (The plumbing already exists: manual `sourceUrl`
   processing, `imagePipelineTrace`, admin paste-URL.)
10. **Vision validation gate**: before persisting an automatic winner to the
    catalog, ask Gemini Flash (integration already in
    `lib/integrations-gemini-ai`) "single bottle of {brand} {name}? yes/no" on
    the processed image; on "no", fall through to the next candidate. This is
    the only reliable fix for wrong-bottle picks that text metadata can't
    catch, and it also gives solver options real teeth (each solver becomes a
    vision-checked assertion rather than a query hint).
11. **Prune the solver list**: collapse the search no-ops
    (`transparent_glass`, `dark_edge_bleed`, `abstract_query`) into processing
    flags (they only change Poof/frontend behavior), and drop solvers whose
    queries can't work (see S4 fixes). A shorter honest list beats 19 options
    where most do nothing.

### Verification hooks already in place

- Every refresh response carries `imagePipelineTrace` (per-candidate skip
  reasons, scores, chosen ordinal) — the admin editor should render it; today
  it is computed and then never shown.
- `pnpm --filter @workspace/scripts run verify:image-pipeline` and the
  existing `imagePipelineCore.test.ts` / `imageSolvers.test.ts` /
  `serperService.test.ts` suites cover the composition functions; Tier 1 items
  1–4 are all unit-testable in those files.
