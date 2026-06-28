import { Router } from "express";
import { getWeather } from "../services/weatherService";
import { buildProfile, searchFragrances } from "../services/scentEngine";
import { deepScrapeFragrance } from "../services/fallbackIntelligence";
import { searchCatalog, getCatalogEntry, saveCatalogEntry, flattenProfile } from "../services/catalogService";
import {
  isImageSolverId,
  resolveRefreshSerperInput,
  solverSkipsBgRemoval,
  solverWantsPoofProductType,
  type ImageSolverId,
} from "../services/imageSolvers";
import { logger } from "../lib/logger";
import { rateLimitMiddleware } from "../lib/rateLimit";
import { resolveConcentrationFast } from "../services/concentrationResolver";
import { resolveProcessedFragranceImage } from "../services/imagePipeline";
import { reimagineBottleImage, isSupportedReimagineModel, ReimagineBusyError } from "../services/reimagineService";
import { imageReferenceDiagnostic, usableImageUrlForResponse } from "../services/imageReference";
import { resolveSharedImageReference } from "../services/imageHydration";
import { parseIncomingImageUrl } from "../services/incomingImageUrl";
import {
  RefreshAttemptCounter,
  decideRefreshThrottle,
  refreshAttemptKey,
} from "../services/refreshImageThrottle";
import {
  asciiForImageSearch,
  resolveFragranceIdentity,
  resolveFragranceQuery,
  shouldSearchExternalFragranceSources,
} from "../services/fragranceNameResolver";
import type { Concentration } from "../services/scentParser";
import { validateScentProfileBody, validateSearchScentBody } from "./scentAddValidation";

const router = Router();

// Server-owned refresh-image attempt counter. Replaces the old client-supplied
// `refreshCount`, which a client could reset to bypass the regeneration caps.
const refreshAttemptCounter = new RefreshAttemptCounter();

type ConcentrationHint = "edt" | "edp" | "parfum" | "extrait" | "elixir";

const CONCENTRATION_HINT_SET = new Set<ConcentrationHint>([
  "edt",
  "edp",
  "parfum",
  "extrait",
  "elixir",
]);

function concentrationToQueryText(hint?: ConcentrationHint): string {
  if (hint === "edt") return "EDT";
  if (hint === "edp") return "EDP";
  if (hint === "parfum") return "Parfum";
  if (hint === "extrait") return "Extrait";
  if (hint === "elixir") return "Elixir";
  return "";
}

function normalizeConcentrationHint(raw: unknown): ConcentrationHint | undefined {
  if (typeof raw !== "string") return undefined;
  const lower = raw.toLowerCase();
  return CONCENTRATION_HINT_SET.has(lower as ConcentrationHint)
    ? (lower as ConcentrationHint)
    : undefined;
}

function concentrationHintToOverride(hint: ConcentrationHint): Concentration {
  switch (hint) {
    case "edt":
      return "Eau de Toilette";
    case "edp":
      return "Eau de Parfum";
    case "parfum":
      return "Parfum";
    case "extrait":
      return "Extrait";
    case "elixir":
      return "Parfum";
    default:
      return "Unknown";
  }
}

function concentrationOverrideFromInput(input: string, hint?: ConcentrationHint): Concentration | undefined {
  if (hint) return concentrationHintToOverride(hint);
  const fast = resolveConcentrationFast(input, "", "");
  return fast && fast.confidence >= 95 ? fast.concentration : undefined;
}

type RefreshImageCatalogMetadata = {
  imageUrl: string;
  storagePath?: string;
  imageHash?: string | null;
  storageProvider?: string;
  sourceProvider?: string;
};

async function upsertRefreshImageCatalog(
  brand: string,
  name: string,
  image: RefreshImageCatalogMetadata,
): Promise<void> {
  let baseProfile = await getCatalogEntry(brand, name);
  if (!baseProfile) {
    const built = await buildProfile(name, brand, undefined, {
      allowCatalogFuzzy: false,
      imageResolution: "skip",
    });
    if ("product" in built) baseProfile = built;
  }
  if (baseProfile) {
    await saveCatalogEntry(brand, name, {
      ...baseProfile,
      imageUrl: image.imageUrl,
      storagePath: image.storagePath,
      imageHash: image.imageHash ?? null,
      storageProvider: image.storageProvider,
      sourceProvider: image.sourceProvider,
    });
  }
}

