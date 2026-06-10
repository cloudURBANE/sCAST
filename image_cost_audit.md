# Image Generation Cost Audit

_Scope: inspection only. Repo: `huge_monorepo`. Date: 2026-06-07._

## Executive summary

The app makes exactly **one** kind of OpenAI image-generation call: the "Reimagine
bottle" feature, which sends a reference image to OpenAI's **image edits**
(image-to-image) endpoint. It is hard-wired to **`gpt-image-2` at `quality=high`,
`size=1024x1024`**, with a **2048×2048 PNG reference image** and a ~400-word prompt
on every call.

The cost exposure is driven less by the per-call settings than by **who can call it
and how often**: the endpoint is **intentionally unauthenticated, has no rate limit,
no per-user cap, no credit gate, and — critically — no cache pre-check**, so an
identical reimagine of the same bottle bills OpenAI again every time. Token-level
usage (the actual `gpt-image-2` cost basis) is **not** recorded; the in-app meter is a
hard-coded flat-per-image estimate that does not reflect token-based billing.

## Where image generation is called

| Concern | Location |
|---|---|
| OpenAI call site | `artifacts/api-server/src/services/reimagineService.ts` → `callOpenAIImageEdits()` (line ~192), endpoint `https://api.openai.com/v1/images/edits` (`OPENAI_IMAGE_EDITS_ENDPOINT`, line 32) |
| Public entry point | `artifacts/api-server/src/routes/scent.ts` → `POST /api/reimagine-bottle-image` (line 519) |
| UI trigger | `artifacts/scent-cast/src/components/Wardrobe.tsx` → `handleReimagine()` (line 1214), "Reimagine" button (line ~2017/2034) |
| Usage ledger | `artifacts/api-server/src/services/apiUsageLedger.ts` (`recordApiUsage`, price table) |
| Usage meter API | `artifacts/api-server/src/routes/usage.ts` → `GET /api/usage/total` |

This is the **only** OpenAI image path. `POST /api/scent-profile` and
`POST /api/refresh-image` use the Serper → Poof (bg removal) → sharp pipeline and do
**not** call OpenAI.

## Confirmed cost drivers (evidence-based)

1. **Model is forced to `gpt-image-2`, the env override is dead.**
   `SUPPORTED_REIMAGINE_MODELS = ["gpt-image-2"]` and `DEFAULT_REIMAGINE_MODEL = "gpt-image-2"`
   (`reimagineService.ts:26-29`). `resolveModel()` only accepts values inside that
   list for both the request body and `OPENAI_REIMAGINE_MODEL`. The shipped
   `.env.example` sets `OPENAI_REIMAGINE_MODEL=gpt-image-1` (line 46) — but
   `gpt-image-1` is **not** in the supported list, so it is silently ignored and the
   code falls back to `gpt-image-2`. **The cheaper-model knob does nothing.**

2. **Quality is hard-coded to `high`.** `DEFAULT_REIMAGINE_QUALITY = "high"`
   (line 31), sent as `form.append("quality", "high")` (line 204). `high` is the most
   expensive quality tier and the single largest controllable token lever. Not
   user- or env-adjustable.

3. **A large reference image is uploaded on every call (image input tokens).**
   `OPENAI_INPUT_MAX_DIMENSION = 2048` (line 41); `toPngForOpenAI()` resizes the
   reference up to 2048×2048 PNG and sends it via `images.edits` (line 199). For
   `gpt-image-2`, image **input** tokens scale with input resolution — a 2048px
   reference costs materially more in input tokens than a 1024px one. The code
   comment explicitly chose 2048 for fidelity, accepting the cost.

4. **No cache short-circuit — identical reimagines re-bill.** `reimagineBottleImage()`
   loads the source bytes and calls OpenAI immediately (lines 301-321). It never
   checks `image_cache` / lookup-key first. The result *is* written to `image_cache`
   afterward, but it is never read back to avoid a repeat call. Re-clicking
   "Reimagine" on the same bottle (same brand/name/source) triggers a **full new
   billed generation** each time. (Contrast: the normal pipeline in
   `imagePipeline.ts` checks caches first.)

5. **Endpoint is unauthenticated with no rate limit / cap / credit gate.**
   `scentRouter` is mounted with no auth (`routes/index.ts:23`, `router.use(scentRouter)`),
   and the `POST /api/reimagine-bottle-image` handler has no `requireAuth`, no rate
   limiter, and no per-user/per-IP quota (`scent.ts:519-596`). The only gate is the
   `ENABLE_REIMAGINE` flag, which **defaults to enabled** (the check only blocks when
   the var is set to a value other than `"true"`; unset = allowed — `scent.ts:520`).
   The `usage.ts` comment confirms the route is "intentionally unauthenticated" to
   support the anonymous preview-then-save flow.

