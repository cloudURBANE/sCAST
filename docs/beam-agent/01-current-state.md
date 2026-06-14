# 01 — Current state (code-grounded)

What Scent Mission / "Beam Agent" actually is today, read from the source. This
condenses `docs/SCENT_MISSION_AGENT_ANALYSIS.md` and verifies it against the
files below.

## Entry points and shape

| Concern | File | Reality |
|---|---|---|
| HTTP route | `artifacts/api-server/src/routes/scentMission.ts` | One stateless endpoint, `POST /api/scent-mission`, rate-limited 30/5min. |
| Orchestration | `artifacts/api-server/src/services/scentMissionService.ts` | Validates request, runs **one** step, returns patches. No session state. |
| Domain model + scoring | `lib/scent-weather-engine/src/scentMission.ts` | Pure, deterministic node graph + recommendation selection. |
| UI | `artifacts/scent-cast/src/components/ScentMissionPanel.tsx` | Fixed 5-node SVG tree, hardcoded buttons, chip facets. |
| Client | `artifacts/scent-cast/src/lib/scentMissionClient.ts` | One-shot `fetch` per turn; replays full state each time. |
| Guide | `docs/SCENT_MISSION_GUIDE.md` | Names the "collection creation gap" explicitly. |

## Two actions, neither agentic

The endpoint accepts exactly `action: "chat"` or `action: "execute_node"`
(`scentMissionService.ts` → `parseScentMissionRequest`).

- **`chat`** sends one prompt to a small model (`gpt-4.1-mini`, Gemini fallback)
  and returns 1–3 sentences (`routes/scentMission.ts` → `chatWithOpenAi` /
  `chatWithGemini`). There is **no tool/function calling and no loop** — the
  model reads text and returns text. Its only influence on app state is indirect:
  a regex (`inferCalibrationFromMessage`) scans the user's words for "work
  meeting" / "date night" and sets two calibration axes.
- **`execute_node`** runs **hardcoded** logic for whichever node is the current
  frontier (`executeNode`). The model does not choose the transition.

The node tree is fixed and linear: `onboarding → wardrobe-sync →
environment-scan → resolution-standard → resolution-premium`
(`SCENT_MISSION_NODE_ORDER`).

## The one recommendation is deterministic, vault-only

`selectScentMissionRecommendation` (in `scentMission.ts`) scores **only the
fragrances the user already owns** with the shared weather engine and returns a
single winner. The LLM is never in this loop. There is no path to discover,
propose, or assemble *new* fragrances.

## The prompt forbids the goal

The system prompt in `routes/scentMission.ts` literally instructs the model to
decline collection-building and to *"Never invent fragrances the user does not
own."* Today's "agent" is, by contract, a vault re-ranker with a chat veneer.

## The UI promises more than the backend uses

`ScentMissionPanel.tsx` collects ~9 facet groups (occasion, mood, season,
projection, **budget**, gender expression, personality, impression, creative
direction) plus Fast/Research/Premium modes. The backend consumes **two axes**:
`destination` and `energy`. Everything else — including budget chips that imply
shopping — is collected and discarded.

## No memory, fake premium, dormant enrichment

- **Stateless by design.** Chat is never persisted (the `conversations`/
  `messages` tables aren't tenant-scoped; the guide forbids writing to them).
- **Premium is a visual lock.** `resolution-premium` ("Molecular Intelligence")
  forces `premiumUnlocked: false` everywhere. No billing behind it.
- **Enrichment can't be triggered.** `enrichment_jobs` is scaffolding — no worker
  consumes jobs, nothing enqueues them.

## The good news: the capabilities already exist

The pieces a real agent would orchestrate already ship — they're just not
callable by a model:

| Capability | Where it lives | Status |
|---|---|---|
| Read the user's owned bottles | `user_fragrances`, loaded tenant+user scoped in the route | Live (read-only) |
| Save / build a collection | `/api/wardrobe` write path (`routes/wardrobe.ts`) | Live; mission never calls it |
| Local catalog search | `services/catalogService.ts` → `searchCatalogCandidates` over `global_fragrances` | Live |
| Discover new fragrances (external) | engine proxy + `VITE_FRAGRANCE_API_URL` (`/search`, `/details`) | Live elsewhere |
| Research a fragrance | `lib/scent-facts/engine.ts` → `getScentFacts` | Live, used decoratively |
| Deterministic weather scoring | `lib/scent-weather-engine` | Live, used |
| Enrich on demand | `enrichment_jobs` queue | Scaffolding — needs a worker |

**The missing piece is the thing that calls these in sequence: a tool-using
loop.** That is exactly what Phase 1 adds — see
[03-migration-plan.md](./03-migration-plan.md).
