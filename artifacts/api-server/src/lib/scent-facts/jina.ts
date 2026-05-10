import type { ScentSource, SourceClass } from "./types";

const TIMEOUT_MS = 12_000;
const MAX_SOURCE_CHARS = 35_000;
const MAX_CANDIDATE_URLS = 6;
const MAX_READABLE_SOURCES = 4;

const RETAILER_DOMAINS = [
  "sephora.com",
  "ulta.com",
  "nordstrom.com",
  "macys.com",
  "bloomingdales.com",
  "saksfifthavenue.com",
  "neimanmarcus.com",
  "fragrancex.com",
  "fragrancenet.com",
];

const FRAGRANCE_DB_DOMAINS = [
  "parfumo.com",
  "basenotes.com",
  "fragrantica.com",
];

const OFFICIAL_BRAND_DOMAINS = [
  "dior.com",
  "chanel.com",
  "creedfragrances.com",
  "tomfordbeauty.com",
  "maisonfranciskurkdjian.com",
  "yslbeauty.com",
  "givenchybeauty.com",
  "hermes.com",
  "guerlain.com",
  "jomalone.com",
  "bvlgari.com",
  "armanibeauty.com",
  "burberry.com",
  "versace.com",
  "cartier.com",
  "guccibeauty.com",
  "lancome.com",
  "carolinaherrera.com",
  "valentino.com",
  "montblanc.com",
];

const BLOCKED_PAGE_HINTS = [
  "just a moment",
  "captcha",
  "access denied",
  "security compromise",
  "ddos attack suspected",
  "temporarily blocked",
];

const NOTE_SIGNAL_HINTS = [
  "top notes",
  "middle notes",
  "heart notes",
  "base notes",
  "main accords",
  "fragrance notes",
];

// Sites used for targeted Serper queries
const TARGETED_SERPER_SITES = [
  "sephora.com",
  "ulta.com",
  "nordstrom.com",
  "parfumo.com",
  "basenotes.com",
  "fragrantica.com",
];

function jinaHeaders(): Record<string, string> {
  const h: Record<string, string> = { Accept: "text/plain" };
  if (process.env.JINA_API_KEY) {
    h.Authorization = `Bearer ${process.env.JINA_API_KEY}`;
  }
  return h;
}

