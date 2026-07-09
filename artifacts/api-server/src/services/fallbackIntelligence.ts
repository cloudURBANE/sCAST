import axios from "axios";

interface ScrapedFragrance {
  name: string;
  brand: string;
  perfumer: string;
  notes: string[];
  pyramid: { top: string[]; heart: string[]; base: string[] };
  family: string;
  description: string;
}

const ALL_NOTE_KEYWORDS = [
  "vanilla", "rose", "sandalwood", "bergamot", "lemon", "patchouli", "musk", "jasmine",
  "oud", "amber", "cedar", "vetiver", "leather", "tonka", "lavender", "iris", "pear",
  "apple", "pepper", "neroli", "tuberose", "ylang", "cardamom", "citrus", "wood",
  "grapefruit", "orange", "lime", "peach", "plum", "cherry", "raspberry", "violet",
  "geranium", "oakmoss", "treemoss", "benzoin", "labdanum", "frankincense", "myrrh",
  "incense", "saffron", "ginger", "cinnamon", "tobacco", "smoke", "honey", "caramel",
  "praline", "coconut", "mint", "eucalyptus", "pine", "fir", "birch", "guaiac",
  "ambergris", "ambroxan", "heliotrope", "orris", "elemi", "styrax", "beeswax",
  "aldehyde", "mastic", "cistus", "marine", "sea", "salt", "aquatic",
];

const FAMILY_MAP: Array<{ keywords: string[]; family: string }> = [
  { keywords: ["oud", "amber", "resin", "balsam", "labdanum", "frankincense", "myrrh", "incense"], family: "Oriental" },
  { keywords: ["rose", "jasmine", "tuberose", "ylang", "violet", "iris", "peony", "magnolia"], family: "Floral" },
  { keywords: ["sandalwood", "cedar", "vetiver", "patchouli", "wood", "guaiac", "birch"], family: "Woody" },
  { keywords: ["bergamot", "lemon", "grapefruit", "lime", "orange", "citrus", "neroli"], family: "Citrus" },
  { keywords: ["marine", "sea", "salt", "aquatic", "ozone", "ocean"], family: "Aquatic" },
  { keywords: ["vanilla", "tonka", "caramel", "praline", "chocolate", "honey", "sugar"], family: "Gourmand" },
  { keywords: ["lavender", "fougere", "coumarin", "oakmoss", "geranium"], family: "Fougere" },
  { keywords: ["moss", "chypre", "oakmoss", "cistus", "labdanum"], family: "Chypre" },
  { keywords: ["fresh", "mint", "eucalyptus", "green", "grass"], family: "Fresh" },
];

const PERFUMER_PATTERNS = [
  /(?:perfumer|nose|created\s+by|composed\s+by|signed\s+by)[:\s]+([A-Z][a-z]+(?: [A-Z][a-z]+)+)/i,
  /([A-Z][a-z]+(?: [A-Z][a-z]+)+)(?:\s+is\s+the\s+(?:nose|perfumer))/i,
];

function detectFamily(notes: string[], snippet: string): string {
  const text = `${notes.join(" ")} ${snippet}`.toLowerCase();
  for (const { keywords, family } of FAMILY_MAP) {
    if (keywords.some(k => text.includes(k))) return family;
  }
  return "Fresh";
}

function classifyNotesByPosition(notes: string[]): { top: string[]; heart: string[]; base: string[] } {
  const top: string[] = [];
  const heart: string[] = [];
  const base: string[] = [];

  const topIndicators = ["bergamot", "lemon", "grapefruit", "lime", "orange", "mandarin", "mint", "aldehy", "pineapple", "neroli", "petitgrain"];
  const baseIndicators = ["sandalwood", "cedar", "vetiver", "patchouli", "oud", "amber", "musk", "vanilla", "tonka", "benzoin", "labdanum", "leather", "moss"];

  for (const note of notes) {
    const n = note.toLowerCase();
    if (topIndicators.some(t => n.includes(t))) {
      top.push(note);
    } else if (baseIndicators.some(b => n.includes(b))) {
      base.push(note);
    } else {
      heart.push(note);
    }
  }

  if (top.length === 0 && heart.length > 1) {
    top.push(...heart.splice(0, 1));
  }

  return { top, heart, base };
}

