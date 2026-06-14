/**
 * Unit tests for the research orchestrator, using fake IO (no DB, no network).
 * Run with:
 *   node --experimental-strip-types --test src/beam-agent/research/beamResearch.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createBeamResearcher,
  type CachedResearch,
  type ResearchIO,
  type ResearchProviderParams,
  type ResearchProviderResult,
  type SaveResearchRecord,
} from "./beamResearch.ts";

type Spies = {
  loads: number;
  saves: SaveResearchRecord[];
  runs: ResearchProviderParams[];
};

function makeIO(
  over: Partial<ResearchIO> = {},
  spies: Spies = { loads: 0, saves: [], runs: [] },
): { io: ResearchIO; spies: Spies } {
  const provider = (params: ResearchProviderParams): ResearchProviderResult => ({
    synthesizedFact: `fact about ${params.query}`,
    sources: [
      { url: "https://fragrantica.com/x", title: "x", excerpt: "e", sourceType: "database", retrievedAt: "t" },
    ],
    confidence: 0.7,
    costUsd: 0.01,
    model: params.model,
    engine: params.engine,
  });

  const io: ResearchIO = {
    loadCache: async () => {
      spies.loads += 1;
      return null;
    },
    saveCache: async (record) => {
      spies.saves.push(record);
    },
    runWebResearch: async (params) => {
      spies.runs.push(params);
      return provider(params);
    },
    modelFor: (mode) => `model-${mode}`,
    degradedModel: () => "model-degraded",
    engine: () => "exa",
    includeDomains: () => ["fragrantica.com"],
    isEnabled: () => true,
    now: () => 1_000_000,
    ...over,
  };
  return { io, spies };
}

test("returns a note and never calls the provider when disabled", async () => {
  const { io, spies } = makeIO({ isEnabled: () => false });
  const research = createBeamResearcher(io);
  const result = await research("price of aventus");
  assert.equal(result.synthesizedFact, "");
  assert.ok(result.note);
  assert.equal(spies.runs.length, 0);
});

test("empty query short-circuits with a note", async () => {
  const { io, spies } = makeIO();
  const research = createBeamResearcher(io);
  const result = await research("   ");
  assert.ok(result.note);
  assert.equal(spies.loads, 0);
  assert.equal(spies.runs.length, 0);
});

test("a fresh cache hit is returned without a web call", async () => {
  const cached: CachedResearch = {
    synthesizedFact: "cached fact",
    sources: [],
    confidence: 0.8,
    mode: "standard_research",
    entityType: "price",
    model: "m",
    engine: "exa",
    costUsd: 0.02,
  };
  const { io, spies } = makeIO({ loadCache: async () => cached });
  const research = createBeamResearcher(io);
  const result = await research("price of aventus");
  assert.equal(result.synthesizedFact, "cached fact");
  assert.equal(result.cached, true);
  assert.equal(spies.runs.length, 0);
  assert.equal(spies.saves.length, 0);
});

test("cache miss runs the web call and writes the result with an entity TTL", async () => {
  const { io, spies } = makeIO();
  const research = createBeamResearcher(io);
  const result = await research("cheapest price for aventus"); // → price entity, standard mode
  assert.equal(result.cached, false);
  assert.match(result.synthesizedFact, /aventus/);
  assert.equal(spies.runs.length, 1);
  assert.equal(spies.saves.length, 1);
  // price TTL is 12h from the injected clock.
  assert.equal(spies.saves[0].expiresAtMs, 1_000_000 + 12 * 60 * 60 * 1000);
  assert.equal(spies.saves[0].entityType, "price");
});

test("depth=premium forces the premium lane (5 results)", async () => {
  const { io, spies } = makeIO();
  const research = createBeamResearcher(io);
  await research("research the niche house nishane", { depth: "premium" });
  assert.equal(spies.runs[0].maxResults, 5);
  assert.equal(spies.runs[0].model, "model-premium_research");
});

test("an explicit tool call never resolves to no-search (cheapest real lane instead)", async () => {
  const { io, spies } = makeIO();
  const research = createBeamResearcher(io);
  // "compare these two" has no freshness/citation signal → would be no_search,
  // but the agent explicitly invoked research, so we run single_source_check.
  await research("tell me about aventus");
  assert.equal(spies.runs.length, 1);
  assert.equal(spies.runs[0].maxResults, 1); // single_source_check
});

test("falls back to the degraded model when the primary call throws", async () => {
  let calls = 0;
  const { io, spies } = makeIO({
    runWebResearch: async (params) => {
      calls += 1;
      if (calls === 1) throw new Error("primary down");
      return {
        synthesizedFact: "degraded fact",
        sources: [],
        confidence: 0.4,
        costUsd: 0.008,
        model: params.model,
        engine: params.engine,
      };
    },
  });
  const research = createBeamResearcher(io);
  const result = await research("price of aventus");
  assert.equal(result.synthesizedFact, "degraded fact");
  assert.equal(result.model, "model-degraded");
  assert.equal(spies.saves.length, 1);
});

test("two failures degrade to a note without throwing or caching", async () => {
  const { io, spies } = makeIO({
    runWebResearch: async () => {
      throw new Error("down");
    },
  });
  const research = createBeamResearcher(io);
  const result = await research("price of aventus");
  assert.equal(result.synthesizedFact, "");
  assert.ok(result.note);
  assert.equal(spies.saves.length, 0);
});
