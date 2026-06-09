import * as cheerio from "cheerio";

const MAX_SOURCE_PAGE_BYTES = 2 * 1024 * 1024;
const SOURCE_PAGE_TIMEOUT_MS = 10_000;

const SOURCE_PAGE_HOSTS = [
  "fragrantica.com",
  "parfumo.com",
];

export class SourcePageImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourcePageImageError";
  }
}

function isAllowedSourcePageHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return SOURCE_PAGE_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

function parseSourcePageUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new SourcePageImageError("Invalid fragrance source URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SourcePageImageError("Source URL must be http or https");
  }
  if (parsed.username || parsed.password) {
    throw new SourcePageImageError("Source URL cannot include credentials");
  }
  if (!isAllowedSourcePageHost(parsed.hostname)) {
    throw new SourcePageImageError("Use a Fragrantica or Parfumo fragrance page URL");
  }

  return parsed;
}

function pushCandidate(candidates: string[], pageUrl: URL, value: unknown): void {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  if (!trimmed || /^data:/i.test(trimmed)) return;
  try {
    const resolved = new URL(trimmed, pageUrl).toString();
    if (!/^https?:\/\//i.test(resolved)) return;
    if (!candidates.includes(resolved)) candidates.push(resolved);
  } catch {
    /* ignore malformed page markup */
  }
}

function imageValuesFromJsonLd(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const image = record.image;
  if (typeof image === "string") return [image];
  if (Array.isArray(image)) return image.filter((item): item is string => typeof item === "string");
  if (image && typeof image === "object" && typeof (image as Record<string, unknown>).url === "string") {
    return [(image as Record<string, string>).url];
  }
  return [];
}

function collectJsonLdImageCandidates($: cheerio.CheerioAPI, pageUrl: URL, candidates: string[]): void {
  $("script[type='application/ld+json']").each((_, el) => {
    const body = $(el).text().trim();
    if (!body) return;
    try {
      const parsed = JSON.parse(body) as unknown;
      const values = Array.isArray(parsed)
        ? parsed.flatMap(imageValuesFromJsonLd)
        : imageValuesFromJsonLd(parsed);
      for (const value of values) pushCandidate(candidates, pageUrl, value);
    } catch {
      /* pages often contain invalid/stitched JSON-LD */
    }
  });
}

async function readLimitedText(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_SOURCE_PAGE_BYTES) {
    throw new SourcePageImageError("Source page is too large");
  }

  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_SOURCE_PAGE_BYTES) {
    throw new SourcePageImageError("Source page is too large");
  }
  return text;
}

export async function extractImageUrlsFromSourcePage(rawUrl: string): Promise<{
  sourcePageUrl: string;
  imageUrls: string[];
}> {
  const pageUrl = parseSourcePageUrl(rawUrl);
  const response = await fetch(pageUrl.toString(), {
    redirect: "follow",
    signal: AbortSignal.timeout(SOURCE_PAGE_TIMEOUT_MS),
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Accept: "text/html,application/xhtml+xml;q=0.95,*/*;q=0.1",
    },
  });

  if (!response.ok) {
    throw new SourcePageImageError(`Source page fetch failed with HTTP ${response.status}`);
  }

  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (contentType && !contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
    throw new SourcePageImageError("Source URL did not return an HTML fragrance page");
  }

  const html = await readLimitedText(response);
  const $ = cheerio.load(html);
  const candidates: string[] = [];

  const metaSelectors = [
    "meta[property='og:image']",
    "meta[property='og:image:url']",
    "meta[name='twitter:image']",
    "meta[name='twitter:image:src']",
    "meta[itemprop='image']",
  ];
  for (const selector of metaSelectors) {
    $(selector).each((_, el) => pushCandidate(candidates, pageUrl, $(el).attr("content")));
  }

  $("link[rel='image_src']").each((_, el) => pushCandidate(candidates, pageUrl, $(el).attr("href")));
  $("img[itemprop='image'], img[src*='mdimg/perfume'], img[src*='pimgs']").each((_, el) => {
    pushCandidate(candidates, pageUrl, $(el).attr("src") ?? $(el).attr("data-src"));
  });
  collectJsonLdImageCandidates($, pageUrl, candidates);

  if (candidates.length === 0) {
    throw new SourcePageImageError("No bottle image was found on that source page");
  }

  return {
    sourcePageUrl: pageUrl.toString(),
    imageUrls: candidates,
  };
}
