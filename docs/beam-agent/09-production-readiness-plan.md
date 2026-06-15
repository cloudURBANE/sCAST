# 09 — Beam Agent: production-readiness plan

**Purpose.** A code-grounded audit of the Beam Agent as it now stands on
`feat/beam-agent-frontend-sse`, plus a prioritized plan to make it sound for a
live, multi-instance web deployment. Every finding names the file/line, a
severity, and an effort estimate so the next pass can act surgically.

**Status of the branch.** The full structural pass is implemented, typechecks
clean across all four packages, and all 318 api-server tests pass (incl. 2 new
note-pyramid builder tests). This document is about what's left to make it
*production-sound*, not about re-doing that work.

> **Update — hardening pass landed (this branch).** Several of the gaps below are
> now implemented in code. Typecheck clean; api-server tests green at **322**
> (4 new). Closed: **P0-1** (`.env.example` Beam block), **P0-4** (SSE 15s
> heartbeat), **P1-2** (per-call token usage captured in both providers + summed
> per run), **P1-3** (one structured `beam agent run finished` log line per run:
> runId, hashed user, outcome, failureCode, turns, tools, modelCalls, tokens,
> synthesis flags, ms), **P1-4** (malformed tool args now return an explicit
> `is_error` tool_result so the model retries instead of misreading empty),
> **P1-5** (loop tests: nudge→tool→synthesis, invalid-args, unconfigured),
> **P2-1** (client `body.model` is no longer honored — the server picks the
> model), **P2-4/P2-5** (stale route header fixed; synthesis failure now flagged
> in the run summary). **Decision A applied:** the Anthropic-direct strong tier
> defaults to `claude-sonnet-4-6` (a real first-party slug, no 404 risk), so the
> cheap-orchestration / smart-synthesis split is ON by default on that path;
> OpenRouter keeps a cheap default and opts into the strong tier via env.
> Still open (need infra/staging, not code): **P0-2** (multi-instance run state —
> single instance or sticky sessions until externalized) and **P0-3** (verify SSE
> through the Vercel edge proxy in staging).

