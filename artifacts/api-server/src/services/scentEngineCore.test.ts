import test from "node:test";
import assert from "node:assert/strict";
import {
  buildProfileWithDeps,
  type ScentEngineDeps,
  type ScentProfile,
} from "./scentEngineCore.ts";

// --- stubs -------------------------------------------------------------------

type CallLog = {
  getCatalogEntry: Array<[string, string]>;
  searchCatalog: string[];
  saveCatalogEntry: Array<{ brand: string; name: string; profile: ScentProfile }>;
  resolveProcessedFragranceImage: Array<Record<string, unknown>>;
  usableImageUrlForResponse: Array<string | undefined>;
  findDatasetFragrance: Array<[string, string]>;
  reportNonFatalError: Array<{ area: string; error: unknown; context?: Record<string, unknown> }>;
  parseFragrance: number;
  vectorize: number;
  calculatePerformance: number;
  calculateContext: number;
};

function makeProfile(over: Partial<ScentProfile> = {}): ScentProfile {
  return {
    product: { name: "Sauvage", brand: "Dior" },
    scent_vector: { freshness: 5, sweetness: 0, woodiness: 4, spice: 6, warmth: 5, musk: 5 },
    performance: { sillage: 7, longevity: 8 },
    context: { weather: ["Warm"], occasion: ["Casual"] },
    notes: ["bergamot", "pepper", "ambroxan"],
    family: "Fresh Spicy",
    concentration: "Eau de Parfum",
    accords: ["fresh", "spicy"],
    imageUrl: "https://cdn.example.com/sauvage.webp",
    storagePath: "images/processed/sauvage.webp",
    imageHash: "deadbeef",
    storageProvider: "supabase",
    description: "a fresh spicy fragrance",
    ...over,
  };
}

function makeDeps(over: Partial<ScentEngineDeps> = {}): { deps: ScentEngineDeps; calls: CallLog } {
  const calls: CallLog = {
    getCatalogEntry: [],
    searchCatalog: [],
    saveCatalogEntry: [],
    resolveProcessedFragranceImage: [],
    usableImageUrlForResponse: [],
    findDatasetFragrance: [],
    reportNonFatalError: [],
    parseFragrance: 0,
    vectorize: 0,
    calculatePerformance: 0,
    calculateContext: 0,
  };

  // Recording wrappers run FIRST and delegate to the override (or a default
  // return). This is the critical detail that lets a test customise a return
  // value without losing call-tracking.
  const deps: ScentEngineDeps = {
    parseFragrance: (data) => {
      calls.parseFragrance++;
      if (over.parseFragrance) return over.parseFragrance(data);
      if (!data) return null;
      return {
        notes: data.notes ?? [],
        pyramidNotes: {
          top: data.pyramid?.top ?? [],
          heart: data.pyramid?.heart ?? [],
          base: data.pyramid?.base ?? [],
        },
        family: data.family ?? "unknown",
        description: data.description ?? "",
        perfumer: data.perfumer ?? "",
        concentration: "Eau de Parfum",
        accords: ["fresh"],
      };
    },
    vectorize: (parsed) => {
      calls.vectorize++;
      if (over.vectorize) return over.vectorize(parsed);
      return { freshness: 5, sweetness: 0, woodiness: 4, spice: 6, warmth: 5, musk: 5 };
    },
    calculatePerformance: (vector, family, concentration) => {
      calls.calculatePerformance++;
      if (over.calculatePerformance) return over.calculatePerformance(vector, family, concentration);
      return { sillage: 7, longevity: 8 };
    },
    calculateContext: (vector) => {
      calls.calculateContext++;
      if (over.calculateContext) return over.calculateContext(vector);
      return { weather: ["Warm"], occasion: ["Casual"] };
    },
    resolveFragranceIdentity: (brand, name) => {
      if (over.resolveFragranceIdentity) return over.resolveFragranceIdentity(brand, name);
      return { brand, name };
    },
    findDatasetFragrance: (brand, name) => {
      calls.findDatasetFragrance.push([brand, name]);
      if (over.findDatasetFragrance) return over.findDatasetFragrance(brand, name);
      return undefined;
    },
    getCatalogEntry: async (brand, name) => {
      calls.getCatalogEntry.push([brand, name]);
      if (over.getCatalogEntry) return over.getCatalogEntry(brand, name);
      return null;
    },
    searchCatalog: async (query) => {
      calls.searchCatalog.push(query);
      if (over.searchCatalog) return over.searchCatalog(query);
      return null;
    },
    saveCatalogEntry: async (brand, name, profile) => {
      if (over.saveCatalogEntry) {
        // Run override first so a rejection bubbles before we record success.
        const result = await over.saveCatalogEntry(brand, name, profile);
        calls.saveCatalogEntry.push({ brand, name, profile });
        return result;
      }
      calls.saveCatalogEntry.push({ brand, name, profile });
    },
    resolveProcessedFragranceImage: async (opts) => {
      calls.resolveProcessedFragranceImage.push(opts as Record<string, unknown>);
      if (over.resolveProcessedFragranceImage) return over.resolveProcessedFragranceImage(opts);
      return null;
    },
    usableImageUrlForResponse: async (url) => {
      calls.usableImageUrlForResponse.push(url);
      if (over.usableImageUrlForResponse) return over.usableImageUrlForResponse(url);
      return url ?? null;
    },
    reportNonFatalError: (area, error, context) => {
      calls.reportNonFatalError.push({ area, error, context });
      over.reportNonFatalError?.(area, error, context);
    },
  };

  return { deps, calls };
}

