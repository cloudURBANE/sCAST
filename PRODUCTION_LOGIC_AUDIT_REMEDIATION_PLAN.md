# Production Logic Audit & Remediation Plan

**Date:** 2026-06-26
**Branch:** `claude/production-issues-audit-s9zuir`
**Method:** 6 parallel domain audits (frontend scoring, external-engine integration, backend scent engine, image pipeline, auth/DB integrity, frontend state/UX). All findings carry `file:line` evidence. Read-only investigation; no code changed yet.

This document is the **fix plan**. It groups 33 raw findings into 11 production-grade workstreams, de-duplicated across layers, and ordered by real end-user impact. Each workstream states the symptom, root cause, the production-grade implementation, the files, verification, and regression risk.

---

## Implementation status (updated 2026-06-28)

All 18 workstreams are implemented and merged/landed on `main` except the one
operator-only DB step noted below. Verified this session: full `pnpm run
typecheck` clean; api-server **821 pass / 0 fail**; scent-cast **206 pass / 0 fail**.

| WS | Status | Notes |
| -- | ------ | ----- |
| WS-1 | ✅ Done | `lookupKey` threaded + scoped in the search-query cache and flight key. |
| WS-2 | ✅ Done | Runner-up margin + symmetric query-adds-variant penalty in catalog match. |
| WS-3 | ✅ Done | `weather.data_complete` from pre-default values + `setting.recognized`; default path can no longer yield "high". |
| WS-4 | ✅ Done | Guest wardrobe migrated/uploaded on sign-in, deduped, once-guarded. |
| WS-5 | ✅ Done (code) | Idempotent add + per-user unique index in schema. **Operator must apply `migrations/0002_user_fragrances_client_id_unique.sql`** (dedup-then-unique-index) — `drizzle push` is guarded; the route is deploy-safe before it lands. |
| WS-6 | ✅ Done | `oauth_error` codes mapped to user-facing messages in `AuthContext`. |
| WS-7 | ✅ Done | Tokenized whole-note matching, primary-axis assignment, magnitude-aware family inclusion. |
| WS-8 | ✅ Done | Catalog don't-downgrade merge + per-key build dedup + image-only deferred merge. |
| WS-9 | ✅ Done | (a) no-cache-degraded + abort-check + 6h TTL; (b) persisted client attempt cap; (c) **server-authoritative heal-resync via `accordHealVersion` in `fragrance_data`** (this session — no migration needed). |
| WS-10 | ✅ Done | Email auto-link only when no existing `oauth_subject`; `linkGoogleSubject` guarded by `WHERE oauth_subject IS NULL`. |
| WS-11 | ✅ Done | `/scent-profile` + `/search-scent` body validation + try/catch graceful failure (this session). |
| WS-12 | ✅ Done | Identity-coverage gate on early-accept + center-region alpha + min-edge floor. |
| WS-13 | ✅ Done | Trait texts + OutlookCandidate precomputed once; stable scoring signature. |
| WS-14 | ✅ Done | Spray-count clamp+assert; warmth divisor from clamp constants + widened cold floor; zero-trait confidence demotion. |
| WS-15 | ✅ Done | Route-scoped ErrorBoundary + order-stable reconcile serialization. |
| WS-16 | ✅ Done | `requeueFragranceDetails` non-idempotent; engine-fallback provenance + preserved original error. |
| WS-17 | ✅ Done | Per-row `rebuilt_at` stamp + opt-in resumable rebuild. |
| WS-18 | ✅ Done | `POST /api/auth/logout` rotates token; admin-unconfigured returns 503. |

**Remaining operator action:** apply migration `0002` to the shared Supabase DB
per CLAUDE.md (`ALLOW_PROD_DB_PUSH` is not used for this — run the reviewed SQL
directly; `CREATE/DROP INDEX CONCURRENTLY` must run outside a transaction).

### Finishing pass (2026-06-28) — residual gaps closed

A three-domain re-audit of the "remaining follow-ups" found and fixed three
genuine residual gaps the original pass left open; the rest were verified
already-solid. Full `pnpm run typecheck` clean; api-server **824 pass / 0 fail**,
scent-cast **206 pass / 0 fail**, scent-weather-engine **30 pass / 0 fail**.

