import * as cheerio from "cheerio";

const MAX_QUERY_LENGTH = 180;
const MAX_CANDIDATES = 12;

const ALLOWED_DETAIL_PATH_PREFIXES = ["/fragrances/"];
const ALLOWED_DETAIL_HOSTS = new Set(["basenotes.com", "www.basenotes.com"]);

const NOTE_SECTION_LABELS: Record<"top" | "heart" | "base", RegExp> = {
  top: /\b(top|head|opening)\s*notes?\b/i,
  heart: /\b(heart|middle|mid)\s*notes?\b/i,
  base: /\b(base|dry\s*down|drydown)\s*notes?\b/i,
};

export type BaseNotesNoteGroups = {
  top: string[];
  heart: string[];
  base: string[];
};

export type BaseNotesNotes =
  | { parsed: false }
  | { parsed: true; grouped?: BaseNotesNoteGroups; flat?: string[] };

export type BaseNotesCandidate = {
  brand: string;
  name: string;
  year?: string;
  url: string;
  searchLabel: string;
};

export type BaseNotesDetail = {
  brand: string;
  name: string;
  year?: string;
  url: string;
  searchLabel: string;
  notes: BaseNotesNotes;
  perfumer?: string;
};

export type NormalizedSelectedIdentity = {
  brand: string;
  name: string;
  year?: string;
  url: string;
  searchLabel: string;
  perfumer?: string;
  notes: BaseNotesNotes;
};

export class BaseNotesError extends Error {
  readonly status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = "BaseNotesError";
    this.status = status;
  }
}

export function sanitizeBaseNotesQuery(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .normalize("NFC")
    .replace(/<[^>]*>/g, " ")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_QUERY_LENGTH);
}

export function isAllowedBaseNotesUrl(raw: unknown): raw is string {
  if (typeof raw !== "string" || !raw) return false;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;
  const host = parsed.hostname.toLowerCase();
  if (!ALLOWED_DETAIL_HOSTS.has(host)) return false;
  const path = parsed.pathname || "/";
  if (!ALLOWED_DETAIL_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    return false;
  }
  return true;
}

export function buildSearchLabel(brand: string, name: string, year?: string): string {
  return [brand, name, year].map((part) => (part ?? "").trim()).filter(Boolean).join(" ");
}

function dedupeNotes(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values) {
    const cleaned = raw.replace(/\s+/g, " ").trim();
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(cleaned);
  }
  return result;
}

function looksLikeFragranceUrl(href: string | undefined): href is string {
  if (!href) return false;
  return /\/fragrances?\//.test(href);
}

