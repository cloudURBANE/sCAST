# 09 — Deploy checklist (Vercel SPA + Railway Express)

What an operator must do so deployed, logged-in users reach the **live** Beam
Agent (grounded in their vault over SSE) instead of the scripted fallback. Two
requirements; both are owner config, not code.

## 1. Set a model provider key on the Railway api-server (required)

The in-process loop calls a model through `beam-agent/provider.ts`. With **no**
provider key configured, every run emits `model_unavailable`, and the SPA
silently falls back to the scripted `/api/scent-mission` path — so the concierge
*looks* fine while the agent never runs.

In the Railway **api-server** service → Variables:

```
OPENROUTER_API_KEY=sk-or-...        # production default (one key, many models)
# — or, as an auto-fallback when OPENROUTER_API_KEY is unset —
ANTHROPIC_API_KEY=sk-ant-...
```

Never commit keys; set them only in the Railway Variables UI (`.env.example`
lists the names). Verify after deploy — the api-server logs one line at startup:

- configured → `Beam Agent model provider configured {"provider":"openrouter"}`
- missing → `Beam Agent has no model provider — set OPENROUTER_API_KEY ...`

Optional: `BEAM_AGENT_PROVIDER=openrouter|anthropic` forces a provider;
`BEAM_RESEARCH_ENABLED=true` (also needs `OPENROUTER_API_KEY`) turns on the live
web-research lane.

## 2. Keep the api-server at a single replica (required, until Phase 5)

Run/session state is an in-memory `Map` in `beamAgentRoutes.ts`. The browser does
`POST /api/beam-agent/runs` (creates the run on one instance), then a **separate**
`GET /runs/:id/events` for the SSE stream. With more than one Railway replica the
SSE attach can land on a different instance, which has no record of the run → the
stream 404s (`code: "run_not_found"`) and the user silently gets the scripted
fallback.

This is enforced in [`railway.json`](../../railway.json):

```jsonc
"deploy": { "numReplicas": 1 }   // do not raise until run-state is in Postgres
```

If the invariant is ever broken, the api-server logs
`beam agent run not found for SSE attach` on every miss — that warning in the
Railway logs is the signal that replicas were scaled up (or the run aged out of
its 30-min TTL / the process restarted mid-run).

**Lifting the limit:** migration-plan Phase 5 moves run/session state into
tenant-scoped Postgres tables; once that ships, the agent is replica-safe and
`numReplicas` can be raised. See [03-migration-plan.md](./03-migration-plan.md).

## 3. Frontend reachability (already wired)

`VITE_API_BASE_URL` / `BACKEND_ORIGIN` route the SPA's `/api/*` to the Railway
api-server (see root `.env.example`). The concierge sends the user's
`localStorage["scent_token"]` as the bearer token the agent's `requireAuth`
needs — no extra config. Guests (no token) always use the scripted path by
design.