- **WS-2 (now closed in code, not just tests):** the flanker→base guard was
  missing real **concentration agreement** — concentration tokens live in
  `EXTRA_WORDS_ALLOWED`, so "Bleu de Chanel Parfum" matched a "…Eau de Parfum"
  catalog row, and EDP↔EDT likewise. Added a concentration-conflict cap (reusing
  `concentrationConflict.ts`) and removed an over-broad `inputHasNumber` exemption
  that let "1 Million" → "1 Million Elixir" through. The "spot-check against real
  traffic" is now a permanent table-driven regression guard over real flanker/base
  pairs (`fragranceNameResolver.test.ts`).
- **WS-10 (hardened):** `createGoogleUserWithFallback` was a non-atomic
  insert+catch; replaced with an atomic `onConflictDoUpdate` on `(tenantId,email)`
  using `coalesce(existing, excluded)` so a racing first-login collapses to one row
  and can never rebind an already-bound `oauth_subject` (hijack-safe).
- **WS-17 (now reachable):** the resumable-rebuild path existed but no caller
  passed `resumeWithinMs`; wired it as an opt-in body param on
  `POST /api/admin/wardrobe/rebuild` so a crashed rebuild is genuinely re-runnable.
- **WS-12 (now closed in code):** the planned post-decode **min-edge floor** was
  never implemented (only a scoring penalty), so a dimensionless SERP thumbnail
  could still win and be stored as a bottle. Added a `MIN_PROCESSED_EDGE = 200`
  rejection in `processSourceToWebp` + a boundary test.

WS-11's optional generated-Zod validation was assessed and intentionally **not**
added: the hand-rolled `validateScentProfileBody`/`validateSearchScentBody` already
cover every malformed-payload case (15 tests) and both routes are try/catch-graceful;
generated Zod would require modelling these bodies in `openapi.yaml` and only
duplicate existing coverage.

**Recommended spot-check:** WS-2 flanker/base matching against real traffic (now
also covered by the regression guard above).

---

## Severity model

| Tier | Meaning |
| ---- | ------- |
| **P0** | Actively wrong/destructive for end users right now: wrong data shown, data loss, broken sign-in, account-ownership risk. |
| **P1** | Misleading results or fragile correctness under normal real-world conditions; silent degradation. |
| **P2** | Robustness, performance, and hardening — degrades UX or invites future regressions but not actively breaking core flows. |

---

# P0 — Correctness, data-loss, trust

## WS-1 · Image cache serves the wrong bottle across fragrances (cache poisoning)
**Findings:** image C1, C2, H1, H3.
**Symptom:** Fragrance B can display fragrance A's bottle. Intermittent "right yesterday, wrong today."
**Root cause:** The **search-query cache lookup** and the **in-flight dedup map** are keyed on the query hash alone, with no `lookupKey`; the **source-hash positive cache + `recordImageReady` upsert** treat "same source bytes" as "same fragrance," and the unique index `(source_url_hash, pipeline_version, background_removed)` lets the last writer rebind the row's `lookupKey`.
**Production-grade fix:**
- Add `eq(imageCacheTable.lookupKey, lookupKey)` to `getLatestReadyCachedImageBySearchQueryHash` and thread `lookupKey` in (`imageCacheService.ts:326-356`, callsite `imagePipeline.ts:546-552`). The search-query hash should disambiguate *within* a fragrance, never *across* fragrances.
- Incorporate `lookupKey` into the search-query flight key: `${lookupKey}:${searchQueryHash}:${bg}` (`imagePipeline.ts:128-132, 512-520`).
- For `sourceProvider: "serper"` rows, require `lookupKey` match on the positive source-hash lookup and scope the upsert conflict target so a per-fragrance Serper pick can't rebind another fragrance's row (`imageCacheService.ts:248-287, 466-495`). Keep pure-bytes dedup only for `manual` sources.
**Verify:** Unit test two distinct `lookupKey`s that normalize to the same search query → each resolves its own row; concurrent resolve of both → no cross-serve. `pnpm --filter @workspace/api-server run test`.
**Risk:** Low; tightens lookups only. Watch cache hit-rate (slightly lower, correctly).

