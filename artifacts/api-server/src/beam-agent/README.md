# Beam Agent module (Phase 1 — read-only)

A self-contained, **additive** module that turns Scent Mission from a scripted
wizard into a real tool-calling agent. It is **not mounted** into the app by
default — the existing server is untouched until you opt in.

## What this is

An in-process Claude tool-calling loop with a small, typed, **read-only** tool
surface that reuses services that already ship in this repo (catalog search,
scent-facts research, the deterministic weather engine, the vault). The model
decides *which* tools to call; the server enforces scope, limits, and safety.

See `../../../../docs/beam-agent/` for the full plan, architecture decision, and
phased migration.

## Files

| File | Role | Deps |
|---|---|---|
| `types.ts` | Shared types | none (pure) |
| `beamToolCore.ts` | Pure helpers (validation, redaction, packet builders, Claude parsing) | none (pure) |
| `beamToolCore.test.ts` | Unit tests for the pure layer | `node:test` |
| `claudeProvider.ts` | Anthropic Messages API via `fetch` | env only |
| `beamTools.ts` | Read-only tool definitions; service-agnostic via `BeamToolDeps` | engine types |
| `beamAgentLoop.ts` | The agent loop (budget-capped, never throws) | core + provider |
| `beamAgentRoutes.ts` | `POST /runs`, `GET /runs/:id/events` (SSE), `POST /runs/:id/stop` | db, services |
| `index.ts` | Public exports + `mountBeamAgent` | — |

## Tools (Phase 1, all read-only)

- `beam_get_user_context` — vault summary + today's weather
- `beam_get_wardrobe` — the user's owned fragrances as candidate packets
- `beam_search_catalog` — search `global_fragrances` for real fragrances
- `beam_get_fragrance_details` — best-effort research facts (never persists)
- `beam_score_candidates` — deterministic weather ranking of the vault

No write tools exist yet. Saving/adding arrives in Phase 4 behind app-issued
confirmation tokens.

## Enable it (one line, when ready)

In `src/app.ts`:

```ts
import { mountBeamAgent } from "./beam-agent/index.ts";
// after the tenant + body-parser middleware, alongside other app.use(...) routes:
mountBeamAgent(app);
```

Set the model credential:

```env
ANTHROPIC_API_KEY=sk-ant-...
# optional overrides:
BEAM_AGENT_MODEL=claude-haiku-4-5-20251001
```

If `ANTHROPIC_API_KEY` is unset, runs fail gracefully with a `model_unavailable`
event — they never crash the server.

## Run the tests

```bash
# from artifacts/api-server
node --experimental-strip-types --test src/beam-agent/beamToolCore.test.ts
```

## Before mounting

Run the workspace typecheck in your environment (the agent module is included in
`tsconfig`'s `src` glob):

```bash
pnpm --filter @workspace/api-server run typecheck
```

## Deliberately out of scope for Phase 1

Writes, persistent sessions/memory, multi-fragrance collection proposals, the
external search-engine fallback, and enrichment. Each has a phase in
`docs/beam-agent/03-migration-plan.md`.
