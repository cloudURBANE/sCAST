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

## 4. Operating the agent: on/off and model switching

All of the below are owner-config in the Railway **api-server** service →
Variables, applied on **restart**. No code change, no redeploy of the SPA.

### Disable / enable the agent (kill-switch)

```
BEAM_AGENT_ENABLED=false   # turn the live agent OFF for ALL users
```

`BEAM_AGENT_ENABLED` is the global kill-switch, read fresh per request in
`provider.ts` (`isBeamAgentEnabled()`). It is **ON by default**: only an explicit
falsey value — `0`, `false`, `off`, `no`, or `disabled` (case/space-insensitive)
— turns it off. Anything else, including leaving it unset, keeps the agent ON.
Change it and **restart** the api-server to toggle for everyone.

**What users experience when off:** every Beam run emits a graceful
`beam_disabled` failure and the SPA silently falls back to the scripted Scent
Mission — the concierge keeps working, just without the live agent (same UX as
the `model_unavailable` fallback in §1).

### Switch model / provider live

Model selection is fully env-driven (resolved at call time in `provider.ts`,
`openRouterProvider.ts`, `claudeProvider.ts`), so swapping models is just a
variable change + restart — no code edit:

```
BEAM_AGENT_PROVIDER=openrouter|anthropic   # force a provider (else auto-selected)
BEAM_AGENT_MODEL=...                        # default concierge / cheap orchestration lane
BEAM_AGENT_MODEL_STRONG=...                 # synthesis "smart closer" tier
BEAM_AGENT_MODEL_PREMIUM=...                # premium-lane ORCHESTRATION tier (NOT the closer)
BEAM_AGENT_SYNTH_MODEL_DEFAULT=...          # per-lane synthesis closer, default lane
BEAM_AGENT_SYNTH_MODEL_PREMIUM=...          # per-lane synthesis closer, premium lane
```

Defaults when unset (confirm slugs in your provider dashboard — they drift):
OpenRouter uses `google/gemma-4-31b-it:free` (`BEAM_AGENT_MODEL` /
`BEAM_AGENT_MODEL_PREMIUM`) and `tencent/hy3-preview` (`BEAM_AGENT_MODEL_STRONG`);
Anthropic-direct uses `claude-haiku-4-5-20251001` and `claude-sonnet-4-6`. The
`BEAM_AGENT_SYNTH_MODEL_*` overrides fall back to the strong slug when unset.

Do **not** pin `BEAM_AGENT_MODEL_PREMIUM` to the expensive synthesis/closer slug
— that puts every premium tool-calling turn on the closer model (the documented
~$0.60/mission blowup). The full model ladder and cost rationale live in
[10-cost-optimized-model-stack.md](./10-cost-optimized-model-stack.md); every
name above is mirrored in the root `.env.example` Beam Agent block.