## WS-2 · Wrong fragrance returned by fuzzy catalog match (flanker → base scent)
**Findings:** backend #3.
**Symptom:** The classic "couldn't find / wrong fragrance" — searching a flanker (e.g. *Sauvage Elixir*) returns the base *Sauvage* profile, notes, and image; adding it persists the wrong data.
**Root cause:** `searchCatalogCandidates` admits substring-containment matches (the `similarity` 0.94 containment cap) and takes `hits[0]` with **no runner-up margin check** — unlike `bestDatasetMatch`, which requires a 0.04 margin. Query-adds-variant is not penalized (only candidate-adds-variant is).
**Production-grade fix:**
- Apply the `bestDatasetMatch` runner-up margin rule to `searchCatalogCandidates` (reject when top two are within ~0.04 and top < ~0.97) (`catalogService.ts:89-118`, `fragranceNameResolver.ts:283-367`).
- Add a symmetric **query-adds-variant** penalty in `similarity`/`candidateScore` so a flanker token absent from the candidate lowers the score.
- Require concentration agreement when the query carries an explicit concentration token (EDP/Elixir/Parfum).
**Verify:** Table test of known flanker/base pairs asserting no substitution; existing fix-playbook cases.
**Risk:** Medium — too-tight gating could regress legitimate fuzzy hits. Land behind tests covering both "should match" and "must not match" pairs.

## WS-3 · Recommendations present fabricated confidence on missing weather / unknown occasion
**Findings:** scoring CRITICAL, scoring HIGH (unknown→indoor).
**Symptom:** When the weather API fails/partials, the app scores the whole vault against an invented 72°F/50%/0mph day and surfaces a **"High Confidence"** pick. An unrecognized occasion silently becomes `indoor` — pushing fresh/citrus and flagging oud/amber/gourmand as "avoid," the opposite of an outdoor/night intent.
**Root cause:** `buildEngineInput` fills missing weather with neutral defaults **before** the engine's real `hasCompleteWeather` guard runs, so the guard is dead code. `mapDestinationToEngineType` catch-all returns the most restrictive `indoor`, so `isKnownSetting` can never be false either — both confidence demotions are inert in production.
**Production-grade fix:**
- Compute `weatherComplete` from the **pre-default** weather values and thread it into the engine input so `calculateConfidence` can demote; never allow the default path to yield `confidence: "high"` (`WardrobeContext.tsx:718-720`, `scentWeatherEngine.ts:272-282, 785`). Surface a "using default conditions" annotation when `locationSource === 'fallback'`.
- Map only known destinations; unknown → neutral `mixed` plus a genuine `settingKnown:false` flag. Add an exhaustiveness switch over `DestinationType` so a new value is a compile error, not a silent indoor fallback (`WardrobeContext.tsx:401-411`, `scentWeatherEngine.ts:284-286`).
**Verify:** Engine unit tests: missing temp/humidity → confidence ≤ medium + flag; unknown destination → mixed, not indoor.
**Risk:** Low; restores intended behavior. Some picks will (correctly) drop to medium/low confidence.

## WS-4 · Guest wardrobe silently destroyed on sign-in (data loss)
**Findings:** frontend C1.
**Symptom:** A guest builds a vault, the UI prompts "sign in to save your wardrobe," and after sign-in **every guest item is gone** — the exact opposite of the prompt's promise.
**Root cause:** The `null → token` auth effect does `setItems([])` then loads only server rows; the guest array in `localStorage` is never migrated/uploaded.
**Production-grade fix:** On the auth-token transition, read `readGuestWardrobeItems()`; if non-empty, upload each via the existing `handleAddItem` server path, de-duplicated against loaded server rows by `vaultIdentityKey`; only clear `GUEST_WARDROBE_STORAGE_KEY` after confirmed upload; guard with a once-per-sign-in ref and merge optimistically so there's no empty flash (`WardrobeContext.tsx:1386-1392, 1028, 2302`).
**Verify:** Manual: guest add 3 items → sign in → all 3 present, server rows created, no dupes. Add a reconcile unit test for the merge.
**Risk:** Medium — must dedupe against server rows and be idempotent on repeated sign-ins. Depends on WS-5 dedupe.

