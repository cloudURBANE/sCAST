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
    "beam_compare_overlap",
    "beam_get_fragrance_details",
    "beam_get_user_context",
    "beam_get_wardrobe",
    "beam_score_candidates",
    "beam_search_catalog",
  ]);
});

test("beam_compare_overlap resolves the query and ranks owned bottles by redundancy", async () => {
  const tools = toolMap(
    makeDeps({
      searchCatalog: async (_q, limit): Promise<BeamCatalogHit[]> =>
        [
          {
            id: "g9",
            flat: {
              name: "Aventus Cologne",
              brand: "Creed",
              pyramid: { top: ["bergamot"], heart: ["birch"], base: ["musk", "oakmoss"] },
              accords: ["fruity", "smoky"],
            },
            score: 0.9,
          },
        ].slice(0, limit),
      loadWardrobePackets: async () => [
        {
          fragranceId: "v1",
          canonicalName: "Sauvage",
          brand: "Dior",
          owned: true,
          notes: { top: ["pepper"], middle: ["lavender"], base: ["ambroxan"] },
          accords: ["fresh"],
          performance: {},
          sourceConfidence: 0.95,
          missingFields: [],
        },
        {
          fragranceId: "v2",
          canonicalName: "Aventus",
          brand: "Creed",
          owned: true,
          notes: { top: ["pineapple"], middle: ["birch"], base: ["musk", "oakmoss"] },
          accords: ["fruity", "smoky"],
          performance: {},
          sourceConfidence: 0.95,
          missingFields: [],
        },
      ],
    }),
  );

  const overlap = tools.get("beam_compare_overlap")!;
  const result = (await overlap.handler({ query: "Aventus Cologne" }, CTX)) as {
    resolved: boolean;
    vaultCount: number;
    closestMatch: { name: string; band: string } | null;
    items: Array<{ name: string; overlap: { combined: number; band: string; sharedBaseNotes: string[] } }>;
  };

  assert.equal(result.resolved, true);
  assert.equal(result.vaultCount, 2);
  assert.equal(result.items[0].name, "Aventus");
  assert.equal(result.closestMatch?.name, "Aventus");
  assert.ok(result.items[0].overlap.combined > result.items[1].overlap.combined);
  assert.deepEqual(result.items[0].overlap.sharedBaseNotes.sort(), ["musk", "oakmoss"]);
});

test("beam_compare_overlap reports when the query is not a real catalog fragrance", async () => {
  const tools = toolMap(makeDeps({ searchCatalog: async () => [] }));
  const result = (await tools.get("beam_compare_overlap")!.handler({ query: "Made Up Juice" }, CTX)) as {
    resolved: boolean;
    items: unknown[];
  };
  assert.equal(result.resolved, false);
  assert.deepEqual(result.items, []);
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
    { fragrances: [{ name: "Aventus", brand: "Creed" }, { name: "Silver Mountain Water", brand: "Creed" }, { name: "Unknown Juice" }] },
    CTX,
  )) as { proposalId: string; count: number; items: unknown[]; unresolved: string[]; excludedOwned: string[] };

  assert.equal(result.count, 1);
  assert.equal(result.unresolved.length, 1);
  assert.deepEqual(result.excludedOwned, ["Creed Aventus"]);
  assert.match(result.proposalId, /^prop_/);

  const event = propose.clientEvent?.(result);
  assert.equal(event?.type, "proposal");
  assert.equal(event && event.type === "proposal" ? event.items.length : -1, 1);
  // A failed/empty proposal yields no card.
  assert.equal(propose.clientEvent?.({ proposalId: "p", items: [] }), null);
});

/** A catalog resolver that returns a rich, chartable profile for known names. */
function cardDeps(): BeamToolDeps {
  return makeDeps({
    resolveCatalogEntry: async (name, brand) => {
      if (name.toLowerCase().includes("unknown")) return null;
      return {
        name,
        brand: brand ?? "Creed",
        notes: ["bergamot", "birch", "musk"],
        pyramid: { top: ["bergamot"], heart: ["birch"], base: ["musk", "oakmoss"] },
        accords: ["fruity", "smoky"],
        scent_vector: { freshness: 0.8, sweetness: 0.3, woodiness: 0.7, spice: 0.5, warmth: 0.6, musk: 0.4 },
        imageUrl: "https://img/x.webp",
      };
    },
  });
}

