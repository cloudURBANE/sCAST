# Beam Agent — cost-optimized model stack

This doc records how the *Beam / ScentBeam Cost-Optimized Model Stack* brief
(`beam_model_stack_optimized_no_verifier.md`, v2.0) was applied to the existing
`artifacts/api-server/src/beam-agent/` subsystem. The brief's thesis: **drop the
separate verification LLM and move trust into deterministic contracts**. The
Beam Agent already had no verifier model, so the work was to (1) retarget the
model ladder, (2) add deterministic answer quality gates as the verifier
replacement, and (3) add cost telemetry plus a cheap deterministic lane selector.

This was a deliberate, bounded mapping onto existing infra — **not** a greenfield
`/src/ai/*` build. The brief's router LLM, Decodo client, and 50-case eval
harness were intentionally left out (the orchestration loop already routes tools;
the research lane already handles fresh external facts).

## 1. Model ladder (brief §02, §16)

Defaults are read at call time and overridable per deployment. **Provider slugs
drift — re-verify in the OpenRouter dashboard before production (brief §15).**

| Lane | OpenRouter default | Env var | When |
|---|---|---|---|
| Default concierge / orchestration | `minimax/minimax-m2.5` | `BEAM_AGENT_MODEL` | normal fragrance chat |
| Premium / synthesis | `minimax/minimax-m3` | `BEAM_AGENT_MODEL_STRONG` | the closing synthesis turn; the whole premium lane |
| Deep strategy | `moonshotai/kimi-k2-thinking` | `BEAM_AGENT_MODEL_DEEP` | gated deep workflows only (hot path never auto-routes here) |

Code: `openRouterProvider.ts` (`defaultOpenRouterModel` / `strongOpenRouterModel`
/ `deepOpenRouterModel`), `provider.ts` (`resolveBeamModels(lane)`,
`resolveDeepModel`). Anthropic-direct stays as the graceful fallback provider.

The research lane (`research/researchConfig.ts`) already defaulted to
`minimax/minimax-m3` and `moonshotai/kimi-k2.7-code`, matching the brief.

## 2. Deterministic concierge lane (brief §03)

`laneSelector.ts` picks `default` vs `premium` from signals available at the
route — the user message and how many prior turns the session carries — with **no
extra router LLM call**. Premium triggers on trip/collection/audit/redundancy/
layering keywords, a very long message, or a deep multi-turn session. Deep (Kimi)
is never selected here; it stays gated (brief §14.2 "do not call Kimi for normal
fragrance chat"). Wired in `beamAgentRoutes.ts` via `selectConciergeLane`.

## 3. Answer quality gates — the verifier replacement (brief §08, §01.3)

`answerQualityGates.ts` runs a pure, sound pass over the final answer and rejects:

- `price_without_evidence`, `availability_without_evidence`,
  `review_claim_without_evidence` — only when the run gathered **no** fresh
  external fact (the research lane returned a real fact, not a `note`);
- `leaked_external_instruction` — prompt-injection text leaking into the reply;
- `over_length`.

Fragrance-name grounding is already enforced mechanically upstream by the
synthesis allowlist (`beamAgentLoop.ts` `groundingAllowlistClause`), so the gates
cover the external-fact surface that allowlist does not.

Wiring (`beamAgentLoop.ts` `finish()`): after synthesis, gates run; on a hard
violation **and** with budget remaining, **one** constrained re-synthesis feeds
the broken rules back (brief §08.1 `if_fail`) and the draft with fewer violations
ships. Bounded to a single attempt — it can never loop, and never throws.

## 4. Cost telemetry (brief §09.1, §11.3, §15)

`costLedger.ts` holds a hard-coded `$/M` table from the brief's §15 snapshot
(auditable, mirroring `services/apiUsageLedger.ts`). The loop tallies tokens
per model lane and the run summary carries `estimatedCostUsd`,
`qualityGatePassed`, and `qualityViolations`, logged per run in
`beamAgentRoutes.ts` (brief §11.3 fields `estimated_llm_cost_usd`,
`quality_gate_passed`).

## 5. Out of scope (follow-ups)

- Separate L0/L1 **router LLM** on every turn — replaced by the deterministic
  lane selector to avoid hot-path cost/latency.
- Standalone `decodoClient`, a new `/src/ai/*` tree, and the 50-case eval harness
  (brief §12) — duplicative of existing infra.
- Hard cost **circuit breakers** / session caps (brief §09.2) — the ledger gives
  the estimate; enforcement is a future pass.

## 6. Tests

`laneSelector.test.ts`, `costLedger.test.ts`, `answerQualityGates.test.ts`, and
new cases in `beamAgentLoop.test.ts` (gate repair + cost in summary). Run:

```bash
pnpm --filter @workspace/api-server run test
```
