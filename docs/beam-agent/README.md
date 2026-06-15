# Beam Agent — build plan

Turning **Scent Mission** (the "Beam Agent") from a scripted, single-turn wizard
into a real tool-calling agent — accurately, incrementally, and without breaking
the existing app.

This folder is the single source of truth for that work. Phase 1 code already
lives in `artifacts/api-server/src/beam-agent/` (additive, **not yet mounted**).

## Read in this order

| Doc | What it covers |
|---|---|
| [00-architecture-decision.md](./00-architecture-decision.md) | The recommended path and *why* — reconciles the two conflicting blueprints in this repo. |
| [01-current-state.md](./01-current-state.md) | Code-grounded read of what Scent Mission is today, with exact file references. |
| [02-tool-contract.md](./02-tool-contract.md) | The typed tool surface: the read-only set that shipped in Phase 1, and the write tools to come. |
| [03-migration-plan.md](./03-migration-plan.md) | Phases 0–7 mapped to real files, the no-touch list, security/writes/memory, testing & evals. |
| [09-deploy-checklist.md](./09-deploy-checklist.md) | The two operator requirements to make the deployed agent actually run: a model provider key + single-replica SSE run-state. |

## TL;DR

- **What's wrong today:** the LLM has no tools. It emits text; every node and
  button is hardcoded React; the one recommendation is deterministic code over
  bottles the user already owns; the prompt explicitly *forbids* building
  collections; nothing persists. It looks agentic; it isn't.
- **Recommended path:** a **hybrid, phased** build. Add an in-process Claude
  tool-calling loop now (lowest risk, reuses your Node/TS stack), behind a
  **framework-agnostic typed tool layer** so a Hermes/MCP runtime can be swapped
  in later for the heavier features (sessions, skills, approvals) without
  rewriting the tools or the UI. This honors the uploaded Hermes plan's endgame
  while de-risking the near term.
- **What shipped in Phase 1:** five **read-only** tools + the agent loop + SSE
  run endpoints, all isolated in one folder and unmounted. No writes, no schema
  changes, no edits to existing files.

## Guardrails carried through every phase

1. The model never invents fragrances — it may only reference ids returned by a
   tool.
2. Deterministic scoring stays in code; the LLM never does the math.
3. Tenant/user scope comes from the authenticated session, never from model
   arguments.
4. No write happens without an explicit, app-issued confirmation token.
5. Each new piece lands in its own folder and is opt-in, so the live app is
   never destabilized by in-progress work.
