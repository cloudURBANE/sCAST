# Beam Agent re-audit — scripted fallback intent preservation

Date: 2026-06-19

This pass is a **re-audit** on top of the already-shipped discovery/NLU work
(`9be4d11`, `b2af6f9`, `bdb2f31`, and `BEAM_AGENT_LOGIC_AUDIT.md`). It does not
re-litigate the retrieval layer that was already fixed and verified; it closes
the one structural item those passes documented but explicitly left open:
**Follow-up #4 — the scripted fallback collapsed/garbled freeform intent and
spoke in mission-control jargon.**

## What was audited

- `services/scentMissionService.ts` — the stateless `/api/scent-mission` agent.
- `components/ScentMissionPanel.tsx` — the SPA caller that decides when to fall
  back to the scripted path and how it sanitizes scripted replies.
- `app.ts` — when the scripted path is actually reached in production.
- The already-shipped retrieval/state code (`catalogProfileSearch.ts`,
  `catalogService.ts`, `missionState.ts`, `beamAgentLoop.ts`,
  `answerQualityGates.ts`) — re-read for correctness; **no change required**, the
  prior pass holds up (see `BEAM_AGENT_LOGIC_AUDIT.md` "Independent deep-audit pass").

## Why Beam felt robotic on the degraded path

`/api/scent-mission` is **not dead code in production**. `app.ts:57-67` and
`ScentMissionPanel.tsx:618` show the SPA silently falls back to it whenever a
live Beam turn returns `model_unavailable` (no/invalid `OPENROUTER_API_KEY`,
provider outage, etc.). Users can and do hit it in live production.

On that path the scripted reply was actively bad in two compounding ways:

1. **Mission-control jargon leaked to users.** `deterministicChatReply` and
   `calibrationUpdatedReply` emitted "Run the environment scan node", "Work
   through the mission tree", "Hit Execute Analysis", and "lock calibration to
   begin the mission tree".
2. **The SPA then discarded the user's intent.** `ScentMissionPanel.tsx:609-616`
   (`safeAssistantText`) rejects any reply matching
   `mission tree|execute analysis|resolution node|sync node|hit execute|work
   through the mission` and substitutes a generic `firstMissingPrompt`. So the
   exact robotic strings the server produced caused the user's freeform request
   ("clean, airy, woody for humid Dallas nights") to be replaced by a canned
   "What setting should this serve…" prompt — the worst-case "feels stupid live"
   behavior, by construction.

## Confirmed issues (this pass)

| Class | Finding | Status |
| --- | --- | --- |
| Canned/robotic copy | `deterministicChatReply` exposed the internal node graph; SPA stripped it | **Fixed** |
| Freeform intent collapse | Chat fallback answered with mission status instead of reflecting the user's words | **Fixed** |
| Enum collapse copy | `calibrationUpdatedReply` framed capture as `destination: X, energy: Y` plus "mission tree" | **Fixed** |
| Weather hijack | "good for hot weather" (scent context) triggered a literal weather readout, dropping the scent intent | **Fixed** |
| Test narrowness | The fallback had no natural-language regression coverage; only node-execution unit tests | **Fixed (3 NL probes added)** |

## What was fixed

`services/scentMissionService.ts`:

- Rewrote `deterministicChatReply` to **reflect the user's own words**
  (`understoodIntentCues`) — occasion, scent direction, weather context, and
  projection are echoed back in the user's framing, never as `node`/enum labels.
  It no longer mentions the mission graph at all, so the SPA's
  `safeAssistantText` filter never strips it and the user's intent survives.
- Gated the weather answer behind an actual conditions *question*
  (`asksAboutConditions`) so scent-context phrases like "hot weather" are
  preserved as intent instead of hijacked into a UV readout.
- Rewrote `calibrationUpdatedReply` to acknowledge the captured setting/mood
  conversationally ("Got it — lining this up for work, feeling focused…") with no
  internal jargon.
