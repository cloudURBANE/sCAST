# 03 — Migration plan

Phased, low-risk path from today's scripted wizard to a real agent. Each phase is
independently shippable, lands in its own folder, and is opt-in until you flip it
on. Phase 1 is **done** (read-only); the rest are specced.

## Guiding rules (apply to every phase)

- **Additive first.** New code goes under `src/beam-agent/` (server) and a new
  `BeamAgentPanel` (client). Existing files are not edited until a phase
  explicitly calls for it.
- **One folder, opt-in mount.** Nothing runs until `mountBeamAgent(app)` is added
  to `app.ts` (one line). The current `/api/scent-mission` route keeps working
  unchanged as the fallback.
- **Reuse, don't duplicate.** Tools call existing service functions
  (`searchCatalogCandidates`, `getScentFacts`, `selectScentMissionRecommendation`,
  the `/api/wardrobe` writer). No re-implemented scoring, no second collection
  schema without checking for one.

## Phase 0 — repository comparison (done as part of this plan)

Verified against the live code: entry points, reusable service signatures,
tenant/user scoping points, and the gaps. Findings are in
[01-current-state.md](./01-current-state.md). No mismatches between this plan and
the code remain open.

## Phase 1 — read-only agent ✅ (shipped, unmounted)

**Goal:** an authenticated user can converse with a tool-using Claude agent that
reads their vault, searches the catalog, researches fragrances, and ranks their
vault — with **zero** writes and zero changes to existing files.

Delivered in `artifacts/api-server/src/beam-agent/`:

- agent loop (`beamAgentLoop.ts`), Claude provider via `fetch`
  (`claudeProvider.ts`), five read-only tools (`beamTools.ts`), SSE run endpoints
  (`beamAgentRoutes.ts`), pure helpers + types, and unit tests (16 passing).

**Acceptance criteria** (met or enforced by design):

- the model cannot recommend an unknown fragrance id (only ids from tool results);
- deterministic scoring stays in code (`beam_score_candidates`);
- tenant/user scope derives from the session, never from model args;
- server-enforced result/turn limits;
- no shell, file, browser, or write tool exists;
- graceful failure when no model provider is configured.

**To turn on:** the one-line mount is already in `app.ts`. Set `OPENROUTER_API_KEY`
(production default — the in-process loop calls OpenRouter; `ANTHROPIC_API_KEY`
still works as an auto-fallback), after running
`pnpm --filter @workspace/api-server run typecheck`. Provider selection lives in
`src/beam-agent/provider.ts`.

## Phase 2 — client surface

Replace the one-shot client with a run-driven one, **alongside** the existing
panel (feature-flagged), not by rewriting `ScentMissionPanel.tsx` in place yet.

- new `artifacts/scent-cast/src/lib/beamAgentClient.ts`: create run → subscribe
  to SSE → stop;
- new `BeamAgentPanel.tsx`: message timeline + observable progress
  (`status`/`tool_*`/`completed` events) instead of fake nodes;
- the existing calibration chips may feed `uiContext`; any facet not sent as
  structured context should be hidden until a phase consumes it.

## Phase 3 — collection proposals (still no writes)

Add `beam_create_collection_proposal` (see
[02-tool-contract.md](./02-tool-contract.md)). The server validates ids exist, no
duplicates, price/coverage, max size; returns existing fragrance-card payloads +
coverage/redundancy analysis. The strong model tier synthesizes the 4–5 bottle
set; cheap tier handles routing/chat. Render with the **existing** card/modal
components. Closes the "collection creation gap" — read-only.

## Phase 4 — confirmation-gated writes {#security}

The only phase that writes. Required sequence:

1. model proposes an action → loop emits an `approval_required` event;
2. the React panel shows an explicit confirmation card
   ("Save this 5-fragrance collection to your account? [Cancel] [Save]");
3. on confirm, the Node API mints a **short-lived, single-use, signed**
   confirmation token: `{ tenantId, userId, action, resourceId/proposalId, exp,
   nonce }`;
4. the write tool (`beam_save_collection` / `beam_add_to_wardrobe`) is retried
   with that token; the server validates + consumes it; the write goes through
   the **existing** `/api/wardrobe` service; the action is audited.

Hard rules: the model can never construct a valid token; tokens are one-time
(replay-rejected); write scopes are off by default. Add an `agent delegation
token` per run carrying only the read scopes it needs.

## Phase 5 — sessions & memory (Postgres)

Move run/session state out of process memory into tenant-scoped tables (names per
`new.md` §9):

- `beam_agent_sessions`, `beam_agent_runs`, `beam_agent_tool_audits`,
  `beam_agent_memories`, `beam_collection_proposals`, `beam_agent_feedback`.

Memory is **curated**, not a transcript dump: structured records with confidence
+ provenance + `userConfirmed`, inspectable and deletable by the user. Do **not**
enable autonomous skill rewriting. This is also the natural point to introduce
**Hermes** if you want its session/skill/approval machinery — expose the existing
tools over MCP and migrate the runtime; the UI and tool contracts don't change.

## Phase 6 — discovery & enrichment

- `beam_search_external` as a **fallback** only when the local catalog is thin;
  normalize + cache results into `global_fragrances` before the model uses them;
- build the missing `enrichment_jobs` worker, then expose `beam_start_enrichment`
  (internal/justified requests only);
- freshness rules, provenance, and per-run cost budgets.

## Phase 7 — controlled rollout

Owner-only → internal testers → small % → plan-based limits, with automatic
fallback to the current deterministic `/api/scent-mission` path. Measure tool
failure rate, cost/run, latency, and save-conversion.

## No-touch list

Do **not**, while building Beam:

- rename broad directories or move existing files;
- edit `routes/scentMission.ts`, `services/scentMissionService.ts`, or
  `lib/scent-weather-engine` beyond *additive* exports (keep the deterministic
  scoring as the single source of truth);
- replace the auth/tenant system;
- let the agent touch Postgres directly (always go through tool/service layers);
- duplicate the weather-scoring logic or add a second collection schema without
  checking for an existing one;
- expose a personal Claude credential to browser code;
- enable shell/file/unrestricted-browser tools in the consumer Beam profile;
- make Claude Code CLI available to end users.

## Testing & evals

**Unit** (Node's built-in runner, matching repo convention): tool input
validation, output-schema shape, scope derivation, event redaction, unknown-tool
handling, limit clamping, packet normalization, confirmation-token signing/
consumption + replay rejection (Phase 4). *Phase 1 ships 16 such tests
(`beamToolCore.test.ts`, `beamTools.test.ts`).*

**Integration** (Phase 2+): run → tool call → SSE ordering; interrupted run;
provider 429 + fallback; tool timeout; expired session; cross-tenant attack;
malicious retrieved text; duplicate save (Phase 4).

**Agent evals** (deterministic cases): one-bottle pick from owned vault;
five-bottle collection under budget; reject duplicate profiles; never invent a
fragrance; respect a disliked note; ask only necessary clarification; no write
without approval; explain unavailable data; recover from one failed tool; stay
within the turn budget. Score on constraint satisfaction, factual grounding, tool
efficiency, write safety, latency, cost.