router.get("/weather", async (req, res) => {
  const { lat, lon } = req.query as { lat?: string; lon?: string };
  const data = await getWeather({ lat, lon });
  // Live readings are server-cached ~5 min; let the browser/CDN reuse them too,
  // with stale-while-revalidate so a poll never blocks on a cold upstream call.
  if (data.isLive) {
    res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=600");
  } else {
    res.setHeader("Cache-Control", "no-store");
  }
  res.json(data);
});

router.post("/scent-profile", async (req, res) => {
  const {
    name,
    brand,
    imageUrl,
    notes,
    family,
    description,
    pyramid,
    perfumer,
    preferEngineData,
    concentrationHint,
  } = req.body as {
    name?: string;
    brand?: string;
    imageUrl?: string;
    notes?: string[];
    family?: string;
    description?: string;
    pyramid?: { top: string[]; heart: string[]; base: string[] };
    perfumer?: string;
    preferEngineData?: boolean;
    concentrationHint?: string;
  };

  if (!name) {
    res.status(400).json({ error: "Fragrance name is required" });
    return;
  }

  // WS-11: validate the rest of the body shape before buildProfile so a
  // malformed payload (e.g. notes as a string) gets a clear 400 instead of an
  // opaque 500 from parseFragrance downstream.
  const validation = validateScentProfileBody(req.body);
  if (!validation.ok) {
    res.status(400).json({ error: validation.error });
    return;
  }

  const normalizedHint = normalizeConcentrationHint(concentrationHint);
  const concentrationOverride = normalizedHint ? concentrationHintToOverride(normalizedHint) : undefined;

  try {
    const result = await buildProfile(
      name,
      brand || "",
      {
        notes,
        family,
        description,
        imageUrl,
        pyramid,
        perfumer,
      },
      {
        preferEngineData: preferEngineData === true,
        imageResolution: "deferred",
        // Capture/add flow: a real selected fragrance that is not in the curated
        // dataset and has not been scraped yet must still be addable as a pending
        // card (background enrichment fills the pyramid), rather than hard-failing
        // with "Could not identify this fragrance".
        allowMinimalFallback: true,
        // Hybrid resolve: before landing a pending card, try a synchronous
        // server-side resolve through the engine (Decodo egress) so the freshly
        // added fragrance renders real notes/family immediately when reachable.
        serverSideResolve: true,
        ...(concentrationOverride ? { concentrationOverride } : {}),
      },
    );
    // Always return a flat shape ({ name, brand, ... } alongside `product`) so the
    // client can rely on top-level keys when it persists this object verbatim.
    if (!("product" in result)) { res.json(result); return; }
    res.json(flattenProfile(result));
  } catch (err: any) {
    logger.error({ err: err?.message }, "scent-profile build failed");
    res.status(502).json({ error: "Could not build this fragrance profile right now. Please try again." });
  }
});

// Cache-only shared-image lookup. Unlike POST /refresh-image this NEVER runs a
// fresh Serper search — it only reads image state that already exists (the
// processed image_cache, then the global catalog) via resolveSharedImageReference.
// Guests poll this after adding an imageless fragrance so the tile can fill in
// from the shared catalog without a per-add image search (cost) and without a
// server-side wardrobe row (guests have none). Returns { imageUrl: null } when
// nothing is cached yet, so the bounded client poll simply tries again or stops.
router.get("/shared-image", async (req, res) => {
  const brand = typeof req.query.brand === "string" ? req.query.brand.trim() : "";
  const name = typeof req.query.name === "string" ? req.query.name.trim() : "";
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  const ref = await resolveSharedImageReference(brand, name);
  res.json({
    imageUrl: ref?.imageUrl ?? null,
    storagePath: ref?.storagePath ?? null,
    sourceProvider: ref?.sourceProvider ?? null,
  });
});

