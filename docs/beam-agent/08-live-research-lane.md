# 08 — Beam live research lane

**Status:** built on branch `feat/beam-research-lane` (stacked on
`feat/beam-agent-openrouter` / PR1, which is not yet on `main`). Additive and
**OFF by default** — the agent surface is unchanged until the lane is enabled
server-side. Every path below is grounded in the shipped code.

> **One line:** cached fragrance intelligence by default; a cheap, freshness-gated
> OpenRouter web search only when the answer depends on *current external facts*;
> premium research only for deep/high-stakes workflows. The point is to give Beam
> current information without letting OpenRouter spend eat the subscription margin.

---

## 1. Why a separate lane (not "just turn on web search")

The Beam agent already answers from cached `global_fragrances` + the user's
wardrobe + the deterministic weather engine. Most prompts ("what should I wear
today?", "rank my owned bottles", "build a date-night rotation") need **none** of
the live web — answering them with a paid search call would burn money for no
gain. So live research is a *controlled evidence tool*, gated three ways:

1. **The model decides** to call `beam_research_web` (the system prompt tells it
   when — see §4).
2. **A deterministic policy** picks the cheapest lane that fits and bounds the
   spend ([researchPolicy.ts](../../artifacts/api-server/src/beam-agent/research/researchPolicy.ts)).
3. **A cache** means one live search per normalized query is reused for everyone
   until it expires ([beam_research_cache](../../lib/db/src/schema/researchCache.ts)).

---

## 2. Architecture (where it lives)

All under `artifacts/api-server/src/beam-agent/research/`, decoupled exactly like
the existing tool layer (pure logic + injected IO):

| File | Role | Network/DB |
|---|---|---|
| [researchPolicy.ts](../../artifacts/api-server/src/beam-agent/research/researchPolicy.ts) | **Pure.** Query normalization, entity classification, deterministic signal inference, the mode ladder, per-entity TTLs, the banned-default guard, per-mode cost caps, cost estimate. | none |
| [researchConfig.ts](../../artifacts/api-server/src/beam-agent/research/researchConfig.ts) | Env-driven model slugs / engine / domain allowlist / enable flag (read at call time). | env |
| [researchProvider.ts](../../artifacts/api-server/src/beam-agent/research/researchProvider.ts) | The **only** network module — OpenRouter Chat Completions with the `web` plugin; parses `url_citation` annotations + real `usage.cost`. | OpenRouter |
| [researchCache.ts](../../artifacts/api-server/src/beam-agent/research/researchCache.ts) | Read fresh rows / upsert by `(normalized_query, entity_type)`. | Postgres |
| [beamResearch.ts](../../artifacts/api-server/src/beam-agent/research/beamResearch.ts) | **DI orchestrator**: cache → mode → web → cache. Never throws. | (injected) |

Data flow for one `beam_research_web(query)` call:

```
agent tool call
   │
   ▼
normalizeQuery → classifyEntity ──▶ cache lookup (fresh?) ──hit──▶ return {…, cached:true}
   │                                       │miss
   │                                       ▼
   │                          selectResearchMode (or `depth` hint)
   │                          (explicit tool call ⇒ never "no search")
   │                                       ▼
   │                          runWebResearch(model, engine, max_results,
   │                                         include_domains, max_tokens)
   │                                  │ok            │throw
   │                                  │              ▼ degraded retry (1 result)
   │                                  ▼                     │still fails
   │                          saveCache(TTL by entity)      ▼
   │                                  ▼               return {note} → agent
   ▼                          return {fact, sources, cost}
```

Both runtimes get the tool from the **same** orchestrator:
- in-process loop → [beamAgentRoutes.ts](../../artifacts/api-server/src/beam-agent/beamAgentRoutes.ts) `buildDeps`
- Hermes / MCP → [mcp/beamServiceDeps.ts](../../artifacts/api-server/src/beam-agent/mcp/beamServiceDeps.ts) `createBeamServiceDeps`

The tool is registered **only when** the `researchWeb` dep is present, so absent
the lane the surface is the original 5 read-only tools (and `beamTools.test.ts`
still asserts exactly those five).

---

## 3. The decision policy & cost caps

`selectResearchMode(signals)` mirrors the spec ladder. Because the agent has
*already* gated by choosing to call the tool, the orchestrator upgrades a
`no_search_use_cache` decision to `single_source_check` (cheapest real lane).

| Mode | max_results | max_output_tokens | target | hard cap | default model (env-overridable) |
|---|---|---|---|---|---|
| `single_source_check` | 1 | 450 | ~$0.010 | $0.025 | `google/gemma-4-31b-it:free` |
| `standard_research` | 2 | 700 | ~$0.025 | $0.060 | `google/gemma-4-31b-it:free` |
| `premium_research` | 5 | 1200 | ~$0.090 | $0.150 | `tencent/hy3-preview` |
| _degraded fallback_ | 1 | 450 | ~$0.010 | $0.025 | `google/gemma-4-31b-it:free` |

**Structural enforcement, not a post-hoc kill switch:** the real cost lever is
`max_results` (Exa/Parallel bill ~$0.005 ≤10 results) + `max_output_tokens` +
the domain allowlist. The dollar figures are telemetry targets. Actual cost is
read from OpenRouter's `usage.cost` when present, else estimated.

**Banned defaults** (`isBannedResearchModel`): any `*:online` variant,
`openrouter/auto`, `openrouter/fusion` — too cost-opaque. An env slug that
matches these is ignored in favor of the safe default.

---

## 4. What the agent is told (system prompt)

Added to [beamAgentLoop.ts](../../artifacts/api-server/src/beam-agent/beamAgentLoop.ts):
answer from catalog/wardrobe by default; reach for `beam_research_web` **only**
for live price/availability, discontinued/reformulated/newly-released status,
unknown metadata (perfumer, year, concentration), sample/decant sellers, or when
the user explicitly wants cited sources. On a `note` (lane off/failed), answer
from cached knowledge and say it isn't freshly verified.

---

## 5. The cache — `beam_research_cache`

[Schema](../../lib/db/src/schema/researchCache.ts). **Global on purpose** (no
tenant/user columns): rows are public web facts, so one user's research improves
everyone's answers. Unique on `(normalized_query, entity_type)`; reads filter on
`expires_at > now()`. TTLs by entity (`ttlMsForEntityType`):

| Entity | TTL |
|---|---|
| price | 12h |
| seller | 24h |
| availability | 48h |
| brand | 30d |
| fragrance / note_claim | 60d |
| general | 24h |

---

## 6. Configuration (all env; lane is OFF by default)

The lane runs on the **server** the agent/MCP exposes, so these live in the
api-server (or Beam MCP server) env — never in browser or Hermes-client config.
The agent never sees the keys.

```
BEAM_RESEARCH_ENABLED=true          # required to turn the lane on
OPENROUTER_API_KEY=sk-or-...        # required (also gates the lane)

# optional overrides (defaults shown in dot-hermes-env.example):
BEAM_RESEARCH_MODEL_SINGLE / _STANDARD / _PREMIUM / _DEGRADED
BEAM_RESEARCH_ENGINE=exa            # exa | parallel | native
BEAM_RESEARCH_INCLUDE_DOMAINS=fragrantica.com,parfumo.com,basenotes.com,luckyscent.com
```

> **Verify the model slugs before enabling.** The defaults are the free/cheap
> stack — `google/gemma-4-31b-it:free` for the single/standard/degraded lanes and
> `tencent/hy3-preview` for premium research. Provider slugs drift, so re-confirm in
> the OpenRouter dashboard and pin via env if a default ever starts 404ing at runtime.

---

## 7. Ops — enabling the lane

1. **Push the schema (manual — deploy does not run drizzle push):**
   ```bash
   corepack pnpm --filter @workspace/db run push   # needs DATABASE_URL
   ```
   Until this runs, `beam_research_cache` reads/writes 500. (See the
   `db-schema-safety` skill; the lane tolerates cache errors — they degrade to a
   live call, not a failure — but the table must exist for caching to work.)
2. Set `OPENROUTER_API_KEY` + `BEAM_RESEARCH_ENABLED=true` in the server env;
   verify/pin the model slugs.
3. **Smoke test:** ask Beam a freshness question ("is Creed Aventus discontinued?"
   / "current price of …"). Confirm the network shows one OpenRouter call with a
   `plugins:[{id:"web", …}]` body, a `beam_research_cache` row appears, and a
   second identical ask is served from cache (no new OpenRouter call).
4. To disable, unset `BEAM_RESEARCH_ENABLED` — the tool vanishes from the surface
   and the agent falls back to cached knowledge.

---

## 8. Tests

`research/researchPolicy.test.ts` (pure: normalization, classification, signal
inference, mode ladder, TTLs, banned guard, cost estimate) and
`research/beamResearch.test.ts` (orchestrator with fakes: disabled→note, cache
hit skips the web call, miss runs+caches with the right TTL, `depth=premium`
forces the premium lane, explicit call never "no-search", degraded retry, double
failure→note). Both are in the api-server suite (316/316 green).

---

## 9. Deliberately out of scope (follow-ups)

- **Model-based freshness router.** The spec floats a `qwen/qwen3.7-plus` router
  to decide *whether* to search from free text. We use a deterministic keyword
  pass (cheaper, no extra call) since the model already gates by calling the tool.
  A model router can layer in later behind a flag.
- **Per-tier engine / Collector gating.** Premium currently uses the same engine
  env; the spec's `parallel`-for-premium and `allowed_tiers: [Collector, admin]`
  gating would hook user-tier into mode selection.
- **Cost ledger integration.** Cost is stored per cache row; rolling it into
  `api_usage_ledger` for spend dashboards is a follow-up.
- **Structured pick from research.** The lane returns free-text facts + sources;
  feeding a structured recommendation card is the same Phase-2 question as the
  06 frontend handoff.
