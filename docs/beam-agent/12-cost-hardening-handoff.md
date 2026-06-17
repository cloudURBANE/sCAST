# Beam Agent — Cost Hardening: what shipped + the finish-line handoff

**Audience:** the next engineer/agent. **Type:** action handoff. Verify the work below, then
complete the remaining cost work to a **production-ready** standard. Every claim maps to
`file:line` and was verified on **2026-06-17**; the implemented changes pass `tsc` + the full
api-server suite (**437/437**).

---

## 0. Context — the cost diagnosis (why we're here)

OpenRouter logs (1-day window, app = *ScentBeam Beam Agent*) showed the spend is almost
entirely **Claude Sonnet 4.6 calls with ~25–29k input tokens and tiny output**. Four root
causes, all in code:

1. **No prompt caching** — both providers re-billed the full ~20k-token system+tools+transcript
   prefix on every agentic turn.
2. **`maxToolResultChars: 100_000`** — a single tool result can be ~25k tokens, kept in the
   transcript and re-sent every subsequent turn ([beamToolCore.ts:28](../../artifacts/api-server/src/beam-agent/beamToolCore.ts)).
3. **Synthesis always runs the strong (Sonnet) model**, even on the cheap lane → ~$0.077 floor
   per default mission.
4. **Premium lane ran the WHOLE loop on Sonnet** — a `trip`/`kit` keyword → 7+ Sonnet
   tool-turns at ~28k input ≈ **$0.60/mission**.

Per-mission before: default ≈ **$0.08**, premium ≈ **$0.40–0.60**.

---

## 1. What shipped in THIS pass (verify this work first)

### #1 — Prompt caching (both providers)
- **Anthropic-direct** ([claudeProvider.ts](../../artifacts/api-server/src/beam-agent/claudeProvider.ts)):
  `cachedSystem` / `cachedTools` / `cachedMessages` add `cache_control:{type:"ephemeral"}`
  breakpoints at the end of `system`, the last tool, and the last message block. The system
  prompt + tool schemas are run-stable (computed once per run — [beamAgentLoop.ts:497,580](../../artifacts/api-server/src/beam-agent/beamAgentLoop.ts)),
  so calls 2..N in a run read that prefix at ~10% of input price.