## WS-5 · Duplicate wardrobe rows (no idempotency in the write path)
**Findings:** frontend H2 (UI-only guard), auth M5 (no DB unique index), auth M4 (client-controlled PK collision).
**Symptom:** Same fragrance appears twice in the vault; recommendation/ticker stats double-count it. Also, a client-supplied UUID reused across users can collide on the global PK → 500 on add.
**Root cause:** The duplicate guard lives only in the search UI (`vaultIdentityKeys`); `handleAddItem` and the server route are check-then-insert with no canonical dedupe and **no DB unique constraint** on `(user_id, fragrance_data->>'id')`. The route trusts `clientId` as the global PK.
**Production-grade fix:**
- In `handleAddItem`, short-circuit on `vaultIdentityKey(brand,name)` match before optimistic insert, returning a `duplicate` flag (`WardrobeContext.tsx:1486-1499`).
- Server: always `id = randomUUID()`; keep the client id inside `fragrance_data->>'id'` (`routes/wardrobe.ts:237-248`).
- Add an expression `unique` index on `(user_id, (fragrance_data->>'id'))` and switch add to `onConflictDoUpdate` so the operation is atomically idempotent (`lib/db/src/schema/userFragrances.ts:32-35`). DB push is **guarded** — coordinate per CLAUDE.md (`ALLOW_PROD_DB_PUSH`, scoped `tablesFilter`).
**Verify:** Double-submit test adds one row; curate-loop add is idempotent; cross-user same-client-id no longer 500s.
**Risk:** Medium — schema change needs a guarded prod push and a pre-push dedupe of any existing duplicate rows or the unique index creation fails.

## WS-6 · OAuth failures strand the user on a blank screen
**Findings:** auth #1.
**Symptom:** Declined consent, unverified email, or a transient Google failure bounces the user back to a normal signed-out app with **zero feedback**; unverified-email users can never sign in and are never told why.
**Root cause:** Backend redirects to `/?oauth_error=...` on every failure path, but the SPA never reads `oauth_error` — the producer/consumer contract was never connected.
**Production-grade fix:** In the `AuthContext` initializer, read `oauth_error`, map each code (`no_code`, `token_exchange`, `user_info`, `missing_email`, `unverified_email`, `server_error`) to a user-facing message, open the auth modal with it, and `replaceState` to strip the param (`AuthContext.tsx:40-54`, `routes/oauth.ts:217-310`).
**Verify:** Manual: simulate each error redirect → correct message shown, param stripped.
**Risk:** Very low; additive.

---

# P1 — Misleading results & fragile correctness

## WS-7 · Scent-vector quality: distorted vectors drive every recommendation
**Findings:** backend #1 (substring double-count + cross-axis leakage), backend #2 (+2.5 floor collapses dynamic range; description always scored), scoring MEDIUM (binary presence discards magnitude & negative axes).
**Symptom:** Clean woody scents tagged spicy/musky; most fragrances cluster at similar vectors; context buckets flip on a single token; a barely-woody scent and a woody bomb get the same family verdict and "avoid" list.
**Root cause:** `scoreText` uses raw `String.includes` (substring false positives, shared tokens inflating 2–3 axes); any hit jumps to ≥3.5 and the marketing description is scored on every axis; downstream the 0–10 vector is then collapsed to boolean `value > 0` presence, dropping magnitude and negative anti-signals.
**Production-grade fix:**
- Tokenize notes and match whole tokens / known multi-word phrases; fire each axis-rule at most once per distinct note; assign a primary axis to shared ingredients (oud, ambroxan, iso-e) to stop cross-axis leakage (`scentVectorizer.ts:109-117`).
- Normalize raw axis scores by matched-weight/note-count before flooring; drop/cut the unconditional +2.5; only score the description when pyramid/notes are empty (mirror the `hasPyramid` guard) (`scentVectorizer.ts:144-153`).
- In the engine consumer, threshold family inclusion on meaningful magnitude (e.g. ≥0.3) or weight by axis value instead of boolean presence (`scentWeatherEngine.ts:230-236`, `WardrobeContext.tsx:485-487`).
**Verify:** Golden-vector tests on a set of reference fragrances (oud, aquatic, gourmand, citrus) asserting dominant axis and no cross-axis inflation.
**Risk:** Medium-high — this shifts recommendations broadly. Snapshot current vs new vectors for a reference set and review before merge.