function extractPerfumer(snippet: string): string {
  for (const pattern of PERFUMER_PATTERNS) {
    const match = snippet.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return "";
}

const KNOWN_MULTI_WORD_BRANDS = [
  "tom ford", "jo malone", "yves saint laurent", "jean paul gaultier",
  "maison francis kurkdjian", "maison margiela", "parfums de marly",
  "comme des garcons", "dolce & gabbana", "viktor & rolf", "acqua di parma",
  "bath & body works", "victoria's secret", "estee lauder", "elizabeth arden",
  "giorgio armani", "christian dior", "donna karan", "narciso rodriguez",
  "issey miyake", "kenzo paris", "van cleef & arpels", "l'artisan parfumeur",
  "penhaligon's london", "miller harris", "byredo parfums", "le labo"
];

function parseQuery(query: string): { brand: string; name: string } {
  const cleaned = query.trim();

  const lowerQuery = cleaned.toLowerCase();
  for (const b of KNOWN_MULTI_WORD_BRANDS) {
    if (lowerQuery.startsWith(b)) {
      const brand = cleaned.substring(0, b.length);
      const name = cleaned.substring(b.length).trim() || brand;
      return { brand, name };
    }
  }

  // We cannot reliably infer the brand from a free-text query. The previous
  // implementation assumed the first word was the brand, which turned
  // "Royal Sapphire" into {brand:"Royal", name:"Sapphire"} and "Michael Jordan"
  // into {brand:"Michael", name:"Jordan"} -- fabricated identities that rendered
  // as "Sapphire by Royal" and poisoned global_fragrances once persisted. Leave
  // the brand unknown and keep the full query as the name; downstream
  // resolveFragranceIdentity recovers the real brand from the dataset when it can.
  return { brand: "", name: cleaned };
}

// Returns `null` when there is no real evidence the query is a fragrance.
// It used to fabricate a generic "Citrus/Musk/Wood" profile around a naive
// brand/name word-split for ANY input, which the caller then persisted to
// global_fragrances -- the source of the "Sapphire by Royal" bug. Now it only
// returns a profile when the Wikipedia snippet actually yields fragrance notes,
// and signals "not found" otherwise so the caller can decline to invent/persist.
export async function deepScrapeFragrance(query: string): Promise<ScrapedFragrance | null> {
  try {
    const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query + " perfume fragrance")}&utf8=&format=json`;
    // Bound the request like every other outbound call in this service: undici/
    // axios has no default timeout, so a hung Wikipedia socket on the guest
    // POST /api/search-scent path would otherwise hold the request open with no
    // deadline and tie up sockets under concurrent slow scrapes.
    const res = await axios.get(searchUrl, {
      headers: { "User-Agent": "OlfactoryApp/1.0" },
      timeout: 8000,
    });

    let snippet = "";
    if (res.data?.query?.search?.length > 0) {
      snippet = res.data.query.search
        .map((s: any) => s.snippet)
        .join(" ")
        .replace(/<[^>]+>/g, "");
    }

    const lowerSnippet = snippet.toLowerCase();
    const foundNotes = ALL_NOTE_KEYWORDS.filter(n => lowerSnippet.includes(n)).map(
      n => n.charAt(0).toUpperCase() + n.slice(1)
    );

    // No detectable fragrance notes -> we have nothing real. Don't fabricate.
    if (foundNotes.length === 0) return null;

    const pyramid = classifyNotesByPosition(foundNotes);
    const family = detectFamily(foundNotes, snippet);
    const perfumer = extractPerfumer(snippet);

    const { brand, name } = parseQuery(query);

    return {
      name,
      brand,
      perfumer,
      notes: foundNotes,
      pyramid,
      family,
      description: `${snippet.substring(0, 300)}...`,
    };
  } catch {
    return null;
  }
}
