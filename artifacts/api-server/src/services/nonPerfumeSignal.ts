/**
 * App-side companion to the Python engine's `enrichment_facts.non_perfume_signal`
 * (search_engine/enrichment_facts.py). The app is a fragrance app; body-care
 * products (lotions, mists, washes, candles) and leaked test fixtures should not
 * enter the wardrobe. The engine gate keeps them out of the enrichment pipeline;
 * this keeps them out of `user_fragrances` at the add-to-wardrobe boundary.
 *
 * HIGH PRECISION is the whole contract: a false positive deletes/blocks a real
 * perfume. The logic mirrors the Python classifier byte-for-byte so the two
 * sides never diverge — change them together.
 */

// Brands whose catalog reaching this pipeline is overwhelmingly scented
// body-care, not eau de parfum. A brand only belongs here because the
// real-perfume page guard below still protects its rare genuine fragrance.
const NON_PERFUME_BRANDS = new Set<string>([
  "bath and body works",
  "bath body works",
  "pull bear",
  "pull and bear",
  "the body shop",
  "body shop",
]);

// Unambiguous non-perfume product tokens. DELIBERATELY excludes words real
// perfumes use as names (e.g. Maison Margiela Replica "Bubble Bath",
// "Beach Walk", "Coffee Break"), so a token match is always a true non-perfume.
const NON_PERFUME_TOKENS = [
  "body lotion",
  "body cream",
  "body butter",
  "body wash",
  "shower gel",
  "hand soap",
  "hand cream",
  "hand wash",
  "body scrub",
  "sugar scrub",
  "shampoo",
  "conditioner",
  "deodorant",
  "room spray",
  "scented candle",
  "wax melt",
  "reed diffuser",
];

const TEST_IDENTITY_MARKERS = ["dummy", "empty-notes", "uncached"];

/**
 * True when any URL is a genuine Fragrantica/Parfumo *perfume* page. Pure string
 * check: a real Fragrantica perfume URL contains `/perfume/` and a Parfumo one
 * `/Perfumes/`. Basenotes-only or empty URLs are NOT a real-perfume page — that
 * is exactly the never-resolved state the brand/token guards then judge.
 */
function hasRealPerfumePage(urls: readonly (string | null | undefined)[]): boolean {
  for (const url of urls) {
    const text = String(url ?? "").toLowerCase();
    if (text.includes("fragrantica.com/perfume/") || (text.includes("parfumo.") && text.includes("/perfumes/"))) {
      return true;
    }
  }
  return false;
}

function normHouse(house: string | null | undefined): string {
  return String(house ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type NonPerfumeSignal = { flagged: boolean; reason: string };

/**
 * Conservative non-perfume classifier. Never flags an item that resolved to a
 * real perfume page. Otherwise flags when the name carries an unambiguous
 * non-perfume product token, when the identity is obviously test/placeholder
 * data, or when the brand is a known body-care catalog.
 *
 * @param urls any source URLs known for the item (Fragrantica/Parfumo/Basenotes
 *   pages, opaque ids that embed `source:<url>`). Used both as the real-perfume
 *   guard and as part of the test-identity blob.
 */
export function nonPerfumeSignal(
  name: string | null | undefined,
  brand: string | null | undefined,
  urls: readonly (string | null | undefined)[] = [],
): NonPerfumeSignal {
  const nameL = String(name ?? "").trim().toLowerCase();
  const houseL = normHouse(brand);

  // Test/placeholder identities are always junk, regardless of URL.
  const blob = `${nameL} ${urls.map((u) => String(u ?? "")).join(" ")}`.toLowerCase();
  if (TEST_IDENTITY_MARKERS.some((marker) => blob.includes(marker))) {
    return { flagged: true, reason: "test/placeholder identity" };
  }

  // A genuine perfume page is decisive: never flag it.
  if (hasRealPerfumePage(urls)) {
    return { flagged: false, reason: "" };
  }

  for (const token of NON_PERFUME_TOKENS) {
    if (nameL.includes(token)) {
      return { flagged: true, reason: `non-perfume product token: '${token}'` };
    }
  }

  if (NON_PERFUME_BRANDS.has(houseL)) {
    return { flagged: true, reason: "body-care brand, no real perfume page" };
  }

  return { flagged: false, reason: "" };
}
