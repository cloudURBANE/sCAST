# Scent Mission — Implementation Guide

Durable reference for the embedded Scent Mission experience: the chat-style,
node-graph discovery agent that replaced the full-screen `ScentIntentModal`
flow. Written 2026-06-12 alongside the MVP implementation; update it when the
contract changes.

## What it is

Clicking **Discover Your Signature Scent** on the dashboard no longer opens a
full-screen two-step modal. It swaps the hero search panel (`FragranceCapture`)
for `ScentMissionPanel` — an in-place agent window with:

- a **git-tree mission scaffold** (SVG trunk + 5 nodes, Framer Motion path
  progress, lucide icons, reduced-motion fallbacks);
- a **chat window** with a bottom composer, suggested chips, and agent/user/
  system message bubbles;
- an **Execute Analysis** action for whichever node is currently active;
- a **Premium lock** on the final node (visual only — no billing/entitlements
  in this pass).

The backend is a real, stateless mission agent at `POST /api/scent-mission`
that uses the live wardrobe, live weather (including UV when available), the
shared scent-weather engine, and — when LLM keys exist — an LLM for free-form
chat plus the existing scent-facts research pipeline for the resolved match.

## Repo facts (as of this implementation)

| Piece | Location |
|---|---|
| Shared engine + mission domain | `lib/scent-weather-engine` (`@workspace/scent-weather-engine`) |
| Frontend compatibility shim | `artifacts/scent-cast/src/lib/scentWeatherEngine.ts` (re-export only) |
| Mission panel UI | `artifacts/scent-cast/src/components/ScentMissionPanel.tsx` |
| Pure client helpers | `artifacts/scent-cast/src/lib/scentMissionClient.ts` |
| App wiring (mission mode state) | `artifacts/scent-cast/src/App.tsx` → `DashboardView` (`missionActive`) |
| API route | `artifacts/api-server/src/routes/scentMission.ts` (mounted in `routes/index.ts`) |
| API service (pure, DI-tested) | `artifacts/api-server/src/services/scentMissionService.ts` |
| Weather UV source | `artifacts/api-server/src/services/weatherService.ts` (`uv_index`) |
| Research stack reused | `artifacts/api-server/src/lib/scent-facts/engine.ts` (`getScentFacts`) |

`ScentIntentModal.tsx` is no longer rendered by `App.tsx`. The component file
and `WardrobeContext`'s `isIntentModalOpen` / `handleIntentComplete` remain on
disk for now; delete them in a dedicated cleanup pass once the mission flow has
soaked in production.

## Shared package: `@workspace/scent-weather-engine`

The pure scoring engine moved out of the SPA so the API server runs the exact
same logic. The package exports:

- `calculateScentWeatherRecommendation`, `calculateAtmosphereScores`,
  `traitsMatchScentFamily` and all engine types (unchanged behavior, moved
  verbatim from `artifacts/scent-cast/src/lib/scentWeatherEngine.ts`);
- the mission domain (`src/scentMission.ts`): types, the deterministic node
  state machine, sanitizers, and `selectScentMissionRecommendation`.

Existing `@/lib/scentWeatherEngine` imports keep working via the shim; new code
should import the package directly. The package is a composite TS project
referenced from the root `tsconfig.json`, `artifacts/api-server/tsconfig.json`,
and `artifacts/scent-cast/tsconfig.json`.

## Mission graph (deterministic state machine)

Node order: `onboarding → wardrobe-sync → environment-scan →
resolution-standard → resolution-premium`.

Statuses: `locked | active | running | complete | blocked`.

Rules (all in `scentMission.ts`, fully unit-tested):

- A fresh mission has `onboarding: active`, everything else `locked`.
- `completeScentMissionNode` only acts on `active`/`running` nodes (idempotent
  replays) and activates the next node — **except** `resolution-premium`,
  which becomes `blocked` while `premiumUnlocked` is false. `blocked` on the
  premium node means "reachable but premium-gated"; on other nodes it means
  "cannot proceed" (e.g. empty vault during wardrobe-sync).
- `premiumUnlocked` is **always false** in the MVP. `sanitizeScentMissionState`
  and `applyScentMissionUpdates` both force it false, so neither a hostile
  client nor a server patch can unlock it.
- Calibration vocabulary is closed: destinations `Staying In | Going Out |
  Work | Night Out | Date | Gym`, energies `Calm | Focused | Confident |
  Social | Relaxed`. Destination maps to the engine setting type exactly like
  the old `WardrobeContext` mapping (`Work→work`, `Night Out→night`,
  `Going Out→mixed`, `Date→date`, `Gym→gym`, default `indoor`).

