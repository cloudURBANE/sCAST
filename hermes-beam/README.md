# hermes-beam — Beam Agent profile for Hermes

This folder is the **Hermes Agent profile** for ScentBeam's Beam Agent: the agent
instructions, identity, domain context, and skills Hermes loads when Claude reasons
over the Beam tools. The tools themselves live in the API server
(`artifacts/api-server/src/beam-agent/mcp/`) and are reached over MCP.

```
hermes-beam/
  AGENTS.md                      # operating instructions (authority + procedure)
  SOUL.md                        # voice / identity only — no auth rules here
  beam-context/
    PRODUCT.md                   # what ScentBeam is
    TOOL_RULES.md                # the tools and how/when to use them
    FRAGRANCE_ONTOLOGY.md        # notes/accords/families vocabulary
    SAFETY.md                    # untrusted-text + no-write + privacy rules
  skills/
    build-fragrance-collection/SKILL.md
    recommend-one-fragrance/SKILL.md
    compare-fragrances/SKILL.md
  config.example.yaml            # excerpt to merge into ~/.hermes/config.yaml
  dot-hermes-env.example         # excerpt to merge into ~/.hermes/.env
```

## How Hermes uses this

1. **Project guidance** — run Hermes with this folder as the working directory (or
   copy `AGENTS.md`, `SOUL.md`, and `beam-context/` into your Hermes profile/working
   dir) so it loads as agent instructions.
2. **Skills** — copy each `skills/<name>/` into `~/.hermes/skills/` (Hermes' skills
   directory). Each becomes an on-demand `/<name>` workflow and is auto-selected when
   a request matches.
3. **Tools** — `config.example.yaml` registers the Beam MCP server and pins Claude as
   the provider. Hermes exposes the tools as `mcp_beam_<tool>` and chooses them during
   reasoning.

Full step-by-step (install Hermes on Windows, auth Claude, start the MCP server, wire
this profile, verify) is in
[`docs/beam-agent/05-hermes-setup-runbook.md`](../docs/beam-agent/05-hermes-setup-runbook.md).

## Division of responsibility (don't blur these)

- **Authority lives in the tools/server**, not in these files. AGENTS.md tells the
  model *how to behave*; the MCP server *enforces* tenant scope, limits, and (later)
  write confirmation. A clever prompt cannot widen access.
- **SOUL.md is voice only.** Never put authorization rules in the personality file.
