---
description: Pull Railway prod logs for the Beam service (sCAST), triage every distinct error, then dispatch agents to root-cause, surgically fix, verify, and commit each one (no deploy).
argument-hint: "[optional: focus filter or # of log lines, e.g. 'OOM' or '500 lines']"
---

# /fix-beam — fix prod Beam issues from the Railway logs

Run this **after the owner finishes testing in prod**. It reads the live Railway logs
for the Beam backend, turns the noise into a list of distinct real issues, and then has
**a subagent per issue** investigate → fix → verify → commit. It never deploys.

Optional argument `$ARGUMENTS` narrows the scope (an error substring to focus on, or a
line count). If empty, triage everything in the recent log window.

## Hard guardrails (do not violate)

- **Read-only Railway only.** The *only* Railway commands allowed are `railway status`,
  `railway whoami`, and `railway logs`. **Never** run `railway up`, `railway redeploy`,
  `railway down`, `railway run`, `railway service`, anything with `--allow-dangerous`, or
  anything that mutates the project. This command fixes code; the owner deploys.
- **No branch switching.** `huge_monorepo` may be a *shared* working tree with one HEAD —
  another agent can be on it. Never `git switch`/`checkout`/`reset`/`pull`. Stage **explicit
  file paths only** (never `git add -A`/`.`) and push with
  `git push <remote> HEAD:refs/heads/<your-branch>`.
- **Surgical fixes only.** Follow the repo investigation doctrine: prove ownership before
  editing, don't rewrite unrelated architecture, don't touch unrelated working-tree changes,
  don't change fonts/design tokens/global styling. Below 95% confidence in ownership, keep
  investigating or report the gap instead of patching.
- **Scoped + verified commits.** One logical fix per commit, only its files, typecheck +
  build (and targeted tests) green *before* committing. No scope-crept mega-commits.

## Context (already known)

- Railway is linked to project **courteous-enchantment**, env **production**.
- The Beam agent runs **in-process inside the `sCAST` service** (the Express api-server,
  `api.scentbeam.com`) on an OpenRouter loop — so prod Beam runtime errors are in **sCAST's
  deploy logs**, not a separate service. The Python fragrance engine is the separate
  `lively-adaptation` service; only pull it if a Beam error clearly originates downstream there.
- Beam code lives under `artifacts/api-server/src/beam-agent/` (agent loop, provider adapter,
  MCP tools). The local `hermes-beam/beam-mcp.log` is the *owner cockpit* MCP server, not prod —
  ignore it here.

## Procedure

### 1. Pull the logs (read-only)
Confirm the linked service first, then capture a recent window. `railway logs` streams, so run
it with a bounded tool timeout (~30s) to grab a snapshot instead of hanging:

```
railway status            # confirm linked service is sCAST / env production
railway logs --service sCAST
```

If `$ARGUMENTS` is a line count, size the window to it; if it's a substring, still pull the full
window but center triage on matching lines. If the logs are clean (no errors/warnings/stack
traces), say so and stop — do not invent work.

### 2. Triage into distinct issues
Group raw log lines by **error signature** (same stack top / message / route), not by
occurrence. Collapse duplicates. For each distinct issue record: the signature, a representative
log excerpt (timestamp + message + stack), rough frequency, and a first guess at the owning area
(route/service/tool). Drop pure noise (expected 404s, healthchecks, deprecation warnings with no
impact). Present this list before doing any fixing.

### 3. One agent per distinct issue
For each real issue, dispatch a subagent (the user asked for agents — this is authorized).
Prefer `slop-to-elite-debugger` for a code defect, else `general-purpose`. Give each agent:
- the exact log excerpt + signature and frequency,
- the guardrails above (read-only Railway, no branch switch, explicit-path staging, surgical
  patch, scoped verified commit),
- the instruction to **load the repo investigation skills** (`large-repo-investigation`,
  `repo-map`, `repo-navigation`, plus `fix-playbooks` / `cross-service-contract` /
  `db-schema-safety` / `state-agent-debug` as the symptom warrants) and prove route → component
  → state → data → style ownership before editing,
- the mandate to make the smallest correct patch, **verify** it (smallest command that covers
  the changed package: `pnpm --filter <pkg> run typecheck`, then build, then any targeted test),
  and **commit just that fix** on a branch, returning: root cause, files changed + why, commands
  run + outcomes, the branch/commit, and residual risk.

Run independent issues' agents in parallel where they touch different files; serialize any that
would touch the same file to avoid a shared-tree collision.

### 4. Reconcile & report
After the agents return, summarize as a table: issue → root cause → fix → files → branch/commit →
verification outcome → residual risk. Call out anything left **unfixed** (ownership < 95%, needs
owner decision, or originates in the `lively-adaptation` engine / external infra like Supabase
billing rather than Beam code). End with the explicit reminder that **nothing was deployed** —
the owner must deploy the committed branches to land the fixes in prod.
