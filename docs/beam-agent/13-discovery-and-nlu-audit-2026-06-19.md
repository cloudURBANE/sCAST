# 13 — Beam Agent "why it feels stupid" audit (2026-06-19)

A focused audit of the live Beam agent against the complaint that it "seems
stupid / not fully fleshed out." The loop itself is mature — budget control, a
dedicated synthesis pass, deterministic answer-quality gates, mission
enforcement, soft-flow recovery, and ~520 passing tests. The weakness is **not**
crashes; it is three structural areas. This pass fixes the two that are fully
verifiable offline and documents the third (which needs a live DB to validate).

## Findings

### F1 — Discovery is structurally crippled (biggest, architectural) — NOT fixed here
`beam_search_catalog` matches **brand and name only**
(`beamTools.ts` tool description: "a query like 'fresh' or 'aquatic' returns
nothing"). The `global_fragrances` catalog already carries `family`, `accords`,
and `scent_vector` (`catalogService.flattenProfile`), but **no tool queries it by
vibe/family/accord.** So to surface *new* picks the model must recall exact
fragrance names from its own memory and hope the sparse local catalog contains
them. When it doesn't, the new-pick lane comes back thin or empty and the answer
feels weak — the dominant "not fully fleshed out" symptom.

**Recommended follow-up:** add a read-only `beam_discover_catalog` tool backed by
a `searchCatalogByFamily(family|accords, limit)` query over `global_fragrances`
(JSONB `profile_data -> family / accords`), so a direction like "green / citrus"
returns real catalog fragrances without depending on LLM name-recall + exact-name
coverage. Deferred because a JSONB catalog query cannot be validated without the
production DB, and this environment has no `DATABASE_URL`; shipping it unverified
would violate the scoped-and-verified rule. The Python fragrance engine
(`VITE_FRAGRANCE_API_URL`) is the richer discovery source the rest of the app
uses and Beam is currently cut off from it — a larger cross-service follow-up.

### F2 — Deterministic NLU missed common occasions → over-asking — FIXED
`parseOccasion` (`missionState.ts`) only knew
date-night / work / night-out / wedding / gym / staying-in. Plainly-stated
occasions — **party, dinner, interview, brunch, funeral, graduation, first
date** — were never captured, so the agent re-asked an occasion the user had just
given. This is the felt "it re-asks what I told it" stupidity.

### F3 — A real gate hole: re-asking a KNOWN occasion was not caught — FIXED
`asksForKnownSlot` (`answerQualityGates.ts`) guarded month / destination /
vibe / direction but **not `occasion`**. So even when the occasion was known, a
redundant occasion re-ask did not trip `redundant_clarification` and was never
repaired.

## What changed (this commit)

All edits are in `artifacts/api-server/src/beam-agent/`:

- **`missionState.ts`** — expanded `OCCASIONS` to cover the missing occasions
  (ordered so multi-word phrases win), and widened
  `inferPendingSlotFromAssistant` so an occasion-worded question is classified as
  the `occasion` slot.
- **`answerQualityGates.ts`** — added the missing `occasion` branch to
  `asksForKnownSlot`; widened the `occasion` re-ask pattern in
  `abandonsPendingSlot` so a legitimate occasion re-ask isn't mis-scored as
  abandonment; and named `occasion` in the `redundant_clarification` repair hint.
  All three layers (parser, abandonment gate, redundant-clarification gate) stay
  in sync, matching the existing `vibe⇄direction` consistency pattern.

## Verification

- `tsc -p tsconfig.json --noEmit` — clean.
- Full `@workspace/api-server` suite — **530/530 pass, 0 fail.**
- New coverage: 3 unit tests (`missionState.test.ts`), 2 gate tests
  (`answerQualityGates.test.ts`), 1 backtest replay (`beamFlowRegression.test.ts`),
  and **2 end-to-end `runBeamAgent` runs** (`beamAgentLoop.test.ts`) that drive the
  full loop (gates + synthesis + repair; provider is the only seam) through the
  new occasion paths — the closest-to-live verification possible without the
  deployed Railway service and model keys.

## Not done (and why)

- **True production live runs** against the deployed agent would need
  `OPENROUTER_API_KEY` + the live DB + the Railway replica. Those are
  outward-facing / billable and out of scope for a local change; the two
  end-to-end loop runs above are the offline substitute.
- **F1 discovery tool** — see the recommended follow-up; needs DB validation.