function ok(result: ScentProfile | { error: string }): asserts result is ScentProfile {
  if ("error" in result && !("product" in result)) {
    assert.fail(`expected ScentProfile, got error: ${result.error}`);
  }
}

function err(result: ScentProfile | { error: string }): asserts result is { error: string } {
  if ("product" in result) {
    assert.fail(`expected error, got profile: ${JSON.stringify(result.product)}`);
  }
}

// --- branching matrix --------------------------------------------------------

test("cache hit with usable image short-circuits: returns cached, skips pipeline+vectorize+save", async () => {
  const cached = makeProfile();
  const { deps, calls } = makeDeps({
    getCatalogEntry: async () => cached,
    usableImageUrlForResponse: async (url) => url ?? null,
  });

  const result = await buildProfileWithDeps(deps, "Sauvage", "Dior");
  ok(result);

  assert.equal(result.product.name, "Sauvage");
  assert.equal(result.imageUrl, cached.imageUrl);
  // Early-return path: no fuzzy, no image pipeline, no vectorize, no save
  assert.equal(calls.searchCatalog.length, 0);
  assert.equal(calls.resolveProcessedFragranceImage.length, 0);
  assert.equal(calls.vectorize, 0);
  assert.equal(calls.saveCatalogEntry.length, 0);
});

test("cache hit with UNUSABLE image keeps cached as base, runs pipeline + vectorize + save", async () => {
  const cached = makeProfile({ imageUrl: "data:image/png;base64,STALE" });
  const { deps, calls } = makeDeps({
    getCatalogEntry: async () => cached,
    // Simulate persistenceGuards rejecting the stale data-URL
    usableImageUrlForResponse: async () => null,
    findDatasetFragrance: () => ({
      name: "Sauvage",
      brand: "Dior",
      family: "Fresh Spicy",
      notes: ["bergamot", "pepper", "ambroxan"],
      description: "a fresh spicy fragrance",
    }),
  });

  const result = await buildProfileWithDeps(deps, "Sauvage", "Dior");
  ok(result);

  assert.equal(calls.vectorize, 1);
  assert.equal(calls.resolveProcessedFragranceImage.length, 1);
  assert.equal(calls.saveCatalogEntry.length, 1);
});

test("B2: allowCatalogFuzzy=false skips searchCatalog entirely (rebuild identity protection)", async () => {
  const { deps, calls } = makeDeps({
    findDatasetFragrance: () => ({
      name: "Sauvage",
      brand: "Dior",
      family: "Fresh Spicy",
      notes: ["bergamot"],
      description: "",
    }),
  });

  const result = await buildProfileWithDeps(deps, "Sauvage", "Dior", undefined, {
    allowCatalogFuzzy: false,
  });
  ok(result);

  assert.equal(calls.getCatalogEntry.length, 1);
  assert.equal(calls.searchCatalog.length, 0, "fuzzy catalog must not be queried");
});

