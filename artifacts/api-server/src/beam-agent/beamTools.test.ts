/**
 * Unit tests for the read-only Beam tool layer, using fake deps (no DB, no
 * network). Run with:
 *   node --experimental-strip-types --test src/beam-agent/beamTools.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createBeamTools, type BeamCatalogHit, type BeamToolDeps } from "./beamTools.ts";
import type { BeamRunContext } from "./types.ts";

const CTX: BeamRunContext = { runId: "run_1", sessionId: "s_1", tenantId: "t_1", userId: "u_1" };

function makeDeps(over: Partial<BeamToolDeps> = {}): BeamToolDeps {
  return {
    loadVault: async () => [
      { id: "v1", name: "Sauvage", brand: "Dior", families: ["fresh"], accords: ["pepper"] },
      { id: "v2", name: "Aventus", brand: "Creed", families: ["fruity"], accords: ["smoky"] },
    ],
    searchCatalog: async (_query, limit): Promise<BeamCatalogHit[]> =>
      [
        { id: "g1", flat: { name: "Aventus", brand: "Creed", accords: ["fruity"] }, score: 0.95 },
        { id: "g2", flat: { name: "Bleu de Chanel", brand: "Chanel", accords: ["woody"] }, score: 0.9 },
      ].slice(0, limit),
    research: async (name) => ({ name, notes: { top: ["bergamot"] } }),
    scoreVault: (items) =>
      items.length > 0
        ? {
            fragranceId: items[0].id,
            name: items[0].name,
            brand: items[0].brand,
            engine: {} as never,
            reason: "best for today",
            score: 88,
          }
        : null,
    getWeather: async () => ({ temperature_f: 90, condition: "Clear", location: "Forney, TX" }),
    ...over,
  };
}

function toolMap(deps: BeamToolDeps) {
  return new Map(createBeamTools(deps).map((tool) => [tool.name, tool] as const));
}

test("exposes exactly the Phase 1 read-only tools", () => {
  const names = createBeamTools(makeDeps()).map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "beam_get_fragrance_details",
    "beam_get_user_context",
    "beam_get_wardrobe",
    "beam_score_candidates",
    "beam_search_catalog",
  ]);
});

test("beam_propose_collection appears only with resolveCatalogEntry and builds a proposal", async () => {
  assert.equal(toolMap(makeDeps()).has("beam_propose_collection"), false);

  const tools = toolMap(
    makeDeps({
      resolveCatalogEntry: async (name, brand) =>
        name.toLowerCase().includes("unknown")
          ? null
          : { name, brand: brand ?? "Creed", notes: ["bergamot"], accords: ["fresh"], imageUrl: "https://img/x.webp" },
    }),
  );
  const propose = tools.get("beam_propose_collection")!;
  const result = (await propose.handler(
    { fragrances: [{ name: "Silver Mountain Water", brand: "Creed" }, { name: "Unknown Juice" }] },
    CTX,
  )) as { proposalId: string; count: number; items: unknown[]; unresolved: string[] };

  assert.equal(result.count, 1);
  assert.equal(result.unresolved.length, 1);
  assert.match(result.proposalId, /^prop_/);

  const event = propose.clientEvent?.(result);
  assert.equal(event?.type, "proposal");
  assert.equal(event && event.type === "proposal" ? event.items.length : -1, 1);
  // A failed/empty proposal yields no card.
  assert.equal(propose.clientEvent?.({ proposalId: "p", items: [] }), null);
});

test("beam_get_wardrobe maps the vault to owned packets", async () => {
  const tools = toolMap(makeDeps());
  const result = (await tools.get("beam_get_wardrobe")!.handler({}, CTX)) as {
    count: number;
    items: Array<{ owned: boolean; canonicalName: string }>;
  };
  assert.equal(result.count, 2);
  assert.equal(result.items[0].owned, true);
  assert.equal(result.items[0].canonicalName, "Sauvage");
});

test("beam_get_user_context summarizes vault + weather", async () => {
  const tools = toolMap(makeDeps());
  const result = (await tools.get("beam_get_user_context")!.handler({}, CTX)) as {
    wardrobeSummary: { count: number; topFamilies: string[] };
    weather: { location: string | null };
  };
  assert.equal(result.wardrobeSummary.count, 2);
  assert.ok(result.wardrobeSummary.topFamilies.includes("fresh"));
  assert.equal(result.weather.location, "Forney, TX");
});

test("beam_search_catalog requires a query and honors excludeOwned", async () => {
  const tools = toolMap(makeDeps());
  const empty = (await tools.get("beam_search_catalog")!.handler({}, CTX)) as { items: unknown[] };
  assert.equal(empty.items.length, 0);

  const all = (await tools.get("beam_search_catalog")!.handler({ query: "creed" }, CTX)) as {
    count: number;
    items: Array<{ canonicalName: string }>;
  };
  assert.equal(all.count, 2);

  // Aventus/Creed is in the fake vault, so excludeOwned should drop it.
  const filtered = (await tools
    .get("beam_search_catalog")!
    .handler({ query: "creed", excludeOwned: true }, CTX)) as {
    items: Array<{ canonicalName: string }>;
  };
  const names = filtered.items.map((item) => item.canonicalName);
  assert.ok(!names.includes("Aventus"));
  assert.ok(names.includes("Bleu de Chanel"));
});

test("beam_search_catalog clamps the model-supplied limit", async () => {
  let askedLimit = -1;
  const tools = toolMap(
    makeDeps({
      searchCatalog: async (_q, limit) => {
        askedLimit = limit;
        return [];
      },
    }),
  );
  await tools.get("beam_search_catalog")!.handler({ query: "x", limit: 9999 }, CTX);
  assert.ok(askedLimit <= 12, `expected server cap, got ${askedLimit}`);
});

test("beam_get_fragrance_details caps names and is best-effort", async () => {
  const many = Array.from({ length: 50 }, (_, i) => `frag ${i}`);
  const tools = toolMap(
    makeDeps({ research: async (name) => (name === "frag 0" ? { name } : null) }),
  );
  const result = (await tools.get("beam_get_fragrance_details")!.handler({ names: many }, CTX)) as {
    count: number;
    items: Array<{ found: boolean }>;
  };
  assert.ok(result.count <= 10, `expected <=10 names, got ${result.count}`);
  assert.equal(result.items[0].found, true);
});

test("beam_score_candidates returns a deterministic pick, null on empty vault", async () => {
  const tools = toolMap(makeDeps());
  const picked = (await tools
    .get("beam_score_candidates")!
    .handler({ destination: "Work", energy: "Focused" }, CTX)) as {
    recommendation: { canonicalName: string; score: number } | null;
  };
  assert.equal(picked.recommendation?.canonicalName, "Sauvage");
  assert.equal(picked.recommendation?.score, 88);

  const emptyTools = toolMap(makeDeps({ loadVault: async () => [] }));
  const none = (await emptyTools
    .get("beam_score_candidates")!
    .handler({}, CTX)) as { recommendation: unknown };
  assert.equal(none.recommendation, null);
});

test("beam_score_candidates returns multiple grounded picks via rankVault + limit", async () => {
  const tools = toolMap(
    makeDeps({
      rankVault: (items) =>
        items.map((item, i) => ({
          fragranceId: item.id,
          name: item.name,
          brand: item.brand,
          engine: {} as never,
          reason: "ranked",
          score: 90 - i,
        })),
    }),
  );
  const result = (await tools
    .get("beam_score_candidates")!
    .handler({ destination: "Night Out", limit: 2 }, CTX)) as {
    recommendation: { canonicalName: string };
    picks: Array<{ canonicalName: string; score: number }>;
  };
  // Two grounded picks, top pick mirrored on `recommendation`.
  assert.equal(result.picks.length, 2);
  assert.deepEqual(result.picks.map((p) => p.canonicalName), ["Sauvage", "Aventus"]);
  assert.equal(result.recommendation.canonicalName, "Sauvage");
});

test("beam_score_candidates scores against a destination weatherOverride and echoes it", async () => {
  let scoredWeather: { temperature_f?: number; condition?: string } | undefined;
  const tools = toolMap(
    makeDeps({
      // local weather is hot Texas; the override should win.
      getWeather: async () => ({ temperature_f: 95, condition: "Clear", location: "Forney, TX" }),
      rankVault: (items, _cal, weather) => {
        scoredWeather = weather;
        return items.map((item) => ({
          fragranceId: item.id,
          name: item.name,
          brand: item.brand,
          engine: {} as never,
          reason: "ranked",
          score: 80,
        }));
      },
    }),
  );
  const result = (await tools.get("beam_score_candidates")!.handler(
    {
      destination: "Going Out",
      locationLabel: "Tokyo, June",
      weatherOverride: { temperature_f: 75, humidity_percent: 85, condition: "Rain" },
    },
    CTX,
  )) as { scoredFor: { locationLabel: string; usedOverride: boolean; weather: { temperature_f: number; condition: string } } };

  // The engine was handed the overridden climate, not the local 95°F clear.
  assert.equal(scoredWeather?.temperature_f, 75);
  assert.equal(scoredWeather?.condition, "Rain");
  // ...and the result echoes the climate it scored for, for grounded prose.
  assert.equal(result.scoredFor.locationLabel, "Tokyo, June");
  assert.equal(result.scoredFor.usedOverride, true);
  assert.equal(result.scoredFor.weather.temperature_f, 75);
});
