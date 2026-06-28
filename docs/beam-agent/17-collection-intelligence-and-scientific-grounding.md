# Beam Agent — Collection Intelligence & Scientific Grounding

**Date:** 2026-06-28
**Branch:** `claude/logic-enhancement-planning-qcc7wv`
**Status:** Phase 1 landed (deterministic collection analysis). Phases 2–4 scoped, not started.

## Context — why this exists

Two user observations drove this work:

1. **"The Beam agent only puts together trips — it isn't a true all-around utility."**
   The mission engine had exactly two intents, `travel_kit` and `recommendation`
   (`missionState.ts:677,697`). A standing question like *"What gaps do I have in my
   collection"* had nowhere to go, so it fell into the generic `recommendation` flow,
   which slot-fills *occasion → scent family* — the trip-assembly feel the user saw.

2. **"Make this systematic and scientific — valid points only."**
   Where analysis did happen, it was ungrounded:
   - **Gaps were pure LLM free-styling** off a vault summary; no tool computed coverage,
     diversity, or redundancy, and no quality gate checked the claim.
   - The home **"recurring molecule" ticker** is a raw frequency count (a note appearing
     ≥2× across the vault), with no normalization, dedup, or data-quality weighting
     (`artifacts/scent-cast/src/App.tsx:288-297`).
   - Confidence/overlap claims **ignore `source_coverage` / vector-confidence**, so a
     1-note placeholder scores identically to a fully-enriched profile.
   - **"Reading your taste profile" is cosmetic** — the `beam_answer_feedback` table is
     write-only and there is no taste schema (`lib/db/src/schema/`).

Both problems share one root cause: **there is no deterministic analytical layer.** The fix
is the same for both — give Beam real math over real data, and route standing collection
questions to it instead of the trip wizard.

This was confirmed by two parallel read-only audits (backend reasoning pipeline; scientific
signal foundation) and corroborates the prior `RECOMMENDATION_LOGIC_GAP_AUDIT.md` and
`PRODUCTION_LOGIC_AUDIT_REMEDIATION_PLAN.md`.

## Design principle: valid points only

Every point the analysis emits must be **computed from real fields, carry its own evidence,
and be gated by data quality.** Absence of data is reported as such — never as evidence of
absence. Concretely:

- Sparse/placeholder bottles are excluded up front via `sourceConfidence` (and a
  no-descriptive-tokens check) before any math runs.
- The report states how much of the vault it could actually assess (`analysisConfidence`).
- When too little is analyzable (`reliable: false`), it asserts **no gaps at all** and says
  so, rather than guessing.
- A "gap" is only emitted when the analyzable subset genuinely fails to cover a documented
  occasion/season slot — each gap names its evidence (`"0 of N analyzable bottles cover …"`).

## Phase 1 — what landed (this branch)

A deterministic, evidence-gated **collection-intelligence engine**, wired as a read-only Beam
tool, with the agent routed to use it for collection questions.

### Files

| File | Change |
|---|---|
| `artifacts/api-server/src/beam-agent/collectionAnalysis.ts` | **New.** Pure engine: `analyzeCollection(items) → CollectionAnalysis`. Family distribution + normalized-Herfindahl diversity, share-thresholded signature accords/notes (the honest "recurring molecule"), occasion/season **coverage slots** with explicit gaps, redundancy clusters (union-find over Jaccard of the combined trait set), ranked evidence-bearing gaps, and a deterministic summary. Data-quality gated throughout. |
| `artifacts/api-server/src/beam-agent/collectionAnalysis.test.ts` | **New.** 9 unit tests: empty/sparse handling, gating, diversity, signature thresholds, coverage gaps, performance gates, redundancy clustering. |
| `artifacts/api-server/src/beam-agent/beamTools.ts` | Registered `beam_analyze_collection` (builds `CollectionItem[]` from packets + clean families from the vault, joined by name; uses real per-row `sourceConfidence`). |
| `artifacts/api-server/src/beam-agent/types.ts` | Added `beam_analyze_collection` to `BeamReadToolName`. |
| `artifacts/api-server/src/beam-agent/beamAgentLoop.ts` | New **"Analyzing the collection"** system-prompt section: route gap/character/"what to add"/"well-rounded" questions to the tool, answer directly from its fields, never assert a claim it doesn't contain, honor `reliable:false`, and search the catalog (not free text) to fill a named gap. |
| `artifacts/api-server/src/beam-agent/beamTools.test.ts` | Updated the "exactly the Phase-1 read-only tools" assertion. |

### Why families/accords, not the 6-axis vector

Owned vault items in the Beam layer (`ScentMissionWardrobeItem`, the packet shapes) **do not
carry a scent vector** — and the repo's own audits flag the keyword-derived vector as the
weakest signal (substring matching, +2.5 floor, cross-axis leakage). Families and accords are
voted/parsed catalog data and far more trustworthy for coverage math, so the engine reasons
over those plus performance (longevity/sillage).

### Verification

- `node --experimental-strip-types --test` — full beam-agent set **259/259 pass**.
- `pnpm --filter @workspace/api-server run typecheck` — **clean** (after `pnpm run typecheck:libs`).

### Risk

Low and additive. A new read-only tool + a new prompt section; no existing tool, scoring path,
schema, or recommendation math changed. The new tool is always available (vault-only deps).

## Deferred phases (scoped, awaiting go-ahead)

These were intentionally **not** started because each is either recommendation-shifting (needs
golden tests) or requires a guarded production DB push. Listed in dependency order.

- **Phase 2 — Data-quality grounding across the agent.** Thread `source_coverage` /
  vector-confidence into every Beam tool result (not just the analysis tool) and add answer
  gates that block unsupported gap/composition/confidence claims everywhere. Additive.
- **Phase 3 — Fix the vector math (WS-7 in `PRODUCTION_LOGIC_AUDIT_REMEDIATION_PLAN.md`).**
  Tokenize notes, remove the +2.5 floor, stop cross-axis leakage, expand the dictionary —
  **behind golden-vector snapshot tests** because it shifts existing recommendations broadly.
- **Phase 4 — Real personalization.** Add a per-user taste schema (preferred/disliked families,
  intensity, `lastWorn`) to `userSettings`, read the `beam_answer_feedback` loop back, and feed
  it into scoring. Makes "reading your taste profile" real. **Requires a guarded prod DB push**
  (`ALLOW_PROD_DB_PUSH`, scoped `tablesFilter`) per `CLAUDE.md`.
- **Phase 5 — Honest hero ticker.** Rebuild `getHeroTickerPhrases` (`App.tsx`) on share-based
  thresholds + normalization + data-quality weighting instead of raw "appears twice" counts,
  reusing the same discipline as the analysis engine.

## How to extend the coverage taxonomy

`COVERAGE_SLOTS` in `collectionAnalysis.ts` is the single source of truth for what "well-rounded"
means. Each slot is `{ slot, label, description, traits[], requireStrong?, requireSoft? }`, with
`traits` drawn from the app's accord vocabulary (`services/scentParser.ts` `ACCORD_KEYWORDS`).
Add or refine slots there; the gap synthesis, summary, and tests pick them up automatically.
