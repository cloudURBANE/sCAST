# 02 — Tool contract

The tool surface is the durable asset (see
[00-architecture-decision.md](./00-architecture-decision.md)): it outlives the
choice of runtime. Tools are defined once in `src/beam-agent/beamTools.ts`,
decoupled from services via `BeamToolDeps`, and adapted to whatever model/runtime
is in use (`toClaudeTools` today; an MCP manifest under Hermes later).

## Principles

1. **Small surface.** More tools ≠ a better agent. Start with the few that
   change behavior; add deliberately.
2. **Scope from the session, not the model.** Every handler receives a
   `BeamRunContext` (`runId, sessionId, tenantId, userId`) derived from the
   authenticated request. `tenantId`/`userId` are **never** model arguments, so a
   model can't widen its own access.
3. **The server owns limits.** Result caps, name caps, and turn budgets live in
   `BEAM_LIMITS` and cannot be raised by a model-supplied value.
4. **Reads are free; writes are gated.** Read tools just orchestrate existing
   services. Write tools (later) require an app-issued, single-use confirmation
   token — see [03-migration-plan.md](./03-migration-plan.md#security).
5. **Retrieve before recommending.** The model may only reference fragrance ids
   that appeared in a tool result (a `CandidatePacket`). Scoring math stays in
   code.

## Phase 1 — read-only tools (shipped)

All implemented in `beamTools.ts`, wired to real services in
`beamAgentRoutes.ts`.

| Tool | Input | Returns | Backed by |
|---|---|---|---|
| `beam_get_user_context` | `{}` | vault summary (`count`, `topFamilies`) + today's weather | `loadVault`, `getWeather` |
| `beam_get_wardrobe` | `{}` | `{ count, items: CandidatePacket[] }` (owned) | `loadVault` (`user_fragrances`) |
| `beam_search_catalog` | `{ query, limit?, excludeOwned? }` | `{ count, items: CandidatePacket[] }` (not owned) | `searchCatalogCandidates` over `global_fragrances` |
| `beam_get_fragrance_details` | `{ names: string[] }` | `{ count, items: [{ name, found, facts }] }` | `getScentFacts` (best-effort, `save:false`) |
| `beam_score_candidates` | `{ destination?, energy? }` | `{ recommendation: {…} \| null }` | `selectScentMissionRecommendation` (deterministic) |

`CandidatePacket` (see `types.ts`) is the compact, normalized evidence shape:
`fragranceId, canonicalName, brand, owned, notes{top,middle,base}, accords,
performance, sourceConfidence, missingFields`. Thin/untrusted catalog records are
normalized defensively and flagged via `missingFields` rather than trusted.

### Scoping & limits in effect

- Vault and catalog reads are scoped to `ctx.tenantId + ctx.userId`.
- `beam_search_catalog` caps results at `BEAM_LIMITS.maxCatalogResults` (12) no
  matter what the model asks for; `beam_get_fragrance_details` caps at 10 names.
- The loop runs at most `BEAM_LIMITS.maxAgentTurns` (8) tool rounds per run.

## Later phases — tools to add

These are specified now so the contract is stable; they are **not** implemented
yet.

### Phase 3 — proposal (still no writes)

| Tool | Purpose |
|---|---|
| `beam_create_collection_proposal` | Validate a draft of 4–5 fragrances (ids exist, no dupes, price/coverage), return cards + coverage analysis. Writes nothing. |

### Phase 4 — confirmation-gated writes

| Tool | Purpose | Guard |
|---|---|---|
| `beam_save_collection` | Persist a proposal to the vault | requires `confirmationToken` |
| `beam_add_to_wardrobe` | Add one fragrance | requires `confirmationToken` |

Write tools call the **existing** `/api/wardrobe` service layer — they never
duplicate SQL. The model can never construct a valid token (see security section
of the migration plan).

### Phase 6 — discovery & enrichment

| Tool | Purpose | Note |
|---|---|---|
| `beam_search_external` | External engine fallback when the local catalog is thin | normalize + cache into `global_fragrances` before use |
| `beam_start_enrichment` | Enqueue an `enrichment_jobs` row | needs the worker built first; restrict to internal/justified requests |

## Runtime adapter

- **Today (in-process Claude):** `toClaudeTools(defs)` emits the Anthropic
  `tools` array; the loop in `beamAgentLoop.ts` executes `def.handler(input, ctx)`
  and feeds `tool_result` blocks back.
- **Later (Hermes/MCP):** wrap the same `BeamToolDefinition[]` in an MCP server;
  Hermes discovers and calls them. The handlers, scoping, and limits are
  unchanged — only the transport differs.