## WS-8 · Shared catalog rot under the real add + poll flow
**Findings:** backend #4 (minimal profile overwrites richer row), backend #6 (no in-flight dedup → concurrent adds race + duplicate paid Serper spend), backend #7 (deferred retry re-writes stale snapshot).
**Symptom:** A fragrance that had notes/vector/image loses them for **everyone** after one user's pending-add misses enrichment; occasional flicker where fresh notes vanish seconds after appearing; redundant Serper cost.
**Root cause:** `saveCatalogEntry` `onConflictDoUpdate` overwrites `profileData` wholesale with no "don't downgrade" guard; `buildProfile` has no per-key promise dedup; the deferred background save re-writes the request-time snapshot.
**Production-grade fix:**
- Add a "don't downgrade" merge in `saveCatalogEntry`: never overwrite non-empty `notes`/real `family`/`imageUrl` with empty/`Unknown Family`/missing; pass an `isMinimal` flag from the fallback path and refuse the save (`catalogService.ts:232-238`, `scentEngineCore.ts:427-432, 488`).
- Add a `Map<lookupKey, Promise<ScentProfile>>` dedup in `buildProfile` (mirror the image pipeline), collapsing concurrent identical builds and their deferred retry loops (`scentEngineCore.ts:202-545`).
- In the deferred save, re-read the current row and merge only image fields onto the latest stored profile (`scentEngineCore.ts:505-541`).
**Verify:** Concurrent-add test → one build, no downgrade; minimal fallback never clobbers a populated row.
**Risk:** Medium; touches the save path. Best-effort failures must stay non-fatal.

## WS-9 · External-engine integration: stale cache, runaway self-heal, redundant re-fetch
**Findings:** ext #1 (7-day query-only cache replays stale/degraded results + ignores abort), ext #3 (self-heal only durable brake is engine-controlled counter → perpetual polling on un-completable rows), ext #4 (heal-resync re-fetches every complete row on new device/guest).
**Symptom:** Repeating a search replays a week-old degraded result with no refresh; a stale response can win after the user typed a new query; fragrances the engine can never fully enrich poll the engine every 15s for the life of the wardrobe row (backoff resets each reload); fresh devices/guests re-fetch and re-persist the entire already-complete vault.
**Root cause:** Cache lookup precedes freshness/abort/degradation logic and the key carries no quality signal; the self-heal termination relies on engine-supplied `requested_count` while the client circuit-breaker is in-memory only; heal-resync "done" set is per-token localStorage, not server-authoritative.
**Production-grade fix:**
- Don't cache degraded/fallback responses or sub-threshold result counts; check `options.signal?.aborted` before returning cache; shorten the 7-day TTL (`fragranceApi.ts:432-460, 1429-1451`).
- Persist a client-side attempt counter + the `detailRefreshBackoffRef` map (keyed by `detailRefreshKeyFor`) to localStorage; stop refreshing after N client-observed attempts regardless of engine counter (`WardrobeContext.tsx:364-374, 1055, 2043-2133`).
- Record heal-resync completion server-side (or via an `accord_heal_version` on the persisted row) so it's authoritative across devices/guests (`WardrobeContext.tsx:2015-2049`).
**Verify:** Abort test (search A then B → A rejects/ignored); un-completable row stops after N attempts and survives reload; complete vault on a fresh session triggers no refetch burst.
**Risk:** Medium; self-heal is load-bearing for partial-tile recovery — keep the genuine-partial refresh, only cap the un-completable case.

