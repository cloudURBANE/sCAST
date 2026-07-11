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
    // A2-GAP1/3: optional coverage assessment. Off by default so legacy tests
    // see the unflagged profile; opted into by the coverage tests below.
    assessVectorCoverage: over.assessVectorCoverage,
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

test("image pipeline: only the scored search-query (Serper) path runs; an empty result stays imageless (the crawled url is never processed)", async () => {
  const { deps, calls } = makeDeps({
    findDatasetFragrance: () => ({
      name: "Sauvage",
      brand: "Dior",
      family: "Fresh Spicy",
      notes: ["bergamot"],
      description: "",
    }),
    // The scored Serper search comes up empty. The forwarded engine image
    // (the crawled Fragrantica og:image) is owner-rejected for display and
    // must not be processed as a fallback — the profile stays imageless.
    resolveProcessedFragranceImage: async () => null,
  });

  const result = await buildProfileWithDeps(deps, "Sauvage", "Dior", {
    imageUrl: "https://upstream.example.com/raw.jpg",
  });
  ok(result);

  assert.equal(calls.resolveProcessedFragranceImage.length, 1);
  // Only call: paid search-query (Serper) — the optimal, scored image.
  assert.equal(calls.resolveProcessedFragranceImage[0].searchQuery, "Dior Sauvage");
  assert.equal(calls.resolveProcessedFragranceImage[0].sourceUrl, undefined);

  assert.equal(result.imageUrl, undefined);
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

// --- A2-GAP1/3: vector provenance on the profile -----------------------------

test("assessVectorCoverage dep: match_ratio + vector_confidence are attached to the profile", async () => {
  const { deps } = makeDeps({
    findDatasetFragrance: () => ({
      name: "Sauvage",
      brand: "Dior",
      family: "Fresh Spicy",
      notes: ["bergamot", "pepper", "ambroxan", "mystery"],
      description: "",
    }),
    assessVectorCoverage: () => ({ matched_notes: 3, total_notes: 4, match_ratio: 0.75 }),
  });

  const result = await buildProfileWithDeps(deps, "Sauvage", "Dior");
  ok(result);

  assert.equal(result.match_ratio, 0.75);
  assert.equal(result.vector_confidence, "ok");
  assert.equal(result.metrics_source, "formula");
});

test("no assessVectorCoverage dep: profile omits provenance (legacy back-compat)", async () => {
  const { deps } = makeDeps({
    findDatasetFragrance: () => ({
      name: "Sauvage",
      brand: "Dior",
      family: "Fresh Spicy",
      notes: ["bergamot"],
      description: "",
    }),
  });

  const result = await buildProfileWithDeps(deps, "Sauvage", "Dior");
  ok(result);

  assert.equal(result.match_ratio, undefined);
  assert.equal(result.vector_confidence, undefined);
});

// --- A2-GAP5: prefer engine-supplied metrics when coverage is complete --------

test("engine metrics: complete derived_metrics override the keyword formula", async () => {
  const { deps } = makeDeps({
    calculatePerformance: () => ({ sillage: 3, longevity: 4 }), // formula would say this
    findDatasetFragrance: () => undefined,
  });

  const result = await buildProfileWithDeps(
    deps,
    "Sauvage",
    "Dior",
    {
      notes: ["bergamot", "pepper", "ambroxan"],
      family: "Fresh Spicy",
      metrics: { sillage: 8, longevity: 9, projection: 7 },
      metricsComplete: true,
    },
    { preferEngineData: true },
  );
  ok(result);

  assert.equal(result.performance.sillage, 8);
  assert.equal(result.performance.longevity, 9);
  assert.equal(result.performance.projection, 7);
  assert.equal(result.metrics_source, "engine");
});

test("engine metrics: incomplete coverage falls back to the keyword formula", async () => {
  const { deps } = makeDeps({
    calculatePerformance: () => ({ sillage: 3, longevity: 4 }),
    findDatasetFragrance: () => undefined,
  });

  const result = await buildProfileWithDeps(
    deps,
    "Sauvage",
    "Dior",
    {
      notes: ["bergamot", "pepper", "ambroxan"],
      family: "Fresh Spicy",
      metrics: { sillage: 8, longevity: 9 },
      metricsComplete: false, // source_coverage was NOT complete
    },
    { preferEngineData: true },
  );
  ok(result);

  assert.equal(result.performance.sillage, 3);
  assert.equal(result.performance.longevity, 4);
  assert.equal(result.metrics_source, "formula");
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
    "Dior Sauvage",
  );
});

// --- 5A (inverted): the scored Serper search outranks the crawled fallback ---
// The crawled Fragrantica og:image is the safety net, never the default:
// letting it win by default made it EVERY new save's tile (owner-rejected).

test("5A: the scored Serper winner is used even when a crawled image URL was forwarded", async () => {
  const { deps, calls } = makeDeps({
    // No cached image, so resolution must choose between Serper and crawled URL.
    resolveCachedFragranceImage: async () => null,
    resolveProcessedFragranceImage: async (opts) => {
      const o = opts as { sourceUrl?: string; searchQuery?: string };
      // The Serper (searchQuery) path succeeds; the crawled (sourceUrl) path
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

  // Exactly one resolve call, and it was the scored Serper search — the crawled
  // fallback must not run when Serper finds the optimal image.
  assert.equal(calls.resolveProcessedFragranceImage.length, 1);
  assert.equal(calls.resolveProcessedFragranceImage[0].searchQuery, "Dior Sauvage");
  assert.equal(
    calls.resolveProcessedFragranceImage.some((o) => typeof o.sourceUrl === "string"),
    false,
    "crawled fallback must not run when the Serper search resolves",
  );
  assert.equal(result.imageUrl, "https://cdn.example.com/from-serper.webp");
});

// --- deferred add with a forwarded engine image ------------------------------
// The capture/add flow runs buildProfile in `imageResolution: "deferred"` and
// forwards the engine's already-resolved image as `fallback.imageUrl`. That
// crawled Fragrantica og:image is owner-rejected for display: the background
// retry pass runs the scored Serper search ONLY, and when it stays empty the
// add stays honestly imageless — nothing is saved or backfilled, and the
// crawled url is never processed.
test("deferred add with a forwarded engine image: background retries are Serper-only and the crawled url is never processed", async () => {
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
      if (o.sourceUrl) {
        throw new Error("the crawled url must never be processed");
      }
      // The Serper (searchQuery) search finds nothing.
      return null;
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

  // Background pass: the scored Serper search only — no crawled processing.
  assert.equal(calls.resolveProcessedFragranceImage.length, 1);
  assert.equal(calls.resolveProcessedFragranceImage[0].searchQuery, "Dior Sauvage");
  assert.equal(
    calls.resolveProcessedFragranceImage.some((o) => typeof o.sourceUrl === "string"),
    false,
    "the crawled fallback must never be processed",
  );

  // Nothing usable resolved, so nothing was pushed to rows or re-saved.
  assert.equal(backfillCalls.length, 0);
  assert.equal(calls.saveCatalogEntry.length, 1);
  assert.equal(calls.saveCatalogEntry[0].profile.imageUrl, undefined);
});

// --- cached crawled fallback: never displayed, Serper upgrade still runs -----
// A deferred save that finds the crawled Fragrantica fallback in the cache must
// NOT display it (owner-rejected); the profile stays imageless and the
// background pass runs the scored Serper search so the real image lands in the
// catalog and (via BE-2) the user's rows. Legacy copies stamped "manual" with a
// Fragrantica source URL count as crawled too.
test("deferred add with a cached crawled image: profile stays imageless and the Serper pass re-saves the catalog", async () => {
  const backfillCalls: Array<{ brand: string; name: string; image: { imageUrl?: string } }> = [];
  const { deps, calls } = makeDeps({
    findDatasetFragrance: () => ({
      name: "Sauvage",
      brand: "Dior",
      family: "Fresh Spicy",
      notes: ["bergamot"],
      description: "",
    }),
    // The cache already holds the crawled fallback (legacy shape: stamped
    // "manual" but pointing at a Fragrantica image URL).
    resolveCachedFragranceImage: async () => ({
      imageUrl: "https://cdn.example.com/from-crawl.webp",
      storagePath: "images/processed/manual/dior-sauvage/abc-v5.webp",
      imageHash: "crawl",
      storageProvider: "supabase",
      sourceProvider: "manual",
      sourceUrl: "https://fimgs.net/mdimg/perfume/375x500.31861.jpg",
    }),
    resolveProcessedFragranceImage: async (opts) => {
      const o = opts as { sourceUrl?: string; searchQuery?: string };
      if (o.sourceUrl) throw new Error("the crawled url must never be re-resolved");
      return {
        imageUrl: "https://cdn.example.com/from-serper.webp",
        storagePath: "images/processed/serper/dior-sauvage/def-v5.webp",
        imageHash: "serper",
        storageProvider: "supabase",
        sourceProvider: "serper",
      };
    },
  });
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

  // The cached crawled fallback is NOT displayable — the add lands imageless.
  assert.equal(result.imageUrl, undefined);

  // Let the fire-and-forget background upgrade settle.
  await new Promise((resolve) => setTimeout(resolve, 0));

  // Serper-only pass ran; the catalog and the user's rows got the optimal image.
  assert.equal(calls.resolveProcessedFragranceImage.length, 1);
  assert.equal(calls.resolveProcessedFragranceImage[0].searchQuery, "Dior Sauvage");
  assert.equal(calls.saveCatalogEntry.length, 2);
  assert.equal(
    calls.saveCatalogEntry[1].profile.imageUrl,
    "https://cdn.example.com/from-serper.webp",
  );
  assert.equal(calls.saveCatalogEntry[1].profile.sourceProvider, "serper");
  assert.equal(backfillCalls.length, 1);
  assert.equal(backfillCalls[0].image.imageUrl, "https://cdn.example.com/from-serper.webp");
});

test("5A: a Serper failure never falls back to the crawled URL — the profile stays imageless and the error is reported", async () => {
  const { deps, calls } = makeDeps({
    resolveCachedFragranceImage: async () => null,
    resolveProcessedFragranceImage: async (opts) => {
      const o = opts as { sourceUrl?: string; searchQuery?: string };
      if (o.searchQuery) throw new Error("Serper down"); // hard failure, not empty
      return { imageUrl: "https://cdn.example.com/from-crawl.webp" };
    },
  });

  const result = await buildProfileWithDeps(deps, "Sauvage", "Dior", {
    notes: ["bergamot", "pepper"],
    family: "Fresh Spicy",
    description: "fresh spicy",
    imageUrl: "https://crawled.example/bottle.jpg",
  });
  ok(result);

  // Serper tried; the crawled URL was NOT processed as a fallback.
  assert.equal(calls.resolveProcessedFragranceImage.length, 1);
  assert.equal(calls.resolveProcessedFragranceImage[0].searchQuery, "Dior Sauvage");
  assert.equal(result.imageUrl, undefined);
  // The Serper failure was reported, not swallowed silently.
  assert.equal(calls.reportNonFatalError.length, 1);
  assert.equal(calls.reportNonFatalError[0].area, "scentEngine.imageResolution");
});
