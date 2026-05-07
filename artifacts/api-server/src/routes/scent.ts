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
import { resolveProcessedFragranceImage } from "../services/imagePipeline";
import { imageReferenceDiagnostic, usableImageUrlForResponse } from "../services/imageReference";

const router = Router();

type ConcentrationHint = "edt" | "edp";

function concentrationToQueryText(hint?: ConcentrationHint): string {
  if (hint === "edt") return "eau de toilette EDT";
  if (hint === "edp") return "eau de parfum EDP";
  return "";
}

function parseIncomingImageUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const s = raw.trim();
  if (s.startsWith("data:image/")) {
    if (s.length > 4_000_000) return null;
    return s;
  }
  if (s.startsWith("/api/image-objects/images/processed/")) {
    return s;
  }
  try {
    const u = new URL(s);
    if (u.protocol === "http:" || u.protocol === "https:") return u.toString();
  } catch {
    return null;
  }
  return null;
}

async function upsertRefreshImageCatalog(brand: string, name: string, finalImageUrl: string): Promise<void> {
  let baseProfile = await getCatalogEntry(brand, name);
  if (!baseProfile) {
    const built = await buildProfile(name, brand, undefined, { allowCatalogFuzzy: false });
    if ("product" in built) baseProfile = built;
  }
  if (baseProfile) {
    await saveCatalogEntry(brand, name, { ...baseProfile, imageUrl: finalImageUrl });
  }
}

router.get("/weather", async (req, res) => {
  const { lat, lon } = req.query as { lat?: string; lon?: string };
  const data = await getWeather({ lat, lon });
  res.json(data);
});

router.post("/scent-profile", async (req, res) => {
  const { name, brand, imageUrl, notes, family, description, pyramid, perfumer } = req.body as {
    name?: string;
    brand?: string;
    imageUrl?: string;
    notes?: string[];
    family?: string;
    description?: string;
    pyramid?: { top: string[]; heart: string[]; base: string[] };
    perfumer?: string;
  };

  if (!name) {
    res.status(400).json({ error: "Fragrance name is required" });
    return;
  }

  const result = await buildProfile(name, brand || "", {
    notes,
    family,
    description,
    imageUrl,
    pyramid,
    perfumer,
  });
  // Always return a flat shape ({ name, brand, ... } alongside `product`) so the
  // client can rely on top-level keys when it persists this object verbatim.
  if (!("product" in result)) { res.json(result); return; }
  res.json(flattenProfile(result));
});

router.post("/search-scent", async (req, res) => {
  const { query, concentrationHint } = req.body as { query?: string; concentrationHint?: ConcentrationHint };
  if (!query) {
    res.status(400).json({ error: "Query is required" });
    return;
  }
  const normalizedHint = concentrationHint === "edt" || concentrationHint === "edp" ? concentrationHint : undefined;
  const queryWithHint = [query, concentrationToQueryText(normalizedHint)].filter(Boolean).join(" ").trim();

  // Check global catalog before hitting local dataset or scraper
  const catalogHit = await searchCatalog(queryWithHint);
  if (catalogHit) {
    const catalogImageUrl = await usableImageUrlForResponse(catalogHit.imageUrl);
    if (catalogImageUrl) {
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
      { allowCatalogFuzzy: false },
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
    });
    res.json(profile);
    return;
  }

  const scraped = await deepScrapeFragrance(queryWithHint);
  const profile = await buildProfile(scraped.name, scraped.brand, {
    notes: scraped.notes,
    family: scraped.family,
    description: scraped.description,
    pyramid: scraped.pyramid,
    perfumer: scraped.perfumer,
  });
  res.json(profile);
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
  };
  const { name, brand, concentrationHint } = body;
  if (!name || !brand) {
    res.status(400).json({ error: "name and brand are required" });
    return;
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

  try {
    if (stripBgOnly && sourceForStrip) {
      const skipBgStrip = typeof body.skipBg === "boolean" ? body.skipBg : false;
      let poofT: "auto" | "product" | undefined;
      const ptStrip = body.poofOptions?.type;
      if (ptStrip === "product" || ptStrip === "auto") poofT = ptStrip;
      if (poofT === undefined) poofT = "product";
      const stripRemoveOpts = poofT === "product" ? ({ poofType: "product" } as const) : undefined;

      logger.info(
        {
          stripBgOnly: true,
          refreshCount: refreshCount ?? null,
          skipBg: skipBgStrip,
          poofType: poofT ?? null,
          sourceKind: sourceForStrip.startsWith("data:") ? "data" : "url",
        },
        "refresh-image",
      );

      const processed = await resolveProcessedFragranceImage({
        brand,
        name,
        sourceUrl: sourceForStrip,
        sourceProvider: "manual",
        allowLookupCache: false,
        removeBackground: !skipBgStrip,
        poofOptions: stripRemoveOpts,
      });

      if (!processed) {
        res.status(422).json({ error: "Could not process this image source" });
        return;
      }

      const finalImageUrl = processed.imageUrl;
      await upsertRefreshImageCatalog(brand, name, finalImageUrl);
      res.json({
        imageUrl: finalImageUrl,
        storagePath: processed.storagePath,
        imageHash: processed.imageHash,
        cached: processed.cached,
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

    if (!solverId && (refreshCount ?? 0) > 3) {
      res.status(429).json({ error: "Automatic image regeneration paused. Choose what looks wrong and try with a hint." });
      return;
    }
    if ((refreshCount ?? 0) > 10) {
      res.status(429).json({ error: "Too many image regeneration attempts for this session." });
      return;
    }

    let poofType = solverWantsPoofProductType(solverId);
    const pt = body.poofOptions?.type;
    if (pt === "product" || pt === "auto") poofType = pt;

    const removeBgOpts = poofType === "product" ? ({ poofType: "product" } as const) : undefined;

    // Normalize to ASCII so accented chars (é, ü, etc.) don't break URL parsing
    const asciiName = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7E]/g, "");
    const asciiBrand = brand.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7E]/g, "");
    const normalizedHint = concentrationHint === "edt" || concentrationHint === "edp" ? concentrationHint : undefined;
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
        refine,
        skipBg,
        poofType: poofType ?? null,
        qPreview: serperQuery.slice(0, 220),
      },
      "refresh-image",
    );

    const processed = await resolveProcessedFragranceImage({
      brand,
      name,
      searchQuery: serperQuery,
      allowLookupCache: false,
      removeBackground: !skipBg,
      poofOptions: removeBgOpts,
      serperRefine: { refine },
      maxCandidates: solverId ? 6 : 4,
    });

    if (!processed) {
      res.status(404).json({ error: "No image found for this fragrance" });
      return;
    }

    const finalImageUrl = processed.imageUrl;
    await upsertRefreshImageCatalog(brand, name, finalImageUrl);

    res.json({
      imageUrl: finalImageUrl,
      storagePath: processed.storagePath,
      imageHash: processed.imageHash,
      cached: processed.cached,
    });
  } catch (err: any) {
    logger.error({ err: err.message }, "refresh-image failed");
    res.status(500).json({ error: err.message || "Image refresh failed" });
  }
});

export default router;