test("fuzzy catalog hit with usable image short-circuits like an exact hit", async () => {
  const fuzzy = makeProfile({ product: { name: "Sauvage", brand: "Dior" } });
  const { deps, calls } = makeDeps({
    searchCatalog: async (q) => {
      assert.equal(q, "Dior Sauvage EDP");
      return fuzzy;
    },
  });

  const result = await buildProfileWithDeps(deps, "Sauvage EDP", "Dior");
  ok(result);

  assert.equal(result.product.name, "Sauvage");
  assert.equal(calls.searchCatalog.length, 1);
  // Short-circuit: vectorize and pipeline never ran
  assert.equal(calls.vectorize, 0);
  assert.equal(calls.resolveProcessedFragranceImage.length, 0);
  assert.equal(calls.saveCatalogEntry.length, 0);
});

test("preferEngineData=true: skips fuzzy AND prevents cached early-return, vectorize always runs", async () => {
  const cached = makeProfile();
  const { deps, calls } = makeDeps({
    getCatalogEntry: async () => cached, // exact hit with a usable image
    findDatasetFragrance: () => undefined,
  });

  const result = await buildProfileWithDeps(
    deps,
    "Sauvage",
    "Dior",
    { notes: ["bergamot", "pepper", "ambroxan"], family: "Fresh Spicy" },
    { preferEngineData: true },
  );
  ok(result);

  // The cached entry is used as a base, not returned directly.
  // searchCatalog must not run.
  assert.equal(calls.searchCatalog.length, 0);
  // Vectorizer must run (we always re-vectorize under preferEngineData)
  assert.equal(calls.vectorize, 1);
});

test("preferEngineData with complete fallback notes: engine notes win over cached/dataset notes", async () => {
  const cached = makeProfile({ notes: ["totally", "different", "notes"] });
  const { deps } = makeDeps({
    getCatalogEntry: async () => cached,
    findDatasetFragrance: () => ({
      name: "Sauvage",
      brand: "Dior",
      family: "Fresh Spicy",
      notes: ["dataset", "notes"],
      description: "",
    }),
  });

  const engineNotes = ["bergamot", "sichuan pepper", "ambroxan"];
  const result = await buildProfileWithDeps(
    deps,
    "Sauvage",
    "Dior",
    { notes: engineNotes },
    { preferEngineData: true },
  );
  ok(result);

  assert.deepEqual(result.notes, engineNotes);
});

test("no catalog + no dataset match + no fallback notes → returns identification error", async () => {
  const { deps, calls } = makeDeps({});

  const result = await buildProfileWithDeps(deps, "Nonexistent Fragrance", "No Brand");
  err(result);

  assert.match(result.error, /Could not identify/);
  // No save, no vectorize on the error path
  assert.equal(calls.vectorize, 0);
  assert.equal(calls.saveCatalogEntry.length, 0);
});

test("concentrationOverride is applied to the final profile after parse", async () => {
  const { deps } = makeDeps({
    findDatasetFragrance: () => ({
      name: "Sauvage",
      brand: "Dior",
      family: "Fresh Spicy",
      notes: ["bergamot"],
      description: "",
    }),
  });

  const result = await buildProfileWithDeps(deps, "Sauvage", "Dior", undefined, {
    concentrationOverride: "Extrait",
  });
  ok(result);

  assert.equal(result.concentration, "Extrait");
});

test("saveCatalogEntry rejection is reported and remains non-fatal", async () => {
  const { deps, calls } = makeDeps({
    findDatasetFragrance: () => ({
      name: "Sauvage",
      brand: "Dior",
      family: "Fresh Spicy",
      notes: ["bergamot"],
      description: "",
    }),
    saveCatalogEntry: async () => {
      throw new Error("DB unavailable");
    },
  });

  // Must not throw despite saveCatalogEntry rejecting.
  const result = await buildProfileWithDeps(deps, "Sauvage", "Dior");
  ok(result);
  assert.equal(calls.saveCatalogEntry.length, 0, "rejection happens before success recording");
  assert.equal(calls.reportNonFatalError.length, 1);
  assert.equal(calls.reportNonFatalError[0].area, "scentEngine.catalogSave");
  assert.deepEqual(calls.reportNonFatalError[0].context, {
    brand: "Dior",
    name: "Sauvage",
  });
});