## API contract — `POST /api/scent-mission`

Middleware: `rateLimitMiddleware({ limit: 30, windowMs: 5 * 60_000 })` (the
route can fan out to an LLM and to research), then `optionalAuth`.

### Request

```ts
{
  action: 'chat' | 'execute_node',
  nodeId?: ScentMissionNodeId,        // required for execute_node
  sessionId?: string,                  // /^[0-9a-zA-Z_-]{8,64}$/, else regenerated
  userMessage?: string,                // required for chat; trimmed, capped at 2000 chars
  mission: ScentMissionState,          // sanitized server-side; never trusted
  context: {
    weather: ScentMissionWeather,      // sanitized; aliases (temp/humidity/windSpeed) accepted
    wardrobe?: ScentMissionWardrobeItem[]  // guest path; capped 60 items / 24 traits / 120 chars
  }
}
```

- **Signed-in users** (`Authorization: Bearer <users.token>`): the server loads
  `user_fragrances` rows scoped to tenant+user, projects them through
  `missionItemFromWardrobeRow`, and **ignores** the client wardrobe.
- **Guests**: the sanitized `context.wardrobe` summary from local state is used.

### Response

```ts
{
  sessionId: string,
  assistantMessage?: string,
  nodeUpdates?: { nodeId, status }[],     // diff against the request's mission
  missionPatch?: Partial<ScentMissionState>,  // currently only calibration
  recommendation?: {
    fragranceId: string,    // client wardrobe id
    dbId?: string | null,   // user_fragrances row UUID (server wardrobe only)
    name: string, brand?: string,
    engine: ScentWeatherRecommendation,  // full shared-engine output
    reason: string,          // concise explanation (engine explanation)
    score: number
  },
  research?: unknown,        // scent-facts result for the winner; best-effort
  premiumLock?: { locked: true, title, body, cta }
}
```

### Behavior per action

- `chat`: with `OPENAI_API_KEY` (preferred) or `GEMINI_API_KEY`, the route
  calls the LLM with a short fragrance-scoped prompt (vault summary + weather +
  user message, 20s timeout). **Without keys, or on any LLM failure, a
  deterministic fallback reply is produced** — local dev always works.
- `execute_node onboarding`: requires both calibration fields in
  `mission.calibration`; completes onboarding and echoes the calibration in
  `missionPatch`.
- `execute_node wardrobe-sync`: empty vault → node `blocked` + guidance;
  otherwise completes with a count + dominant-families summary.
- `execute_node environment-scan`: completes with a weather summary. UV is
  reported as `UV index N` only when `uv_index` is a number; otherwise the
  message says **"UV index unavailable"** — never fake UV on fallback weather.
- `execute_node resolution-standard`: runs
  `selectScentMissionRecommendation` (engine display score + best-family hits
  ×8 − avoid-family hits ×14, ties broken by wardrobe order). Attaches
  scent-facts `research` for the winner when LLM keys exist; research failures
  never block the match. Completing this node flips `resolution-premium` to
  `blocked`.
- `execute_node resolution-premium`: returns `premiumLock` conversion copy and
  no node updates — the node stays locked.

Errors: 400 with `{ error }` for invalid envelopes, 429 from the rate limiter,
500 `{ error }` for unexpected failures (logged via pino).

## Frontend UX spec

- Mission mode is **app-level state** (`missionActive` in `DashboardView`).
  Entering hides `FragranceCapture`, the onboarding steps, and the discovery
  CTA; exiting (X button) restores them. The rest of the dashboard (atmosphere
  bar, vault) is untouched.
- The tree rail renders the 5 nodes with status styling; the gold trunk is a
  `motion.path` animating `pathLength` to `completedNodes / 5`. Reduced motion
  (`useReducedMotion`) or iPad Safari performance mode
  (`isIpadSafariPerformanceMode`) swaps it for a static partial path and
  disables spinner-adjacent flourish. **No animated `backdrop-filter`** — that
  is the documented iPad/Safari GPU-crash construct.
- Onboarding renders destination/energy chip groups inline in the chat scroll;
  Execute is disabled until both are chosen.
- Node execution optimistically sets the node to `running`, restores the prior
  state on failure, and appends a system (red) message with the error.