router.post("/search-scent", async (req, res) => {
  const { query, concentrationHint } = req.body as { query?: string; concentrationHint?: ConcentrationHint };
  if (!query) {
    res.status(400).json({ error: "Query is required" });
    return;
  }
  // WS-11: validate the rest of the body shape (concentrationHint type).
  const validation = validateSearchScentBody(req.body);
  if (!validation.ok) {
    res.status(400).json({ error: validation.error });
    return;
  }
  try {
  const normalizedHint = normalizeConcentrationHint(concentrationHint);
  const concentrationOverride = concentrationOverrideFromInput(query, normalizedHint);
  const resolvedQuery = resolveFragranceQuery(query);
  if (resolvedQuery?.corrected) {
    logger.info(
      {
        inputPreview: query.slice(0, 160),
        brand: resolvedQuery.brand,
        name: resolvedQuery.name,
        confidence: resolvedQuery.confidence,
      },
      "search-scent canonicalized fragrance query",
    );

    const profile = await buildProfile(resolvedQuery.name, resolvedQuery.brand, undefined, {
      allowCatalogFuzzy: false,
      imageResolution: "deferred",
      ...(concentrationOverride ? { concentrationOverride } : {}),
    });
    if ("product" in profile) {
      res.json(flattenProfile(profile));
      return;
    }
  }

  const queryWithHint = [query, concentrationToQueryText(normalizedHint)].filter(Boolean).join(" ").trim();

  // Check global catalog before hitting local dataset or scraper
  const catalogHit = await searchCatalog(queryWithHint);
  if (catalogHit) {
    const catalogImageUrl = await usableImageUrlForResponse(catalogHit.imageUrl);
    if (catalogImageUrl && !concentrationOverride) {
      res.json(flattenProfile({ ...catalogHit, imageUrl: catalogImageUrl }));
      return;
    }
    logger.info(
      {
        queryPreview: queryWithHint.slice(0, 160),
        brand: catalogHit.product.brand,
        name: catalogHit.product.name,
        image: await imageReferenceDiagnostic(catalogHit.imageUrl),
      },
      "search-scent catalog hit has no usable image",
    );

    const completed = await buildProfile(
      catalogHit.product.name,
      catalogHit.product.brand,
      {
        notes: catalogHit.notes,
        family: catalogHit.family,
        description: catalogHit.description,
        imageUrl: catalogImageUrl ?? undefined,
        pyramid: catalogHit.pyramid,
        perfumer: catalogHit.product.perfumer,
      },
      {
        allowCatalogFuzzy: false,
        imageResolution: "deferred",
        ...(concentrationOverride ? { concentrationOverride } : {}),
      },
    );

    if ("product" in completed) {
      res.json(flattenProfile(completed));
      return;
    }

    res.json(flattenProfile(catalogHit));
    return;
  }

  const local = searchFragrances(queryWithHint);
  if (local.length > 0) {
    const first = local[0];
    const profile = await buildProfile(first.name, first.brand, {
      notes: first.notes,
      family: first.family,
      description: first.description,
      pyramid: first.pyramid,
      perfumer: first.perfumer,
    }, {
      ...(concentrationOverride ? { concentrationOverride } : {}),
      imageResolution: "deferred",
    });
    res.json("product" in profile ? flattenProfile(profile) : profile);
    return;
  }

  if (!shouldSearchExternalFragranceSources(queryWithHint)) {
    res.status(422).json({
      error:
        "Search only supports fragrance, perfume, or cologne names. Try the brand plus fragrance name, or add 'perfume' for a newer scent.",
    });
    return;
  }

  const scraped = await deepScrapeFragrance(queryWithHint);
  if (!scraped) {
    // No real fragrance data found. Returning a fabricated word-split profile
    // here is what produced bogus "<name> by <brand>" results and poisoned the
    // catalog, so decline cleanly instead of inventing + persisting one.
    res.status(422).json({
      error:
        "Search only supports fragrance, perfume, or cologne names. Try the brand plus fragrance name, or add 'perfume' for a newer scent.",
    });
    return;
  }
  const profile = await buildProfile(scraped.name, scraped.brand, {
    notes: scraped.notes,
    family: scraped.family,
    description: scraped.description,
    pyramid: scraped.pyramid,
    perfumer: scraped.perfumer,
  }, {
    ...(concentrationOverride ? { concentrationOverride } : {}),
    imageResolution: "deferred",
  });
  res.json("product" in profile ? flattenProfile(profile) : profile);
  } catch (err: any) {
    logger.error({ err: err?.message }, "search-scent failed");
    res.status(502).json({ error: "Search is temporarily unavailable. Please try again." });
  }
});

