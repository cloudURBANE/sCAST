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
  resolveCachedFragranceImage: Array<[string, string]>;
  resolveProcessedFragranceImage: Array<Record<string, unknown>>;
  usableImageUrlForResponse: Array<string | undefined>;
  backfillUserFragranceImages: Array<{ brand: string; name: string; image: unknown }>;
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
    resolveCachedFragranceImage: [],
    resolveProcessedFragranceImage: [],
    usableImageUrlForResponse: [],
    backfillUserFragranceImages: [],
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
    resolveCachedFragranceImage: async (brand, name) => {
      calls.resolveCachedFragranceImage.push([brand, name]);
      if (over.resolveCachedFragranceImage) return over.resolveCachedFragranceImage(brand, name);
      return null;
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
    // Optional: only wired when a test supplies it, so the default deps leave
    // the hybrid server-side resolve disabled (mirrors production opt-in).
    resolveProfileViaEngine: over.resolveProfileViaEngine,
    backfillUserFragranceImages: async (brand, name, image) => {
      calls.backfillUserFragranceImages.push({ brand, name, image });
      await over.backfillUserFragranceImages?.(brand, name, image);
    },
    // BE-3: forwarded so deferred-image retry tests can shrink the backoff and
    // skip real timers. Defaults stay unset → legacy single-attempt behavior.
    deferredImageRetryDelaysMs: over.deferredImageRetryDelaysMs,
    sleep: over.sleep,
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

test("fuzzy catalog hit without concentration text short-circuits like an exact hit", async () => {
  const fuzzy = makeProfile({ product: { name: "Sauvage", brand: "Dior" } });
  const { deps, calls } = makeDeps({
    searchCatalog: async (q) => {
      assert.equal(q, "Dior Savauge");
      return fuzzy;
    },
  });

  const result = await buildProfileWithDeps(deps, "Savauge", "Dior");
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

test("preferEngineData with flat engine notes still keeps dataset pyramid tiers", async () => {
  const datasetPyramid = {
    top: ["Cardamom"],
    heart: ["Sandalwood", "Papyrus"],
    base: ["Leather", "Amber"],
  };
  const { deps } = makeDeps({
    findDatasetFragrance: () => ({
      name: "Santal 33",
      brand: "Le Labo",
      family: "Woody",
      notes: ["dataset", "notes"],
      pyramid: datasetPyramid,
      description: "",
    }),
  });

  const engineNotes = ["Sandalwood", "Leather", "Cardamom"];
  const result = await buildProfileWithDeps(
    deps,
    "Santal 33",
    "Le Labo",
    { notes: engineNotes },
    { preferEngineData: true },
  );
  ok(result);

  assert.deepEqual(result.notes, engineNotes);
  assert.deepEqual(result.pyramid, datasetPyramid);
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

test("allowMinimalFallback: no match + no notes but real identity → minimal pending profile, not error", async () => {
  const { deps, calls } = makeDeps({});

  const result = await buildProfileWithDeps(deps, "Bleu Electrique", "Yves Saint Laurent", undefined, {
    allowMinimalFallback: true,
  });
  ok(result);

  // The capture flow must land a real-but-unscraped fragrance as a profile
  // (vectorized + persisted), so background enrichment can fill the pyramid.
  assert.equal(result.product.name, "Bleu Electrique");
  assert.equal(result.product.brand, "Yves Saint Laurent");
  assert.deepEqual(result.notes, []);
  assert.equal(calls.vectorize, 1);
});

test("allowMinimalFallback does NOT rescue an empty identity (still errors)", async () => {
  const { deps } = makeDeps({
    resolveFragranceIdentity: (brand) => ({ brand, name: "" }),
  });

  const result = await buildProfileWithDeps(deps, "", "", undefined, {
    allowMinimalFallback: true,
  });
  err(result);
  assert.match(result.error, /Could not identify/);
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

test("concentrationOverride bypasses cached early return and rebuilds profile", async () => {
  const cached = makeProfile({ concentration: "Eau de Toilette" });
  const { deps, calls } = makeDeps({
    getCatalogEntry: async () => cached,
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
  assert.equal(result.imageUrl, cached.imageUrl);
  assert.equal(result.storagePath, cached.storagePath);
  assert.equal(calls.resolveProcessedFragranceImage.length, 0);
  assert.equal(calls.vectorize, 1);
  assert.equal(calls.saveCatalogEntry.length, 1);
});

test("raw concentration labels bypass cached early return without route override", async () => {
  const cached = makeProfile({ concentration: "Eau de Toilette" });
  const { deps, calls } = makeDeps({
    resolveFragranceIdentity: () => ({ brand: "Dior", name: "Sauvage" }),
    getCatalogEntry: async () => cached,
    findDatasetFragrance: () => ({
      name: "Sauvage",
      brand: "Dior",
      family: "Fresh Spicy",
      notes: ["bergamot"],
      description: "",
    }),
  });

  const result = await buildProfileWithDeps(deps, "Sauvage EDP 100ml", "Dior");
  ok(result);

  assert.equal(result.product.name, "Sauvage");
  assert.equal(result.concentration, "Eau de Parfum");
  assert.equal(result.imageUrl, cached.imageUrl);
  assert.equal(result.storagePath, cached.storagePath);
  assert.equal(calls.resolveProcessedFragranceImage.length, 0);
  assert.equal(calls.vectorize, 1);
  assert.equal(calls.saveCatalogEntry.length, 1);
});

test("raw concentration labels survive identity normalization", async () => {
  const { deps } = makeDeps({
    resolveFragranceIdentity: () => ({ brand: "Dior", name: "Sauvage" }),
    parseFragrance: (data) =>
      data
        ? {
            notes: data.notes ?? [],
            pyramidNotes: {
              top: data.pyramid?.top ?? [],
              heart: data.pyramid?.heart ?? [],
              base: data.pyramid?.base ?? [],
            },
            family: data.family ?? "unknown",
            description: data.description ?? "",
            perfumer: data.perfumer ?? "",
            concentration: "Unknown",
            accords: [],
          }
        : null,
    findDatasetFragrance: () => ({
      name: "Sauvage",
      brand: "Dior",
      family: "Fresh Spicy",
      notes: ["bergamot"],
      description: "",
    }),
  });

  const result = await buildProfileWithDeps(deps, "Sauvage EDP 100ml", "Dior");
  ok(result);

  assert.equal(result.product.name, "Sauvage");
  assert.equal(result.concentration, "Eau de Parfum");
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

test("image pipeline: free crawled sourceUrl is tried first; on failure falls back to the paid search-query (Serper) path", async () => {
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
      // First call (free crawled sourceUrl) fails; second (paid search-query)
      // succeeds. Recording is handled by makeDeps; the override only provides
      // the return value.
      if (callIdx === 1) return null;
      return { imageUrl: "https://cdn.example.com/fallback.webp", storagePath: "images/processed/x.webp", imageHash: "abc", storageProvider: "supabase" };
    },
  });

  const result = await buildProfileWithDeps(deps, "Sauvage", "Dior", {
    imageUrl: "https://upstream.example.com/raw.jpg",
  });
  ok(result);

  assert.equal(calls.resolveProcessedFragranceImage.length, 2);
  // First call: free crawled sourceUrl from the fallback (no paid Serper search).
  assert.equal(calls.resolveProcessedFragranceImage[0].sourceUrl, "https://upstream.example.com/raw.jpg");
  assert.equal(calls.resolveProcessedFragranceImage[0].sourceProvider, "manual");
  assert.equal(calls.resolveProcessedFragranceImage[0].allowLookupCache, false);
  // Second call: paid search-query (Serper) fallback.
  assert.equal(calls.resolveProcessedFragranceImage[1].searchQuery, "Dior Sauvage single fragrance bottle no box HQ product photo studio no plants");
  assert.equal(calls.resolveProcessedFragranceImage[1].sourceUrl, undefined);

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

test("deferred image resolution reuses cached image and skips expensive pipeline", async () => {
  const { deps, calls } = makeDeps({
    findDatasetFragrance: () => ({
      name: "Sauvage",
      brand: "Dior",
      family: "Fresh Spicy",
      notes: ["bergamot"],
      description: "",
    }),
    resolveCachedFragranceImage: async () => ({
      imageUrl: "https://cdn.example.com/cached.webp",
      storagePath: "images/processed/cached.webp",
      imageHash: "cached",
      storageProvider: "supabase",
      sourceProvider: "serper",
    }),
  });

  const result = await buildProfileWithDeps(deps, "Sauvage", "Dior", undefined, {
    imageResolution: "deferred",
  });
  ok(result);

  assert.equal(result.imageUrl, "https://cdn.example.com/cached.webp");
  assert.deepEqual(calls.resolveCachedFragranceImage, [["Dior", "Sauvage"]]);
  assert.equal(calls.resolveProcessedFragranceImage.length, 0);
  assert.equal(calls.saveCatalogEntry.length, 1);
});

test("deferred image resolution returns profile before background pipeline finishes", async () => {
  let finishImage!: (value: {
    imageUrl: string;
    storagePath: string;
    imageHash: string;
    storageProvider: string;
    sourceProvider: string;
  }) => void;
  const slowImage = new Promise<{
    imageUrl: string;
    storagePath: string;
    imageHash: string;
    storageProvider: string;
    sourceProvider: string;
  }>((resolve) => {
    finishImage = resolve;
  });
  const { deps, calls } = makeDeps({
    findDatasetFragrance: () => ({
      name: "Sauvage",
      brand: "Dior",
      family: "Fresh Spicy",
      notes: ["bergamot"],
      description: "",
    }),
    resolveProcessedFragranceImage: async () => slowImage,
  });

  const result = await Promise.race([
    buildProfileWithDeps(deps, "Sauvage", "Dior", undefined, {
      imageResolution: "deferred",
    }),
    new Promise<"timed_out">((resolve) => setTimeout(() => resolve("timed_out"), 25)),
  ]);
  assert.notEqual(result, "timed_out");
  ok(result);
  assert.equal(result.imageUrl, undefined);
  assert.equal(calls.saveCatalogEntry.length, 1);
  assert.equal(calls.resolveProcessedFragranceImage.length, 1);

  finishImage({
    imageUrl: "https://cdn.example.com/background.webp",
    storagePath: "images/processed/background.webp",
    imageHash: "background",
    storageProvider: "supabase",
    sourceProvider: "serper",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(calls.saveCatalogEntry.length, 2);
  assert.equal(calls.saveCatalogEntry[1].profile.imageUrl, "https://cdn.example.com/background.webp");
});

test("deferred image resolution retries a transient first-pass miss and self-heals", async () => {
  let imageAttempts = 0;
  const { deps, calls } = makeDeps({
    findDatasetFragrance: () => ({
      name: "Sauvage",
      brand: "Dior",
      family: "Fresh Spicy",
      notes: ["bergamot"],
      description: "",
    }),
    // First background pass finds nothing (transient miss); the second succeeds.
    resolveProcessedFragranceImage: async () => {
      imageAttempts++;
      if (imageAttempts < 2) return null;
      return {
        imageUrl: "https://cdn.example.com/recovered.webp",
        storagePath: "images/processed/recovered.webp",
        imageHash: "recovered",
        storageProvider: "supabase",
        sourceProvider: "serper",
      };
    },
    // One retry, no real delay, no real timer.
    deferredImageRetryDelaysMs: [0],
    sleep: async () => {},
  });

  const result = await buildProfileWithDeps(deps, "Sauvage", "Dior", undefined, {
    imageResolution: "deferred",
  });
  ok(result);
  // The deferred save still returns imageless immediately.
  assert.equal(result.imageUrl, undefined);

  // Drain the fire-and-forget background retry loop.
  for (let i = 0; i < 50 && calls.backfillUserFragranceImages.length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  // Re-queried Serper after the first empty pass.
  assert.equal(calls.resolveProcessedFragranceImage.length, 2);
  // Recovered image is persisted to the catalog AND backfilled into the user's
  // still-imageless wardrobe rows (so the tile self-heals without a re-add).
  assert.equal(calls.saveCatalogEntry.length, 2);
  assert.equal(calls.saveCatalogEntry[1].profile.imageUrl, "https://cdn.example.com/recovered.webp");
  assert.equal(calls.backfillUserFragranceImages.length, 1);
  assert.equal(
    (calls.backfillUserFragranceImages[0].image as { imageUrl?: string }).imageUrl,
    "https://cdn.example.com/recovered.webp",
  );
});

test("deferred image resolution stops retrying once an image is found", async () => {
  let imageAttempts = 0;
  const { deps, calls } = makeDeps({
    findDatasetFragrance: () => ({
      name: "Sauvage",
      brand: "Dior",
      family: "Fresh Spicy",
      notes: ["bergamot"],
      description: "",
    }),
    resolveProcessedFragranceImage: async () => {
      imageAttempts++;
      return {
        imageUrl: "https://cdn.example.com/first.webp",
        storagePath: "images/processed/first.webp",
        imageHash: "first",
        storageProvider: "supabase",
        sourceProvider: "serper",
      };
    },
    // Generous retry budget that must NOT be spent once the first pass succeeds.
    deferredImageRetryDelaysMs: [0, 0, 0],
    sleep: async () => {},
  });

  const result = await buildProfileWithDeps(deps, "Sauvage", "Dior", undefined, {
    imageResolution: "deferred",
  });
  ok(result);

  for (let i = 0; i < 50 && calls.backfillUserFragranceImages.length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  assert.equal(imageAttempts, 1, "must not retry after a successful first pass");
  assert.equal(calls.saveCatalogEntry.length, 2);
  assert.equal(calls.backfillUserFragranceImages.length, 1);
});

test("serverSideResolve hit: engine notes build a full profile instead of a pending card", async () => {
  const engineCalls: Array<[string, string]> = [];
  const { deps, calls } = makeDeps({
    resolveProfileViaEngine: async (brand, name) => {
      engineCalls.push([brand, name]);
      return {
        notes: ["bergamot", "ambroxan", "pepper"],
        family: "Fresh Spicy",
        description: "resolved via engine",
        pyramid: { top: ["bergamot"], heart: ["pepper"], base: ["ambroxan"] },
      };
    },
  });

  const result = await buildProfileWithDeps(deps, "Bleu Electrique", "Yves Saint Laurent", undefined, {
    allowMinimalFallback: true,
    serverSideResolve: true,
  });
  ok(result);

  assert.deepEqual(engineCalls, [["Yves Saint Laurent", "Bleu Electrique"]]);
  // Real notes from the engine, not the empty minimal-fallback profile.
  assert.deepEqual(result.notes, ["bergamot", "ambroxan", "pepper"]);
  assert.deepEqual(result.pyramid, { top: ["bergamot"], heart: ["pepper"], base: ["ambroxan"] });
  assert.equal(result.family, "Fresh Spicy");
  assert.equal(calls.vectorize, 1);
});

test("serverSideResolve miss: falls through to minimal pending profile when allowed", async () => {
  let engineCalled = 0;
  const { deps, calls } = makeDeps({
    resolveProfileViaEngine: async () => {
      engineCalled++;
      return null; // engine could not resolve real notes
    },
  });

  const result = await buildProfileWithDeps(deps, "Bleu Electrique", "Yves Saint Laurent", undefined, {
    allowMinimalFallback: true,
    serverSideResolve: true,
  });
  ok(result);

  assert.equal(engineCalled, 1, "engine resolve must have been attempted");
  // Graceful pending behavior is preserved on a miss.
  assert.deepEqual(result.notes, []);
  assert.equal(result.product.name, "Bleu Electrique");
  assert.equal(calls.vectorize, 1);
});

test("serverSideResolve is not consulted without the opt-in flag", async () => {
  let engineCalled = 0;
  const { deps } = makeDeps({
    resolveProfileViaEngine: async () => {
      engineCalled++;
      return { notes: ["should-not-be-used"] };
    },
  });

  const result = await buildProfileWithDeps(deps, "Nonexistent Fragrance", "No Brand");
  err(result);
  assert.equal(engineCalled, 0, "engine resolve must stay off unless serverSideResolve is set");
  assert.match(result.error, /Could not identify/);
});

test("serverSideResolve is skipped when a dataset match already exists (no wasted engine call)", async () => {
  let engineCalled = 0;
  const { deps } = makeDeps({
    findDatasetFragrance: () => ({
      name: "Sauvage",
      brand: "Dior",
      family: "Fresh Spicy",
      notes: ["bergamot"],
      description: "",
    }),
    resolveProfileViaEngine: async () => {
      engineCalled++;
      return { notes: ["engine"] };
    },
  });

  const result = await buildProfileWithDeps(deps, "Sauvage", "Dior", undefined, {
    serverSideResolve: true,
  });
  ok(result);
  assert.equal(engineCalled, 0, "local dataset match must short-circuit the engine resolve");
  assert.deepEqual(result.notes, ["bergamot"]);
});

test("serverSideResolve rejection is reported and remains non-fatal (falls through to pending)", async () => {
  const { deps, calls } = makeDeps({
    resolveProfileViaEngine: async () => {
      throw new Error("engine unreachable");
    },
  });

  const result = await buildProfileWithDeps(deps, "Bleu Electrique", "Yves Saint Laurent", undefined, {
    allowMinimalFallback: true,
    serverSideResolve: true,
  });
  ok(result);

  assert.deepEqual(result.notes, []);
  assert.equal(calls.reportNonFatalError.length, 1);
  assert.equal(calls.reportNonFatalError[0].area, "scentEngine.serverSideResolve");
  assert.deepEqual(calls.reportNonFatalError[0].context, {
    brand: "Yves Saint Laurent",
    name: "Bleu Electrique",
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

// --- 5A: free crawled URL is preferred over a paid Serper search -------------

test("5A: a usable crawled image URL is processed before any paid Serper search", async () => {
  const { deps, calls } = makeDeps({
    // No cached image, so resolution must choose between crawled URL and Serper.
    resolveCachedFragranceImage: async () => null,
    resolveProcessedFragranceImage: async (opts) => {
      const o = opts as { sourceUrl?: string; searchQuery?: string };
      // The crawled (sourceUrl) path succeeds; the Serper (searchQuery) path
      // would also succeed but must never be reached.
      if (o.sourceUrl) return { imageUrl: "https://cdn.example.com/from-crawl.webp" };
      return { imageUrl: "https://cdn.example.com/from-serper.webp" };
    },
  });

  const result = await buildProfileWithDeps(deps, "Sauvage", "Dior", {
    notes: ["bergamot", "pepper"],
    family: "Fresh Spicy",
    description: "fresh spicy",
    imageUrl: "https://crawled.example/bottle.jpg",
  });
  ok(result);

  // Exactly one resolve call, and it was the free crawled URL — never Serper.
  assert.equal(calls.resolveProcessedFragranceImage.length, 1);
  assert.equal(calls.resolveProcessedFragranceImage[0].sourceUrl, "https://crawled.example/bottle.jpg");
  assert.equal(
    calls.resolveProcessedFragranceImage.some((o) => typeof o.searchQuery === "string"),
    false,
    "paid Serper search must not run when the crawled URL resolves",
  );
  assert.equal(result.imageUrl, "https://cdn.example.com/from-crawl.webp");
});

// --- new-add regression: forwarded engine image heals a deferred add --------
// Reproduces the "no image on new fragrance adds" fix. The capture/add flow
// runs buildProfile in `imageResolution: "deferred"` and now forwards the
// engine's already-resolved image as `fallback.imageUrl`. This proves the
// background pass resolves that image via the FREE crawled-URL path (never a
// paid Serper search) and pushes it into the user's wardrobe rows via BE-2, so
// a fresh add self-heals even when a Serper image search would have found
// nothing.
test("deferred add with a forwarded engine image: background uses the free crawled URL (not Serper) and BE-2 backfills user rows", async () => {
  const backfillCalls: Array<{ brand: string; name: string; image: { imageUrl?: string } }> = [];
  const { deps, calls } = makeDeps({
    findDatasetFragrance: () => ({
      name: "Sauvage",
      brand: "Dior",
      family: "Fresh Spicy",
      notes: ["bergamot"],
      description: "",
    }),
    // Fresh fragrance: nothing in the image cache yet for the synchronous pass.
    resolveCachedFragranceImage: async () => null,
    resolveProcessedFragranceImage: async (opts) => {
      const o = opts as { sourceUrl?: string; searchQuery?: string };
      // Crawled (sourceUrl) path succeeds; the Serper (searchQuery) path would
      // also succeed but must never be reached.
      if (o.sourceUrl) {
        return {
          imageUrl: "https://cdn.example.com/from-crawl.webp",
          storagePath: "images/processed/from-crawl.webp",
          imageHash: "crawl",
          storageProvider: "supabase",
          sourceProvider: "manual",
        };
      }
      return { imageUrl: "https://cdn.example.com/from-serper.webp" };
    },
  });
  // BE-2 backfill is an optional dep not wrapped by makeDeps — attach directly.
  deps.backfillUserFragranceImages = async (brand, name, image) => {
    backfillCalls.push({ brand, name, image });
  };

  const result = await buildProfileWithDeps(
    deps,
    "Sauvage",
    "Dior",
    { imageUrl: "https://crawled.example/bottle.jpg" },
    { imageResolution: "deferred" },
  );
  ok(result);

  // Deferred-by-design: the synchronous add response is imageless and only the
  // image cache was consulted up front (no synchronous Serper spend).
  assert.equal(result.imageUrl, undefined);
  assert.deepEqual(calls.resolveCachedFragranceImage, [["Dior", "Sauvage"]]);

  // Let the fire-and-forget background pass settle.
  await new Promise((resolve) => setTimeout(resolve, 0));

  // Background pass resolved the FREE crawled URL — the paid Serper search
  // (searchQuery) must never run when the forwarded engine image resolves.
  assert.equal(calls.resolveProcessedFragranceImage.length, 1);
  assert.equal(
    calls.resolveProcessedFragranceImage[0].sourceUrl,
    "https://crawled.example/bottle.jpg",
  );
  assert.equal(
    calls.resolveProcessedFragranceImage.some((o) => typeof o.searchQuery === "string"),
    false,
    "paid Serper search must not run when the forwarded engine image resolves",
  );

  // BE-2: the resolved image was pushed into the user's wardrobe rows so the
  // tile self-heals, and the catalog was re-saved with the image.
  assert.equal(backfillCalls.length, 1);
  assert.equal(backfillCalls[0].brand, "Dior");
  assert.equal(backfillCalls[0].name, "Sauvage");
  assert.equal(backfillCalls[0].image.imageUrl, "https://cdn.example.com/from-crawl.webp");
  assert.equal(calls.saveCatalogEntry.length, 2);
  assert.equal(
    calls.saveCatalogEntry[1].profile.imageUrl,
    "https://cdn.example.com/from-crawl.webp",
  );
});

test("5A: falls back to the paid Serper search when the crawled URL fails to resolve", async () => {
  const { deps, calls } = makeDeps({
    resolveCachedFragranceImage: async () => null,
    resolveProcessedFragranceImage: async (opts) => {
      const o = opts as { sourceUrl?: string; searchQuery?: string };
      if (o.sourceUrl) return null; // crawled URL did not yield a usable image
      return { imageUrl: "https://cdn.example.com/from-serper.webp" };
    },
  });

  const result = await buildProfileWithDeps(deps, "Sauvage", "Dior", {
    notes: ["bergamot", "pepper"],
    family: "Fresh Spicy",
    description: "fresh spicy",
    imageUrl: "https://crawled.example/bottle.jpg",
  });
  ok(result);

  // Crawled URL tried first, then the Serper search as the documented fallback.
  assert.equal(calls.resolveProcessedFragranceImage.length, 2);
  assert.equal(calls.resolveProcessedFragranceImage[0].sourceUrl, "https://crawled.example/bottle.jpg");
  assert.equal(
    calls.resolveProcessedFragranceImage[1].searchQuery,
    "Dior Sauvage single fragrance bottle no box HQ product photo studio no plants",
  );
  assert.equal(result.imageUrl, "https://cdn.example.com/from-serper.webp");
});