6. **Regeneration button + no idempotency.** The "Reimagine" button is a manual
   regeneration control. The frontend guards only against *concurrent* double-clicks
   on the same item (`reimaginingIds` set, `Wardrobe.tsx:1215/1223`); nothing limits
   repeated *sequential* generations.

7. **Large prompt sent every call (text input tokens).** `REIMAGINE_PROMPT`
   (`reimagineService.ts:57-93`) is ~400 words and is sent verbatim on every request.
   Small relative to image tokens, but non-zero and constant.

8. **Token usage is not tracked; cost is a flat estimate.** `recordApiUsage` is
   always called with `inputTokens`/`outputTokens` unset → stored as `null`
   (`reimagineService.ts:324-347`). The ledger computes cost from a **hard-coded
   flat-per-image table** (`apiUsageLedger.ts:21-51`), and the `gpt-image-2` rows are
   explicitly annotated "pricing not yet published … best estimate" (line 32,
   `high` = $0.20/image). Because `gpt-image-2` is token-based, the in-app
   "Reimagine spend so far" meter does **not** reflect real billed cost and likely
   **understates** it for high-quality + 2048px-input generations.

9. **No per-user attribution.** The route calls `reimagineBottleImage(...)` without
   `userId`/`fragranceId` (`scent.ts:564-569`), so every ledger row is `userId = null`
   and cost cannot be attributed to a user/session — masking any single abusive caller.

## Risk ranking

| Risk | Driver | Why |
|---|---|---|
| **HIGH** | #5 unauthenticated + no rate limit/cap (+ default-on) | Anyone can repeatedly trigger `gpt-image-2 high` generations; no spend ceiling. |
| **HIGH** | #4 no cache pre-check | Same bottle re-bills on every click/retry. |
| **HIGH** | #2 + #3 `quality=high` + 2048px reference | Largest token levers, both maxed and non-configurable. |
| **MEDIUM** | #1 dead model override | Intended cheaper model (`gpt-image-1`) is silently upgraded to `gpt-image-2`. |
| **MEDIUM** | #8 no token tracking / flat estimate | Real spend invisible; meter unreliable for the token-priced model. |
| **LOW** | #7 large prompt | Constant text-input overhead, minor vs image tokens. |
| **LOW** | #9 null userId | Limits forensics, not itself a spend driver. |

## Likely reason costs are high

The combination of **(a) an open, uncapped endpoint**, **(b) no result caching so
repeats re-bill**, and **(c) every call maxed to the costliest configuration**
(`gpt-image-2`, `quality=high`, 2048px image input) means each "Reimagine" click — and
each repeat of the same bottle — incurs near-worst-case `gpt-image-2` token cost, with
no ceiling on volume. Because token usage isn't logged, this has likely been
accumulating without an accurate in-app signal.

## Minimum safe changes recommended (not performed)

1. **Add a cache pre-check** in `reimagineBottleImage()`: look up `image_cache` by
   `(lookupKey, source hash)` and return the stored result instead of calling OpenAI
   when a prior reimagine exists.
2. **Gate the endpoint**: add `requireAuth` and/or a per-user/per-IP rate limit and a
   credit/quota check on `POST /api/reimagine-bottle-image`.
3. **Lower the cost levers**: make `quality` and input `OPENAI_INPUT_MAX_DIMENSION`
   configurable; consider `quality=medium` and a 1024px reference as defaults.
4. **Fix or remove the dead model override** so `OPENAI_REIMAGINE_MODEL` (or a cheaper
   supported model) actually takes effect, or update `.env.example` to stop implying
   `gpt-image-1` is selectable.
5. **Record token usage** (`input_tokens`, image input/output tokens) and `userId` on
   the ledger row, and update the `gpt-image-2` price entries to published rates.

## What not to touch

- The Serper/Poof/sharp pipeline (`imagePipeline.ts`, `bgService.ts`, `scent-profile`,
  `refresh-image`) — not an OpenAI cost path.
- The deferred-image / wardrobe re-hydrate logic — unrelated to generation cost.
- `recordApiUsage` ledger insert semantics beyond adding fields — it already degrades
  gracefully when the table is missing.
- The `REIMAGINE_PROMPT` wording — it is tuned for identity/bg-removal correctness;
  trimming it for tokens risks output quality for marginal savings.

## Open questions (need OpenAI dashboard / API usage confirmation)

1. **Actual `gpt-image-2` billed cost per call** at `high` / 1024×1024 output with a
   2048px input — the repo's price table is an unverified estimate.
2. **Real image-input token cost of the 2048px reference** vs a 1024px reference —
   confirms the savings of change #3.
3. **Call volume & repeat rate** from the OpenAI dashboard — how much spend is repeat
   reimagines of the same bottle (validates the missing-cache impact) vs unique ones.
4. **Evidence of unauthenticated/abusive traffic** to `/api/reimagine-bottle-image`
   (the ledger can't show it — `userId` is always null).
5. Whether **`ENABLE_REIMAGINE`** is actually set in the production environment, or
   relying on the default-on behavior.