function absoluteUrl(href: string, base: string): string | null {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

function extractYear(text: string): string | undefined {
  const match = text.match(/\b(19|20)\d{2}\b/);
  return match ? match[0] : undefined;
}

function extractBrandAndName(
  rawText: string,
  fallbackHref: string,
  opts: { allowSlugFallback?: boolean } = {},
): { brand: string; name: string } {
  const text = rawText.replace(/\s+/g, " ").trim();
  if (text.includes(" by ")) {
    const [namePart, brandPart] = text.split(/\s+by\s+/i);
    if (namePart && brandPart) {
      return {
        brand: brandPart.replace(/\s*\(\d{4}\)\s*$/, "").trim(),
        name: namePart.trim(),
      };
    }
  }
  const dashSplit = text.split(/\s+[-]\s+/);
  if (dashSplit.length >= 2) {
    return {
      brand: dashSplit[0].trim(),
      name: dashSplit.slice(1).join(" - ").trim(),
    };
  }
  // URL-slug fallback only applies for search-row anchors (where the rendered
  // text is sometimes useless); we MUST NOT clobber a real page title with a
  // slug guess, or "Mystery Juice" becomes brand="Mystery", name="Juice".
  if (opts.allowSlugFallback) {
    try {
      const slug = new URL(fallbackHref).pathname.split("/").filter(Boolean).pop() ?? "";
      const parts = slug.split("-").filter(Boolean);
      if (parts.length >= 2) {
        return {
          brand: parts[0].replace(/\b\w/g, (c) => c.toUpperCase()),
          name: parts.slice(1).join(" ").replace(/\b\w/g, (c) => c.toUpperCase()),
        };
      }
    } catch {
      /* ignore */
    }
  }
  return { brand: "", name: text };
}

export function parseBaseNotesSearchHtml(
  html: string,
  baseUrl = "https://basenotes.com/",
): BaseNotesCandidate[] {
  const $ = cheerio.load(html);
  const candidates: BaseNotesCandidate[] = [];
  const seenUrls = new Set<string>();

  $("a[href]").each((_, el) => {
    if (candidates.length >= MAX_CANDIDATES) return false;
    const href = $(el).attr("href");
    if (!looksLikeFragranceUrl(href)) return;
    const abs = absoluteUrl(href!, baseUrl);
    if (!abs || !isAllowedBaseNotesUrl(abs)) return;
    if (seenUrls.has(abs)) return;

    const text = $(el).text().replace(/\s+/g, " ").trim();
    if (!text || text.length < 2) return;

    const surrounding = $(el).closest("li, tr, .result, .search-result, article").text();
    const yearText = `${text} ${surrounding ?? ""}`;
    const year = extractYear(yearText);

    const { brand, name } = extractBrandAndName(text, abs, { allowSlugFallback: true });
    const safeName = name || text;
    if (!safeName) return;

    seenUrls.add(abs);
    candidates.push({
      brand,
      name: safeName,
      year,
      url: abs,
      searchLabel: buildSearchLabel(brand, safeName, year),
    });
    return undefined;
  });

  return candidates;
}

function parseGroupedNotes($: ReturnType<typeof cheerio.load>): BaseNotesNoteGroups | null {
  const groups: BaseNotesNoteGroups = { top: [], heart: [], base: [] };
  let foundAny = false;

  for (const key of ["top", "heart", "base"] as const) {
    const matcher = NOTE_SECTION_LABELS[key];
    let collected: string[] = [];

    $("h1, h2, h3, h4, h5, h6, strong, b, dt, .label, .note-group-title").each((_, el) => {
      if (collected.length > 0) return;
      const headingText = $(el).text().replace(/\s+/g, " ").trim();
      if (!matcher.test(headingText)) return;

      const container = $(el).next();
      if (container.length === 0) return;
      const items = container.find("li, .note, a").toArray();
      if (items.length > 0) {
        collected = items
          .map((node) => $(node).text().replace(/\s+/g, " ").trim())
          .filter((value) => value.length > 0 && value.length < 60);
      } else {
        const text = container.text();
        collected = text
          .split(/[,]/)
          .map((value) => value.replace(/\s+/g, " ").trim())
          .filter((value) => value.length > 0 && value.length < 60);
      }
    });

    const cleaned = dedupeNotes(collected);
    if (cleaned.length > 0) {
      groups[key] = cleaned;
      foundAny = true;
    }
  }

  return foundAny ? groups : null;
}

function parseFlatNotes($: ReturnType<typeof cheerio.load>): string[] {
  const candidates: string[] = [];

  $('[class*="note" i], [data-note], li.note').each((_, el) => {
    const text = $(el).text().replace(/\s+/g, " ").trim();
    if (text && text.length < 60) candidates.push(text);
  });

  if (candidates.length === 0) {
    const labelEl = $("*")
      .filter((_, el) => /^\s*notes?\s*[:\-]/i.test($(el).text()))
      .first();
    if (labelEl.length > 0) {
      const text = labelEl.text();
      const after = text.split(/notes?\s*[:\-]/i)[1] ?? "";
      candidates.push(
        ...after
          .split(/[,;]/)
          .map((value) => value.replace(/\s+/g, " ").trim())
          .filter((value) => value.length > 0 && value.length < 60),
      );
    }
  }

  return dedupeNotes(candidates).slice(0, 24);
}

function parsePerfumer($: ReturnType<typeof cheerio.load>): string | undefined {
  // Match a 1-4 word capitalized human name (allows accented letters and
  // apostrophes/hyphens within name parts) so "François Demachy" survives.
  const PERFUMER_RE =
    /(?:perfumer|nose)\s*[:\-]\s*(\p{Lu}[\p{L}'’.]+(?:[ -]\p{Lu}[\p{L}'’.]+){0,3})/iu;
  let perfumer: string | undefined;
  // Iterate over likely leaf containers so we don't match a regex against the
  // entire document body (which would absorb following section headings).
  $("p, dd, li, span, div, td").each((_, el) => {
    if (perfumer) return false;
    const text = $(el).text().replace(/\s+/g, " ").trim();
    if (!text || text.length > 240) return undefined;
    const match = text.match(PERFUMER_RE);
    if (match?.[1]) perfumer = match[1].trim();
    return undefined;
  });
  return perfumer;
}

