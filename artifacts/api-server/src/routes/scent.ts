import { Router } from "express";
import { getWeather } from "../services/weatherService";
import { buildProfile, searchFragrances } from "../services/scentEngine";
import { deepScrapeFragrance } from "../services/fallbackIntelligence";
import { searchCatalog, getCatalogEntry, saveCatalogEntry, flattenProfile } from "../services/catalogService";
import { searchImageUrl } from "../services/imageService";
import { removeBg } from "../services/bgService";
import {
  isImageSolverId,
  resolveRefreshSerperInput,
  solverSkipsBgRemoval,
  solverWantsPoofProductType,
  type ImageSolverId,
} from "../services/imageSolvers";
import { logger } from "../lib/logger";

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
    res.json(catalogHit);
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
    res.status(400).json({ error: "stripBgOnly requires a valid imageUrl (https URL or data:image/...)" });
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

      let finalImageUrl = sourceForStrip;
      if (!skipBgStrip) {
        try {
          const isRemote = sourceForStrip.startsWith("http://") || sourceForStrip.startsWith("https://");
          const { cleanImage } = await removeBg(sourceForStrip, isRemote, stripRemoveOpts);
          if (cleanImage) finalImageUrl = cleanImage;
        } catch (bgErr: any) {
          logger.warn({ err: bgErr.message }, "refresh-image stripBgOnly: bg removal skipped");
        }
      }

      await upsertRefreshImageCatalog(brand, name, finalImageUrl);
      res.json({ imageUrl: finalImageUrl });
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

    const rawUrl = await searchImageUrl(serperQuery, { refine });
    if (!rawUrl) {
      res.status(404).json({ error: "No image found for this fragrance" });
      return;
    }

    let safeUrl: string;
    try {
      safeUrl = new URL(rawUrl).toString();
    } catch {
      res.status(422).json({ error: `Image URL invalid: ${rawUrl.slice(0, 80)}` });
      return;
    }

    let finalImageUrl = safeUrl;
    if (!skipBg) {
      try {
        const { cleanImage } = await removeBg(safeUrl, true, removeBgOpts);
        if (cleanImage) finalImageUrl = cleanImage;
      } catch (bgErr: any) {
        logger.warn({ err: bgErr.message }, "refresh-image: bg removal skipped, using raw URL");
      }
    }

    await upsertRefreshImageCatalog(brand, name, finalImageUrl);

    res.json({ imageUrl: finalImageUrl });
  } catch (err: any) {
    logger.error({ err: err.message }, "refresh-image failed");
    res.status(500).json({ error: err.message || "Image refresh failed" });
  }
});

export default router;
