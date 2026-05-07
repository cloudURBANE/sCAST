import type { ScentSource } from "./types";

const TIMEOUT_MS = 12_000;
const MAX_SOURCE_CHARS = 35_000;

const TRUSTED_DOMAINS = [
  "parfumo.com",
  "fragrantica.com",
  "basenotes.com",
];

const FALLBACK_DOMAINS = [
  "sephora.com",
  "ulta.com",
  "nordstrom.com",
  "dior.com",
  "chanel.com",
  "creedfragrances.com",
  "tomfordbeauty.com",
  "maisonfranciskurkdjian.com",
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

function headers(): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "text/plain",
  };
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

function sourceRank(url: string): number {
  const domain = getDomain(url);
  const trustedIndex = TRUSTED_DOMAINS.findIndex((d) => domain.includes(d));
  if (trustedIndex >= 0) return 100 - trustedIndex;

  const fallbackIndex = FALLBACK_DOMAINS.findIndex((d) => domain.includes(d));
  if (fallbackIndex >= 0) return 50 - fallbackIndex;

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

function pickTopTrusted(urls: string[]): string[] {
  const uniqueByDomain = new Map<string, string>();
  for (const url of urls) {
    const domain = getDomain(url);
    if (!uniqueByDomain.has(domain)) {
      uniqueByDomain.set(domain, url);
    }
  }
  return Array.from(uniqueByDomain.values())
    .sort((a, b) => sourceRank(b) - sourceRank(a))
    .slice(0, 3);
}

async function searchWithJina(query: string): Promise<string[]> {
  const searchUrl = `https://s.jina.ai/?q=${encodeURIComponent(query)}`;
  const res = await fetch(searchUrl, {
    method: "GET",
    headers: headers(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return [];

  const text = await res.text();
  return pickTopTrusted(extractHttpUrls(text));
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
    headers: {
      "User-Agent": "Mozilla/5.0",
      Accept: "text/html",
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return [];

  const html = await res.text();
  const redirected = Array.from(
    html.matchAll(/https?:\/\/duckduckgo\.com\/l\/\?[^\s"'<>]+/g),
    (m) => m[0],
  )
    .map(decodeDuckDuckGoRedirect)
    .filter((u): u is string => Boolean(u));

  const direct = extractHttpUrls(html);
  return pickTopTrusted([...redirected, ...direct]);
}

async function searchWithSerper(query: string): Promise<string[]> {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) return [];

  const serperQueries = [
    query,
    `${query} site:parfumo.com`,
    `${query} site:fragrantica.com`,
    `${query} site:basenotes.com`,
  ];

  const links: string[] = [];
  for (const q of serperQueries) {
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({
        q,
        num: 10,
        gl: "us",
        hl: "en",
      }),
    });
    if (!res.ok) continue;

    const data: any = await res.json();
    const organic = Array.isArray(data?.organic) ? data.organic : [];
    const organicLinks = organic
      .map((item: any) => (typeof item?.link === "string" ? item.link : ""))
      .filter(Boolean);
    links.push(...organicLinks);
  }

  return pickTopTrusted(links);
}

export async function searchScentSources(fragranceName: string): Promise<string[]> {
  const clean = cleanQuery(fragranceName);
  if (!clean) return [];

  const query = `"${clean}" fragrance notes top middle base notes`;
  try {
    const fromJina = await searchWithJina(query);
    if (fromJina.length) return fromJina;
  } catch {
    // Fall through to non-Jina search fallback.
  }

  try {
    const fromSerper = await searchWithSerper(query);
    if (fromSerper.length) return fromSerper;
  } catch {
    // Fall through to next fallback.
  }

  try {
    return await searchWithDuckDuckGo(query);
  } catch {
    return [];
  }
}

export async function readSource(url: string): Promise<ScentSource | null> {
  if (!isHttpUrl(url)) return null;

  try {
    const jinaUrl = `https://r.jina.ai/${url}`;
    const res = await fetch(jinaUrl, {
      method: "GET",
      headers: headers(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;

    const raw = await res.text();
    const text = raw.trim();
    if (text.length < 200) return null;
    const lowerText = text.toLowerCase();
    if (BLOCKED_PAGE_HINTS.some((hint) => lowerText.includes(hint))) {
      return null;
    }
    if (!NOTE_SIGNAL_HINTS.some((hint) => lowerText.includes(hint))) {
      return null;
    }

    return {
      url,
      domain: getDomain(url),
      text: text.slice(0, MAX_SOURCE_CHARS),
    };
  } catch {
    return null;
  }
}

export async function readSources(urls: string[]): Promise<ScentSource[]> {
  const unique = [...new Set(urls)].slice(0, 3);
  const settled = await Promise.allSettled(unique.map(readSource));

  return settled
    .filter(
      (r): r is PromiseFulfilledResult<ScentSource | null> => r.status === "fulfilled",
    )
    .map((r) => r.value)
    .filter((v): v is ScentSource => Boolean(v));
}
