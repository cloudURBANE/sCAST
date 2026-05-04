import { Router } from "express";
import { getWeather } from "../services/weatherService";
import { buildProfile, searchFragrances } from "../services/scentEngine";
import { deepScrapeFragrance } from "../services/fallbackIntelligence";
import { searchCatalog, getCatalogEntry, saveCatalogEntry, flattenProfile } from "../services/catalogService";
import { searchImageUrl } from "../services/imageService";
import { removeBg } from "../services/bgService";
import { logger } from "../lib/logger";

const router = Router();

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
  const { query } = req.body as { query?: string };
  if (!query) {
    res.status(400).json({ error: "Query is required" });
    return;
  }

  // Check global catalog before hitting local dataset or scraper
  const catalogHit = await searchCatalog(query);
  if (catalogHit) {
    res.json(catalogHit);
    return;
  }

  const local = searchFragrances(query);
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

  const scraped = await deepScrapeFragrance(query);
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
  const { name, brand } = req.body as { name?: string; brand?: string };
  if (!name || !brand) {
    res.status(400).json({ error: "name and brand are required" });
    return;
  }
  try {
    // Normalize to ASCII so accented chars (é, ü, etc.) don't break URL parsing
    const asciiName  = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7E]/g, "");
    const asciiBrand = brand.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7E]/g, "");
    const query = `${asciiBrand} ${asciiName} single perfume bottle no box product photo`;

    const rawUrl = await searchImageUrl(query);
    if (!rawUrl) {
      res.status(404).json({ error: "No image found for this fragrance" });
      return;
    }

    // Validate the URL before passing it downstream — avoids "did not match pattern" from axios
    let safeUrl: string;
    try {
      safeUrl = new URL(rawUrl).toString();
    } catch {
      res.status(422).json({ error: `Image URL invalid: ${rawUrl.slice(0, 80)}` });
      return;
    }

    // Background removal is best-effort — a provider error here must not kill the route
    let finalImageUrl = safeUrl;
    try {
      const { cleanImage } = await removeBg(safeUrl, true);
      if (cleanImage) finalImageUrl = cleanImage;
    } catch (bgErr: any) {
      logger.warn({ err: bgErr.message }, "refresh-image: bg removal skipped, using raw URL");
    }

    // Persist to global catalog so every future user gets the refreshed image
    const existing = await getCatalogEntry(brand, name);
    if (existing) {
      await saveCatalogEntry(brand, name, { ...existing, imageUrl: finalImageUrl });
    }

    res.json({ imageUrl: finalImageUrl });
  } catch (err: any) {
    logger.error({ err: err.message }, "refresh-image failed");
    res.status(500).json({ error: err.message || "Image refresh failed" });
  }
});

export default router;