export function cleanQuery(input: string): string {
  return input
    .replace(/[^\w\s'"&.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

export function isHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function getDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function getSourceClass(url: string): SourceClass {
  const domain = getDomain(url);
  if (RETAILER_DOMAINS.some((d) => domain.includes(d))) return "retailer";
  if (FRAGRANCE_DB_DOMAINS.some((d) => domain.includes(d))) return "fragrance_db";
  if (OFFICIAL_BRAND_DOMAINS.some((d) => domain.includes(d))) return "official_brand";
  return "other";
}

function sourceRank(url: string): number {
  const cls = getSourceClass(url);
  if (cls === "fragrance_db") return 90;
  if (cls === "retailer") return 80;
  if (cls === "official_brand") return 70;
  return 0;
}

function isUsefulSource(url: string): boolean {
  return sourceRank(url) > 0;
}

function extractHttpUrls(text: string): string[] {
  return Array.from(
    text.matchAll(/https?:\/\/[^\s\])}"']+/g),
    (m) => m[0].replace(/[.,;]+$/g, ""),
  )
    .filter(isHttpUrl)
    .filter(isUsefulSource);
}

function diversifyCandidates(urls: string[], maxCount: number): string[] {
  // One URL per domain
  const uniqueByDomain = new Map<string, string>();
  for (const url of urls) {
    const domain = getDomain(url);
    if (!uniqueByDomain.has(domain)) {
      uniqueByDomain.set(domain, url);
    }
  }

  const byClass: Record<SourceClass, string[]> = {
    fragrance_db: [],
    retailer: [],
    official_brand: [],
    other: [],
  };
  for (const url of uniqueByDomain.values()) {
    byClass[getSourceClass(url)].push(url);
  }

  // Interleave by class: fragrance_db → retailer → official_brand → other
  const queues: string[][] = [
    byClass.fragrance_db,
    byClass.retailer,
    byClass.official_brand,
    byClass.other,
  ];
  const result: string[] = [];
  let round = 0;
  while (result.length < maxCount) {
    let anyAdded = false;
    for (const queue of queues) {
      if (result.length >= maxCount) break;
      if (round < queue.length) {
        result.push(queue[round]);
        anyAdded = true;
      }
    }
    if (!anyAdded) break;
    round++;
  }
  return result;
}

async function searchWithJina(query: string): Promise<string[]> {
  const searchUrl = `https://s.jina.ai/?q=${encodeURIComponent(query)}`;
  const res = await fetch(searchUrl, {
    method: "GET",
    headers: jinaHeaders(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return [];
  const text = await res.text();
  return extractHttpUrls(text);
}

function decodeDuckDuckGoRedirect(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.includes("duckduckgo.com")) return null;
    const target = parsed.searchParams.get("uddg");
    if (!target) return null;
    return decodeURIComponent(target);
  } catch {
    return null;
  }
}

async function searchWithDuckDuckGo(query: string): Promise<string[]> {
  const searchUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetch(searchUrl, {
    method: "GET",
    headers: { "User-Agent": "Mozilla/5.0", Accept: "text/html" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return [];

  const html = await res.text();
  const redirected = Array.from(
    html.matchAll(/https?:\/\/duckduckgo\.com\/l\/\?[^\s"'<>]+/g),
    (m) => m[0],
  )
    .map(decodeDuckDuckGoRedirect)
    .filter((u): u is string => Boolean(u))
    .filter(isUsefulSource);

  return [...redirected, ...extractHttpUrls(html)];
}

async function searchWithSerper(fragranceName: string): Promise<string[]> {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) return [];

  const queries = [
    `"${fragranceName}" fragrance notes`,
    ...TARGETED_SERPER_SITES.map((site) => `"${fragranceName}" fragrance notes site:${site}`),
    `"${fragranceName}" official fragrance notes`,
  ];

  const settled = await Promise.allSettled(
    queries.map(async (q) => {
      const res = await fetch("https://google.serper.dev/search", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        body: JSON.stringify({ q, num: 5, gl: "us", hl: "en" }),
      });
      if (!res.ok) return [] as string[];
      const data: any = await res.json();
      const organic: any[] = Array.isArray(data?.organic) ? data.organic : [];
      return organic
        .map((item) => (typeof item?.link === "string" ? item.link : ""))
        .filter((u: string): boolean => Boolean(u) && isUsefulSource(u));
    }),
  );

  return settled
    .filter((r): r is PromiseFulfilledResult<string[]> => r.status === "fulfilled")
    .flatMap((r) => r.value);
}

export async function searchScentSources(fragranceName: string): Promise<string[]> {
  const clean = cleanQuery(fragranceName);
  if (!clean) return [];

  const query = `"${clean}" fragrance notes top middle base`;
  const allUrls: string[] = [];

  // Layer 1: Jina search
  try {
    allUrls.push(...(await searchWithJina(query)));
  } catch {
    // Proceed without Jina.
  }

  // Layer 2: Serper with targeted site queries — always run if key exists
  try {
    allUrls.push(...(await searchWithSerper(clean)));
  } catch {
    // Proceed without Serper.
  }

  // Layer 3: DuckDuckGo only when earlier layers yielded fewer than 3 usable URLs
  if (allUrls.filter(isUsefulSource).length < 3) {
    try {
      allUrls.push(...(await searchWithDuckDuckGo(query)));
    } catch {
      // Proceed without DuckDuckGo.
    }
  }

  return diversifyCandidates(allUrls, MAX_CANDIDATE_URLS);
}

export async function readSource(url: string): Promise<ScentSource | null> {
  if (!isHttpUrl(url)) return null;

  try {
    const jinaUrl = `https://r.jina.ai/${url}`;
    const res = await fetch(jinaUrl, {
      method: "GET",
      headers: jinaHeaders(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;

    const raw = await res.text();
    const text = raw.trim();
    if (text.length < 200) return null;

    const lowerText = text.toLowerCase();
    if (BLOCKED_PAGE_HINTS.some((hint) => lowerText.includes(hint))) return null;

    const noteSignalFound = NOTE_SIGNAL_HINTS.some((hint) => lowerText.includes(hint));
    if (!noteSignalFound) return null;

    return {
      url,
      domain: getDomain(url),
      text: text.slice(0, MAX_SOURCE_CHARS),
      source_class: getSourceClass(url),
      note_signal_found: noteSignalFound,
    };
  } catch {
    return null;
  }
}

function applySourceDiversity(sources: ScentSource[], maxCount: number): ScentSource[] {
  if (sources.length <= maxCount) return sources;

  const byClass: Record<SourceClass, ScentSource[]> = {
    fragrance_db: [],
    retailer: [],
    official_brand: [],
    other: [],
  };
  for (const source of sources) {
    byClass[source.source_class].push(source);
  }

  const queues: ScentSource[][] = [
    byClass.fragrance_db,
    byClass.retailer,
    byClass.official_brand,
    byClass.other,
  ];
  const result: ScentSource[] = [];
  let round = 0;
  while (result.length < maxCount) {
    let anyAdded = false;
    for (const queue of queues) {
      if (result.length >= maxCount) break;
      if (round < queue.length) {
        result.push(queue[round]);
        anyAdded = true;
      }
    }
    if (!anyAdded) break;
    round++;
  }
  return result;
}

export async function readSources(urls: string[]): Promise<ScentSource[]> {
  const candidates = [...new Set(urls)].slice(0, MAX_CANDIDATE_URLS);
  const settled = await Promise.allSettled(candidates.map(readSource));

  const readable = settled
    .filter(
      (r): r is PromiseFulfilledResult<ScentSource | null> => r.status === "fulfilled",
    )
    .map((r) => r.value)
    .filter((v): v is ScentSource => v !== null);

  return applySourceDiversity(readable, MAX_READABLE_SOURCES);
}
