# Addendum — Hermes Agent MCP: are we actually connected?
**Companion to:** *ScentBeam "Beam Agent" — Code-Grounded Root-Cause Handoff*
**Type:** READ-ONLY verification. No code changed. Every claim mapped to `file:line`, verified against source on **2026-06-16**.
**Question answered:** Is the live app actually connected to / running the Hermes Agent MCP, or is that code just scaffolding on disk?

---

## TL;DR
**No — the running app is NOT connected to Hermes.** The live user path the handoff audited (SPA → `beamAgentRoutes.ts` → `beamAgentLoop.ts` → `provider.ts`/OpenRouter, **in-process**) never touches the Hermes/MCP code. The Hermes integration is **real, committed, and functional**, but it is an **alternative, opt-in runtime** that nothing in the deployment starts. It requires a separate manually-run process, an external Hermes install, a minted token, and a secret — none of which the Railway deploy provides.

**Important correction to the handoff:** §1 and §3 (B2) dismiss `mcp/delegationToken.ts` as *"unrelated auth."* That is **wrong**. It is the HMAC agent-delegation token for the Beam→Hermes MCP runtime — squarely Beam-related. The handoff's practical conclusion still holds (it isn't part of the live audited loop), but the *reason* given is incorrect: it's not unrelated, it's a **different (inactive) runtime**.

---

## What actually exists (and works)
A complete, deliberate Beam-over-MCP runtime so Hermes Agent (with Claude as its reasoning model) can call the existing read-only Beam tools:

- **MCP HTTP server** — `artifacts/api-server/src/beam-agent/mcp/beamMcpServer.ts` (stateless Streamable-HTTP adapter over `createBeamTools`, real MCP SDK v1.x).
- **Entrypoint** — `mcp/mcpMain.ts` (binds `127.0.0.1:8848`, refuses to start without `BEAM_AGENT_TOKEN_SECRET`).
- **Auth core** — `mcp/delegationToken.ts` (HMAC mint/verify), `mcp/mcpContext.ts` (scope→tool map, derives tenant/user **from the token**, never from args), `mcp/mintOwnerToken.ts`.
- **Hermes profile** — top-level `hermes-beam/` (AGENTS.md, SOUL.md, beam-context/, skills/, `config.example.yaml`, `dot-hermes-env.example`).
- **Docs** — `docs/beam-agent/05-hermes-setup-runbook.md`, `00-architecture-decision.md`.
- **Dependency present & installed** — `@modelcontextprotocol/sdk ^1.29.0` is in `artifacts/api-server/package.json` and resolved in `artifacts/api-server/node_modules/`.
- **Scripts present** — `beam:mcp:build`, `beam:mcp`, `beam:mint-token` (`artifacts/api-server/package.json:13-15`); builder `artifacts/api-server/build-beam-mcp.mjs` exists.

So this is not vapor — it builds and runs if you start it.

## Why it is NOT live in this deployment
| Check | Finding | Evidence |
|---|---|---|
| Live loop imports the MCP/Hermes path? | **No.** Zero imports of `mcp/` or "hermes" in the live loop or route. | grep of `beamAgentLoop.ts`, `beamAgentRoutes.ts` → "NO mcp/hermes import" |
| What the live loop actually calls | The **in-process** provider (OpenRouter/Anthropic direct), not Hermes. | `beamAgentLoop.ts:29` imports `./provider.ts`; `:483` "Set OPENROUTER_API_KEY (or ANTHROPIC_API_KEY)" |
| Does the deploy start the MCP server? | **No.** Railway/Docker run `pnpm start` → api-server `start` → `dist/index.mjs` (Express API only). `beam:mcp` is never invoked. | `railway.json` `startCommand: "pnpm start"`; `Dockerfile:31 CMD ["pnpm","start"]`; root `package.json:13` → api-server `start` = `dist/index.mjs` |
| Is the MCP server mounted inside the API process? | **No.** It's a standalone Express app on its own port (8848); the main API never builds `createBeamMcpApp`. | `beamMcpServer.ts` self-contained; no reference from `app.ts`/routes |
| Real Hermes config in repo? | **No.** Only `config.example.yaml` / `dot-hermes-env.example`. A live `~/.hermes/config.yaml` lives on an operator machine, not here. | `hermes-beam/config.example.yaml` (header: "MERGE into ~/.hermes/config.yaml — not a standalone file") |
| Required secret/token | `BEAM_AGENT_TOKEN_SECRET` + a minted bearer token are required; server is localhost-only and exits without the secret. | `mcpMain.ts:16-24`; `beamMcpServer.ts:110-124` |

## Mental model (the two runtimes)
```
LIVE (production, audited by the handoff):
  SPA → beamAgentRoutes.ts → beamAgentLoop.ts → provider.ts → OpenRouter/Anthropic
        (in-process; createBeamTools called directly; NO MCP, NO Hermes)

HERMES (built, committed, INERT in this deploy):
  external Hermes Agent → HTTP+Bearer → mcp/beamMcpServer.ts (127.0.0.1:8848)
        → createBeamTools (same contract)
  Requires: `pnpm run beam:mcp` running + BEAM_AGENT_TOKEN_SECRET + minted token
            + a real ~/.hermes/config.yaml on the operator host.
```
Both runtimes consume the **same** `createBeamTools` contract, so the tool behavior and "never invent a fragrance" guarantees are identical — but only the in-process one is wired to users today.

