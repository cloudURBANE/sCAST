import { loadDataset, type FragranceData } from "./datasetLoader";
import { parseFragrance } from "./scentParser";
import { vectorize, calculatePerformance, calculateContext, type ScentVector, type PerformanceMetrics, type ContextProfile } from "./scentVectorizer";
import { searchImageUrl } from "./imageService";
import { removeBg } from "./bgService";
import { getOrCreateCachedImage } from "./firebaseCache";
import { getCatalogEntry, saveCatalogEntry, searchCatalog } from "./catalogService";

export interface ScentProfile {
  product: { name: string; brand: string; perfumer?: string };
  scent_vector: ScentVector;
  performance: PerformanceMetrics;
  context: ContextProfile;
  notes: string[];
  pyramid?: { top: string[]; heart: string[]; base: string[] };
  family: string;
  concentration: string;
  accords: string[];
  imageUrl?: string;
  description?: string;
  error?: string;
}

function findFragrance(name: string, brand: string): FragranceData | undefined {
  const dataset = loadDataset();
  const searchName = name.toLowerCase();
  const searchBrand = brand.toLowerCase();
  const combined = `${brand} ${name}`.toLowerCase().trim();

  return dataset.find(item => {
    const itemName = item.name.toLowerCase();
    const itemBrand = item.brand.toLowerCase();
    const full = `${itemBrand} ${itemName}`.toLowerCase();
    return (
      (itemBrand === searchBrand && itemName.includes(searchName)) ||
      (brand === "" && itemName.includes(searchName)) ||
      (brand === "" && full.includes(searchName)) ||
      itemName === searchName ||
      full === combined
    );
  });
}

export function searchFragrances(query: string): FragranceData[] {
  const dataset = loadDataset();
  const q = query.toLowerCase();
  return dataset.filter(item => {
    const itemName = item.name.toLowerCase();
    const itemBrand = item.brand.toLowerCase();
    const full = `${itemBrand} ${itemName}`.toLowerCase();
    return itemName.includes(q) || itemBrand.includes(q) || full.includes(q);
  });
}

export async function buildProfile(
  name: string,
  brand: string,
  fallback?: {
    notes?: string[];
    family?: string;
    description?: string;
    imageUrl?: string;
    pyramid?: { top: string[]; heart: string[]; base: string[] };
    perfumer?: string;
  }
): Promise<ScentProfile | { error: string }> {
  // 1. Check global catalog — exact match first, then fuzzy to catch AI naming variations
  const cached = await getCatalogEntry(brand, name);
  if (cached) return cached;

  // Fuzzy search handles cases like "Sauvage EDP" matching stored "Sauvage"
  const fuzzy = await searchCatalog(`${brand} ${name}`);
  if (fuzzy) return fuzzy;

  // 2. Resolve image: check Firestore by name+brand first; on miss, run image
  // search + background removal exactly once even if many users request simultaneously.
  const cleanImageUrl = await getOrCreateCachedImage(
    brand,
    name,
    async () => {
      let imageUrl = fallback?.imageUrl;
      try {
        const searchQuery = `${brand} ${name} single fragrance bottle no box HQ`;
        const searchRes = await searchImageUrl(searchQuery);
        if (searchRes) {
          imageUrl = searchRes;
        }
      } catch {
        /* keep fallback */
      }
      if (!imageUrl) return null;
      try {
        const { cleanImage } = await removeBg(imageUrl, true);
        return cleanImage ?? null;
      } catch {
        return null;
      }
    },
  );

  const match = findFragrance(name, brand);
  const finalName = match?.name || name;
  const finalBrand = match?.brand || brand;
  const finalNotes = match?.notes || fallback?.notes || [];
  const finalFamily = match?.family || fallback?.family || "Unknown Family";
  const finalDescription = match?.description || fallback?.description || "";
  const finalPyramid = match?.pyramid || fallback?.pyramid;
  const finalPerfumer = match?.perfumer || fallback?.perfumer;

  if (!match && (!fallback || !fallback.notes)) {
    return { error: "Could not identify this fragrance. Try a more specific name." };
  }

  const parsed = parseFragrance({
    name: finalName,
    brand: finalBrand,
    notes: finalNotes,
    family: finalFamily,
    description: finalDescription,
    pyramid: finalPyramid,
    perfumer: finalPerfumer,
  } as FragranceData);

  if (!parsed) return { error: "Failed to parse fragrance data." };

  const vector = vectorize(parsed);
  const performance = calculatePerformance(vector, finalFamily, parsed.concentration);
  const context = calculateContext(vector);

  const profile: ScentProfile = {
    product: {
      name: finalName,
      brand: finalBrand,
      ...(parsed.perfumer ? { perfumer: parsed.perfumer } : {}),
    },
    scent_vector: vector,
    performance,
    context,
    notes: finalNotes,
    pyramid: finalPyramid,
    family: finalFamily,
    concentration: parsed.concentration,
    accords: parsed.accords,
    imageUrl: cleanImageUrl ?? undefined,
    description: finalDescription,
  };

  // 3. Save to global catalog so future users skip all the above work
  await saveCatalogEntry(finalBrand, finalName, profile).catch(() => { /* non-fatal */ });

  return profile;
}