test("card tools appear only with resolveCatalogEntry", () => {
  const lean = toolMap(makeDeps());
  for (const name of ["beam_show_scent_profile", "beam_compare_fragrances", "beam_present_travel_kit"]) {
    assert.equal(lean.has(name), false, `${name} should be gated off without resolveCatalogEntry`);
  }
  const rich = toolMap(cardDeps());
  for (const name of ["beam_show_scent_profile", "beam_compare_fragrances", "beam_present_travel_kit"]) {
    assert.equal(rich.has(name), true, `${name} should be exposed with resolveCatalogEntry`);
  }
});

test("beam_show_scent_profile emits a grounded scent_profile card and marks owned", async () => {
  const tools = toolMap(cardDeps());
  const profile = tools.get("beam_show_scent_profile")!;
  // Aventus/Creed is in the fake vault, so it should be flagged owned.
  const result = (await profile.handler({ name: "Aventus", brand: "Creed", caption: "Bright & smoky" }, CTX)) as {
    resolved: boolean;
    shown: { owned: boolean };
    hasVector: boolean;
  };
  assert.equal(result.resolved, true);
  assert.equal(result.shown.owned, true);
  assert.equal(result.hasVector, true);

  const event = profile.clientEvent?.(result);
  assert.equal(event?.type, "card");
  assert.ok(event && event.type === "card" && event.card.kind === "scent_profile");
  if (event && event.type === "card" && event.card.kind === "scent_profile") {
    assert.equal(event.card.fragrance.name, "Aventus");
    assert.equal(event.card.fragrance.owned, true);
    assert.equal(event.card.caption, "Bright & smoky");
    assert.ok(event.card.fragrance.scentVector);
  }
});

test("beam_show_scent_profile refuses an un-resolvable fragrance (no invented card)", async () => {
  const tools = toolMap(cardDeps());
  const result = (await tools.get("beam_show_scent_profile")!.handler({ name: "Unknown Juice" }, CTX)) as {
    resolved: boolean;
    card?: unknown;
  };
  assert.equal(result.resolved, false);
  assert.equal(result.card, undefined);
});

test("beam_compare_fragrances emits a compare card with grounded overlap", async () => {
  const tools = toolMap(cardDeps());
  const compare = tools.get("beam_compare_fragrances")!;
  const result = (await compare.handler(
    { a: { name: "Aventus", brand: "Creed" }, b: { name: "Green Irish Tweed", brand: "Creed" }, verdict: "Close cousins" },
    CTX,
  )) as { resolved: boolean; overlapPercent: number; band: string };
  assert.equal(result.resolved, true);
  // Both resolve to the same fake profile → identical notes/accords → full overlap.
  assert.equal(result.overlapPercent, 100);
  assert.equal(result.band, "high");

  const event = compare.clientEvent?.(result);
  assert.ok(event && event.type === "card" && event.card.kind === "compare");
  if (event && event.type === "card" && event.card.kind === "compare") {
    assert.equal(event.card.a.name, "Aventus");
    assert.equal(event.card.b.name, "Green Irish Tweed");
    assert.equal(event.card.verdict, "Close cousins");
    assert.ok(event.card.sharedAccords.length > 0);
  }

  // A missing side yields no card.
  const miss = (await compare.handler({ a: { name: "Aventus" }, b: { name: "Unknown Juice" } }, CTX)) as {
    resolved: boolean;
  };
  assert.equal(miss.resolved, false);
});

