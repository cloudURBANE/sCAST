# Beam MCP server (Hermes runtime path)

Exposes the existing Phase‑1 **read‑only** Beam tools over the **Model Context
Protocol** so [Hermes Agent](https://github.com/NousResearch/hermes-agent) — with
Claude selected as its reasoning model — can call them. This is the "Beam MCP/tool
service" in the plan's target architecture (§5.1, §6) and the migration path the
[architecture decision](../../../../../docs/beam-agent/00-architecture-decision.md)
named: *keep the runtime‑agnostic tool layer; point Hermes at it over MCP.*

It does **not** replace the in‑process loop (`../beamAgentLoop.ts`). Both consume the
same `createBeamTools` contract. Pick a runtime per deployment; the tools, scoping,
and "never invent a fragrance" guarantees are identical.

## What's here

| File | Role | SDK? |
|---|---|---|
| `delegationToken.ts` | HMAC‑signed agent delegation token: mint + verify (plan §14) | no (pure) |
| `mcpContext.ts` | Scope→tool mapping, bearer parsing, run‑context derivation | no (pure) |
| `beamServiceDeps.ts` | Wires the real services into `BeamToolDeps` (reuses, no dup logic) | no |
| `beamMcpServer.ts` | Stateless Streamable‑HTTP MCP adapter over `createBeamTools` | **yes** |
| `mcpMain.ts` | Entrypoint (localhost bind, env‑driven) | via above |
| `mintOwnerToken.ts` | One‑off owner token minter for `~/.hermes/.env` | no (pure) |
| `*.test.ts` | Unit tests for the pure security core (token + scope logic) | no |

## Security model (plan §14)

- Hermes sends `Authorization: Bearer <delegation token>` on every MCP call.
- The server **verifies** the token (HMAC) and derives `tenantId`/`userId`/`scope`
  **from it** — never from tool arguments. The public tool schemas don't even
  accept tenant/user ids.
- A token only sees/calls the tools its scopes unlock (`SCOPE_TOOL_MAP`). Phase‑1
  scopes are all read‑only; **no write tool exists.**
- Stateless transport: each request builds a fresh MCP server bound to its own
  verified context, so requests can't cross‑read scope.

The secret (`BEAM_AGENT_TOKEN_SECRET`) and the model credential stay on the host
running this server/Hermes. They are never sent to the browser or passed to tools.

## Run it (owner/dev)

```bash
# 1) Same env as the API (DATABASE_URL, etc.) + a strong secret:
export BEAM_AGENT_TOKEN_SECRET="$(openssl rand -hex 32)"

# 2) Mint a read-only owner token (find ids in users/tenants tables):
pnpm --filter @workspace/api-server run beam:mint-token --user <USER_ID> --tenant <TENANT_ID>

# 3) Start the MCP server (bundles to dist-beam/ then runs; binds 127.0.0.1:8848):
pnpm --filter @workspace/api-server run beam:mcp

# 4) Probe it:
curl -s http://127.0.0.1:8848/healthz
```

Then point Hermes at it (HTTP MCP server + bearer token) and pin Claude as the
provider — full walkthrough in
[`docs/beam-agent/05-hermes-setup-runbook.md`](../../../../../docs/beam-agent/05-hermes-setup-runbook.md).

## Before relying on it

`@modelcontextprotocol/sdk` (v1.x) was added to `package.json`. Install + typecheck:

```bash
pnpm install
pnpm --filter @workspace/api-server run typecheck
pnpm --filter @workspace/api-server run test   # includes the token + scope unit tests
```

## Env

| Var | Required | Meaning |
|---|---|---|
| `BEAM_AGENT_TOKEN_SECRET` | yes | HMAC secret; must match between minter and server |
| `BEAM_MCP_PORT` | no (8848) | Listen port |
| `BEAM_MCP_HOST` | no (127.0.0.1) | Bind host — keep private; never expose publicly |
| `DATABASE_URL`, … | yes | Same app env the services need (vault, catalog, scent‑facts) |

## Not in scope here (later phases)

Writes/proposals/confirmation tokens (Phase 3–4), per‑run tokens minted by the Node
API for true multi‑user (Phase 5/§12), and a server‑side weather lookup
(`getWeather` currently returns the engine's seasonal default).