> **Doc drift to fix first.** [07-experience-improvement-audit](./07-experience-improvement-audit.md)
> and [01-current-state](./01-current-state.md) still say backend **B** (the
> Claude loop) is "built, not mounted." It **is** mounted now —
> [app.ts:55](../../artifacts/api-server/src/app.ts#L55) calls `mountBeamAgent(app)`,
> and the SPA's `ScentMissionPanel` routes conversational turns to it via
> `beamAgentClient.ts` with a scripted `/api/scent-mission` fallback. Those docs
> need a one-line status correction so the next reader isn't misled.

---

## Remediation pass status — 2026-06-15

Outcomes of the `HANDOFF_NEXT_PASS_WEBAPP.md` Beam-Agent items in this pass:

- **W-5 / P1-2 (per-user quota + spend metric):** ✅ done — see P1-2 below.
- **W-8 (answer consistency & context honesty):** ✅ done. The synthesis turn is
  now held to the deterministic scorer's ranking (`beamAgentLoop.ts` captures the
  latest `beam_score_candidates` verdict and pins the headline owned-bottle pick
  to the scorer's top match, or forces an explicit one-clause override), and an
  unconditional context-honesty rule forbids inventing a city/climate/season the
  user never gave (the "cool London evenings" failure). Covered by a new loop test.
- **W-6 / P0-3 (SSE through the Vercel edge proxy):** code is **staging-ready**,
  not yet verified on a live deploy (cannot deploy from the dev box). The proxy
  streams `upstream.body` directly with no app-level buffering
  ([middleware.js](../../middleware.js)), and Express's `Cache-Control: no-cache,
  no-transform` survives the proxy's header logic (it only sets `no-store` when
  Cache-Control is absent), so `no-transform` reaches the browser. **Remaining =
  one staging test:** open a real Vercel→Railway run and confirm `message_delta`
  events arrive incrementally (not dumped at the end). If the Edge runtime buffers,
  fall back to attaching `GET /runs/:id/events` directly to the Railway origin, or
  rely on the non-stream `completed` event (already works). Heartbeat (P0-4) is in.
- **W-7 / P0-2 (externalize run/session state):** interim mitigation **confirmed in
  place** — `railway.json` pins `numReplicas: 1`, the SSE attach logs a warning +
  returns `run_not_found` if a run is missing (surfacing a broken single-replica
  invariant), and the route header documents it. The durable fix (run+session
  state in Postgres/Redis) remains **Phase 5** and is intentionally NOT built in
  this pass: it is a large change against the **shared prod Supabase** DB and the
  handoff scopes it as the deferred "real fix." Keep single-replica until then.
- **W-11 (conversations/messages tenant-scoping):** **deferred by design.** These
  two schema files remain off-runtime (not re-exported) and have no `tenantId`/
  `userId`. No persistence is wired this pass, so no cross-tenant surface is
  created. Wiring chat persistence MUST first add `tenantId`/`userId` FKs (mirror
  `pushSubscriptions.ts`), re-export, and confirm both table names are inside
  `drizzle.config.ts` `tablesFilter` before any `push` — see `b-21`. Not started
  here to avoid adding unused, security-sensitive schema to a shared prod DB.
- **W-12 (enrichment producer + worker):** ✅ done — env-gated producer
  (`ENRICHMENT_QUEUE_ENABLED`) enqueues on the backend's own incomplete-coverage
  signal (`isDetailLocallyComplete`), and an env-gated worker
  (`ENRICHMENT_WORKER_ENABLED`) claims jobs with `FOR UPDATE SKIP LOCKED` (never
  racing the failed-job sweeper) and enriches via the engine `/search`+`/details`
  contract. Both default OFF (zero behavior change). Worker orchestration unit-tested.

---

## 1. What the system is now (grounded)

```
Browser (ScentMissionPanel.tsx)
  └─ runBeamAgentMission()  (beamAgentClient.ts)
       POST /api/beam-agent/runs           → { runId, sessionId, eventsUrl }   (202)
       GET  /api/beam-agent/runs/:id/events → SSE: status | message_delta | tool_* | completed | failed
       POST /api/beam-agent/runs/:id/stop   → cooperative cancel
            │  (on failed/unavailable → falls back to scripted /api/scent-mission)
            ▼
  beamAgentRoutes.ts  (auth, tenant scope, rate limit, in-memory run + session registries)
       └─ runBeamAgent()  (beamAgentLoop.ts)
            ├─ callModel()  (provider.ts → OpenRouter | Anthropic-direct)
            │     orchestration turns: tools, 2048 tok
            │     synthesis turn:     tool-free, 4096 tok, STREAMED (onDelta → message_delta)
            └─ createBeamTools()  (beamTools.ts → real services via BeamToolDeps)
                 beam_get_user_context · beam_get_wardrobe · beam_search_catalog
                 beam_get_fragrance_details · beam_score_candidates · [beam_research_web]
```

Key properties already in place and worth preserving:

- **Read-only**, tenant/user scope from `ctx` never from model args
  ([types.ts:30-36](../../artifacts/api-server/src/beam-agent/types.ts#L30-L36)).
- **Server-enforced limits** the model cannot widen (`BEAM_LIMITS`,
  [beamToolCore.ts:20-26](../../artifacts/api-server/src/beam-agent/beamToolCore.ts#L20-L26)).
- **Never throws** — failures become `failed` events; the route also guards the
  fire-and-forget with `.catch` ([beamAgentRoutes.ts:272-275](../../artifacts/api-server/src/beam-agent/beamAgentRoutes.ts#L272-L275)).
- **Event redaction** keeps prompts/ids/creds off the wire
  ([beamToolCore.ts:92-105](../../artifacts/api-server/src/beam-agent/beamToolCore.ts#L92-L105)).
- **Graceful fallback** to the scripted path when the model is unconfigured or a
  run fails ([ScentMissionPanel.tsx:692-694](../../artifacts/scent-cast/src/components/ScentMissionPanel.tsx#L692-L694)).

---

## 2. What this pass delivered (the nine weaknesses)

| # | Weakness | Resolution | Verified |
|---|---|---|---|
| 1 | Cheap tier for everything | Dedicated tool-free synthesis turn via `finish()` using `synthesisModel` ([beamAgentLoop.ts:167-192](../../artifacts/api-server/src/beam-agent/beamAgentLoop.ts#L167-L192)); models resolved per-provider by `resolveBeamModels()` ([provider.ts:47-56](../../artifacts/api-server/src/beam-agent/provider.ts#L47-L56)) | partial — strong tier off by default (see §4) |
| 2 | No memory | Per session/tenant/user in-memory history, 1h TTL, clean text turns only ([beamAgentRoutes.ts:90-119](../../artifacts/api-server/src/beam-agent/beamAgentRoutes.ts#L90-L119)) | ✓ logic; ✗ no test, single-process only |
| 3 | 1024-token cap | `ORCHESTRATION_MAX_TOKENS=2048`, `SYNTHESIS_MAX_TOKENS=4096` ([beamAgentLoop.ts:28-29](../../artifacts/api-server/src/beam-agent/beamAgentLoop.ts#L28-L29)) | ✓ |
| 4 | Thin evidence | `packetFromWardrobeRow` reads the real note pyramid; wired as optional `loadWardrobePackets` dep ([beamToolCore.ts:163-200](../../artifacts/api-server/src/beam-agent/beamToolCore.ts#L163-L200)) | ✓ (2 new tests) |
| 5 | Retrieve-before-recommend unenforced | One bounded `RETRIEVAL_NUDGE` on a zero-tool opening turn ([beamAgentLoop.ts:214-225](../../artifacts/api-server/src/beam-agent/beamAgentLoop.ts#L214-L225)) | ✓ logic; ✗ no test |
| 6 | Prompt all prohibitions | Rewritten to lead with "how to work" before hard rules ([beamAgentLoop.ts:31-56](../../artifacts/api-server/src/beam-agent/beamAgentLoop.ts#L31-L56)) | ✓ |
| 7 | Scoring fixed | Deliberately deferred (Phase-3 ranking; out of scope) | n/a |
| 8 | Silent arg-dropping | Mitigated only; `safeParseArgs` still returns `{}` on bad JSON ([openRouterProvider.ts:151-161](../../artifacts/api-server/src/beam-agent/openRouterProvider.ts#L151-L161)) | open (see §3 P1-4) |
| 9 | No streaming | Real token streaming on the synthesis turn, both providers; SPA shows live preview ([claudeProvider.ts:87-137](../../artifacts/api-server/src/beam-agent/claudeProvider.ts#L87-L137), [openRouterProvider.ts:246-296](../../artifacts/api-server/src/beam-agent/openRouterProvider.ts#L246-L296)) | ✓ logic; ✗ no test |

---

## 3. Production-readiness gaps (new findings)

These are the things that make the difference between "works on my one box" and
"sound for a live web app." Ordered by severity.

### P0 — will break or mislead in the real deployment

**P0-1 · `.env.example` documents none of the Beam config. (S)**
The agent is mounted and live, but `.env.example` has no `OPENROUTER_API_KEY`,
`ANTHROPIC_API_KEY`, `BEAM_AGENT_PROVIDER`, `BEAM_AGENT_MODEL`,
`BEAM_AGENT_MODEL_STRONG`, `OPENROUTER_SITE_URL`, `OPENROUTER_APP_TITLE`, or the
`BEAM_RESEARCH_ENABLED` lane vars (verified: `grep -niE 'beam|openrouter|anthropic' .env.example` → none).
An operator has no way to know what to set; the agent silently degrades to the
scripted path forever. **Fix:** add a documented Beam Agent block to
`.env.example` and a one-paragraph "enable Beam" note in
[docs/beam-agent/README.md](./README.md).

**P0-2 · In-memory run registry breaks under horizontal scaling. (M)**
`runs` and `sessions` are module-level `Map`s
([beamAgentRoutes.ts:71](../../artifacts/api-server/src/beam-agent/beamAgentRoutes.ts#L71),
[:91](../../artifacts/api-server/src/beam-agent/beamAgentRoutes.ts#L91)). The
flow is two HTTP calls: `POST /runs` then `GET /runs/:id/events`. On Railway with
>1 instance (or after a restart/redeploy), the events request can land on an
instance that never saw the run → **404, every time, nondeterministically.** The
route header even flags this ("one process… Phase 5 moves to Postgres"). For a
single instance it's fine; the moment you scale or redeploy mid-conversation it
isn't. **Fix options, cheapest first:** (a) document + enforce **single
instance** for the Beam route as an interim constraint; (b) enable **sticky
sessions** at the proxy; (c) the real fix — move run/session state to Postgres or
Redis (Phase 5). Pick (a)+(b) now, schedule (c).

**P0-3 · SSE through the Vercel edge proxy is unverified. (S to verify, M if broken)**
The production topology proxies `/api/*` through
[middleware.js](../../middleware.js), which does `return new Response(upstream.body, …)`.
That *should* pass the SSE stream through, and Express sets `X-Accel-Buffering: no`
+ `no-transform`. But Edge-runtime response buffering and function execution-time
limits can defeat long-lived SSE, and a buffered stream turns "live preview" into
"frozen, then dumps at the end." **This must be validated against a real Vercel
deploy** before relying on streaming UX. If it buffers, the fallback is fine
(non-stream `completed` still arrives) but the §2.9 win is lost in prod. **Fix:**
test in staging; if buffered, consider hitting the Railway origin directly for the
events endpoint, or add chunked-flush/heartbeat.

**P0-4 · No SSE heartbeat. (S)**
Only one comment frame is sent on open
([beamAgentRoutes.ts:301](../../artifacts/api-server/src/beam-agent/beamAgentRoutes.ts#L301)).
A multi-turn agent run can go many seconds between events; idle proxies
(Railway/Vercel/Cloudflare) may drop a connection with no traffic. **Fix:** emit a
`: ping\n\n` comment every ~15s while the run is open.

### P1 — quality, cost, and safety hardening

**P1-1 · Strong tier is off by default. (S, decision)**
`STRONG_*_MODEL` falls back to the cheap default unless `BEAM_AGENT_MODEL_STRONG`
is set ([claudeProvider.ts:33](../../artifacts/api-server/src/beam-agent/claudeProvider.ts#L33),
[openRouterProvider.ts:40-41](../../artifacts/api-server/src/beam-agent/openRouterProvider.ts#L40-L41)).
So the headline "quality jump" (weakness #1) is dark in every environment until
an operator sets it. See §4 for the recommendation.

**P1-2 · Cost / token / quota accounting. (M) — ✅ Addressed (2026-06-15).**
The synthesis turn adds one extra model call per tool-using run. Beyond the
per-IP rate limit (20 / 5 min, [beamAgentRoutes.ts](../../artifacts/api-server/src/beam-agent/beamAgentRoutes.ts)),
each run is now persisted to the shared `api_usage_ledger`
(`recordBeamRunUsage`, operation `beam.run`) with its captured tokens + estimated
cost, and `POST /runs` enforces a **per-user daily cap** off that ledger
(`getBeamUserUsageSince`): both a run-count cap (`BEAM_USER_DAILY_RUN_CAP`, default
60) and a spend cap (`BEAM_USER_DAILY_SPEND_USD`, default 2) — whichever trips
first returns `429 user_daily_quota_exceeded`. The read is fail-open (ledger
unavailable ⇒ zeros) so a DB hiccup can't lock users out. Daily spend is now a
queryable metric (beam rows surface in `getUsageTotals`). Per-IP limit remains as
the burst guard; full multi-instance durability still rides on P0-2.

**P1-3 · No observability on the agent path. (M)**
`logger.error` fires only on an unexpected crash
([beamAgentRoutes.ts:273](../../artifacts/api-server/src/beam-agent/beamAgentRoutes.ts#L273)).
There's no structured logging of: run started/completed/failed, which tools ran,
turn count, latency, fallback rate, or model-unavailable rate. In production you
won't know if the agent is silently falling back to the scripted path for 90% of
users. **Fix:** structured per-run log line (runId, userId hash, turns, tools[],
ms, outcome) + counters for fallback/timeout/max_turns.

**P1-4 · Silent argument dropping (weakness #8, still open). (S-M)**
`safeParseArgs` returns `{}` on malformed tool-call JSON
([openRouterProvider.ts:151-161](../../artifacts/api-server/src/beam-agent/openRouterProvider.ts#L151-L161)),
and tool handlers coerce missing fields to "empty result" (e.g. catalog search
returns `{ items: [], note: "query is required" }`). A dropped arg becomes an
empty result the model may read as "nothing exists." **Fix:** when args fail to
parse or a required field is missing, return an explicit `tool_result` *error*
(`is_error: true`) so the model retries with corrected args instead of giving up.

**P1-5 · No integration test for the loop, routes, memory, or streaming. (M)**
The 318 tests cover pure core, providers' translation, tools with fakes, and
research policy — but **not** the synthesis branch, the retrieval nudge, session
seeding/writeback, or the SSE route lifecycle (replay + live + close). These are
exactly the new, behavior-bearing additions. **Fix:** add a loop test with a fake
`callModel` driving: (a) zero-tool → nudge → tool path, (b) tool path → synthesis
turn uses `synthesisModel` + empty tools, (c) `onComplete` writeback; and a route
test for SSE replay/forbidden/404.

### P2 — polish and debt

- **P2-1 (S):** `body.model` is passed through from the client untrusted
  ([beamAgentRoutes.ts:267](../../artifacts/api-server/src/beam-agent/beamAgentRoutes.ts#L267)) —
  a caller can pin any orchestration slug (cost vector / unprovisioned-slug
  failure). Allowlist it or drop it; the server should choose the model.
- **P2-2 (S):** Run TTL (30 min) vs session TTL (1h) vs frontend timeout are
  three independent magic numbers; document the intended relationship.
- **P2-3 (S):** `pruneRuns`/`pruneSessions` only run on new requests; an idle
  server holds memory until the next call. Fine at current scale; note it.
- **P2-4 (S):** ✅ Done — stale "not mounted" claim corrected in 01, 07, and the README.
- **P2-5 (S):** Synthesis-turn failure silently falls back to the clipped draft
  ([beamAgentLoop.ts:183-186](../../artifacts/api-server/src/beam-agent/beamAgentLoop.ts#L183-L186)) —
  add a debug log so a high synthesis-failure rate is visible, not invisible.

---

## 4. The two open decisions

**A. Set a concrete `BEAM_AGENT_MODEL_STRONG` so the strong tier is on by default?**
Recommendation: **yes, but only in `.env.example` as a documented, commented
suggestion — not hardcoded in source.** The OpenRouter adapter's own comment is
right that slugs are provider-namespaced and an unprovisioned default breaks live
runs ([openRouterProvider.ts:26-34](../../artifacts/api-server/src/beam-agent/openRouterProvider.ts#L26-L34)).
So: ship `.env.example` with `BEAM_AGENT_MODEL_STRONG=anthropic/claude-sonnet-4.6`
(OpenRouter) / a Sonnet slug (Anthropic-direct) **commented with a "confirm in
dashboard" note**, and set the real value in the Railway/Vercel env. Keep the
source default = cheap so an unconfigured deploy degrades safely rather than 404s
on a bad slug. This makes the quality jump opt-in-per-deploy, not opt-in-per-code.

**B. Commit now?**
The branch is green (typecheck + 318 tests). The blocking gap before this is
*safely* live is **P0-1** (env docs) and a decision on **P0-2** (scaling
constraint). Recommendation: commit the implementation now on
`feat/beam-agent-frontend-sse` (it's already isolated and falls back gracefully),
**fold P0-1 into the same PR**, and capture P0-2/P0-3/P0-4 as the PR's "before we
scale past one instance" checklist. Per `git-guardrails`, this stays a
short-lived feature branch → PR to `main`; don't back-merge `main` into it.

---

## 5. Suggested sequencing

1. **P0-1 (env docs) + P2-4 (doc drift) + decision A** — an afternoon, unblocks
   operators and turns the quality tier on for your deploys.
2. **P0-4 (heartbeat) + P0-3 (verify SSE through Vercel)** — make streaming
   actually reliable in prod, or knowingly accept the buffered fallback.
3. **P1-3 (observability) + P1-2 (cost/quota)** — you cannot run an LLM feature
   live without knowing its fallback rate and its spend.
4. **P1-5 (tests) + P1-4 (explicit tool errors)** — lock in the new behavior and
   stop the "gives up on empty result" symptom at its source.
5. **P0-2 (Postgres/Redis run+session state)** — the real Phase-5 lift; until
   it's done, run a single instance with sticky sessions and say so.

---

## 6. Rollout checklist (gate before calling it "live for everyone")

- [x] `.env.example` documents every Beam var; Railway/Vercel env set to match.
- [x] `BEAM_AGENT_MODEL_STRONG` set to a confirmed slug (or strong tier knowingly off).
      Anthropic-direct defaults to `claude-sonnet-4-6`; OpenRouter opts in via env.
- [ ] SSE verified streaming end-to-end through the Vercel→Railway proxy in staging.
- [x] SSE heartbeat in place; long runs don't drop behind the proxy.
- [ ] Single-instance constraint enforced **or** run/session state externalized.
      (Documented in the route header; still must be enforced at the proxy.)
- [x] Per-run structured logging + fallback/timeout/max_turns counters (via `failureCode`).
- [~] Per-user quota: token usage now recorded per run; a per-user cap is still TODO
      (rate limit remains per-IP — see P1-2).
- [x] Loop integration tests added; `pnpm --filter @workspace/api-server run test` green (322).
- [x] `pnpm --filter @workspace/api-server run typecheck` clean.
- [x] Stale "not mounted" claim corrected in the route header and docs 01/07/README.
```