- Standard resolution renders an in-mission result card first; **Reveal
  Match** maps the recommendation back to the local `Fragrance` (dbId → id →
  normalized brand+name via `findWardrobeMatch`) and opens the existing
  recommendation overlay through the `WardrobeContext` setters.
- The premium node renders as a locked card with conversion copy; "Preview
  Premium" calls `execute_node resolution-premium` and surfaces the lock
  message in chat.
- Styling rides the existing `scent-*` design system (`scent-vault-panel`,
  `scent-type-label`, `scent-type-chip`, `scent-primary-button`,
  `scent-lux-input`) so the panel reads native to the black/gold ScentBeam UI.

## Weather + UV

`GET /api/weather` now returns `uv_index?: number | null`:

- One Call 3.0 path → `current.uvi` (number) when present, else `null`;
- 2.5 fallback path → `null` (the endpoint has no UV field);
- demo/simulated fallbacks → `null`.

`WeatherData` (frontend `WeatherContext`) carries the same optional field. The
mission environment scan and chat prompt must keep saying "unavailable" when it
is null.

## Why not the existing conversations/messages tables

`lib/db/src/schema/conversations.ts` and `messages.ts` exist on disk but are
**not re-exported** from the schema index, are not part of the runtime schema
surface, and are **not tenant/user-scoped**. Do not persist mission chat into
them. Chat persistence is deferred until a properly scoped schema exists
(e.g. `scent_mission_sessions` keyed by tenant+user). Until then the mission is
stateless: the client holds the transcript and the full mission state rides
each request. Remember: schema pushes are manual in this repo
(`pnpm --filter @workspace/db run push`) — a new table 500s until pushed.

## Implementation sequence (as landed)

1. Extracted the engine to `lib/scent-weather-engine` (git-moved file + test),
   left the `@/lib/scentWeatherEngine` shim, registered the package in root /
   api-server / scent-cast tsconfig references and `package.json` deps.
2. Added the mission domain (types, state machine, sanitizers, selection) and
   its unit tests to the package.
3. Added `scentMissionService.ts` (validation, wardrobe row mapping,
   deterministic chat fallback, node execution with injected `llmChat` /
   `research` deps) + tests, and the rate-limited `optionalAuth` route.
4. Added `uv_index` to the weather service and `WeatherData`.
5. Built `scentMissionClient.ts` (pure helpers + tests) and
   `ScentMissionPanel.tsx`; wired `missionActive` into `DashboardView`,
   removing the `ScentIntentModal` render path.

## Risk notes

- **iPad/Safari**: keep the panel free of continuously-animated filters; the
  only animation is a one-shot SVG path tween, gated by reduced-motion and the
  iPad performance flag. The detail-modal OOM investigation
  (`project_ios_detail_modal_crash`) means: no new always-on GPU surfaces.
- **Rate limit vs. UX**: 30 requests / 5 min per IP covers a full mission
  (~5 executes) plus generous chat. If users hit 429s in practice, raise the
  limit before considering per-user keys.
- **LLM spend**: only `chat` turns call the LLM; node execution is
  deterministic except optional research on the single resolved fragrance.
- **Guest trust boundary**: guests can fabricate wardrobe traits — acceptable;
  the worst outcome is a recommendation among items they claimed to own.
  Signed-in flows never use client wardrobe data.
- **Engine drift**: `WardrobeContext` still has its own trait-extraction +
  scoring for the legacy overlay path. The mission selection in the shared
  package mirrors its weights (8 / −14). If you tune one, tune both — or
  finish migrating the context onto the package helpers.

## Test checklist

- `corepack pnpm --filter @workspace/scent-weather-engine run test` — engine
  behavior + mission state machine (progression, premium lock, sanitizers,
  deterministic selection).
- `corepack pnpm --filter @workspace/api-server run test` — includes
  `scentMissionService.test.ts`: payload validation, wardrobe sanitization /
  row mapping, deterministic chat fallback, LLM failure fallback, per-node
  execution, server-wardrobe precedence, research resilience, premium lock.
- `corepack pnpm --filter @workspace/scent-cast run test` — includes
  `scentMissionClient.test.ts`: wardrobe/weather projection, match mapping,
  progress/active-node derivation, response round-trip.
- `corepack pnpm run typecheck` and the two production builds
  (`--filter @workspace/scent-cast run build`, `--filter @workspace/api-server
  run build`).
- Manual smoke (optional, post-deploy): guest mission end-to-end without LLM
  keys (deterministic replies), signed-in mission resolving a real vault, UV
  line on live One Call weather vs "unavailable" on fallback.
