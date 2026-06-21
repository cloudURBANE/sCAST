/**
 * Unit tests for the discovery tools (`beam_find_similar`, `beam_discover_external`)
 * and their pure helper, using fake deps (no DB, no network). Run with:
 *   node --experimental-strip-types --test src/beam-agent/beamDiscoveryTools.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createBeamTools, type BeamCatalogHit, type BeamToolDeps } from "./beamTools.ts";
import { BEAM_LIMITS, packetFromExternalCandidate } from "./beamToolCore.ts";
import type { BeamRunContext, ExternalDiscoveryCandidate } from "./types.ts";

const CTX: BeamRunContext = { runId: "run_1", sessionId: "s_1", tenantId: "t_1", userId: "u_1" };

/** Minimal deps; the vault owns Sauvage (Dior) and Aventus (Creed). */
function makeDeps(over: Partial<BeamToolDeps> = {}): BeamToolDeps {
  return {
    loadVault: async () => [
      { id: "v1", name: "Sauvage", brand: "Dior", families: ["fresh"], accords: ["pepper"] },
      { id: "v2", name: "Aventus", brand: "Creed", families: ["fruity"], accords: ["smoky"] },
    ],
    searchCatalog: async (_q, limit): Promise<BeamCatalogHit[]> => [],
    research: async (name) => ({ name }),
    scoreVault: () => null,
    getWeather: async () => ({ temperature_f: 72, condition: "Clear", location: "Forney, TX" }),
    ...over,
  };
}

function toolMap(deps: BeamToolDeps) {
  return new Map(createBeamTools(deps).map((tool) => [tool.name, tool] as const));
}

/* ---------------------------------------------------------------- */
/* packetFromExternalCandidate (pure)                               */
/* ---------------------------------------------------------------- */

test("packetFromExternalCandidate marks external provenance and reflects detail depth", () => {
  const detailed = packetFromExternalCandidate({
    id: "abc123",
    name: "Asad",
    brand: "Lattafa",
    detailed: true,
    accords: ["sweet", "woody"],
    notes: { top: ["pineapple"], heart: ["blackcurrant"], base: ["ambergris"] },
  });
  assert.equal(detailed.fragranceId, "engine:abc123");
  assert.equal(detailed.owned, false);
  assert.deepEqual(detailed.accords, ["sweet", "woody"]);
  assert.equal(detailed.notes.base[0], "ambergris");
  assert.ok(!detailed.missingFields.includes("accords"));
  assert.ok(detailed.sourceConfidence > 0.4);

  const thin = packetFromExternalCandidate({ id: "x", name: "Mystery", brand: "", detailed: false });
  assert.ok(thin.missingFields.includes("notes"));
  assert.ok(thin.missingFields.includes("accords"));
  assert.ok(thin.sourceConfidence < detailed.sourceConfidence, "search-only picks are lower confidence");
});

/* ---------------------------------------------------------------- */
/* beam_find_similar                                                */
/* ---------------------------------------------------------------- */

const AVENTUS_FLAT = {
  name: "Aventus",
  brand: "Creed",
  family: "Chypre Fruity",
  accords: ["fruity", "smoky"],
  scent_vector: { freshness: 0.7, sweetness: 0.3, woodiness: 0.5, spice: 0.2, warmth: 0.4, musk: 0.3 },
  pyramid: { top: ["bergamot"], heart: ["birch"], base: ["musk", "oakmoss"] },
};

function similarDeps(over: Partial<BeamToolDeps> = {}): BeamToolDeps {
  return makeDeps({
    resolveCatalogEntry: async () => AVENTUS_FLAT,
    searchCatalog: async (_q, limit): Promise<BeamCatalogHit[]> =>
      [
        // The reference itself — must be excluded as its own similar result.
        { id: "g0", flat: AVENTUS_FLAT, score: 1 },
        // A close cousin: overlapping accords + a near vector.
        {
          id: "g1",
          flat: {
            name: "Aventus Cologne",
            brand: "Creed",
            accords: ["fruity", "fresh"],
            scent_vector: { freshness: 0.75, sweetness: 0.3, woodiness: 0.45, spice: 0.2, warmth: 0.4, musk: 0.3 },
          },
          score: 0.9,
        },
        // A far pick: different accords + a distant vector.
        {
          id: "g2",
          flat: {
            name: "Bleu de Chanel",
            brand: "Chanel",
            accords: ["aromatic", "woody"],
            scent_vector: { freshness: 0.2, sweetness: 0.1, woodiness: 0.9, spice: 0.6, warmth: 0.2, musk: 0.1 },
          },
          score: 0.8,
        },
      ].slice(0, limit),
    ...over,
  });
}