## WS-10 · Account-ownership safety on OAuth (link hijack + first-login race)
**Findings:** auth #2 (email-only matching can rebind an account to a new subject), auth #3 (non-atomic find-or-create → duplicate users / 500s).
**Symptom:** If an account exists for an email without an `oauth_subject` (legacy/email-only/admin-created), the first Google login for that email **adopts that account and its wardrobe**; double-clicked sign-in can race to duplicate inserts and transient `server_error`.
**Root cause:** Email treated as a trusted account key; `linkGoogleSubjectBestEffort` rebinds `oauth_subject` unconditionally; find-or-create is a non-atomic check-then-insert leaning on the unique constraint as a backstop; `tenantId` is nullable so NULL-tenant rows don't conflict.
**Production-grade fix:**
- Auto-link by email **only** when the existing row has no `oauth_subject` and was itself email-verified; guard `linkGoogleSubjectBestEffort` with `WHERE oauth_subject IS NULL` so an existing subject is never rebound (`routes/oauth.ts:273-283`, link helper L86-92).
- Replace create with a single `insert(...).onConflictDoUpdate({ target:[tenantId,email], ... }).returning()`; ensure `tenantId` is always non-null before the write (`createGoogleUserWithFallback` L122-138).
**Verify:** Concurrent first-login test → one row, no 500; existing-subject account is not rebound by a different `sub`.
**Risk:** Medium — auth path; needs careful testing of legacy email-only accounts and the tenant-null assumption.

## WS-11 · Add-route hardening: validation + graceful failure
**Findings:** backend #5.
**Symptom:** A malformed/partial client payload (e.g. `notes` sent as a string) or a transient DB blip turns "add fragrance" into an opaque 500 instead of the designed graceful "pending card."
**Root cause:** `/scent-profile` and `/search-scent` have no try/catch and read the body with raw casts — no Zod validation; bad shapes reach `parseFragrance` and throw.
**Production-grade fix:** Wrap both handlers in try/catch returning a friendly 502/503; validate bodies with the generated `@workspace/api-zod` schemas (assert `notes`/`pyramid.*` are bounded string arrays) before `buildProfile` (`routes/scent.ts:136-199, 223-348`).
**Verify:** Malformed payload → 400 with message, not 500; DB blip → graceful degrade.
**Risk:** Low; additive guards.

---

# P2 — Robustness, performance, hardening

Grouped; each is a focused, low-risk patch.

**WS-12 · Image candidate selection & quality gates**
- Gate `EARLY_ACCEPT_PROCESSED_SCORE` on a minimum identity coverage (≥0.66) so host-trust + dimensions can't early-accept the wrong flanker (image H2; `imagePipeline.ts:586-608`, `imageCandidateRanking.ts:187`).
- Run `hasOpaqueLightBackground` on all Poof 200s regardless of `poofType`; use a center-region alpha check, not whole-image mean (image M2; `bgService.ts:202`, `bgServiceCore.ts:40`).
- Strip whitespace before the data-URI regex / validate via `Buffer.from` so valid-but-wrapped base64 isn't 6h negative-cached (image M3).
- Enforce a real min-edge floor post-decode in `processSourceToWebp` for SERP results with omitted dims (image M4).
- Add a wall-clock budget across the candidate loop; add `AbortController`/timeout to Supabase/Firebase uploads (image L2, L3).

**WS-13 · Weekly Outlook performance**
- Precompute each fragrance's `OutlookCandidate` + trait texts once and thread them through engine sub-functions instead of re-deriving `getTraitTexts` ~5× per call; stabilize `items` identity (scoring MEDIUM-perf; `WeeklyOutlookDashboard.tsx:372-382`, `WardrobeContext.tsx:911-915`). ~1085 redundant engine runs for a 155-bottle vault × 7 days.