- The node-execution state machine (`executeNode`, node graph, `missionPatch`
  capture) is **unchanged** — those messages are driven by explicit node buttons,
  a different surface, and rewriting them would risk the verified node flow.

`services/scentMissionService.test.ts`:

- Updated the calibration test to assert the captured setting/mood is reflected
  and that **no** stripped jargon appears.
- Added three natural-language regression tests over real task probes:
  - the fallback never emits any phrase the SPA's `safeAssistantText` strips,
  - it reflects freeform scent/context intent (fresh + woody + humid),
  - it only answers weather when actually asked, and preserves scent-context
    "hot weather" otherwise.

## Local end-to-end evidence (NOT production)

True production Beam credentials/session were **not available**, so this is a
local end-to-end run of the real `parseScentMissionRequest` + `executeScentMission`
no-model path (the exact code production falls back to). It is **not** a live
production test and does not exercise the OpenRouter model, Express routing, or
real wardrobe/DB retrieval.

```
USER: I want something clean, airy, woody, and expensive-smelling for humid Dallas nights.
BEAM: Got it — something fresh and clean, a woody direction, and hot, humid air. Give me one more detail — the setting or the mood — or just say go and I'll pull picks from your collection.

USER: I need a fragrance for a dinner date tomorrow, intimate but memorable.
BEAM: Got it — lining this up for date. Add anything else you want it to do, or just say go and I'll pull picks from your collection.
  captured: {"destination":"Date"}

USER: I'm going to a wedding and want something elegant that projects but doesn't choke people out.
BEAM: Got it — a formal event and real projection. Give me one more detail — the setting or the mood — or just say go and I'll pull picks from your collection.

USER: what's the weather like right now?
BEAM: Right now it's 88°F, 70% humidity, UV index unavailable. Tell me where you're headed or the vibe you want, and I'll match a fragrance to it.
```

## What was NOT fixed (remaining gaps)

- **The no-model fallback cannot do true owned/new reasoning.** "I own Oud Wood…
  I want something greener" reflects the named bottle's family because it is a
  deterministic word-matcher, not a planner. The **live Beam path** handles
  owned/new separation correctly (server-forced `excludeOwned`, verified in the
  prior pass). The fallback is a safety net, not the concierge.
- **Indexed descriptive retrieval** (`tsvector`/dedicated profile columns) is
  still the real production-scale discovery solution; profile search remains a
  bounded 96-row `profile_data::text` scan. Unchanged this pass — it is a DB
  migration, out of scope for a safe local change (`BEAM_AGENT_LOGIC_AUDIT.md`
  Follow-up #1).
- **`missionWithDefaultsForFast` (`ScentMissionPanel.tsx:753`)** still defaults a
  Fast-button run to `Going Out`/`Confident` when the user gave nothing. That is
  an explicit "just go" affordance, not a freeform collapse, and is left as
  documented scaffolding.
- **Node-execution copy** (`executeNode`) still uses some product vocabulary
  ("Resolution is armed"). It is button-driven, not freeform chat, so it is out
  of this pass's scope.

## Verification

| Check | Command (via `pnpm agent:run`) | Result |
| --- | --- | --- |
| Scripted-service unit + new NL probes | `node --test …/scentMissionService.test.ts` | 20 passed, 0 failed (was 17) |
| API typecheck | `pnpm --filter @workspace/api-server run typecheck` | Passed |
| Full API suite | `pnpm --filter @workspace/api-server run test` | **540 passed, 0 failed** (was 537; +3 new) |
| API build | `pnpm --filter @workspace/api-server run build` | Passed |
| Frontend | n/a | Not changed; not rebuilt |
| Live production | n/a | **Not run — credentials/session unavailable** |

## Limitations of testing

- No authenticated production Beam run; no OpenRouter model invoked; no real
  vault/DB retrieval. The evidence above is a deterministic local run of the
  no-model fallback and the Node test runner only.
- The new tests assert intent-preservation and jargon-absence, not model taste.