test("beam_find_similar ranks by vector+overlap and never returns the reference itself", async () => {
  const tool = toolMap(similarDeps()).get("beam_find_similar");
  assert.ok(tool, "beam_find_similar should be exposed when resolveCatalogEntry is wired");
  const result = (await tool.handler({ query: "Aventus" }, CTX)) as {
    resolved: boolean;
    reference: { name: string };
    items: Array<{ name: string; similarity: number; band: string; basis: string }>;
  };
  assert.equal(result.resolved, true);
  assert.equal(result.reference.name, "Aventus");
  const names = result.items.map((i) => i.name);
  assert.ok(!names.includes("Aventus"), "must exclude the reference (self)");
  assert.equal(result.items[0].name, "Aventus Cologne", "closest pick should rank first");
  assert.ok(result.items[0].similarity >= result.items[1].similarity, "ranked best-first");
  assert.equal(result.items[0].basis, "scent-vector + accords");
});

test("beam_find_similar degrades to overlap when the reference has no scent vector", async () => {
  const noVectorRef = { name: "Aventus", brand: "Creed", accords: ["fruity", "smoky"], family: "Chypre Fruity" };
  const tool = toolMap(similarDeps({ resolveCatalogEntry: async () => noVectorRef })).get("beam_find_similar");
  assert.ok(tool);
  const result = (await tool.handler({ query: "Aventus" }, CTX)) as {
    resolved: boolean;
    items: Array<{ basis: string }>;
    note?: string;
  };
  assert.equal(result.resolved, true);
  assert.ok(result.items.length > 0, "still returns picks via accord/note overlap");
  assert.ok(result.items.every((i) => i.basis === "accords/notes"));
  assert.match(result.note ?? "", /overlap/i);
});

test("beam_find_similar can exclude owned bottles", async () => {
  // Pool is the user's owned Aventus (excluded) only → expect an empty set, no throw.
  const tool = toolMap(
    similarDeps({
      searchCatalog: async (_q, limit): Promise<BeamCatalogHit[]> =>
        [{ id: "v2", flat: { name: "Aventus", brand: "Creed", accords: ["smoky"] }, score: 0.9 }].slice(0, limit),
    }),
  ).get("beam_find_similar");
  assert.ok(tool);
  const result = (await tool.handler({ query: "Aventus", excludeOwned: true }, CTX)) as { items: unknown[] };
  assert.equal(result.items.length, 0);
});

/* ---------------------------------------------------------------- */
/* beam_discover_external                                           */
/* ---------------------------------------------------------------- */

const EXTERNAL_CANDIDATES: ExternalDiscoveryCandidate[] = [
  { id: "e1", name: "Asad", brand: "Lattafa", detailed: true, accords: ["sweet", "woody"] },
  // Already owned (vault has Sauvage/Dior) → must be dropped, never re-curated.
  { id: "e2", name: "Sauvage", brand: "Dior", detailed: false },
  { id: "e3", name: "Cloud", brand: "Ariana Grande", detailed: false },
];

test("beam_discover_external is exposed only when the discoverExternal dep is wired", () => {
  assert.equal(toolMap(makeDeps()).has("beam_discover_external"), false);
  const withDep = toolMap(makeDeps({ discoverExternal: async () => [] }));
  assert.equal(withDep.has("beam_discover_external"), true);
});

test("beam_discover_external caps the per-call detail-fetch and surfaces unowned picks", async () => {
  const calls: Array<{ limit: number; detailLimit: number }> = [];
  const enqueued: Array<{ name: string; brand?: string }> = [];
  const tool = toolMap(
    makeDeps({
      discoverExternal: async (_q, opts) => {
        calls.push(opts);
        return EXTERNAL_CANDIDATES;
      },
      enqueueCuration: (frag) => enqueued.push(frag),
    }),
  ).get("beam_discover_external");
  assert.ok(tool);

  const result = (await tool.handler({ query: "sweet woody clone", deepen: 99 }, CTX)) as {
    count: number;
    items: Array<{ canonicalName: string }>;
    curatedForEnrichment: number;
  };

  // The model asked for 99 deep-fetches; the server clamps to the hard per-call cap.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].detailLimit, BEAM_LIMITS.maxExternalDetailFetch);

  // Owned Sauvage dropped; the two unowned picks surface and are curated.
  const names = result.items.map((i) => i.canonicalName).sort();
  assert.deepEqual(names, ["Asad", "Cloud"]);
  assert.equal(result.curatedForEnrichment, 2);
  assert.deepEqual(enqueued.map((e) => e.name).sort(), ["Asad", "Cloud"]);
});

