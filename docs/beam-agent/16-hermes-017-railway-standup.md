# 16 — Hermes Agent v0.17.0 standup (Railway)

**Status:** ready to provision · **Date:** 2026-06-20 · **Target:** Hermes Agent
**v0.17.0 (v2026.6.19, "The Reach Release")** — confirmed the latest upstream
release at authoring time (NousResearch/hermes-agent).

Supersedes the readiness notes in
[11-hermes-mcp-connection-status.md](./11-hermes-mcp-connection-status.md). Read
[00-architecture-decision.md](./00-architecture-decision.md) first: Hermes is an
**optional swap-in**, not the default. The live runtime users hit is still the
in-process loop (`beamAgentLoop.ts`); promoting Hermes does **not** inherit the
in-process brain fixes — they are mirrored into `hermes-beam/AGENTS.md`.

## What this standup changes (code, committed)

These are additive and leave the live Express API byte-identical:

| Change | File | Effect |
|---|---|---|
| No-rebuild MCP start script | `artifacts/api-server/package.json` (`start:beam-mcp`) | Runs the prebuilt `dist-beam/beam-mcp.mjs` — for the deploy image where the bundle is already baked. |
| Bake the MCP bundle into the image | `Dockerfile` | Adds `beam:mcp:build` after `pnpm run build`. **Default `CMD` is unchanged** (`pnpm start` = API only). |
| Env-driven MCP URL | `hermes-beam/config.example.yaml`, `dot-hermes-env.example` | `${BEAM_MCP_URL}` so one profile works local + Railway. |
| Hermes service image | `hermes-beam/deploy/Dockerfile.hermes-agent` | The external Hermes v0.17.0 runtime + Beam profile. **Not build-verified here** — validate on the deploy host. |
| Version pin | config/env examples | Targets v0.17.0. |

## Topology

```
                Railway project (private network)
  ┌─────────────────────────┐      ┌──────────────────────────────┐
  │ api-server  (existing)   │      │ beam-mcp  (NEW service)      │
  │  CMD: pnpm start         │      │  same image, start:beam-mcp  │
  │  Express API :8080       │      │  MCP listener :8848 /mcp     │
  └─────────────────────────┘      └──────────────┬───────────────┘
                                                   │ http (private)
                                    ┌──────────────┴───────────────┐
                                    │ hermes-agent  (NEW service)  │
                                    │  Dockerfile.hermes-agent     │
                                    │  CMD: hermes gateway         │
                                    └──────────────────────────────┘
```

`beam-mcp` and `api-server` build from the **same repo image**; only the start
command differs. `hermes-agent` builds from `hermes-beam/deploy/Dockerfile.hermes-agent`.

## Verified locally (2026-06-20, dev box)

Re-confirmed the MCP runtime works on the current code before standup:

- `pnpm --filter @workspace/api-server run beam:mcp:build` → `dist-beam/beam-mcp.mjs` (2.7 MB) ✅
- Boot with `BEAM_AGENT_TOKEN_SECRET` set → `GET /healthz` → `{"ok":true,"server":"beam-tools","version":"0.1.0"}` ✅
- Unauthenticated `POST /mcp` → **401** ✅ (auth guard intact)
- Mint owner token (`beam:mint-token`) → authenticated `POST /mcp` `initialize` → **200** ✅

`tools/list`/`tools/call` returning all 11 tools (incl. the 3 card tools) over the
MCP SDK client was verified in prior passes (see doc 11) and is unchanged by this
standup. **Not verified here:** the `hermes-agent` image build/run (external
runtime; needs the deploy host) and the end-to-end Hermes→MCP traffic.

## Provisioning steps (operator — on Railway)

> These are the irreducible deploy-host steps. They were **not** performed from
> the dev box (no production deploy was made by this change).

1. **Shared secret** — set one strong `BEAM_AGENT_TOKEN_SECRET` as a Railway
   shared variable (used by the `beam-mcp` service and the token minter):
   `openssl rand -hex 32`.
2. **`beam-mcp` service** — new service from this repo / same image. Override:
   - Start command: `pnpm --filter @workspace/api-server run start:beam-mcp`
   - Env: `BEAM_AGENT_TOKEN_SECRET` (shared), `BEAM_MCP_HOST=::`, `BEAM_MCP_PORT=8848`,
     and the **same `DATABASE_URL`** as the API (the tools hit the same DB).
   - Confirm: `GET /healthz` on the service → `{ ok: true }`.
3. **Mint a delegation token** for the owner/tenant (same secret):
   `pnpm --filter @workspace/api-server run beam:mint-token --user <ID> --tenant <ID>`.
4. **`hermes-agent` service** — new service built from
   `hermes-beam/deploy/Dockerfile.hermes-agent`. Validate the image first
   (`hermes --version` → `0.17.0`). Env:
   - `BEAM_MCP_URL=http://api-server.railway.internal:8848/mcp` (always `http://`)
   - `BEAM_AGENT_TOKEN=<minted token>`
   - `OPENROUTER_API_KEY=<reasoning credential>`
5. **Smoke test** before traffic: from the hermes-agent shell, a `tools/list`
   must return the 11 Beam tools, then one `tools/call` of `beam_search_catalog`.
6. **Cut over only when ready.** The SPA keeps using the in-process loop until you
   deliberately point it at Hermes — this standup does not change the SPA path.

## Rollback

- **Pre-traffic:** delete the `beam-mcp` and `hermes-agent` Railway services. The
  `api-server` service is untouched, so nothing about the live app changes.
- **Code:** revert the standup branch (`chore/hermes-017-standup`). The
  `Dockerfile` change only adds a build step + comments; the default runtime
  command is unchanged, so reverting cannot affect a deployed API.
- The in-process loop remains the live runtime throughout — there is no flag to
  flip back.