## Net effect on the handoff
- Every P0/P1 finding in the handoff stands — they're about the **in-process** loop, which is the only thing users hit.
- The brain-level fixes (B1 slots, B2 delegation, B3 mission, B5 persistence, B6 gates) must land in `beamAgentLoop.ts` / `beamSessionStore.ts` / `answerQualityGates.ts`. **They will NOT be inherited by the Hermes path**, because Hermes drives its own loop and only borrows the tools. If Hermes is ever promoted to the live runtime, the orchestration/memory work has to be re-expressed as Hermes agent instructions + MCP-exposed state, or those same symptoms return there.

## To actually connect Hermes (if/when desired)
1. `export BEAM_AGENT_TOKEN_SECRET=$(openssl rand -hex 32)` (same value for minter + server).
2. `pnpm --filter @workspace/api-server run beam:mint-token --user <ID> --tenant <ID>`.
3. `pnpm --filter @workspace/api-server run beam:mcp` (serves `127.0.0.1:8848`); probe `GET /healthz`.
4. Install Hermes; merge `hermes-beam/config.example.yaml` into `~/.hermes/config.yaml` and the token into `~/.hermes/.env`; point it at the MCP URL.
Full walkthrough: `docs/beam-agent/05-hermes-setup-runbook.md`.

## Answers to the handoff's open questions touched here
- **§9 Q1 (Redis vs in-memory sessions):** unchanged and still open — that's about the in-process store, independent of Hermes.
- **New:** the handoff's §1/B2 "`mcp/delegationToken.ts` = unrelated auth" line should be revised to: *"part of the inactive Hermes MCP runtime — Beam-related, but not on the live in-process path."*

*Method: targeted reads + grep across the live loop, the `mcp/` server, `hermes-beam/`, package manifests, and deploy config (`railway.json`, `Dockerfile`). Re-verified against source on 2026-06-16. No files modified.*

---

## Update — 2026-06-17: Hermes surface brought to parity + verified running

This pass acted on the decision to make Hermes a first-class, ready runtime (not a
flip-the-prod-switch, which the §"Net effect" warning still rightly cautions against —
the in-process loop remains the default the SPA users hit, with all the brain fixes).

**What changed (code):**
- **Tool-surface parity.** The MCP service deps now wire `resolveCatalogEntry` +
  `loadWardrobePackets` (`mcp/beamServiceDeps.ts`), so the MCP surface builds the SAME
  proposal + new UI-card tools as the in-process agent instead of a read-only subset.
- **New scope `beam:present:read`** (`mcp/delegationToken.ts`, `mcp/mcpContext.ts`)
  unlocks `beam_propose_collection`, `beam_show_scent_profile`, `beam_compare_fragrances`,
  `beam_present_travel_kit`. Owner tokens carry it (it's in `ALL_READ_SCOPES`). These
  tools still **write nothing** — the vault save is always the user's in-app Confirm.
- **Brain mirrored into the Hermes agent context** (`hermes-beam/AGENTS.md`): memory /
  "never re-ask a known value", mission structure (owned + new counts), delegation
  handling, and "show, don't just tell" card guidance — so a Hermes-driven loop does
  not regress the in-process B1/B2/B3 behaviour.

**Verified locally (2026-06-17):** built `dist-beam/beam-mcp.mjs`, booted it
(`127.0.0.1`), `GET /healthz` → `{ ok: true }`, minted an owner token, connected with
the MCP SDK client over Streamable HTTP, and `tools/list` returned all **11** tools
including the three card tools (`beam_show_scent_profile`, `beam_compare_fragrances`,
`beam_present_travel_kit`). `tools/call` against the DB-backed tools needs the real
`DATABASE_URL` env (same as the API) and was not exercised here.

**Still a deploy-host step (cannot be done from the dev box):** for Hermes to serve
real users, the deploy must run the long-lived `beam:mcp` process, set
`BEAM_AGENT_TOKEN_SECRET`, and either run Hermes alongside it or have the API mint
per-run tokens. Railway's current `startCommand` runs only the Express API. Until that
is provisioned, the in-process loop stays the live runtime and Hermes is a verified,
parity runtime ready to be promoted.

---

## Update — 2026-06-17 (later): tools/call DB path exercised + delegation backstop

Two follow-ups closing open items from the parity pass above.

- **`tools/call` against the DB-backed surface is now exercised (the gap noted above).**
  Booted the built `dist-beam/beam-mcp.mjs` with the real `.env` (so `DATABASE_URL`
  is live), minted an owner token, connected with the MCP SDK Streamable-HTTP client,
  and confirmed: `GET /healthz` → `{ ok: true }`; unauthenticated `POST /mcp` → `401`;
  authenticated `tools/list` → all **11** tools (incl. the 3 card tools); and a real
  `tools/call` of `beam_search_catalog {query:"Creed Aventus"}` returned a grounded
  catalog hit with `isError:false`. The full token → scope → tool → Postgres path is
  verified, not just `tools/list`.

- **New deterministic delegation backstop in the in-process brain
  (`answerQualityGates.ts`).** Handoff acceptance criterion B2 ("'idk you tell me' →
  next turn commits, no new preference question") previously rested on a prompt rule
  only; the gates caught re-asking a *known slot* (`redundant_clarification`) but not a
  *new* preference question after delegation. Added a `delegated_but_questioned` gate:
  when the user delegated and the answer poses a clarifying question yet names no
  grounded pick, it fails and the existing single repair pass re-synthesizes a committed
  recommendation. Naming a real grounded fragrance (even with a trailing rhetorical
  question) still passes. Covered by 4 new unit tests; full suite 432/432 green. This
  hardens the **in-process** loop only — if Hermes is promoted, the same rule lives in
  `hermes-beam/AGENTS.md` for the Hermes-driven loop.