- **OpenRouter** ([openRouterProvider.ts](../../artifacts/api-server/src/beam-agent/openRouterProvider.ts)):
  `modelSupportsCaching()` gates caching to Anthropic slugs only (MiniMax keeps the plain-string
  shape — no surprise behavior on the cheap lane). When enabled, the system prompt is sent as a
  single cached text part. **Limitation (intentional, for the next pass):** only the *system*
  prompt is cached on OpenRouter — the transcript/tool-result tail is **not** yet cached there
  (tool-role message parts aren't a documented OpenRouter cache surface). On Anthropic-direct the
  transcript tail **is** cached.

### #4 — Premium-lane blowup
- **Separated the two model roles** ([provider.ts:`resolveBeamModels`](../../artifacts/api-server/src/beam-agent/provider.ts)):
  the `strong`/synthesis slug (often a Sonnet override via `BEAM_AGENT_MODEL_STRONG`) is now used
  for the **closing synthesis turn only**. Premium **orchestration** uses its own cheap tier via
  the new `premiumOrchestrationModel()` (`BEAM_AGENT_MODEL_PREMIUM`, default `minimax/minimax-m3`).
  This restores brief §03.2's actual intent (premium = M3) and means premium can never again put
  the tool loop on Sonnet. Anthropic-direct mirrors this (premium orchestration stays on Haiku/the
  default unless `BEAM_AGENT_MODEL_PREMIUM` is pinned).
- **Narrowed over-broad triggers** ([laneSelector.ts](../../artifacts/api-server/src/beam-agent/laneSelector.ts)):
  dropped `date night` and `signature scent` (everyday one-shot asks). Kept genuinely multi-step
  ones (trip/kit/travel/audit/redundancy/optimize/layering/purchase strategy/capsule).

**Tests added:** `provider.test.ts` (new — locks `premium.model !== synthesisModel`),
`openRouterProvider.test.ts` (+caching/premium-model), `laneSelector.test.ts` (+de-escalation).

### Verify-my-work checklist
- [ ] `corepack pnpm --filter @workspace/api-server run typecheck` is clean.
- [ ] `corepack pnpm --filter @workspace/api-server run test` → all green (437+).
- [ ] Read `resolveBeamModels` and confirm: on OpenRouter, `premium.model` is M3 and
      `synthesisModel` is whatever `BEAM_AGENT_MODEL_STRONG` is — and they are never equal when
      STRONG is overridden.
- [ ] In a live OpenRouter log line for a Sonnet call, confirm a **cache discount** appears
      (cached input tokens priced lower) once traffic flows post-deploy. If not, the provider
      OpenRouter routed to may not support caching for that request — check the `provider` column
      (Anthropic and Google Vertex both support Anthropic prompt caching).

---

## 1b. What shipped in the FOLLOW-UP pass (2026-06-17, second sitting)

The high-impact, behavior-preserving items below are now **implemented + verified**
(tsc clean, api-server suite **441/441**). The remaining `#3` is left as a product
decision (see §2).

### #2 — Tool-result trimming (DONE — record-aware, not a blind slice)
- New pure helper `boundToolResultForTranscript`
  ([beamToolCore.ts](../../artifacts/api-server/src/beam-agent/beamToolCore.ts)) caps
  array COUNT (`maxToolResultArrayItems: 16`) and string LENGTH
  (`maxToolResultStringChars: 1000`) recursively, with a depth ceiling. Output is
  always valid JSON (no mid-record cut — the reviewer's risk), short identifying
  fields (name/brand/accords) always survive, and a dropped array tail leaves a
  `…+N more` marker. `maxToolResultChars` lowered `100_000` → `12_000` as a final
  backstop only.
- Wired at [beamAgentLoop.ts:~860](../../artifacts/api-server/src/beam-agent/beamAgentLoop.ts):
  the transcript copy is bounded BEFORE serialization. Crucially the **untrimmed**
  `result` still feeds grounding (`collectGroundedFragranceNames`) and the UI cards,
  so trimming never weakens the answer-gate allowlist.
- Side-effect: a circular/unserializable result is now depth-bounded into a usable
  shape instead of throwing → the old "unserializable → is_error" path is gracefully
  handled (the no-duplicate-`tool_use_id` invariant is preserved and still tested).
- Tests: `boundToolResultForTranscript` count/length/grounded-name cases in
  `beamToolCore.test.ts`; the circular-result loop test updated.

### Transcript caching reaches the OpenRouter synthesis call (DONE — closes §1's gap)
- `toOpenAiMessages` now marks the **last user turn** as a cache breakpoint for
  caching-capable (Anthropic) slugs via `markLastUserCacheBreakpoint`
  ([openRouterProvider.ts](../../artifacts/api-server/src/beam-agent/openRouterProvider.ts)).
  The closing synthesis transcript ends on the folded user instruction, so the whole
  ~25k-token prefix (system + every tool result) is now read from cache on the Sonnet
  synthesis call — the call where the discount pays off. Restricted to the user role
  (the documented OpenRouter surface); tool-role parts left untouched. MiniMax keeps
  the plain-string shape. Anthropic-direct already cached the transcript tail.
- Tests: caching marks the trailing user turn; non-caching leaves it a plain string.

### #5 — Per-user daily cost cap (ALREADY DONE — handoff was stale)
- Implemented at [beamAgentRoutes.ts:69-296](../../artifacts/api-server/src/beam-agent/beamAgentRoutes.ts):
  a per-user/day run-count cap (`BEAM_USER_DAILY_RUN_CAP`, default 60) AND a USD cap
  (`BEAM_USER_DAILY_SPEND_USD`, default 2), read off the usage ledger
  (`getBeamUserUsageSince`), 429-ing whichever trips first. Fail-open (a ledger hiccup
  never locks users out). It is ledger/DB-backed rather than the Redis-backed design §2
  sketched, but it satisfies the "ready to scale" backstop. Tune via env per environment.

---

## 2. Finish the cost work to production-ready (the remaining asks)

### #2 — DONE in §1b. (Original brief retained below for context.)
Tool-result trimming (HIGH impact on synthesis input):
The synthesis call's ~25k input is dominated by accumulated tool-result JSON in the transcript,
not the system prompt. Caching helps repeat turns; trimming shrinks the base.

- **Lower `maxToolResultChars`** from `100_000` → ~`8_000`–`12_000`
  ([beamToolCore.ts:28](../../artifacts/api-server/src/beam-agent/beamToolCore.ts); used at
  [beamAgentLoop.ts:860](../../artifacts/api-server/src/beam-agent/beamAgentLoop.ts)). Measure the
  real serialized sizes of `beam_search_catalog` (12 results) and `beam_score_candidates` first so
  you don't truncate mid-record — prefer trimming **result count / per-field length** over a blind
  char slice. A blind slice can cut a JSON record in half and the model reads garbage.
- **Better:** project tool results to a lean shape the model actually needs (name, brand, key
  accords, score) before they enter the transcript, keeping the full payload only for the UI-card
  events. The card sanitizers already cap fields (`maxCardAccords`, `maxCardNotes`, etc.) — reuse
  that discipline for what goes into `messages`.
- **Guardrail:** add a test asserting a large tool result is bounded in the transcript, and that a
  grounded name survives trimming (don't regress the grounding allowlist at
  [beamAgentLoop.ts:~193](../../artifacts/api-server/src/beam-agent/beamAgentLoop.ts)).

### #3 — Default-lane synthesis model (product call — confirm with owner)
Today both lanes synthesize on the strong (Sonnet) slug → a ~$0.077 floor on every default
mission. Options, cheapest-first:
- **(a)** Default-lane synthesis on MiniMax M3 instead of Sonnet; reserve Sonnet synthesis for the
  premium lane only. Wire this in `resolveBeamModels` by returning a lane-aware `synthesisModel`.
- **(b)** Keep Sonnet synthesis but rely on #1+#2 to make its input cheap. Validate the real
  post-cache cost before deciding — caching may make Sonnet synthesis cheap enough to keep
  everywhere (best quality).
- Whichever you pick, add a `provider.test.ts` case pinning the default-lane `synthesisModel`, and
  do a **quality A/B** (M3 vs Sonnet closer) on the regression transcript in §4 before flipping —
  the closing recommendation is the most user-visible output, so don't trade quality blind.

### Fine-tuning opportunities (do after #2/#3)
- **Split the system block** into the stable `SYSTEM_PROMPT` (cache it) and the volatile
  `beamSessionStatePrompt(...)` suffix (don't), so a mid-run slot update doesn't bust the system
  cache. Today they're concatenated at [beamAgentLoop.ts:497](../../artifacts/api-server/src/beam-agent/beamAgentLoop.ts);
  pass `system` as two parts and put the breakpoint after the stable half.
- **OpenRouter transcript caching** — close the limitation noted in §1. Investigate whether
  OpenRouter accepts `cache_control` on user-part content for the folded synthesis instruction
  ([beamAgentLoop.ts:`withSynthesisInstruction`](../../artifacts/api-server/src/beam-agent/beamAgentLoop.ts)),
  which would cache the synthesis transcript on the OpenRouter path too.
- **#5 cost cap** — **DONE** (see §1b). Both a per-user/day run-count cap and a USD cap are
  enforced off the ledger at [beamAgentRoutes.ts:69-296](../../artifacts/api-server/src/beam-agent/beamAgentRoutes.ts),
  on top of the per-IP `beam-runs` limiter (20 runs/5min). Optional future polish: move it to the
  Redis store (lower latency than a ledger query) and/or surface the remaining budget to the client.

---

## 3. Production wiring checklist (Railway — operator must verify; not doable from the dev box)

| Env var | Required value | Why it matters |
|---|---|---|
| `REDIS_URL` | the Upstash URL | **Critical.** Without it, sessions fall back to a 1h in-memory Map on a single replica ([beamSessionStore.ts:17,47](../../artifacts/api-server/src/beam-agent/beamSessionStore.ts)) — a redeploy mid-session wipes all memory. Confirm it's set AND that logs don't show "redis … failed - using in-memory session". |
| `BEAM_AGENT_MODEL_STRONG` | the Sonnet slug (e.g. `anthropic/claude-sonnet-4.6`) | Now used for **synthesis only**. Confirm it's still the closer you want. |
| `BEAM_AGENT_MODEL_PREMIUM` | **leave unset** (→ `minimax/minimax-m3`), or pin to M3 | NEW. **Never set this to a Sonnet/closer slug** — that re-creates the premium blowup. |
| `BEAM_AGENT_MODEL` | unset (→ `minimax/minimax-m2.5`) | Default-lane orchestration. |
| `OPENROUTER_API_KEY` | the (rotated) key | The leaked key from the diagnosis chat must be **rotated** in the OpenRouter dashboard. |
| `BEAM_AGENT_PROVIDER` | unset/`openrouter` | Production path. |

**Post-deploy validation:** run the §4 regression transcript live, then read the OpenRouter logs:
premium missions should show MiniMax (M3) orchestration turns + a single Sonnet synthesis (not 7
Sonnet turns), and Sonnet calls should show a cache discount on turns after the first.

---

## 4. Regression transcript (run live before re-exposing users)

```
User: I'm planning a trip to Tokyo and need two fragrances to take + two new ones not in my collection
User: August and artsy
User: Idk you tell me
```
Cost expectations after this pass:
- Premium lane fires (trip/kit) but orchestration is **M3, not Sonnet** → no $0.60 mission.
- Exactly one Sonnet **synthesis** call per turn that closes; its input shows a cache discount.
- (Brain acceptance criteria from `BEAM_AGENT_ROOTCAUSE_HANDOFF.md` §6 still apply — don't regress
  slots/delegation/mission gates.)

---

## 5. Hermes note (don't forget)
Hermes/MCP is verified and parity-ready but **inert in prod** (Railway runs only the Express API;
nothing starts `beam:mcp`). See `docs/beam-agent/11-hermes-mcp-connection-status.md`. **None of the
cost fixes in this pass are inherited by the Hermes loop** — it drives its own orchestration. If
Hermes is ever promoted, the lane/caching/trimming logic must be re-expressed there (or Hermes must
call back through a cost-governed seam).

---

*Implemented + verified 2026-06-17 (first sitting): #1 caching (both providers) and #4
premium-lane split; tsc clean; suite 437/437.*

*Implemented + verified 2026-06-17 (second sitting): #2 record-aware tool-result trim,
OpenRouter synthesis-transcript caching; confirmed #5 cost cap already in place. tsc clean;
api-server suite 441/441. **Only remaining item: #3** — whether the DEFAULT lane closes on
MiniMax M3 instead of Sonnet. That is a product/quality call (the closing recommendation is the
most user-visible output) and per §3 it needs a quality A/B before flipping, so it was deliberately
NOT changed here — both lanes still synthesize on the strong (Sonnet) slug, now with cheap cached +
trimmed input. The split system-cache fine-tuning (§2) was judged low-value vs. blast radius and
skipped (system already caches whole; only state-change turns lose it).*

---

## 6. Lane-aware synthesis routing + run budgets (third sitting, 2026-06-17)

Turns #3 from a blind code flip into a **config A/B** and adds the cost guardrails a
cheaper/reasoning closer needs — all opt-in, **defaults exactly match prior behavior**.

**What changed (code):**
- `provider.ts` — `resolveBeamModels(lane)` now resolves the synthesis closer **per lane**
  via `synthesisModelForLane`: `BEAM_AGENT_SYNTH_MODEL_DEFAULT` / `BEAM_AGENT_SYNTH_MODEL_PREMIUM`,
  each falling back to the provider strong slug (unset ⇒ unchanged on both lanes). New
  `resolveBeamBudget(lane)` returns `{ maxTurns, orchestrationMaxTokens, synthesisMaxTokens }`
  from env (`BEAM_AGENT_MAX_TURNS_*`, `BEAM_AGENT_ORCH_MAX_TOKENS`, `BEAM_AGENT_SYNTH_MAX_TOKENS`),
  defaulting to the `BEAM_LIMITS` values; `maxTurns` is clamped to the hard ceiling (8 — env can
  only lower it).
- `beamToolCore.ts` — output-token defaults (`orchestrationMaxTokens: 2048`,
  `synthesisMaxTokens: 4096`) moved into `BEAM_LIMITS` as the single source of truth.
- `beamAgentLoop.ts` — accepts `orchestrationMaxTokens` / `synthesisMaxTokens` and uses them for
  the orchestration, synthesis, and repair calls (was two module constants).
- `beamAgentRoutes.ts` — resolves `resolveBeamBudget(lane)` and forwards the caps + `maxTurns`.

**DeepSeek V4 is now a drop-in A/B** (no new provider, no first-party PRC data path — it routes
through the existing OpenRouter seam):
```
BEAM_AGENT_SYNTH_MODEL_DEFAULT=deepseek/deepseek-v4-flash   # everyday closer
BEAM_AGENT_SYNTH_MODEL_PREMIUM=deepseek/deepseek-v4-pro     # nuanced closer
BEAM_AGENT_SYNTH_MAX_TOKENS=2000                            # cap reasoning-as-output bill
BEAM_AGENT_MAX_TURNS_DEFAULT=4                              # tighten free-lane tool rounds
```
Recommended routing (from the V4 cost analysis): default lane → V4 Flash, premium lane → V4 Pro,
strong/Sonnet kept as the verification fallback. Caching + record-aware trimming from sittings 1–2
apply unchanged on top.

**Two risks to weigh before flipping in prod (NOT addressed in code — they're operational):**
1. *Reasoning-token billing* — reasoning slugs bill their trace as output; the new
   `BEAM_AGENT_SYNTH_MAX_TOKENS` cap is the rail, set it before enabling V4.
2. *Data handling* — first-party DeepSeek processes/stores prompts in the PRC. This pass routes
   via OpenRouter precisely to avoid that direct path; do **not** add a first-party DeepSeek
   provider without a data-handling decision.

**Still a product call:** which closer actually ships by default. The mechanism is in place and
defaults are unchanged — run the A/B, then set the env. No code change needed to flip.

*Implemented + verified 2026-06-17 (third sitting): lane-aware synthesis routing + per-lane run
budgets, DeepSeek V4 enabled as an OpenRouter drop-in. tsc clean; api-server suite green (+budget
and lane-routing tests).*