router.post("/refresh-image", async (req, res) => {
  const body = req.body as {
    name?: string;
    brand?: string;
    concentrationHint?: ConcentrationHint;
    solverId?: unknown;
    refreshCount?: unknown;
    skipBg?: unknown;
    poofOptions?: { type?: unknown };
    stripBgOnly?: unknown;
    imageUrl?: unknown;
    fixtureId?: unknown;
    traceId?: unknown;
  };
  const { name, brand, concentrationHint } = body;
  if (!name || !brand) {
    res.status(400).json({ error: "name and brand are required" });
    return;
  }
  const resolvedIdentity = resolveFragranceIdentity(brand, name);
  const imageBrand = resolvedIdentity.brand;
  const imageName = resolvedIdentity.name;
  if (resolvedIdentity.corrected) {
    logger.info(
      {
        inputBrand: brand.slice(0, 80),
        inputName: name.slice(0, 120),
        brand: imageBrand,
        name: imageName,
        confidence: resolvedIdentity.confidence,
      },
      "refresh-image canonicalized fragrance identity",
    );
  }

  const stripBgOnly = body.stripBgOnly === true;
  const sourceForStrip = stripBgOnly ? parseIncomingImageUrl(body.imageUrl) : null;
  if (stripBgOnly && !sourceForStrip) {
    res.status(400).json({ error: "stripBgOnly requires a valid imageUrl (https URL or small data:image preview)" });
    return;
  }

  const rc = body.refreshCount;
  const refreshCount =
    typeof rc === "number" && Number.isFinite(rc) && rc >= 0 && rc <= 10_000 ? Math.floor(rc) : undefined;
  const fixtureId =
    typeof body.fixtureId === "string" && body.fixtureId.trim().length > 0
      ? body.fixtureId.trim().slice(0, 80)
      : undefined;
  const traceId =
    typeof body.traceId === "string" && body.traceId.trim().length > 0
      ? body.traceId.trim().slice(0, 80)
      : undefined;

  try {
    if (stripBgOnly && sourceForStrip) {
      const skipBgStrip = typeof body.skipBg === "boolean" ? body.skipBg : false;
      // Default for stripBgOnly: do NOT force Poof `product` mode. Product mode
      // tends to preserve the retail/product white rectangle behind the bottle.
      // Only opt in when the caller passes `poofOptions.type === "product"`.
      let poofT: "auto" | "product" | undefined;
      const ptStrip = body.poofOptions?.type;
      if (ptStrip === "product" || ptStrip === "auto") poofT = ptStrip;
      const stripRemoveOpts = poofT === "product" ? ({ poofType: "product" } as const) : undefined;

      logger.info(
        {
          stripBgOnly: true,
          refreshCount: refreshCount ?? null,
          skipBg: skipBgStrip,
          poofType: poofT ?? null,
          sourceKind: sourceForStrip.startsWith("data:") ? "data" : "url",
          fixtureId: fixtureId ?? null,
          traceId: traceId ?? null,
        },
        "refresh-image",
      );

      const processed = await resolveProcessedFragranceImage({
        brand: imageBrand,
        name: imageName,
        sourceUrl: sourceForStrip,
        sourceProvider: "manual",
        allowLookupCache: false,
        removeBackground: !skipBgStrip,
        poofOptions: stripRemoveOpts,
        fixtureId,
        traceId,
      });

      if (!processed) {
        res.status(422).json({ error: "Could not process this image source" });
        return;
      }

      const finalImageUrl = processed.imageUrl;
      if (skipBgStrip || processed.backgroundRemoved) {
        await upsertRefreshImageCatalog(imageBrand, imageName, {
          imageUrl: finalImageUrl,
          storagePath: processed.storagePath,
          imageHash: processed.imageHash,
          storageProvider: processed.storageProvider,
          sourceProvider: processed.sourceProvider,
        });
      }
      res.json({
        imageUrl: finalImageUrl,
        storagePath: processed.storagePath,
        imageHash: processed.imageHash,
        sourceProvider: processed.sourceProvider,
        cached: processed.cached,
        backgroundRemoved: processed.backgroundRemoved,
        removeBgStatus: processed.removeBgStatus ?? (processed.backgroundRemoved ? "removed" : "fallback"),
        removeBgReason: processed.removeBgReason ?? (processed.backgroundRemoved ? "removed" : "local_trim_fallback"),
        imagePipelineTrace: processed.imagePipelineTrace,
      });
      return;
    }

    const rawSolver = body.solverId;
    let solverId: ImageSolverId | undefined;
    if (rawSolver === undefined || rawSolver === null || rawSolver === "") {
      solverId = undefined;
    } else if (isImageSolverId(rawSolver)) {
      solverId = rawSolver;
    } else {
      res.status(400).json({ error: "Invalid solverId" });
      return;
    }

    let skipBg = solverSkipsBgRemoval(solverId);
    if (typeof body.skipBg === "boolean") skipBg = body.skipBg;

    // Abuse caps are enforced from SERVER-owned state, not the client's
    // `refreshCount` (which a client can reset to drive unbounded paid
    // regeneration). Count this attempt per client + fragrance; `priorAttempts`
    // is everything before it, matching the thresholds the old gate used.
    const priorAttempts =
      refreshAttemptCounter.record(refreshAttemptKey(req.ip || "unknown", imageBrand, imageName)) - 1;
    const throttle = decideRefreshThrottle(priorAttempts, Boolean(solverId));
    if (!throttle.allowed) {
      res.status(429).json({
        error:
          throttle.reason === "needs-solver"
            ? "Automatic image regeneration paused. Choose what looks wrong and try with a hint."
            : "Too many image regeneration attempts for this session.",
      });
      return;
    }

    // Default for normal refresh: do NOT force Poof `product` mode. Product mode
    // tends to preserve the retail/product white rectangle behind the bottle and
    // return HTTP 200, which the pipeline then mistakes for a clean removal.
    // Product mode is still applied when:
    //   - the solver explicitly requests it (transparent_glass, hand_interference)
    //   - the caller passes `poofOptions.type === "product"` explicitly
    //   - the stripBgOnly branch (handled separately above)
    let poofType: "auto" | "product" | undefined = solverWantsPoofProductType(solverId);
    const pt = body.poofOptions?.type;
    if (pt === "product" || pt === "auto") poofType = pt;

    const removeBgOpts = poofType === "product" ? ({ poofType: "product" } as const) : undefined;

    // Normalize to ASCII so accented chars (é, ü, etc.) don't break URL parsing
    const asciiName = asciiForImageSearch(imageName);
    const asciiBrand = asciiForImageSearch(imageBrand);
    const normalizedHint = normalizeConcentrationHint(concentrationHint);
    const concentrationText = concentrationToQueryText(normalizedHint);

    const { query: serperQuery, refine } = resolveRefreshSerperInput({
      asciiBrand,
      asciiName,
      concentrationText,
      solverId,
    });

    logger.info(
      {
        solverId: solverId ?? null,
        refreshCount: refreshCount ?? null,
        serverAttempts: priorAttempts,
        refine,
        skipBg,
        poofType: poofType ?? null,
        fixtureId: fixtureId ?? null,
        traceId: traceId ?? null,
        qPreview: serperQuery.slice(0, 220),
      },
      "refresh-image",
    );

    const processed = await resolveProcessedFragranceImage({
      brand: imageBrand,
      name: imageName,
      searchQuery: serperQuery,
      allowLookupCache: false,
      removeBackground: !skipBg,
      poofOptions: removeBgOpts,
      serperRefine: { refine },
      maxCandidates: solverId ? 6 : 4,
      fixtureId,
      traceId,
    });

    if (!processed) {
      res.status(404).json({ error: "No image found for this fragrance" });
      return;
    }

    const finalImageUrl = processed.imageUrl;
    if (skipBg || processed.backgroundRemoved) {
      await upsertRefreshImageCatalog(imageBrand, imageName, {
        imageUrl: finalImageUrl,
        storagePath: processed.storagePath,
        imageHash: processed.imageHash,
        storageProvider: processed.storageProvider,
        sourceProvider: processed.sourceProvider,
      });
    }

    res.json({
      imageUrl: finalImageUrl,
      storagePath: processed.storagePath,
      imageHash: processed.imageHash,
      sourceProvider: processed.sourceProvider,
      cached: processed.cached,
      backgroundRemoved: processed.backgroundRemoved,
      removeBgStatus: processed.removeBgStatus ?? (processed.backgroundRemoved ? "removed" : "fallback"),
      removeBgReason: processed.removeBgReason ?? (processed.backgroundRemoved ? "removed" : "local_trim_fallback"),
      imagePipelineTrace: processed.imagePipelineTrace,
    });
  } catch (err: any) {
    logger.error({ err: err.message }, "refresh-image failed");
    res.status(500).json({ error: err.message || "Image refresh failed" });
  }
});

