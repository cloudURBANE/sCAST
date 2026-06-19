# Beam Agent logic audit

Date: 2026-06-19

## Root causes

1. **Descriptive catalog retrieval was the largest intelligence gap.** `beam_search_catalog` was explicitly brand/name-only, so requests such as “clean, airy, woody, humid” required the model to guess fragrance names before retrieval. The production route and MCP wiring both delegated to strict identity search. Evidence: `artifacts/api-server/src/beam-agent/beamTools.ts`, `beamAgentRoutes.ts`, `mcp/beamServiceDeps.ts`, and `services/catalogService.ts`.
2. **Deterministic state captured too little of dense free text.** Common occasions were already covered, but event locations (“party in Dallas”), prepositive travel phrasing (“Tokyo trip”), compound direction (“clean, airy, woody”), restrained projection (“not too loud”), modern vibe, and attractive/polished intent were not reliably preserved. Evidence: `missionState.ts` parsers and the exact regression prompts.
3. **Owned/new lane separation trusted model arguments for mixed missions.** The loop forced `excludeOwned=true` only for new-only missions. A 1-owned/1-new or 2-owned/2-new mission could search with `excludeOwned=false`, weakening the “new” lane even though the system prompt said otherwise. Evidence: `beamAgentLoop.ts:453`.
4. **Fixed UI inputs are mostly scaffolding, but the fallback remains narrow.** `ScentMissionPanel.tsx:133` contains static occasion/mood/season/projection/etc. chips. They do not replace live-agent free text: the raw message is sent at `ScentMissionPanel.tsx:1310`, backend slots are merged into UI cues, and model-provided suggestions supersede static chips. However, `inferTextFacets` and `missionWithDefaultsForFast` (`:663`, `:753`) still compress scripted-fallback intent into fixed destination/energy enums and can default missing intent to `Going Out`/`Confident`. This is acceptable recovery scaffolding, not a reliable primary intelligence layer.
5. **The state/loop architecture is materially stronger than the retrieval layer.** The route derives and saves state before the model runs (`beamAgentRoutes.ts:361-370`), the store preserves state independently of successful transcript append, travel missions stay on the premium lane, and quality gates block known-slot re-asks. The weakness was not an absent loop; it was incomplete deterministic capture plus retrieval that could not understand user-language scent criteria.

Before this change, search did not retrieve by vibe, season/weather, occasion, notes, accords, family, performance language, gender presentation, vector qualities, wardrobe similarity, or collection gaps. The profile path now maps common scent/occasion/weather concepts and preserves useful freeform profile tokens for text retrieval across product identity, family, notes, pyramid, accords, context, and description. Scent vectors rerank text-retrieved candidates; they are not a standalone database retrieval index. Performance and presentation can match only when represented in profile text; wardrobe similarity and collection gaps remain cross-tool reasoning (`beam_get_wardrobe` + `beam_compare_overlap`), not native catalog-ranking signals.

## Fixed now

- Expanded deterministic extraction for event locations, “Tokyo trip” phrasing, formal events, modern vibe, compound fresh/woody direction, restrained projection, and attractive/approachable/polished impression.
- Preserved strict brand/name identity search for identity-sensitive callers while adding a Beam-only profile search over family, notes, pyramid, accords, context, description, and scent vectors.
- Added scent-domain aliases and deterministic ranking for clean/airy/fresh, hot/humid, woody, sweetness, warmth, spice, musk, green/aromatic, occasion, and modern language.
- Updated the tool contract and provider prompt to search combined user intent directly instead of requiring guessed fragrance names.
- Server-enforced `excludeOwned=true` for every travel mission with a requested new lane.
- Extended occasion pending-slot handling for formal events.
- Follow-up audit fixes preserve strict identity hits for names containing descriptive words (for example, “Oud Wood”), include brand/name evidence in mixed queries, exclude vector field names from SQL text matching, and order the bounded candidate set deterministically by term coverage.
- Follow-up audit fixes prevent “business/family/weekend/road trip” and relative-time phrases from becoming false destinations while retaining explicit “trip to Tokyo” and proper-noun “Tokyo trip” parsing.

## Deterministic loop backtests

Authenticated production/provider access was unavailable. These runs used the real `deriveBeamSessionState` + `runBeamAgent` loop with injected deterministic provider and tool results. They bypass Express routing, session persistence, `createBeamTools`, real wardrobe/database retrieval, and the production model, so they are deterministic loop harnesses rather than route-equivalent or live tests.