export function parseBaseNotesDetailHtml(html: string, url: string): BaseNotesDetail {
  const $ = cheerio.load(html);

  const titleText = ($("h1").first().text() || $("title").first().text() || "").trim();
  const headingMatch = titleText.match(/^(.+?)\s+by\s+(.+?)(?:\s*\((\d{4})\))?$/i);

  let brand = "";
  let name = "";
  let year: string | undefined;
  if (headingMatch) {
    name = headingMatch[1].trim();
    brand = headingMatch[2].replace(/\s*\(\d{4}\)\s*$/, "").trim();
    year = headingMatch[3];
  } else if (titleText) {
    const parts = extractBrandAndName(titleText, url);
    brand = parts.brand;
    name = parts.name;
    year = extractYear(titleText);
  }

  if (!name) {
    throw new BaseNotesError("Could not parse fragrance name from BaseNotes page", 502);
  }

  const grouped = parseGroupedNotes($);
  const flat = grouped ? [] : parseFlatNotes($);
  const parsed = Boolean(grouped) || flat.length > 0;
  const notes: BaseNotesNotes = parsed
    ? { parsed: true, ...(grouped ? { grouped } : {}), ...(flat.length ? { flat } : {}) }
    : { parsed: false };

  const perfumer = parsePerfumer($);

  return {
    brand,
    name,
    year,
    url,
    searchLabel: buildSearchLabel(brand, name, year),
    notes,
    ...(perfumer ? { perfumer } : {}),
  };
}

export function normalizeSelectedIdentity(raw: unknown): NormalizedSelectedIdentity | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.url !== "string" || !isAllowedBaseNotesUrl(value.url)) return null;
  if (typeof value.name !== "string" || !value.name.trim()) return null;
  const brand = typeof value.brand === "string" ? value.brand.trim() : "";
  const name = value.name.trim();
  const year =
    typeof value.year === "string" && /^(19|20)\d{2}$/.test(value.year) ? value.year : undefined;
  const searchLabelRaw = typeof value.searchLabel === "string" ? value.searchLabel.trim() : "";
  const searchLabel =
    searchLabelRaw || [brand, name, year].filter(Boolean).join(" ") || name;
  const perfumer =
    typeof value.perfumer === "string" && value.perfumer.trim() ? value.perfumer.trim() : undefined;

  let notes: BaseNotesNotes = { parsed: false };
  if (value.notes && typeof value.notes === "object") {
    const candidate = value.notes as Record<string, unknown>;
    if (candidate.parsed === true) {
      const grouped =
        candidate.grouped && typeof candidate.grouped === "object"
          ? (candidate.grouped as Record<string, unknown>)
          : null;
      const flat = Array.isArray(candidate.flat)
        ? (candidate.flat as unknown[])
            .filter((n): n is string => typeof n === "string" && n.trim().length > 0)
            .map((n) => n.trim())
            .slice(0, 24)
        : undefined;
      const groupedClean = grouped
        ? {
            top: Array.isArray(grouped.top)
              ? (grouped.top as unknown[])
                  .filter((n): n is string => typeof n === "string" && n.trim().length > 0)
                  .map((n) => n.trim())
                  .slice(0, 12)
              : [],
            heart: Array.isArray(grouped.heart)
              ? (grouped.heart as unknown[])
                  .filter((n): n is string => typeof n === "string" && n.trim().length > 0)
                  .map((n) => n.trim())
                  .slice(0, 12)
              : [],
            base: Array.isArray(grouped.base)
              ? (grouped.base as unknown[])
                  .filter((n): n is string => typeof n === "string" && n.trim().length > 0)
                  .map((n) => n.trim())
                  .slice(0, 12)
              : [],
          }
        : undefined;
      const hasGrouped =
        !!groupedClean &&
        (groupedClean.top.length > 0 ||
          groupedClean.heart.length > 0 ||
          groupedClean.base.length > 0);
      const hasFlat = !!flat && flat.length > 0;
      if (hasGrouped || hasFlat) {
        notes = {
          parsed: true,
          ...(hasGrouped ? { grouped: groupedClean as BaseNotesNoteGroups } : {}),
          ...(hasFlat ? { flat } : {}),
        };
      }
    }
  }

  return { brand, name, year, url: value.url, searchLabel, perfumer, notes };
}
