# Beam Agent logic audit

Date: 2026-06-19

## Root causes

1. **Descriptive catalog retrieval was the largest intelligence gap.** `beam_search_catalog` was explicitly brand/name-only, so requests such as “clean, airy, woody, humid” required the model to guess fragrance names before retrieval. The production route and MCP wiring both delegated to strict identity search. Evidence: `artifacts/api-server/src/beam-agent/beamTools.ts`, `beamAgentRoutes.ts`, `mcp/beamServiceDeps.ts`, and `services/catalogService.ts`.
2. **Deterministic state captured too little of dense free text.** Common occasions were already covered, but event locations (“party in Dallas”), prepositive travel phrasing (“Tokyo trip”), compound direction (“clean, airy, woody”), restrained projection (“not too loud”), modern vibe, and attractive/polished intent were not reliably preserved. Evidence: `missionState.ts` parsers and the exact regression prompts.
3. **Owned/new lane separation trusted model arguments for mixed missions.** The loop forced `excludeOwned=true` only for new-only missions. A 1-owned/1-new or 2-owned/2-new mission could search with `excludeOwned=false`, weakening the “new” lane even though the system prompt said otherwise. Evidence: `beamAgentLoop.ts:453`.
4. **Fixed UI inputs are mostly scaffolding, but the fallback remains narrow.** `ScentMissionPanel.tsx:133` contains static occasion/mood/season/projection/etc. chips. They do not replace live-agent free text: the raw message is sent at `ScentMissionPanel.tsx:1310`, backend slots are merged into UI cues, and model-provided suggestions supersede static chips. However, `inferTextFacets` and `missionWithDefaultsForFast` (`:663`, `:753`) still compress scripted-fallback intent into fixed destination/energy enums and can default missing intent to `Going Out`/`Confident`. This is acceptable recovery scaffolding, not a reliable primary intelligence layer.
5. **The state/loop architecture is materially stronger than the retrieval layer.** The route derives and saves state before the model runs (`beamAgentRoutes.ts:361-370`), the store preserves state independently of successful transcript append, travel missions stay on the premium lane, and quality gates block known-slot re-asks. The weakness was not an absent loop; it was incomplete deterministic capture plus retrieval that could not understand user-language scent criteria.

Before this change, search did not retrieve by vibe, season/weather, occasion, notes, accords, family, performance language, gender presentation, vector qualities, wardrobe similarity, or collection gaps. The new profile path covers the fields the catalog actually stores reliably: vibe aliases, weather/season, occasion/context, notes, accords, family, description, and vector qualities such as freshness/sweetness/woodiness. Performance and presentation can match only when represented in profile text; wardrobe similarity and collection gaps remain cross-tool reasoning (`beam_get_wardrobe` + `beam_compare_overlap`), not native catalog-ranking signals.

## Fixed now

- Expanded deterministic extraction for event locations, “Tokyo trip” phrasing, formal events, modern vibe, compound fresh/woody direction, restrained projection, and attractive/approachable/polished impression.
- Preserved strict brand/name identity search for identity-sensitive callers while adding a Beam-only profile search over family, notes, pyramid, accords, context, description, and scent vectors.
- Added scent-domain aliases and deterministic ranking for clean/airy/fresh, hot/humid, woody, sweetness, warmth, spice, musk, green/aromatic, occasion, and modern language.
- Updated the tool contract and provider prompt to search combined user intent directly instead of requiring guessed fragrance names.
- Server-enforced `excludeOwned=true` for every travel mission with a requested new lane.
- Extended occasion pending-slot handling for formal events.

## Internal route-equivalent backtests

True production access was unavailable: the workspace has no provider key, database URL, API base URL, or authenticated production session. These runs used the real `deriveBeamSessionState` + `runBeamAgent` loop with injected deterministic provider/tool results. They are local route-equivalent tests, not live tests.

| Scenario             | Extracted                                                                                                                | Missed / boundary                                                                                                                                                          | Tool behavior                                                                                   | Result                                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Dallas rooftop party | destination Dallas; occasion party; lighter/fresh direction; moderate projection; attractive impression; 1 owned + 1 new | Hot/humid remains in the full raw message rather than a dedicated slot; named owned bottles are resolved by the authenticated wardrobe tool, not copied into session slots | Vault score, then descriptive catalog search with owned exclusion forced                        | No clarification. Specific owned and new picks were justified against Dallas humidity and restrained projection in the deterministic harness. |
| Tokyo in August      | destination Tokyo; month August; modern vibe; lighter/fresh + woody direction; 2 owned + 2 new                           | Humidity remains in raw intent rather than a dedicated weather slot                                                                                                        | Two vault picks, descriptive `clean modern airy woody hot humid` search, owned exclusion forced | No clarification. Exactly 2 owned + 2 new grounded picks passed mission gates.                                                                |

The backtests prove extraction, prompt-state injection, tool argument enforcement, exact lane counts, and gate behavior. They do not prove live model taste quality or production database result quality.

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

- `artifacts/api-server/src/services/catalogProfileSearch.ts` — pure profile concepts and ranker.
- `artifacts/api-server/src/services/catalogService.ts` — bounded descriptive profile retrieval.
- `artifacts/api-server/src/beam-agent/missionState.ts` — broader multi-fact extraction.
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
| Focused state/gate/tool/profile tests             | 93 passed                                                                                                                                                                                                                                               |
| Beam loop tests, including both requested prompts | 27 passed                                                                                                                                                                                                                                               |
| API typecheck                                     | Passed                                                                                                                                                                                                                                                  |
| Full API suite                                    | 534 passed, 0 failed. The previously reported Rakuten baseline failure did not reproduce; this Beam change did not modify Rakuten code.                                                                                                                 |
| API build                                         | Passed                                                                                                                                                                                                                                                  |
| Beam MCP build                                    | Blocked before compilation because the currently running `dist-beam/beam-mcp.mjs` process locks `beam-mcp.err.log` on Windows. The shared source passed API typecheck/build and MCP tests, but the isolated output-directory rebuild was not completed. |
| Frontend build                                    | Not required: frontend was audited but not changed                                                                                                                                                                                                      |
| Live production                                   | Not run; credentials/session unavailable                                                                                                                                                                                                                |