| Scenario             | Extracted                                                                                                                | Missed / boundary                                                                                                                                                          | Tool behavior                                                                                   | Result                                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Dallas rooftop party | destination Dallas; occasion party; lighter/fresh direction; moderate projection; attractive impression; 1 owned + 1 new | Hot/humid remains in the full raw message rather than a dedicated slot; named owned bottles are resolved by the authenticated wardrobe tool, not copied into session slots | Vault score, then descriptive catalog search with owned exclusion forced                        | No clarification. Specific owned and new picks were justified against Dallas humidity and restrained projection in the deterministic harness. |
| Tokyo in August      | destination Tokyo; month August; modern vibe; lighter/fresh + woody direction; 2 owned + 2 new                           | Humidity remains in raw intent rather than a dedicated weather slot                                                                                                        | Two vault picks, descriptive `clean modern airy woody hot humid` search, owned exclusion forced | No clarification. Exactly 2 owned + 2 new grounded picks passed mission gates.                                                                |

The backtests verify extraction, prompt-state injection, `excludeOwned` argument rewriting, grounded lane-count gates, and non-clarifying completion under scripted responses. Their returned candidates and final rationales are fixtures. They do not validate live model taste quality, real database retrieval quality, Express/session integration, or production behavior.

## Deeper follow-up findings

The post-commit audit reproduced four correctness gaps in `9be4d11` and fixed them in the working tree:

1. Identity queries containing mapped descriptive words entered profile-only retrieval. “Tom Ford Oud Wood” could therefore miss the exact catalog identity. Strict identity resolution now runs first and wins when confidence-gated hits exist.
2. SQL matched `profile_data::text`, including JSON vector keys such as `freshness` and `woodiness`. Queries for “fresh” or “wood” could match nearly every row before the 96-row limit. Candidate text now excludes `scent_vector`, and rows are ordered by matched-term count plus lookup key before the bound is applied.
3. The original concept vocabulary omitted multiple directions already recognized by mission state and did not support arbitrary note pairs. The vocabulary now covers those families/occasions/seasons, while non-boilerplate freeform tokens such as “rose patchouli” participate in retrieval and ranking.
4. The prepositive-trip regex captured modifiers and relative time as destinations: “business trip to Tokyo” became `business`, while “meeting in the morning” became `the morning`. Explicit postpositive destinations now take precedence, prepositive destinations require proper-noun phrasing, and relative-time captures are rejected.

The 96-row bound remains a recall/performance tradeoff. Deterministic term-count ordering removes arbitrary row selection, but this is still not a true indexed global rank. A generated search document/`tsvector` or dedicated profile columns remain the production-scale solution.

## Hard-coded/fixed inventory and assessment

- Static frontend cue sets, mode/tone options, progress copy, initial assistant copy, recovery actions, and fast-mode defaults: useful for discoverability and degraded-mode recovery; shallow if the live agent is unavailable.
- Backend slot keys and deterministic regex extraction: useful authoritative memory guardrails; inherently incomplete, so the raw transcript remains authoritative context and tests must grow from real failures.
- Lane routing thresholds and keyword lists: reasonable cost controls; active travel state correctly prevents mid-mission downgrade.
- Quality gates: strong at unsupported claims, lane counts, ownership, destination mismatch, delegation, and redundant asks; they cannot judge whether a recommendation is tasteful. Better retrieval is therefore required upstream.
- Provider workflow: previously hard-coded around name guessing because catalog search was weak. It now permits direct profile queries while keeping tool-grounding requirements.
- Session store: no evidence of intent loss in the audited flow; state is saved before model execution and merged across turns.

## Follow-up

1. Add an indexed profile-search representation (generated text/tsvector or dedicated columns). The safe local fix searches `profile_data::text`; it is bounded to 96 candidates but may become a sequential-scan bottleneck as the catalog grows.
2. Add explicit structured climate/daypart slots if production telemetry shows raw-message weather is regularly ignored by providers.
3. Add native performance/presentation filters and a deterministic wardrobe-gap objective; today these are text matches or model-orchestrated cross-tool reasoning rather than first-class retrieval dimensions.
4. Make the scripted fallback preserve open-ended free text instead of collapsing to destination/energy enums; keep this separate from the live-agent path.
5. Run the two prompts against authenticated production with real vault/database data and capture returned catalog candidates, latency, model, and final answers before claiming live concierge quality.

## Changed files