test("beam_present_travel_kit grounds the owned lane and drops un-owned/un-resolvable picks", async () => {
  const tools = toolMap(cardDeps());
  const kit = tools.get("beam_present_travel_kit")!;
  const result = (await kit.handler(
    {
      title: "Tokyo · August",
      // Aventus IS owned; Bleu de Chanel is NOT in the vault → must be dropped from the owned lane.
      owned: [{ name: "Aventus", brand: "Creed" }, { name: "Bleu de Chanel", brand: "Chanel" }],
      newPicks: [{ name: "Aventus", brand: "Creed" }, { name: "Silver Mountain Water", brand: "Creed" }, { name: "Unknown Juice" }],
    },
    CTX,
  )) as { resolved: boolean; ownedCount: number; newCount: number; unresolved: string[]; excludedOwned: string[]; card: { kind: string } };

  assert.equal(result.resolved, true);
  assert.equal(result.ownedCount, 1, "only the genuinely-owned bottle survives the owned lane");
  assert.equal(result.newCount, 1, "only the resolvable new pick survives");
  assert.equal(result.unresolved.length, 1);
  assert.deepEqual(result.excludedOwned, ["Creed Aventus"]);

  const event = kit.clientEvent?.(result);
  assert.ok(event && event.type === "card" && event.card.kind === "travel_kit");
  if (event && event.type === "card" && event.card.kind === "travel_kit") {
    assert.equal(event.card.title, "Tokyo · August");
    assert.equal(event.card.ownedPicks.length, 1);
    assert.equal(event.card.ownedPicks[0].owned, true);
    assert.equal(event.card.newPicks.length, 1);
    assert.match(event.card.proposalId ?? "", /^prop_/);
  }
});

test("add-ready tools fail closed when vault ownership cannot be loaded", async () => {
  const deps = cardDeps();
  deps.loadVault = async () => { throw new Error("vault unavailable"); };
  const unavailable = toolMap(deps);

  await assert.rejects(
    unavailable.get("beam_propose_collection")!.handler({ fragrances: [{ name: "Wulong Cha" }] }, CTX),
    /vault unavailable/,
  );
  await assert.rejects(
    unavailable.get("beam_present_travel_kit")!.handler({ newPicks: [{ name: "Wulong Cha" }] }, CTX),
    /vault unavailable/,
  );
});

