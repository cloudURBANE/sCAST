# 05 — Hermes setup runbook (Windows host)

How to run the Beam Agent on the **Hermes runtime**: Hermes drives the agent loop,
Claude is the reasoning model, and the Beam tools are reached over MCP from the API
server. This is the runtime swap the [architecture decision](./00-architecture-decision.md)
kept the door open for — the React UI and the tool contracts don't change.

Everything in steps 1–3 and 5–7 runs **on your machine / host** (interactive). The
in-repo pieces (MCP server, profile, config templates) are already built:
`artifacts/api-server/src/beam-agent/mcp/` and `hermes-beam/`.

> **Read first — two caveats you accepted by choosing the Hermes path**
>
> 1. **Claude credentials.** Hermes' Anthropic **OAuth** path requires a Claude
>    **Max plan + extra usage credits** and is for **individual/owner** use — it is
>    *not* a basis for serving multiple customers, and the new Agent-SDK monthly
>    credit (Pro $20 / Max $100–200, from **2026‑06‑15**) is sized for individual
>    automation, not production. For a real multi-user ScentBeam, use a **Claude
>    Platform API key** (pay‑per‑token). See [`providers`](https://hermes-agent.nousresearch.com/docs/integrations/providers).
> 2. **Separate service.** Hermes is a separate (Python) process with its own
>    lifecycle. The Node API stays the public gateway; the Beam MCP server is a small
>    private Node service Hermes connects to. Plan for running and supervising both.

---

## 0. Prerequisites

- The monorepo checked out, `pnpm install` run, Node ≥ 20.
- The **same environment the API uses** available to the MCP server: `DATABASE_URL`
  and any other vars the vault/catalog/scent-facts services need. The MCP server
  reuses those services, so it needs that env.
- Your **owner `userId` and `tenantId`** (from the `users` / `tenants` tables, or an
  authenticated app session). Needed to mint the owner token.

---

## 1. Install Hermes Agent (Windows)

Recommended — the Desktop installer (CLI + desktop app):
download from <https://hermes-agent.nousresearch.com/desktop> and run it.

CLI-only (native Windows PowerShell):

```powershell
iex (irm https://hermes-agent.nousresearch.com/install.ps1)
```

(WSL2 users can instead use the Linux installer `curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash`.)

Verify:

```powershell
hermes doctor
```

Hermes stores **secrets** in `~/.hermes/.env` and **config** in `~/.hermes/config.yaml`
(`~` = `%USERPROFILE%` on Windows; install dir is `%LOCALAPPDATA%\hermes\hermes-agent`).

---

## 2. Pin Claude as the reasoning model

```powershell
hermes model
```

Choose **Anthropic**, then:

- **Owner-only / dev:** Anthropic **OAuth** (requires Claude Max + extra usage
  credits). Hermes stores the OAuth credential itself.
- **Production / multi-user (recommended):** choose **API key** and set it in
  `~/.hermes/.env`:

  ```
  ANTHROPIC_API_KEY=sk-ant-...
  ```

Confirm a plain chat works before wiring Beam (Hermes needs ≥64K context — Claude
models qualify):

```powershell
hermes
# ask: "Say hello in one sentence."
```

---

## 3. Start the Beam MCP server (private)

From the repo. Use a strong secret and the **same** app env as the API:

```powershell
# PowerShell — set for this shell/session (or put in the API's env file):
$env:BEAM_AGENT_TOKEN_SECRET = -join ((48..57)+(97..102) | Get-Random -Count 64 | % {[char]$_})
# ...plus DATABASE_URL etc. that the services need.

pnpm --filter @workspace/api-server run beam:mcp
```

This bundles to `dist-beam/beam-mcp.mjs` and serves `http://127.0.0.1:8848/mcp`
(localhost only). Probe it:

```powershell
curl http://127.0.0.1:8848/healthz   # -> {"ok":true,"server":"beam-tools",...}
```

Keep it running (use a service manager / `pm2` / a Windows service for always-on).

---

## 4. Mint an owner delegation token

In another shell, with the **same** `BEAM_AGENT_TOKEN_SECRET`:

```powershell
pnpm --filter @workspace/api-server run beam:mint-token --user <USER_ID> --tenant <TENANT_ID>
```

The token prints on the last line. It is read-only (the five `beam_*` read scopes)
and long-lived (default 30 days; `--ttl-days N` to change).

---

## 5. Wire the Beam profile into Hermes

Merge the templates from `hermes-beam/` into your Hermes config:

**`~/.hermes/.env`** — add (see `hermes-beam/dot-hermes-env.example`):

```
BEAM_AGENT_TOKEN=<the token from step 4>
```

**`~/.hermes/config.yaml`** — merge (see `hermes-beam/config.example.yaml`):

```yaml
model: "anthropic/claude-opus-4-8"   # confirm the exact alias via `hermes model`

mcp_servers:
  beam:
    url: "http://127.0.0.1:8848/mcp"
    headers:
      Authorization: "Bearer ${BEAM_AGENT_TOKEN}"
    tools:
      include: [beam_get_user_context, beam_get_wardrobe, beam_search_catalog, beam_get_fragrance_details, beam_score_candidates]
      prompts: false
      resources: false
    timeout: 60
```

**Agent instructions + skills:**

- Run Hermes with `hermes-beam/` as the working directory (or copy `AGENTS.md`,
  `SOUL.md`, and `beam-context/` into your Hermes working dir/profile) so they load
  as guidance.
- Copy each `hermes-beam/skills/<name>/` into `~/.hermes/skills/`. Confirm with
  `hermes skills` — each becomes a `/<name>` command and is auto-selected on matching
  requests.

---

## 6. Restrict Hermes' built-in power (consumer profile) — plan §15

Hermes ships terminal/browser/file tools. For the Beam profile, expose **only** the
Beam MCP tools:

```powershell
hermes tools
```

Disable shell/terminal, browser, file-write, cron, and messaging for this profile.
The Beam MCP server is already locked to read-only tools, but the host agent should
not carry unrelated power in a consumer-facing setup. (Sandboxing for any future
terminal/browser need is plan §15.3.)

---

## 7. Reload and verify end-to-end

If Hermes was running when you edited config:

```text
/reload-mcp
```

Then:

```powershell
hermes
```

Try, in order:

1. `What tools do you have?` → should list `mcp_beam_*` (Hermes prefixes MCP tools as
   `mcp_<server>_<tool>`).
2. `What's in my vault and what should I wear for a hot, humid day?` → Hermes should
   call `beam_get_user_context` → `beam_get_wardrobe` → `beam_score_candidates` and
   answer with a grounded pick.
3. `Build me a 5-bottle summer collection under $600 for work, dates, and one
   statement scent.` → triggers the `build-fragrance-collection` skill (read-only
   recommendation; no save).

Success = Hermes calls the Beam tools, never invents a fragrance, and the picks trace
to tool results.

---

## 8. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Tools don't appear | MCP server down / wrong URL / token | `curl /healthz`; check `config.yaml` `url`; confirm `BEAM_AGENT_TOKEN` in `~/.hermes/.env`; `/reload-mcp` |
| `401 Invalid token` from the server | secret mismatch or expired token | Re-mint with the **same** `BEAM_AGENT_TOKEN_SECRET`; check TTL |
| `503 missing BEAM_AGENT_TOKEN_SECRET` | server started without the secret | Set it in the server's env and restart |
| Empty/garbled replies | provider/model not set | `hermes model` again; confirm a plain chat works |
| Server errors on tool calls | missing `DATABASE_URL`/app env | Start the MCP server with the same env as the API |
| OAuth burns credits fast | Anthropic OAuth metered path | Expected for OAuth; use an API key for anything beyond owner testing |

Recovery order: `hermes doctor` → `hermes model` → re-check `config.yaml`/`.env` →
`/reload-mcp`.

---

## 9. Credential boundary (do not cross)

The Claude credential and `BEAM_AGENT_TOKEN_SECRET` stay on the host running
Hermes / the MCP server. They must never be sent to the browser, returned in events,
passed to Beam tools, committed to Git, or placed in agent prompts.

---

## 10. What this does **not** yet do

This runbook stands up the **read-only** Beam Agent on Hermes. Still ahead (see
[03-migration-plan.md](./03-migration-plan.md)):

- **Writes** (save collection / add to vault) behind app-issued, single-use
  confirmation tokens — and the matching write scopes (Phase 4).
- **True multi-user**: the Node API minting a short-lived per-run delegation token and
  proxying React ⇄ Hermes (Phase 5 / §12), instead of one owner token.
- **Discovery/enrichment**: external search fallback + the enrichment worker (Phase 6).
- A **server-side weather** lookup for the MCP path (`getWeather` currently returns the
  engine's seasonal default).