**WS-14 · Spray-count & warmth-gradient math**
- Clamp `recommended` into `[wearableMinimum, contextualMax]` first, then derive `min`/`max`; assert `min ≤ recommended ≤ max`; unit-test parfum+gym+hot-humid+subtle (scoring MEDIUM; `scentWeatherEngine.ts:643-675`).
- Derive `idealWarmth` divisor from clamp constants and widen the cold floor so sub-freezing days don't all collapse to identical rankings (scoring HIGH-local; `weeklyOutlookPlanner.ts:143-147`).
- Demote confidence to `low` when a fragrance contributed zero trait signals; break scoring ties on a quality signal before array index (scoring LOW; `scentWeatherEngine.ts:551-553, 787`, `WardrobeContext.tsx:844`).

**WS-15 · Frontend state robustness**
- Route-scoped ErrorBoundary with `resetKeys=[pathname]` + soft reset so one view's error doesn't nuke the shell (frontend M4; `ErrorBoundary.tsx`, `main.tsx:34`).
- Replace `JSON.stringify` deep-equality in `reconcileWardrobeItems` with a stable render-field comparison to stop per-minute re-render/image flicker on large vaults (frontend M5; `lib/wardrobeReconcile.ts:44-48`).
- Set `wardrobeLoaded` on the load-cooldown early-returns and schedule a one-shot retry; merge the auth reset+load into one ordered effect; distinguish guest-local add success from `persisted` (frontend H3, M6, M7).
- Gate/annotate recommendation surfaces on real weather availability (frontend L8 — overlaps WS-3).

**WS-16 · Engine-call idempotency & provenance**
- Mark `requeueFragranceDetails` non-idempotent so retry/back-off and the direct-fallback don't double-enqueue scrape jobs (ext #2; `fragranceApi.ts:1043-1085, 1657`).
- Tag engine-5xx → Express fallback details with a provenance marker so the UI can show "showing local/cached profile — engine unavailable," and preserve the original engine error if the fallback also fails (ext #5; `fragranceApi.ts:1630-1644`).

**WS-17 · Wardrobe rebuild resumability**
- Wrap each row's read+update in a transaction and persist a per-row `rebuilt_at` so a crashed rebuild is re-runnable and skips committed rows; do **not** wrap the whole loop in one tx (long-lived tx across network calls) (auth #6; `services/wardrobeRebuild.ts:37-106`).

**WS-18 · Token revocation & admin diagnosability**
- Add an authenticated `POST /api/auth/logout` that rotates `users.token`; consider a short-lived one-time code exchange instead of embedding the long-lived token in the redirect URL (auth LOW; `oauth.ts:296-304`, `auth.ts:51-67`, `AuthContext.tsx:154`).
- Return a distinct 503 "admin not configured" (vs 401) and log a startup warning when `ADMIN_SECRET` is unset (auth LOW; `adminSecret.ts:24`).

---

## Suggested execution order

1. **WS-1, WS-3, WS-6** — fast, low-risk, high-visibility correctness wins (wrong image, fake confidence, broken sign-in feedback).
2. **WS-4 + WS-5** — together (guest migration depends on dedupe); includes the guarded DB unique-index push.
3. **WS-2, WS-7, WS-8** — scent-data correctness; land behind golden/snapshot tests because they shift recommendations broadly.
4. **WS-9, WS-10, WS-11** — integration + auth-ownership hardening.
5. **WS-12 … WS-18** — robustness/perf/hardening, batchable.

## Cross-cutting verification per CLAUDE.md
- `pnpm run typecheck` (and `:libs`) after lib/schema changes.
- `pnpm --filter @workspace/api-server run test` for engine/image/route changes.
- Schema changes (WS-5, possibly WS-9/WS-17) go through the **guarded** Drizzle push (`ALLOW_PROD_DB_PUSH=yes`, scoped `tablesFilter`) and must pre-dedupe existing rows before adding unique indexes.
- Keep the `isSourceCoverageComplete` contract **strict** — do not loosen (CLAUDE.md cross-service contract).
- No font/token/global-style changes; surgical patches only.

## Notable confirmed-solid (no action)
Strict `isSourceCoverageComplete` predicate; constant-time admin-secret compare; tenant-scoped token lookup; non-UUID token → clean 401; guarded localStorage JSON parsing (no crash-on-corrupt); bounded image-backfill spinner with give-up; `parseQuery` no longer fabricates brand-from-first-word; correct `levenshtein` DP.