test("beam_present_travel_kit deduplicates repeated new picks", async () => {
  const kit = toolMap(cardDeps()).get("beam_present_travel_kit")!;
  const result = (await kit.handler(
    { newPicks: [{ name: "Silver Mountain Water", brand: "Creed" }, { name: "Silver Mountain Water", brand: "Creed" }] },
    CTX,
  )) as { newCount: number; card: { newPicks: unknown[] } };
  assert.equal(result.newCount, 1);
  assert.equal(result.card.newPicks.length, 1);
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

test("beam_get_wardrobe returns count===N with every owned item, in order", async () => {
  const vault = [
    { id: "v1", name: "Sauvage", brand: "Dior", families: ["fresh"], accords: ["pepper"] },
    { id: "v2", name: "Aventus", brand: "Creed", families: ["fruity"], accords: ["smoky"] },
    { id: "v3", name: "Oud Wood", brand: "Tom Ford", families: ["woody"], accords: ["oud"] },
    { id: "v4", name: "Light Blue", brand: "Dolce & Gabbana", families: ["citrus"], accords: ["lemon"] },
    { id: "v5", name: "Bleu de Chanel", brand: "Chanel", families: ["woody"], accords: ["incense"] },
  ];
  const tools = toolMap(makeDeps({ loadVault: async () => vault }));
  const result = (await tools.get("beam_get_wardrobe")!.handler({}, CTX)) as {
    count: number;
    items: Array<{ owned: boolean; canonicalName: string }>;
  };
  assert.equal(result.count, vault.length, "count must equal the wardrobe row count");
  assert.equal(result.items.length, vault.length);
  assert.ok(result.items.every((item) => item.owned === true), "every packet is owned");
  assert.deepEqual(
    result.items.map((item) => item.canonicalName),
    vault.map((v) => v.name),
    "wardrobe items round-trip in order",
  );
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

test("owned exclusion uses the uncapped identity view for vaults over 60 items", async () => {
  const ownershipVault = Array.from({ length: 61 }, (_, index) => ({
    id: `v${index + 1}`,
    name: index === 60 ? "Aventus" : `Scent ${index + 1}`,
    brand: index === 60 ? "Creed" : "House",
  }));
  const tools = toolMap(makeDeps({
    loadVault: async () => ownershipVault.slice(0, 60),
    loadVaultForOwnership: async () => ownershipVault,
  }));
  const result = (await tools.get("beam_search_catalog")!.handler(
    { query: "creed", excludeOwned: true }, CTX,
  )) as { items: Array<{ canonicalName: string }> };
  assert.equal(result.items.some((item) => item.canonicalName === "Aventus"), false);
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

test("travel scoring rejects missing or mismatched destination climate", async () => {
  const tools = toolMap(makeDeps({ requiredDestinationClimate: { destination: "Tokyo", month: "August" } }));
  const missing = (await tools.get("beam_score_candidates")!.handler(
    { destination: "Going Out", locationLabel: "Tokyo, August" }, CTX,
  )) as { picks: unknown[]; note: string };
  assert.deepEqual(missing.picks, []);
  assert.match(missing.note, /destination climate required/i);
  const mismatched = (await tools.get("beam_score_candidates")!.handler({
    destination: "Going Out",
    locationLabel: "Paris, August",
    weatherOverride: { temperature_f: 75, humidity_percent: 80 },
  }, CTX)) as { picks: unknown[] };
  assert.deepEqual(mismatched.picks, []);
});

test("destination override never inherits unrelated home weather fields", async () => {
  let scoredWeather: Record<string, unknown> | undefined;
  const tools = toolMap(makeDeps({
    getWeather: async () => ({ temperature_f: 95, humidity_percent: 20, condition: "Clear", location: "Forney" }),
    rankVault: (items, _cal, weather) => {
      scoredWeather = weather as Record<string, unknown>;
      return items.map((item) => ({
        fragranceId: item.id, name: item.name, brand: item.brand,
        engine: {} as never, reason: "ranked", score: 80,
      }));
    },
  }));
  await tools.get("beam_score_candidates")!.handler(
    { destination: "Going Out", locationLabel: "Tokyo", weatherOverride: { humidity_percent: 85 } }, CTX,
  );
  assert.equal(scoredWeather?.humidity_percent, 85);
  assert.equal(scoredWeather?.temperature_f, undefined);
  assert.equal(scoredWeather?.location, undefined);
});

test("beam_check_enrichment_state is exposed only when the dep is wired", () => {
  assert.equal(toolMap(makeDeps()).has("beam_check_enrichment_state"), false);
  assert.equal(
    toolMap(makeDeps({ checkEnrichmentState: async () => ({ level: "full", complete: true }) })).has(
      "beam_check_enrichment_state",
    ),
    true,
  );
});

test("beam_check_enrichment_state reports complete vs defer per level", async () => {
  const tools = toolMap(
    makeDeps({
      checkEnrichmentState: async ({ name }) =>
        name === "Aventus" ? { level: "full", complete: true } : { level: "partial", complete: false },
    }),
  );
  const tool = tools.get("beam_check_enrichment_state")!;

  const complete = (await tool.handler({ name: "Aventus", brand: "Creed" }, CTX)) as Record<string, unknown>;
  assert.equal(complete.complete, true);
  assert.equal(complete.level, "full");
  assert.match(String(complete.recommendation), /safe to present/i);

  const partial = (await tool.handler({ name: "Obscure Blend" }, CTX)) as Record<string, unknown>;
  assert.equal(partial.complete, false);
  assert.equal(partial.level, "partial");
  assert.match(String(partial.recommendation), /researching|notify/i);
});

test("beam_check_enrichment_state is conservative when the probe throws or name is missing", async () => {
  const tools = toolMap(
    makeDeps({
      checkEnrichmentState: async () => {
        throw new Error("engine down");
      },
    }),
  );
  const tool = tools.get("beam_check_enrichment_state")!;

  const noName = (await tool.handler({}, CTX)) as Record<string, unknown>;
  assert.equal(noName.ok, false);
  assert.equal(noName.complete, false);

  const failed = (await tool.handler({ name: "Anything" }, CTX)) as Record<string, unknown>;
  assert.equal(failed.ok, false);
  assert.equal(failed.complete, false);
  assert.equal(failed.level, "none");
});