test("image pipeline: search-query call returns null AND fallback.imageUrl present → second attempt with manual sourceUrl", async () => {
  let callIdx = 0;
  const { deps, calls } = makeDeps({
    findDatasetFragrance: () => ({
      name: "Sauvage",
      brand: "Dior",
      family: "Fresh Spicy",
      notes: ["bergamot"],
      description: "",
    }),
    resolveProcessedFragranceImage: async (_opts) => {
      callIdx++;
      // First call (search-query path) fails; second (manual sourceUrl) succeeds.
      // Recording is handled by makeDeps; the override only provides the return value.
      if (callIdx === 1) return null;
      return { imageUrl: "https://cdn.example.com/fallback.webp", storagePath: "images/processed/x.webp", imageHash: "abc", storageProvider: "supabase" };
    },
  });

  const result = await buildProfileWithDeps(deps, "Sauvage", "Dior", {
    imageUrl: "https://upstream.example.com/raw.jpg",
  });
  ok(result);

  assert.equal(calls.resolveProcessedFragranceImage.length, 2);
  // First call: search-query mode
  assert.equal(calls.resolveProcessedFragranceImage[0].searchQuery, "Dior Sauvage single fragrance bottle no box HQ product photo studio no plants");
  assert.equal(calls.resolveProcessedFragranceImage[0].sourceUrl, undefined);
  // Second call: manual sourceUrl from fallback
  assert.equal(calls.resolveProcessedFragranceImage[1].sourceUrl, "https://upstream.example.com/raw.jpg");
  assert.equal(calls.resolveProcessedFragranceImage[1].sourceProvider, "manual");
  assert.equal(calls.resolveProcessedFragranceImage[1].allowLookupCache, false);

  assert.equal(result.imageUrl, "https://cdn.example.com/fallback.webp");
});

test("image pipeline: search-query rejection is reported and does not abort buildProfile", async () => {
  const { deps, calls } = makeDeps({
    findDatasetFragrance: () => ({
      name: "Sauvage",
      brand: "Dior",
      family: "Fresh Spicy",
      notes: ["bergamot"],
      description: "",
    }),
    resolveProcessedFragranceImage: async () => {
      throw new Error("Serper down");
    },
  });

  const result = await buildProfileWithDeps(deps, "Sauvage", "Dior");
  ok(result);

  // Pipeline error swallowed: result has no imageUrl but build still succeeds
  assert.equal(result.imageUrl, undefined);
  assert.equal(calls.vectorize, 1);
  assert.equal(calls.reportNonFatalError.length, 1);
  assert.equal(calls.reportNonFatalError[0].area, "scentEngine.imageResolution");
  assert.deepEqual(calls.reportNonFatalError[0].context, {
    brand: "Dior",
    name: "Sauvage",
    mode: "search",
  });
});

test("identity normalization: uses resolveFragranceIdentity output for catalog lookup and search query", async () => {
  const { deps, calls } = makeDeps({
    resolveFragranceIdentity: (_brand, _name) => ({ brand: "Dior", name: "Sauvage" }),
    findDatasetFragrance: () => ({
      name: "Sauvage",
      brand: "Dior",
      family: "Fresh Spicy",
      notes: ["bergamot"],
      description: "",
    }),
  });

  await buildProfileWithDeps(deps, "Sauvage Eau de Parfum 100ml", "Dior");

  // Catalog query uses the normalized (brand, name), not the raw input
  assert.deepEqual(calls.getCatalogEntry[0], ["Dior", "Sauvage"]);
  // Dataset query also uses normalized
  assert.deepEqual(calls.findDatasetFragrance[0], ["Dior", "Sauvage"]);
  // Image search-query is constructed from normalized identity
  assert.equal(
    calls.resolveProcessedFragranceImage[0].searchQuery,
    "Dior Sauvage single fragrance bottle no box HQ product photo studio no plants",
  );
});