test("beam_discover_external no-ops gracefully when the engine yields nothing", async () => {
  const tool = toolMap(makeDeps({ discoverExternal: async () => [] })).get("beam_discover_external");
  assert.ok(tool);
  const result = (await tool.handler({ query: "anything" }, CTX)) as { count: number; items: unknown[]; note: string };
  assert.equal(result.count, 0);
  assert.equal(result.items.length, 0);
  assert.match(result.note, /unavailable|No external/i);
});

test("beam_discover_external works (no throw) when enrichment curation is unavailable", async () => {
  // No enqueueCuration dep (worker disabled / lean surface): picks still surface.
  const tool = toolMap(makeDeps({ discoverExternal: async () => EXTERNAL_CANDIDATES })).get("beam_discover_external");
  assert.ok(tool);
  const result = (await tool.handler({ query: "x" }, CTX)) as { count: number; curatedForEnrichment: number };
  assert.equal(result.count, 2);
  assert.equal(result.curatedForEnrichment, 0, "nothing curated when the hook is absent");
});

/* ---------------------------------------------------------------- */
/* beam_discover_external — price/budget gating (audit F)           */
/* ---------------------------------------------------------------- */

const PRICED_CANDIDATES: ExternalDiscoveryCandidate[] = [
  { id: "p1", name: "Cheap One", brand: "BrandA", detailed: true, price: 45 },
  { id: "p2", name: "Pricey One", brand: "BrandB", detailed: true, price: 150 },
  { id: "p3", name: "No Price", brand: "BrandC", detailed: false },
];

test("packetFromExternalCandidate carries a captured price (and omits it when absent)", () => {
  const priced = packetFromExternalCandidate({ id: "p", name: "X", brand: "Y", detailed: true, price: 99 });
  assert.equal(priced.price, 99);
  const unpriced = packetFromExternalCandidate({ id: "p", name: "X", brand: "Y", detailed: true });
  assert.equal("price" in unpriced, false, "no price key when none was captured");
});

test("beam_discover_external annotates priceStatus and downranks over-budget when a ceiling is set", async () => {
  const tool = toolMap(
    makeDeps({ discoverExternal: async () => PRICED_CANDIDATES, budgetCeiling: 100 }),
  ).get("beam_discover_external");
  assert.ok(tool);
  const result = (await tool.handler({ query: "under 100" }, CTX)) as {
    items: Array<{ canonicalName: string; priceStatus: string }>;
    withinBudget: number;
    overBudget: number;
    budgetCeiling: number;
    note: string;
  };
  // within -> unknown -> over (downranked, never dropped).
  assert.deepEqual(result.items.map((i) => i.canonicalName), ["Cheap One", "No Price", "Pricey One"]);
  assert.deepEqual(result.items.map((i) => i.priceStatus), ["within_budget", "unknown", "over_budget"]);
  assert.equal(result.withinBudget, 1);
  assert.equal(result.overBudget, 1);
  assert.equal(result.budgetCeiling, 100);
  assert.match(result.note, /over the ~\$100 budget/);
});

test("beam_discover_external leaves price 'unknown' when no ceiling (degrade, never fake within)", async () => {
  const tool = toolMap(makeDeps({ discoverExternal: async () => PRICED_CANDIDATES })).get("beam_discover_external");
  assert.ok(tool);
  const result = (await tool.handler({ query: "anything" }, CTX)) as {
    items: Array<{ priceStatus: string }>;
    budgetCeiling?: number;
  };
  // No ceiling -> no enforcement, original order, everything 'unknown'.
  assert.ok(result.items.every((i) => i.priceStatus === "unknown"));
  assert.equal("budgetCeiling" in result, false);
});

/* ---------------------------------------------------------------- */
/* beam_find_similar — explicit dislike gate (audit D)              */
/* ---------------------------------------------------------------- */

test("beam_find_similar drops picks that headline an avoided term when avoidTerms is wired", async () => {
  // Bleu de Chanel's accords include 'woody'; an explicit avoid must drop it even
  // though the (fake) pool still returns it.
  const tool = toolMap(similarDeps({ avoidTerms: ["woody"] })).get("beam_find_similar");
  assert.ok(tool);
  const result = (await tool.handler({ query: "Aventus" }, CTX)) as {
    items: Array<{ name: string }>;
  };
  const names = result.items.map((i) => i.name);
  assert.ok(!names.includes("Bleu de Chanel"), "avoided (woody) pick must be dropped");
  assert.ok(names.includes("Aventus Cologne"), "non-avoided similar pick still surfaces");
});