- `artifacts/api-server/src/services/catalogProfileSearch.ts` — profile concepts, freeform query tokens, and ranker.
- `artifacts/api-server/src/services/catalogService.ts` — identity-first, bounded, deterministically ordered descriptive profile retrieval.
- `artifacts/api-server/src/beam-agent/missionState.ts` — broader multi-fact extraction.
- `artifacts/api-server/src/beam-agent/missionState.test.ts` — trip-modifier and relative-time destination regressions.
- `artifacts/api-server/src/beam-agent/answerQualityGates.ts` — formal-event pending-slot parity.
- `artifacts/api-server/src/beam-agent/beamAgentLoop.ts` — profile-search prompt and new-lane ownership enforcement.
- `artifacts/api-server/src/beam-agent/beamTools.ts` — accurate descriptive search contract.
- `artifacts/api-server/src/beam-agent/beamAgentRoutes.ts` — production route uses Beam profile search.
- `artifacts/api-server/src/beam-agent/mcp/beamServiceDeps.ts` — MCP uses the same retrieval path.
- `artifacts/api-server/src/beam-agent/beamFlowRegression.test.ts` — exact extraction/catalog backtests.
- `artifacts/api-server/src/beam-agent/beamAgentLoop.test.ts` — exact route-equivalent two-conversation tests.

## Verification

| Check                                             | Result                                                                                                                                                                                                                                                  |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Focused Beam-adjacent gate after follow-up fixes  | 216 passed, 0 failed                                                                                                                                                                                                                                    |
| Beam loop tests, including both requested prompts | Included in the 216-test focused gate; both deterministic scripted conversations passed                                                                                                                                                                |
| API typecheck                                     | Passed                                                                                                                                                                                                                                                  |
| Full API suite                                    | 537 passed, 0 failed after adding three regression tests. The previously reported Rakuten baseline failure did not reproduce; this Beam change did not modify Rakuten code.                                                                            |
| API build                                         | Passed                                                                                                                                                                                                                                                  |
| Beam MCP build                                    | **Compiles cleanly** (verified). The MCP entrypoint (`mcpMain.ts`) was bundled successfully via an isolated esbuild to a throwaway output dir — full 2.7 MB `beam-mcp.mjs` + pino transports emitted, exit 0. The blockage is purely a Windows file lock: the canonical `beam:mcp:build` first `rm`s `dist-beam/`, which fails while the running `node ./dist-beam/beam-mcp.mjs` process (local Hermes cockpit, not a managed service) holds an open handle. So the source is good; only the in-place artifact swap is gated on stopping that local process. |
| Frontend build                                    | Not required: frontend was audited but not changed                                                                                                                                                                                                      |
| Live production                                   | Not run; credentials/session unavailable                                                                                                                                                                                                                |

## Independent deep-audit pass (2026-06-19)

A fresh pass re-verified the committed work (`9be4d11`, `b2af6f9`) end-to-end and re-examined the retrieval/state code for correctness bugs and premium-quality gaps. Re-verification: full API suite **537/537 passed**, API typecheck **passed**, API build **passed**, and the MCP entrypoint **compiles cleanly** (isolated bundle, exit 0 — see the Verification table). No regressions; no new code changes were required to the audited beam-agent retrieval/state path.

Correctness checks that held up under scrutiny (no bug found):

- **`profile_data - 'scent_vector'` is valid.** `global_fragrances.profile_data` is `jsonb` (not `json`), so the key-removal operator in `searchCatalogProfileCandidates` is sound — it correctly stops `%fresh%` from matching the `freshness` vector key on every row.
- **Identity-first short-circuit does not poison descriptive queries.** `searchCatalogProfileCandidates` calls `searchCatalogCandidates` first, but every hit there is gated through `scoreFragranceCandidate(...).matched` against `minScore`. A descriptive multi-word query ("clean airy woody hot humid") cannot clear that name/brand confidence gate, so it falls through to profile search as intended; a real identity ("Oud Wood") clears it and wins.
- **Deterministic ordering is bounded and stable.** Candidate rows order by matched-term count then `lookup_key` before the `MAX_PROFILE_CANDIDATES` bound, then re-rank by `scoreCatalogProfileForQuery`; no arbitrary row selection.

Confirmed premium-quality gaps (documented, not code-changed this pass — they are degraded-mode scaffolding or future-scope, and rewriting them risks regressing working behavior):

- **Legacy scripted `scentMissionService.deterministicChatReply` remains robotic.** Copy like "Run the environment scan node", "lock calibration to begin the mission tree", and the `Going Out` / `Confident` enum collapse is the antithesis of premium concierge tone. This is the non-Beam degraded fallback (`/api/scent-mission`); the live Beam path (strong, data-grounded `SYSTEM_PROMPT`) is what users normally hit. Reworking the fallback to preserve free text is the standing Follow-up item #4, not a regression introduced here.
- **96-row recall bound** on profile search is still a sequential-scan recall/perf tradeoff (Follow-up #1) — acceptable at current catalog size.

Operational note: the Beam MCP `dist-beam` artifact swap is gated on stopping the local `beam-mcp.mjs` process (PID-owned local Hermes cockpit). That is the owner's process in a shared worktree, so this pass did not force-kill it; the source is verified to compile.