// Per-IP rate limit on the (intentionally unauthenticated) reimagine endpoint —
// each call bills OpenAI, so cap abuse without forcing login. Tunable via
// REIMAGINE_RATE_LIMIT_PER_HOUR (default 10/hour/IP).
const reimagineRateLimitPerHour = (() => {
  const raw = Number(process.env.REIMAGINE_RATE_LIMIT_PER_HOUR?.trim());
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 10;
})();
const reimagineRateLimit = rateLimitMiddleware({
  name: "reimagine",
  limit: reimagineRateLimitPerHour,
  windowMs: 60 * 60 * 1000,
});

router.post("/reimagine-bottle-image", reimagineRateLimit, async (req, res) => {
  if (process.env.ENABLE_REIMAGINE && process.env.ENABLE_REIMAGINE.trim().toLowerCase() !== "true") {
    res.status(403).json({ error: "Reimagine is disabled in this environment." });
    return;
  }

  const body = req.body as {
    name?: string;
    brand?: string;
    imageUrl?: unknown;
    model?: unknown;
    force?: unknown;
  };
  const { name, brand } = body;
  if (!name || !brand) {
    res.status(400).json({ error: "name and brand are required" });
    return;
  }

  const sourceUrl = parseIncomingImageUrl(body.imageUrl);
  if (!sourceUrl) {
    res.status(400).json({ error: "imageUrl is required (https URL, /api/image-objects/..., or data:image preview)" });
    return;
  }

  const requestedModel = typeof body.model === "string" ? body.model.trim() : undefined;
  if (requestedModel && !isSupportedReimagineModel(requestedModel)) {
    res.status(400).json({ error: "Unsupported reimagine model" });
    return;
  }

  const resolvedIdentity = resolveFragranceIdentity(brand, name);
  const imageBrand = resolvedIdentity.brand;
  const imageName = resolvedIdentity.name;

  logger.info(
    {
      brand: imageBrand,
      name: imageName,
      model: requestedModel ?? null,
      sourceKind: sourceUrl.startsWith("data:") ? "data" : sourceUrl.startsWith("/api/image-objects/") ? "local-object" : "remote",
    },
    "reimagine-bottle-image",
  );

  try {
    const result = await reimagineBottleImage({
      brand: imageBrand,
      name: imageName,
      sourceUrl,
      model: requestedModel ?? null,
      force: body.force === true,
    });

    await upsertRefreshImageCatalog(imageBrand, imageName, {
      imageUrl: result.imageUrl,
      storagePath: result.storagePath,
      imageHash: result.imageHash,
      storageProvider: result.storageProvider,
      sourceProvider: result.sourceProvider,
    });

    res.json({
      imageUrl: result.imageUrl,
      storagePath: result.storagePath,
      imageHash: result.imageHash,
      sourceProvider: result.sourceProvider,
      cached: result.cached,
      backgroundRemoved: result.backgroundRemoved,
      removeBgStatus: result.removeBgStatus ?? (result.backgroundRemoved ? "removed" : "fallback"),
      removeBgReason: result.removeBgReason ?? "openai_reimagine",
      model: result.model,
    });
  } catch (err: any) {
    // Queue-full refusal happens before OpenAI is called — nothing was billed.
    if (err instanceof ReimagineBusyError) {
      logger.warn({ brand: imageBrand, name: imageName }, "reimagine-bottle-image refused: server busy");
      res.status(429).json({ error: err.message });
      return;
    }
    const message = err?.message || "Reimagine failed";
    const isConfigError = /OPENAI_API_KEY/i.test(message);
    logger.error({ err: message }, "reimagine-bottle-image failed");
    res.status(isConfigError ? 503 : 502).json({ error: message });
  }
});

export default router;
