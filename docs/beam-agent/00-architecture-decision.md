# 00 — Architecture decision

**Status:** accepted · **Date:** 2026-06-13 · **Decision owner:** you (Claude
recommended; you asked it to choose and justify).

## Context

This repo contains **two conflicting blueprints** for the same goal, both dated
June 13:

1. **`new.md` (uploaded)** — *"Hermes Agent + Claude Integration Plan."* Run
   [Hermes Agent](https://github.com/NousResearch/hermes-agent) (a real,
   MIT-licensed, self-improving agent runtime, currently v0.15.2) as a separate
   **Python service**, with Claude as the model provider, fronted by a TypeScript
   **Beam MCP tool server**. Very capable: persistent sessions, skills, memory,
   approvals, subagents, MCP. Also the most new infrastructure.

2. **`docs/SCENT_MISSION_AGENT_ANALYSIS.md` (in repo)** — argues the *opposite*:
   keep everything in the current Node/TS stack and add an **in-process
   tool-calling loop** with a small typed toolset, model tiering, and
   catalog-first RAG. Simpler, less to break.

Both are accurate about the current code. They disagree only on **runtime
topology**. The constraints you set: *highly accurate, no bugs, focus on just the
Beam agent, don't break anything, keep it in its own folder.*

## Decision

**Build hybrid and phased. Ship the in-process Claude tool-loop first, behind a
framework-agnostic typed tool layer; keep Hermes as a later, optional swap-in.**

Concretely:

- The **tool contract** (`beam_get_wardrobe`, `beam_search_catalog`,
  `beam_score_candidates`, …) is defined once, in plain TypeScript, decoupled
  from any runtime via a `BeamToolDeps` interface (see
  [02-tool-contract.md](./02-tool-contract.md)). This is the durable asset.
- **Phase 1–4 runtime** is an in-process loop in the existing `api-server`
  (`src/beam-agent/`). No new service, no Python, no new deployment target.
- **If/when** you want Hermes' sessions/skills/approvals/subagents, you expose
  the *same* tools over MCP and point Hermes at them. The Node API stays the
  public gateway; the React UI and the tool contracts don't change.

## Why this over each pure option

**Why not "Hermes as a separate service" first (the `new.md` shape)?**
Even `new.md` concedes *"the fastest implementation is **not** to rewrite the app
around Hermes"* and that its own "minimal first build" is read-only tools. Leading
with a separate Python service adds, before you've shipped a single new
capability: a second runtime and language, a new deployment + secrets boundary, a
second agent loop to observe, and cross-service auth. That is a lot of new surface
for a "no bugs / don't break anything" mandate. The capability Scent Mission
actually lacks today is **a tool-calling loop** — that does not require Hermes.

**Why not "in-process loop, forget Hermes" (the analysis-doc shape)?**
That under-serves your stated endgame. Hermes genuinely owns hard problems you'll
want later — durable multi-session memory, approval lifecycles, skills,
subagent delegation, cross-channel messaging. Throwing it away means rebuilding
those yourself. The hybrid keeps the door open at near-zero cost: the only thing
required to stay Hermes-compatible is to keep the tool layer
**runtime-agnostic** — which is good design regardless.

**Why the typed tool layer is the real product.** Whether the loop is in-process
Claude today or Hermes tomorrow, the value and the risk both live in the tools:
tenant scoping, "never invent a fragrance," deterministic scoring,
confirmation-gated writes. Get those right once and the runtime becomes a
swappable detail.

## What this means for the model/credentials

Keep the architecture **credential- and model-agnostic** (both source docs agree):

- **Dev / owner / beta:** `ANTHROPIC_API_KEY`, or — for owner-only use — Claude
  subscription credentials (and, per `new.md`, the separate Agent SDK credit
  eligible plans can claim after **June 15, 2026**). Fine for low volume.
- **Production multi-user:** Claude Platform API-key billing (or an approved
  enterprise arrangement). **Do not** serve all customers from one personal
  subscription — `new.md` §4 is right about this.
- The Phase 1 provider reads the model from env (`BEAM_AGENT_MODEL`), so swapping
  cheap↔strong tiers or credential sources needs no code change.

## Consequences

- **Now:** a real read-only fragrance agent in your existing stack, isolated in
  one folder, mountable in one line, with zero risk to the running app until you
  opt in.
- **Later, only if you want it:** expose the same tools over MCP, stand up a
  private Hermes service, and migrate the runtime — UI and tool contracts intact.
- **Cost stays close to today's** on the common path (cheap model + deterministic
  scoring + catalog-first retrieval), spending more only on the explicit
  "build me a collection" action.

## Status of the two source docs

Both are kept for reference. `new.md` remains the **north star for the eventual
Hermes runtime and production hardening**; `SCENT_MISSION_AGENT_ANALYSIS.md` is
the **accurate current-state analysis** this plan builds on. Where they conflict
on *topology*, this document supersedes them with the hybrid path.
