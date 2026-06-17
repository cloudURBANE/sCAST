const FRAGRANCE_SEARCH_CACHE_STORAGE_KEY = "scentcast.fragranceSearchCache.v4";
const FRAGRANCE_SEARCH_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const FRAGRANCE_SEARCH_CACHE_MAX_ENTRIES = 100;
const SUPPLEMENTAL_SEARCH_MIN_RESULTS = 8;
const SEARCH_QUERY_BRAND_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ["mfk", "Maison Francis Kurkdjian"],
  ["ysl", "Yves Saint Laurent"],
  ["tf", "Tom Ford"],
  ["jpg", "Jean Paul Gaultier"],
  ["pdm", "Parfums de Marly"],
  ["eldo", "Etat Libre d'Orange"],
  ["adp", "Acqua di Parma"],
  ["atg", "Aaron Terence Hughes"],
];
const SEARCH_RANK_IGNORED_TOKENS = new Set([
  "cologne",
  "de",
  "eau",
  "edc",
  "edp",
  "edt",
  "extrait",
  "fragrance",
  "parfum",
  "perfume",
  "toilette",
]);

export type FragranceSearchOrigin = "srt" | "app";

export type FragranceSearchDiagnostics = {
  result_count?: number;
  fragrantica_linked_count?: number;
  fragrantica_unreachable?: boolean;
  fallback_source?: string | null;
  warning?: string;
} & Record<string, unknown>;

export type SourceCoverage = {
  basenotes?: boolean;
  fragrantica?: boolean;
  fragrantica_cached?: boolean;
  fragrantica_cache_source?: string;
  basenotes_linked?: boolean;
  fragrantica_linked?: boolean;
  derived_metrics?: "none" | "partial" | "complete" | "full" | string;
  complete?: boolean;
  // True only when all 4 Fragrantica status-derived metric groups
  // (performance/value/community/wear) made it through. The wardrobe
  // auto-refresh keys off this to decide whether to keep polling a partial tile.
  fragrantica_metrics_complete?: boolean;
};

export type DerivedMetrics = {
  headline?: {
    crowd_consensus_score?: number;
    crowd_consensus_score_raw?: number;
    label?: string;
    summary?: string;
    components_used?: string[];
    weight_basis?: number;
  } | null;
  fg_rating_score?: unknown | null;
  bn_sentiment_score?: unknown | null;
  performance_score?: {
    score?: number;
    score_raw?: number;
    sillage_score?: number;
    sillage_score_raw?: number;
    sillage_percent?: number;
    sillage_pct?: number;
    longevity_score?: number;
    longevity_score_raw?: number;
    longevity_percent?: number;
    longevity_pct?: number;
    longevity_label?: string;
    sillage_label?: string;
  } | null;
  value_score?: {
    score?: number;
    score_raw?: number;
    dominant_label?: string;
  } | null;
  wear_profile?: {
    primary_seasons?: string[];
    primary_time?: string;
  } | null;
  community_interest_score?: {
    score?: number;
    score_raw?: number;
  } | null;
  main_accords?: {
    accord_summary?: string;
    items?: Array<{
      label?: string;
      score?: number;
      pct?: number;
    }>;
    /** Railway engine shape — accords + model scores, or catalog 0–10 axes object */
    scent_vector?: Array<{
      accord?: string;
      score?: number;
    }>;
    top_accords?: string[];
  } | null;
  notes?: {
    has_pyramid?: boolean;
    top?: string[];
    heart?: string[];
    base?: string[];
    flat?: string[];
  } | null;
  source_coverage?: Record<string, boolean>;
};

export type FragranceSearchResult = {
  id: string;
  name: string;
  house?: string;
  brand?: string;
  year?: number | null;
  gender?: string | null;
  source_url?: string | null;
  origin?: FragranceSearchOrigin;
  bn_positive_pct?: number;
  bn_vote_count?: number;
};

export type FragranceSearchResponse = {
  query: string;
  results: FragranceSearchResult[];
  diagnostics?: FragranceSearchDiagnostics;
};

type FragranceSearchCacheEntry = {
  cachedAt: number;
  response: FragranceSearchResponse;
};

type FragranceSearchCache = Record<string, FragranceSearchCacheEntry>;

export type EnrichmentStatus =
  | "not_needed"
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | "ignored"
  | string;

export type FragranceDetail = {
  id?: string;
  name?: string;
  house?: string;
  brand?: string;
  year?: number | null;
  gender?: string | null;
  concentration?: string | null;
  season?: string | null;
  imageUrl?: string;
  image_url?: string;
  source_url?: string | null;
  source_coverage?: SourceCoverage;
  derived_metrics?: DerivedMetrics | null;
  enrichment?: {
    status?: EnrichmentStatus;
    requires_worker?: boolean;
    requested_count?: number;
    last_requested_at?: string;
    message?: string;
  } | null;
  raw?: {
    description?: string | null;
    notes?: {
      top?: string[];
      heart?: string[];
      base?: string[];
      flat?: string[];
      has_pyramid?: boolean;
    } | null;
    source_urls?: {
      bn_url?: string;
      frag_url?: string;
    } | null;
  } & Record<string, unknown>;
} & Record<string, unknown>;

export type FragranceDetailResponse = FragranceDetail;

export type FragranceDetailRequeuePayload = {
  id?: string;
  source_url?: string;
  priority?: number;
};

export type FragranceDetailRequeueResponse = {
  queued?: boolean;
  job?: {
    id?: string;
    status?: string;
  } | null;
} & Record<string, unknown>;

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string" && typeof value !== "number") continue;
    const trimmed = String(value).trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function sourceUrlFromCollection(value: unknown): string | undefined {
  if (Array.isArray(value)) return firstNonEmptyString(...value);
  const record = objectRecord(value);
  return firstNonEmptyString(record.frag_url, record.fragrantica, record.fragrantica_url, record.url);
}

function cleanFragranceUrlSegment(value: string): string {
  return value
    .replace(/\.html?$/i, "")
    .replace(/-\d+$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleCaseFragranceSegment(value: string): string {
  return value
    .split(" ")
    .filter(Boolean)
    .map((word) =>
      /^(?:edp|edt|edc|dna|oud|ysl)$/i.test(word)
        ? word.toUpperCase()
        : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(" ");
}

function decodeFragranceUrlSegment(value: string | undefined): string {
  if (!value) return "";
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

function basenotesIdentityFromUrlParts(parts: string[]): { house?: string; name?: string } {
  const fragrancesIndex = parts.findIndex((part) => /^fragrances$/i.test(part));
  const slugPart = fragrancesIndex >= 0 ? parts[fragrancesIndex + 1] : undefined;
  if (!slugPart) return {};

  const slug = slugPart.replace(/\.\d+$/i, "");
  const byIndex = slug.toLowerCase().lastIndexOf("-by-");
  if (byIndex < 0) return {};

  const name = titleCaseFragranceSegment(cleanFragranceUrlSegment(slug.slice(0, byIndex)));
  const house = titleCaseFragranceSegment(cleanFragranceUrlSegment(slug.slice(byIndex + 4)));
  return {
    ...(house ? { house } : {}),
    ...(name ? { name } : {}),
  };
}

function fragranceIdentityFromSourceUrl(
  value: string | undefined,
): { house?: string; name?: string } {
  if (!value) return {};

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return {};
  }

  const parts = parsed.pathname
    .split("/")
    .map(decodeFragranceUrlSegment)
    .filter(Boolean);

  if (parsed.hostname.toLowerCase().endsWith("basenotes.com")) {
    const basenotesIdentity = basenotesIdentityFromUrlParts(parts);
    if (basenotesIdentity.name) return basenotesIdentity;
  }

  const perfumeIndex = parts.findIndex((part) => /^perfumes?$/i.test(part));
  const housePart = perfumeIndex >= 0 ? parts[perfumeIndex + 1] : undefined;
  const namePart = perfumeIndex >= 0 ? parts[perfumeIndex + 2] : parts.at(-1);
  const house = titleCaseFragranceSegment(cleanFragranceUrlSegment(housePart ?? ""));
  const name = titleCaseFragranceSegment(cleanFragranceUrlSegment(namePart ?? ""));

  return {
    ...(house ? { house } : {}),
    ...(name ? { name } : {}),
  };
}

function decodeSearchIdPart(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const decoded = decodeURIComponent(value).trim();
    return decoded || undefined;
  } catch {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
}

function fragranceIdentityFromStructuredId(
  value: string | undefined,
): { house?: string; name?: string; sourceUrl?: string } {
  if (!value) return {};

  if (value.startsWith("source:")) {
    const sourceUrl = value.slice("source:".length).trim();
    return {
      ...fragranceIdentityFromSourceUrl(sourceUrl),
      ...(sourceUrl ? { sourceUrl } : {}),
    };
  }

  const identityMatch = /^(?:catalog|dataset):([^:]+)::(.+)$/.exec(value);
  if (identityMatch) {
    return {
      house: decodeSearchIdPart(identityMatch[1]),
      name: decodeSearchIdPart(identityMatch[2]),
    };
  }

  return {};
}

function base64UrlToBase64(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4;
  return padding ? normalized + "=".repeat(4 - padding) : normalized;
}

function decodeBase64Json(value: string): unknown {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value) || value.length < 12) return null;

  try {
    const binary = globalThis.atob(base64UrlToBase64(value));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function fragranceIdentityFromOpaqueId(
  value: string | undefined,
): { house?: string; name?: string; sourceUrl?: string } {
  if (!value) return {};
  const decoded = decodeBase64Json(value);
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return {};

  const data = decoded as Record<string, unknown>;
  const house = firstNonEmptyString(
    data.b,
    data.brand,
    data.house,
    data.brand_name,
    data.designer,
  );
  const name = firstNonEmptyString(
    data.n,
    data.name,
    data.fragrance_name,
    data.title,
    data.product_name,
  );
  const sourceUrl = firstNonEmptyString(data.fg, data.bn);

  return {
    ...(house ? { house } : {}),
    ...(name ? { name } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
  };
}

function fragranceSearchCacheKey(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

function canUseSearchCache(): boolean {
  try {
    return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
  } catch {
    return false;
  }
}

function readSearchCache(): FragranceSearchCache {
  if (!canUseSearchCache()) return {};
  try {
    const raw = window.localStorage.getItem(FRAGRANCE_SEARCH_CACHE_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as FragranceSearchCache)
      : {};
  } catch {
    return {};
  }
}

function writeSearchCache(cache: FragranceSearchCache): void {
  if (!canUseSearchCache()) return;
  try {
    window.localStorage.setItem(FRAGRANCE_SEARCH_CACHE_STORAGE_KEY, JSON.stringify(cache));
  } catch {
    /* Search cache is an optimization only. */
  }
}

function getCachedFragranceSearch(query: string): FragranceSearchResponse | null {
  const key = fragranceSearchCacheKey(query);
  if (!key) return null;
  const cache = readSearchCache();
  const entry = cache[key];
  if (!entry || !Array.isArray(entry.response?.results)) return null;
  if (Date.now() - entry.cachedAt > FRAGRANCE_SEARCH_CACHE_MAX_AGE_MS) {
    delete cache[key];
    writeSearchCache(cache);
    return null;
  }

  const cachedQuery = typeof entry.response.query === "string" ? entry.response.query : query;
  const normalizedResults = entry.response.results
    .map((result) => {
      const cachedOrigin =
        result?.origin === "app" || result?.origin === "srt" ? result.origin : "srt";
      return normalizeFragranceSearchResult(result, cachedQuery, cachedOrigin);
    })
    .filter((result): result is FragranceSearchResult => result !== null);

  return normalizedResults.length > 0
    ? {
        ...entry.response,
        query: cachedQuery,
        results: normalizedResults,
      }
    : null;
}

function cacheFragranceSearch(query: string, response: FragranceSearchResponse): void {
  const key = fragranceSearchCacheKey(query);
  if (!key || response.results.length === 0) return;

  const cache = readSearchCache();
  cache[key] = { cachedAt: Date.now(), response };

  const entries = Object.entries(cache).sort(([, a], [, b]) => b.cachedAt - a.cachedAt);
  writeSearchCache(Object.fromEntries(entries.slice(0, FRAGRANCE_SEARCH_CACHE_MAX_ENTRIES)));
}

export function normalizeFragranceSearchResult(
  value: unknown,
  fallbackQuery: string,
  fallbackOrigin: FragranceSearchOrigin = "srt",
): FragranceSearchResult | null {
  if (!value || typeof value !== "object") return null;

  const result = value as Record<string, unknown>;
  const product = objectRecord(result.product);
  const raw = objectRecord(result.raw);
  const rawSourceUrls = objectRecord(raw.source_urls);
  const rawId = firstNonEmptyString(
    result.id,
    result.fragrance_id,
    result.source_id,
    result.slug,
  );
  const structuredIdIdentity = fragranceIdentityFromStructuredId(rawId);
  const opaqueIdIdentity = fragranceIdentityFromOpaqueId(rawId);
  const sourceUrl = firstNonEmptyString(
    result.source_url,
    result.sourceUrl,
    result.url,
    result.fg_url,
    sourceUrlFromCollection(result.source_urls),
    sourceUrlFromCollection(rawSourceUrls),
    structuredIdIdentity.sourceUrl,
    opaqueIdIdentity.sourceUrl,
  );
  const sourceIdentity = fragranceIdentityFromSourceUrl(sourceUrl);
  const id = firstNonEmptyString(
    rawId,
    sourceUrl ? `source:${sourceUrl}` : undefined,
  );
  if (!id) return null;

  const name = firstNonEmptyString(
    result.name,
    result.fragrance_name,
    result.title,
    result.product_name,
    product.name,
    product.fragrance_name,
    product.title,
    product.product_name,
    sourceIdentity.name,
    structuredIdIdentity.name,
    opaqueIdIdentity.name,
  );
  if (!name) return null;
  const house = firstNonEmptyString(
    result.house,
    result.brand,
    result.brand_name,
    result.designer,
    result.house_name,
    result.designer_name,
    result.manufacturer,
    result.maker,
    result.company,
    result.perfume_house,
    result.fragrance_house,
    product.brand,
    product.house,
    product.brand_name,
    product.designer,
    sourceIdentity.house,
    structuredIdIdentity.house,
    opaqueIdIdentity.house,
  );
  const origin = result.origin === "app" || result.origin === "srt" ? result.origin : fallbackOrigin;

  return {
    ...(result as FragranceSearchResult),
    id,
    name,
    house,
    brand: firstNonEmptyString(result.brand, house),
    year: typeof result.year === "number" ? result.year : null,
    gender: typeof result.gender === "string" ? result.gender : null,
    source_url: sourceUrl ?? null,
    origin,
  };
}

/** Normalize engine main_accords whether the API used `items` or `scent_vector` / `top_accords`. */
export type MainAccordDisplayRow = { label: string; score?: number; pct?: number };

export const NUMERIC_SCENT_AXIS_KEYS = [
  "freshness",
  "sweetness",
  "woodiness",
  "spice",
  "warmth",
  "musk",
] as const;

export type NumericScentAxes = Partial<Record<(typeof NUMERIC_SCENT_AXIS_KEYS)[number], number>>;

const SCENT_AXIS_LABELS: Record<(typeof NUMERIC_SCENT_AXIS_KEYS)[number], string> = {
  freshness: "Freshness",
  sweetness: "Sweetness",
  woodiness: "Woodiness",
  spice: "Spice",
  warmth: "Warmth",
  musk: "Musk",
};

function mainAccordsScentVectorRaw(main: DerivedMetrics["main_accords"]): unknown {
  return (main as { scent_vector?: unknown }).scent_vector;
}

function isPlainObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** Map a normalized row onto 0–100 bar width for the accord chart. */
export function normalizedAccordBarPct(
  row: MainAccordDisplayRow,
  rankIndex = 0,
  rankTotal = 1,
): number {
  if (typeof row.pct === "number" && Number.isFinite(row.pct)) {
    return Math.round(Math.max(14, Math.min(100, row.pct)));
  }
  if (typeof row.score === "number" && Number.isFinite(row.score)) {
    const s = row.score;
    if (s <= 10.75) return Math.round(Math.max(14, Math.min(100, (s / 10) * 100)));
    return Math.round(Math.max(14, Math.min(100, s)));
  }
  const n = Math.max(1, rankTotal);
  if (n <= 1) return 90;
  return Math.round(
    Math.max(38, Math.min(96, 96 - rankIndex * ((96 - 38) / (n - 1)))),
  );
}

/** Catalog / wardrobe 0–10 axes when derived_metrics lacks explicit accord bars. */
export function axesVectorToMainAccordRows(axes?: NumericScentAxes | null): MainAccordDisplayRow[] {
  if (!axes) return [];

  const rows: MainAccordDisplayRow[] = [];
  for (const key of NUMERIC_SCENT_AXIS_KEYS) {
    const raw = axes[key];
    if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
    const bounded = Math.max(0, Math.min(10, raw));
    rows.push({
      label: SCENT_AXIS_LABELS[key],
      score: bounded,
      pct: Math.round((bounded / 10) * 100),
    });
  }

  rows.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return rows;
}

function scentAxisObjectRows(vector: Record<string, unknown>): MainAccordDisplayRow[] {
  const axes: NumericScentAxes = {};
  for (const key of NUMERIC_SCENT_AXIS_KEYS) {
    const raw = vector[key];
    if (typeof raw === "number" && Number.isFinite(raw)) {
      axes[key] = raw;
    }
  }
  return axesVectorToMainAccordRows(axes);
}

export function collectMainAccordDisplayRows(
  main: DerivedMetrics["main_accords"] | null | undefined,
): MainAccordDisplayRow[] {
  if (!main) return [];

  const fromItems =
    main.items
      ?.map((item) => ({
        label: typeof item.label === "string" ? item.label.trim() : "",
        score: typeof item.score === "number" ? item.score : undefined,
        pct: typeof item.pct === "number" ? item.pct : undefined,
      }))
      .filter((row) => row.label) ?? [];

  if (fromItems.length > 0) return fromItems;

  const svRaw = mainAccordsScentVectorRaw(main);

  if (Array.isArray(svRaw)) {
    const fromVector = svRaw
      .map((row) => {
        if (!row || typeof row !== "object") return { label: "" };
        const item = row as { accord?: unknown; score?: unknown };
        return {
          label: typeof item.accord === "string" ? item.accord.trim() : "",
          score: typeof item.score === "number" ? item.score : undefined,
        };
      })
      .filter((row) => row.label);

    if (fromVector.length > 0) return fromVector;
  }

  if (isPlainObjectRecord(svRaw)) {
    const fromAxes = scentAxisObjectRows(svRaw);
    if (fromAxes.length > 0) return fromAxes;
  }

  const top = (main.top_accords ?? [])
    .map((a) => (typeof a === "string" ? a.trim() : ""))
    .filter(Boolean);

  if (top.length === 0) return [];

  return top.map((label, i, arr) => ({
    label,
    pct:
      arr.length <= 1
        ? 90
        : Math.round(Math.max(42, Math.min(96, 96 - i * ((96 - 42) / (arr.length - 1))))),
  }));
}

/** Prefer engine main_accords; fall back to profile-level 0–10 scent axes (wardrobe / catalog). */
export function resolveMainAccordChartRows(
  mainAccords: DerivedMetrics["main_accords"] | null | undefined,
  scentAxesFallback?: NumericScentAxes | null,
): MainAccordDisplayRow[] {
  const direct = collectMainAccordDisplayRows(mainAccords);
  if (direct.length > 0) return direct;
  return axesVectorToMainAccordRows(scentAxesFallback);
}

function hasString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function hasNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

function hasStringArrayContent(value: unknown): boolean {
  return Array.isArray(value) && value.some((item) => hasString(item));
}

function normalizedStatus(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function hasDerivedMetricsPayload(metrics?: DerivedMetrics | null): boolean {
  if (!metrics) return false;

  const headline = metrics.headline;
  const performance = metrics.performance_score;
  const value = metrics.value_score;
  const wear = metrics.wear_profile;
  const community = metrics.community_interest_score;
  const mainAccords = metrics.main_accords;
  const notes = metrics.notes;

  return Boolean(
    hasString(headline?.summary) ||
      hasString(headline?.label) ||
      hasNumber(headline?.crowd_consensus_score) ||
      hasNumber(headline?.crowd_consensus_score_raw) ||
      hasNumber(performance?.score) ||
      hasNumber(performance?.score_raw) ||
      hasString(performance?.longevity_label) ||
      hasString(performance?.sillage_label) ||
      hasNumber(value?.score) ||
      hasNumber(value?.score_raw) ||
      hasString(value?.dominant_label) ||
      hasStringArrayContent(wear?.primary_seasons) ||
      hasString(wear?.primary_time) ||
      hasNumber(community?.score) ||
      hasNumber(community?.score_raw) ||
      hasString(mainAccords?.accord_summary) ||
      collectMainAccordDisplayRows(mainAccords).length > 0 ||
      hasStringArrayContent(notes?.top) ||
      hasStringArrayContent(notes?.heart) ||
      hasStringArrayContent(notes?.base) ||
      hasStringArrayContent(notes?.flat),
  );
}

export function isDerivedMetricsCompleteFlag(value: unknown): boolean {
  const status = normalizedStatus(value);
  return status === "complete" || status === "completed" || status === "full";
}

export function isSourceCoverageComplete(coverage?: SourceCoverage | null): boolean {
  if (!coverage) return false;
  return (
    coverage.basenotes === true &&
    coverage.fragrantica === true &&
    (coverage.complete === true ||
      coverage.fragrantica_metrics_complete === true ||
      isDerivedMetricsCompleteFlag(coverage.derived_metrics))
  );
}

const VERIFIED_SOURCE_PROFILE_COPY = "Verified community-source profile available.";
const PARTIAL_SOURCE_PROFILE_COPY = "Community-source profile available. Source coverage is incomplete.";

const ENRICHMENT_STATUS_COPY: Record<string, string> = {
  not_needed: VERIFIED_SOURCE_PROFILE_COPY,
  pending: "Enhanced metrics queued.",
  processing: "Enhanced metrics are being prepared.",
  completed: "Enhanced metrics available.",
  failed: "Enhanced metrics unavailable right now.",
  ignored: "Enhancement not scheduled for this fragrance.",
};

export type SourceStatusResolution = {
  hasCoverage: boolean;
  complete: boolean;
  badgeLabel: "Complete" | "Partial" | null;
  summary: string | null;
  sourceCount: number;
  sourceCountLabel: string | null;
  metricsLabel: string | null;
  enrichmentMessage: string | null;
  statusText: string | null;
  shouldShowEnrichmentMessage: boolean;
};

function enrichmentStatusCopy(enrichment?: FragranceDetail["enrichment"] | null): string | null {
  const message = enrichment?.message?.trim();
  if (message) return message;
  const status = normalizedStatus(enrichment?.status);
  return status ? ENRICHMENT_STATUS_COPY[status] ?? null : null;
}

export function resolveSourceStatus(
  coverage?: SourceCoverage | null,
  enrichment?: FragranceDetail["enrichment"] | null,
  emptyFallback: string | null = null,
): SourceStatusResolution {
  const hasCoverage = Boolean(coverage && Object.keys(coverage).length > 0);
  const complete = isSourceCoverageComplete(coverage);
  const sourceCount =
    (coverage?.basenotes === true ? 1 : 0) + (coverage?.fragrantica === true ? 1 : 0);
  const summary = hasCoverage
    ? complete
      ? VERIFIED_SOURCE_PROFILE_COPY
      : PARTIAL_SOURCE_PROFILE_COPY
    : null;
  const hasCustomEnrichmentMessage = Boolean(enrichment?.message?.trim());
  const enrichmentStatus = normalizedStatus(enrichment?.status);
  const rawEnrichmentMessage = enrichmentStatusCopy(enrichment);
  const enrichmentMessage =
    !complete &&
    !hasCustomEnrichmentMessage &&
    (enrichmentStatus === "not_needed" || enrichmentStatus === "completed")
      ? null
      : rawEnrichmentMessage;
  const statusText = hasCoverage ? summary : enrichmentMessage ?? emptyFallback;

  return {
    hasCoverage,
    complete,
    badgeLabel: hasCoverage ? (complete ? "Complete" : "Partial") : null,
    summary,
    sourceCount,
    sourceCountLabel: hasCoverage ? `Sources ${sourceCount} of 2` : null,
    metricsLabel: hasCoverage ? (complete ? "Metrics ready" : "Metric coverage incomplete") : null,
    enrichmentMessage,
    statusText,
    shouldShowEnrichmentMessage: Boolean(
      hasCoverage && enrichmentMessage && enrichmentMessage !== summary,
    ),
  };
}

export function isTerminalEnrichmentStatus(value: unknown): boolean {
  const status = normalizedStatus(value);
  return (
    status === "completed" ||
    status === "complete" ||
    status === "not_needed" ||
    status === "failed" ||
    status === "ignored" ||
    status === "cancelled"
  );
}

export function isBackgroundEnrichmentQueued(
  enrichment?: FragranceDetail["enrichment"] | null,
): boolean {
  const status = normalizedStatus(enrichment?.status);
  if (status && isTerminalEnrichmentStatus(status)) return false;
  return status === "pending" || status === "processing" || (status === "" && enrichment?.requires_worker === true);
}

export function isFragranceDetailEffectivelyComplete(
  detail?: FragranceDetail | null,
): boolean {
  if (!detail) return false;
  return isSourceCoverageComplete(detail.source_coverage);
}

export function normalizeSourceCoverage(
  coverage?: SourceCoverage | null,
  metrics?: DerivedMetrics | null,
  _enrichment?: FragranceDetail["enrichment"] | null,
): SourceCoverage | undefined {
  const hasCoverage = coverage && Object.keys(coverage).length > 0;
  const hasMetrics = hasDerivedMetricsPayload(metrics);
  if (!hasCoverage && !hasMetrics) return coverage ?? undefined;

  const next: SourceCoverage = { ...(coverage ?? {}) };
  next.complete = isSourceCoverageComplete(next);

  if (!next.derived_metrics && hasMetrics) {
    next.derived_metrics = next.complete ? "complete" : "partial";
  }

  return next;
}

export function normalizeFragranceDetail(detail: FragranceDetail): FragranceDetail {
  const source_coverage = normalizeSourceCoverage(
    detail.source_coverage,
    detail.derived_metrics,
    detail.enrichment,
  );
  return source_coverage ? { ...detail, source_coverage } : detail;
}

function viteEnv(key: string): string | undefined {
  return (
    (import.meta as { env?: Record<string, string | undefined> }).env?.[key] ??
    (typeof process !== "undefined" ? process.env?.[key] : undefined)
  );
}

function getFragranceEngineApiBase() {
  const appBase = getAppApiBase();
  // Production Vercel leaves VITE_API_BASE_URL empty so browser calls stay same-origin.
  // Cross-origin Railway fetches often fail for guests (ad blockers, privacy mode, CORP).
  if (!appBase) {
    return "/api/engine";
  }

  const direct = viteEnv("VITE_FRAGRANCE_API_URL")?.trim();
  if (direct) {
    return direct.replace(/\/+$/, "");
  }

  return `${appBase}/api/engine`;
}

function usesFragranceEngineProxy(base: string): boolean {
  const normalized = base.replace(/\/+$/, "");
  return normalized === "/api/engine" || normalized.endsWith("/api/engine");
}

function fragranceEngineUrl(path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const base = getFragranceEngineApiBase().replace(/\/+$/, "");
  if (usesFragranceEngineProxy(base)) {
    return `${base}${normalizedPath}`;
  }
  return `${base}/api${normalizedPath}`;
}

export function isFetchNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "AbortError") return false;
  // Browsers report a failed fetch with engine-specific messages:
  // Chromium/Firefox → "Failed to fetch" / "NetworkError"; WebKit (Safari,
  // iOS/iPadOS) → "Load failed". Match all so the same-origin engine fallbacks
  // engage on every browser, not just Chromium.
  return (
    err.message === "Failed to fetch" ||
    err.message === "Load failed" ||
    err.message.includes("NetworkError")
  );
}

function isFragranceEngineTransportError(err: unknown): boolean {
  if (isFetchNetworkError(err)) return true;
  if (!(err instanceof Error)) return false;
  return err.message.startsWith("Fragrance engine request failed:");
}

/**
 * A detail fetch that fails on a network blip or a 5xx is transient: the selected
 * search result itself is valid, so callers can fall back to a best-effort profile
 * from its brand/name rather than failing the whole add. A 4xx (e.g. a genuine
 * "not found") is a real failure and returns false so it surfaces unchanged.
 * Matches the `Fragrance detail fetch failed: <status>` message thrown by
 * {@link getFragranceDetails}.
 */
export function isTransientDetailFetchError(err: unknown): boolean {
  if (isFetchNetworkError(err)) return true;
  if (err instanceof Error) {
    const match = err.message.match(/fetch failed:\s*(\d{3})/i);
    if (match) return Number(match[1]) >= 500;
  }
  return false;
}

function directFragranceEngineUrl(path: string): string | null {
  const direct = viteEnv("VITE_FRAGRANCE_API_URL")?.trim();
  if (!direct) return null;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${direct.replace(/\/+$/, "")}/api${normalizedPath}`;
}

// Backoff schedule (ms) for transient-network/5xx retries of the primary engine
// request. A Railway cold start or deploy/OOM restart leaves the host briefly
// unreachable (a few seconds), which the browser surfaces as a "Failed to fetch"
// — the exact error that drives the "temporarily unavailable" banner. Retrying
// across that window lets a momentary blip self-heal instead of erroring out.
// Lengths chosen to span a typical restart while keeping the truly-down case
// from feeling sluggish (worst added latency ≈ 1.7s before falling through).
const ENGINE_RETRY_BACKOFF_MS = [500, 1200] as const;

type FragranceEngineFetchOptions = {
  retryBackoffMs?: readonly number[];
};

function abortableSleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// True for failures that a brief retry can plausibly recover: a thrown
// browser-level network error (host momentarily unreachable) or a 5xx surfaced
// as our wrapped engine error. 4xx and aborts are intentionally excluded.
function isRetriableEngineError(err: unknown): boolean {
  if (isFetchNetworkError(err)) return true;
  return (
    err instanceof Error &&
    err.message.startsWith("Fragrance engine request failed:")
  );
}

async function fetchFragranceEngine(
  path: string,
  init?: RequestInit,
  options: FragranceEngineFetchOptions = {},
): Promise<Response> {
  const [pathname, query = ""] = path.split("?", 2);
  const querySuffix = query ? `?${query}` : "";
  const primaryUrl = `${fragranceEngineUrl(pathname)}${querySuffix}`;
  const retryBackoffMs = options.retryBackoffMs ?? ENGINE_RETRY_BACKOFF_MS;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retryBackoffMs.length; attempt++) {
    try {
      const res = await fetch(primaryUrl, init);
      if (res.ok || res.status < 500) return res;
      lastError = new Error(`Fragrance engine request failed: ${res.status}`);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw err;
      lastError = err;
    }

    // Retry the primary across a transient blip before falling through to the
    // direct fallback / surfacing the error. Only retry recoverable failures,
    // and only while attempts remain.
    if (
      attempt < retryBackoffMs.length &&
      isRetriableEngineError(lastError)
    ) {
      await abortableSleep(retryBackoffMs[attempt]!, init?.signal);
      continue;
    }
    break;
  }

  const fallbackUrl = directFragranceEngineUrl(pathname);
  const fallbackRequestUrl = fallbackUrl ? `${fallbackUrl}${querySuffix}` : null;
  if (fallbackRequestUrl && fallbackRequestUrl !== primaryUrl) {
    return fetch(fallbackRequestUrl, init);
  }

  if (lastError instanceof Error) throw lastError;
  throw new Error("Fragrance engine request failed");
}

function getSearchApiBase() {
  return getFragranceEngineApiBase();
}

function getAppApiBase() {
  return (viteEnv("VITE_API_BASE_URL")?.trim() || "").replace(/\/+$/, "");
}

function appApiUrl(path: string) {
  const base = getAppApiBase();
  return base ? `${base}${path}` : path;
}

function normalizeSearchDiagnostics(value: unknown): FragranceSearchDiagnostics | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as FragranceSearchDiagnostics;
}

function normalizeForDedupe(value: unknown): string {
  return firstNonEmptyString(value)
    ?.toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ") ?? "";
}

/**
 * Strip diacritics and non-alphanumeric symbols (accents, ®, ™, punctuation)
 * from a search query, collapsing runs of whitespace to a single space. Case is
 * preserved — the Google-backed engine is case-insensitive, and the SPA feeds
 * the result straight back into the visible search input.
 *
 * This is the single source of truth shared by two call sites: the automatic
 * zero-result retry in {@link searchFragrances} below, and the manual "Remove
 * symbols" recovery chip in FragranceCapture. Mirrors NFD (not NFKD) so a
 * trademark glyph like "™" is dropped rather than expanded to the letters "TM".
 */
export function sanitizeEngineQuery(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function expandKnownSearchBrandAlias(query: string): string {
  const normalized = normalizeForDedupe(query);
  if (!normalized) return query.trim();
  const queryTokens = normalized.split(" ").filter(Boolean);

  for (const [alias, expandedBrand] of SEARCH_QUERY_BRAND_ALIASES) {
    const aliasTokens = alias.split(" ");
    const matchesAliasPrefix = aliasTokens.every((token, index) => queryTokens[index] === token);
    if (!matchesAliasPrefix) continue;

    const remainder = queryTokens.slice(aliasTokens.length).join(" ");
    return [expandedBrand, remainder].filter(Boolean).join(" ");
  }

  return query.trim();
}

function searchRankTokens(value: unknown): string[] {
  return normalizeForDedupe(value)
    .split(" ")
    .filter((token) => token.length > 1 && !SEARCH_RANK_IGNORED_TOKENS.has(token));
}

function tokenCoverage(wanted: string[], candidate: Set<string>): number {
  if (wanted.length === 0) return 0;
  const matched = wanted.filter((token) => candidate.has(token)).length;
  return matched / wanted.length;
}

function fragranceIdentityKey(result: FragranceSearchResult): string {
  const house = normalizeForDedupe(result.house ?? result.brand);
  const name = normalizeForDedupe(result.name);
  if (house || name) return `${house}::${name}`;
  return normalizeForDedupe(result.source_url ?? result.id);
}

function hasResolvedSearchHouse(result: FragranceSearchResult): boolean {
  return Boolean(firstNonEmptyString(result.house, result.brand));
}

function isBrandOnlyArchiveResult(result: FragranceSearchResult): boolean {
  // A brand-only "archive" placeholder has its name equal to its house and no
  // real source page behind it — it is never an openable fragrance.
  if (firstNonEmptyString(result.source_url)) return false;
  const name = normalizeForDedupe(result.name);
  const house = normalizeForDedupe(result.house ?? result.brand);
  if (!name || !house || name !== house) return false;

  const id = firstNonEmptyString(result.id) ?? "";
  // App-search ids carry an explicit catalog:/dataset: prefix. The Python engine
  // instead base64-encodes its candidate ids (api.py:_encode_id), so its
  // placeholders slip past a prefix check — decode the opaque token and treat a
  // source-less brand==name identity as the very same brand-only card.
  if (id.startsWith("catalog:") || id.startsWith("dataset:")) return true;
  if (id.startsWith("source:")) return false;
  const opaque = fragranceIdentityFromOpaqueId(id);
  return Boolean(opaque.house || opaque.name);
}

function normalizedInitials(value: unknown): string {
  return normalizeForDedupe(value)
    .split(" ")
    .filter(Boolean)
    .map((word) => word[0])
    .join("");
}

function looksLikeGeneratedToken(value: unknown): boolean {
  const normalized = normalizeForDedupe(value);
  return /^[a-z0-9]{6,12}$/.test(normalized) && /[a-z]/.test(normalized) && /\d/.test(normalized);
}

function searchResultMatchesQueryIntent(query: string, result: FragranceSearchResult): boolean {
  const normalizedQuery = normalizeForDedupe(query);
  if (!normalizedQuery) return true;

  const name = normalizeForDedupe(result.name);
  const house = normalizeForDedupe(result.house ?? result.brand);
  const combined = [house, name, normalizedInitials(result.house ?? result.brand)].filter(Boolean).join(" ");
  if (!combined) return false;

  const queryTokens = normalizedQuery
    .split(" ")
    .filter((token) => token.length > 1);
  if (queryTokens.length === 0) return true;

  if (house === normalizedQuery || name === normalizedQuery || combined.includes(normalizedQuery)) {
    return true;
  }

  const matched = queryTokens.filter((token) => combined.includes(token)).length;
  return matched / queryTokens.length >= 0.5;
}

function hasDisplayableSearchIdentity(query: string, result: FragranceSearchResult): boolean {
  const name = firstNonEmptyString(result.name);
  const house = firstNonEmptyString(result.house, result.brand);
  if (!name || !house) return false;
  if (looksLikeGeneratedToken(name) || looksLikeGeneratedToken(house)) return false;
  if (isBrandOnlyArchiveResult(result)) return false;
  return searchResultMatchesQueryIntent(query, result);
}

function mergeSearchResults(
  primary: FragranceSearchResult[],
  supplemental: FragranceSearchResult[],
): FragranceSearchResult[] {
  const seen = new Set<string>();
  const merged: FragranceSearchResult[] = [];

  for (const result of [...primary, ...supplemental]) {
    const key = fragranceIdentityKey(result);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(result);
  }

  return merged;
}

function scoreSearchResultForQuery(query: string, result: FragranceSearchResult): number {
  const expandedQuery = expandKnownSearchBrandAlias(query);
  const queryTokens = searchRankTokens(expandedQuery);
  if (queryTokens.length === 0) return 0;

  const houseTokens = searchRankTokens(result.house ?? result.brand);
  const nameTokens = searchRankTokens(result.name);
  const fullTokenList = [...houseTokens, ...nameTokens];
  const houseInitials = normalizedInitials(result.house ?? result.brand);
  if (houseInitials) fullTokenList.push(houseInitials);
  const fullTokens = new Set(fullTokenList);
  const houseTokenSet = new Set(houseTokens);
  const nameTokenSet = new Set(nameTokens);
  const queryTokenSet = new Set(queryTokens);
  const nameIntentTokens = queryTokens.filter((token) => !houseTokenSet.has(token));

  const normalizedQuery = normalizeForDedupe(expandedQuery);
  const normalizedName = normalizeForDedupe(result.name);
  const normalizedFull = normalizeForDedupe([result.house ?? result.brand, result.name].filter(Boolean).join(" "));
  const nameCoverage = tokenCoverage(nameIntentTokens.length > 0 ? nameIntentTokens : queryTokens, nameTokenSet);
  const overallCoverage = tokenCoverage(queryTokens, fullTokens);
  const brandCoverage = tokenCoverage(queryTokens, houseTokenSet);

  let score = overallCoverage * 40 + nameCoverage * 55 + brandCoverage * 15;
  if (normalizedFull && normalizedFull === normalizedQuery) score += 100;
  if (normalizedName && normalizedName === normalizedQuery) score += 70;
  if (normalizedName && normalizedQuery.includes(normalizedName)) score += 40;
  if (normalizedFull && normalizedFull.includes(normalizedQuery)) score += 30;

  if (nameIntentTokens.length > 0) {
    const extraNameTokens = nameTokens.filter((token) => !queryTokenSet.has(token)).length;
    score -= extraNameTokens * 7;
  }

  return score;
}

function rankSearchResultsByQuery(
  query: string,
  results: FragranceSearchResult[],
): FragranceSearchResult[] {
  return results
    .map((result, index) => ({
      result,
      index,
      score: scoreSearchResultForQuery(query, result),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ result }) => result);
}

function hasDegradedBreadth(diagnostics: FragranceSearchDiagnostics | undefined): boolean {
  if (!diagnostics || !("fallback_source" in diagnostics)) return false;
  return diagnostics.fallback_source !== null && diagnostics.fallback_source !== undefined;
}

function queryMatchesResultHouse(query: string, results: FragranceSearchResult[]): boolean {
  const normalizedQuery = normalizeForDedupe(query);
  if (!normalizedQuery || results.length === 0) return false;

  return results.some((result) => {
    const house = normalizeForDedupe(result.house ?? result.brand);
    return house === normalizedQuery;
  });
}

function shouldSupplementWithAppSearch(
  query: string,
  response: FragranceSearchResponse,
): boolean {
  if (hasDegradedBreadth(response.diagnostics)) return true;
  if (response.results.length === 0) return true;
  return (
    response.results.length < SUPPLEMENTAL_SEARCH_MIN_RESULTS &&
    queryMatchesResultHouse(query, response.results)
  );
}

async function apiErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const data = await res.clone().json();
    if (typeof data?.detail === "string" && data.detail.trim()) return data.detail;
    if (typeof data?.error === "string" && data.error.trim()) return data.error;
    if (typeof data?.message === "string" && data.message.trim()) return data.message;
  } catch {
    try {
      const text = await res.text();
      if (text.trim()) return text.trim();
    } catch {
      /* fall through to fallback */
    }
  }

  return fallback;
}

/**
 * Raised when a response body is empty or non-JSON. Vercel edge middleware
 * strips content-length/encoding, cold-start gateways serve HTML, and 204/empty
 * 2xx bodies all reach the client — calling `res.json()` on those throws an
 * opaque `SyntaxError: Unexpected end of JSON input`. This carries a clear
 * message and a stable `name`, so resilient callers can fall back instead of
 * surfacing a crash.
 */
class FragranceResponseBodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FragranceResponseBodyError";
  }
}

function isResponseBodyError(err: unknown): err is FragranceResponseBodyError {
  return err instanceof Error && err.name === "FragranceResponseBodyError";
}

async function parseJsonResponse<T>(res: Response, context: string): Promise<T> {
  let text: string;
  try {
    text = await res.text();
  } catch {
    throw new FragranceResponseBodyError(`${context} response could not be read.`);
  }
  if (!text.trim()) {
    throw new FragranceResponseBodyError(`${context} returned an empty response.`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new FragranceResponseBodyError(`${context} returned a malformed response.`);
  }
}

/**
 * Public search entry point. Runs the live search once, and — when a query
 * carrying accents or symbols ("LANCÔME Idôle", "BORNTOSTANDOUT®") comes back
 * empty — automatically retries a single time with a sanitized ASCII form
 * before the caller surfaces "no matches". The live engine is Google-backed and
 * those glyphs can sink an otherwise-findable query; this mirrors the manual
 * "Remove symbols" recovery chip in FragranceCapture so the user no longer has
 * to trigger it by hand.
 *
 * Purely additive: the retry only fires after the raw query already returned
 * zero results, so it can never change a search that already succeeded. The
 * caller's original query string is preserved on the returned response, and the
 * result is cached under that original query.
 */
export async function searchFragrances(
  query: string,
  options?: { signal?: AbortSignal },
): Promise<FragranceSearchResponse> {
  const cached = getCachedFragranceSearch(query);
  if (cached) return cached;

  let response = await executeFragranceSearch(query, options);

  if (response.results.length === 0) {
    const sanitized = sanitizeEngineQuery(query);
    if (sanitized && sanitized.toLowerCase() !== query.trim().toLowerCase()) {
      try {
        const retried = await executeFragranceSearch(sanitized, options);
        if (retried.results.length > 0) {
          response = { ...retried, query };
        }
      } catch (err) {
        // Re-throw genuine aborts so a cancelled search stays cancelled; swallow
        // anything else — the sanitized pass is best-effort recovery and must
        // not turn a clean empty result into a surfaced error.
        if (err instanceof Error && err.name === "AbortError") throw err;
      }
    }
  }

  cacheFragranceSearch(query, response);
  return response;
}

async function executeFragranceSearch(
  query: string,
  options?: { signal?: AbortSignal },
): Promise<FragranceSearchResponse> {
  const requestQuery = expandKnownSearchBrandAlias(query);

  let data: unknown;
  try {
    const res = await fetchFragranceEngine(
      `/fragrances/search?q=${encodeURIComponent(requestQuery)}`,
      { signal: options?.signal },
      { retryBackoffMs: [] },
    );

    if (res.status >= 500) {
      return await searchAppFragrances(requestQuery, options, query);
    }

    if (!res.ok) {
      throw new Error(await apiErrorMessage(res, `Fragrance search failed: ${res.status}`));
    }

    data = await parseJsonResponse(res, "Fragrance search");
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw err;
    // A transport failure or a 2xx with an empty/HTML body (truncated proxy
    // response, cold-start gateway page) both mean the engine gave us nothing
    // usable — try the Express app search before surfacing the error.
    if (isFragranceEngineTransportError(err) || isResponseBodyError(err)) {
      try {
        return await searchAppFragrances(requestQuery, options, query);
      } catch (fallbackErr) {
        if (fallbackErr instanceof Error && fallbackErr.name === "AbortError") throw fallbackErr;
      }
    }
    throw err;
  }

  const rawResults: unknown[] = Array.isArray(data)
    ? data
    : Array.isArray((data as { results?: unknown[] })?.results)
      ? (data as { results: unknown[] }).results
      : [];

  const response: FragranceSearchResponse = {
    query,
    results: rawResults
      .map((result) => normalizeFragranceSearchResult(result, requestQuery, "srt"))
      .filter((result): result is FragranceSearchResult => {
        return result !== null && hasDisplayableSearchIdentity(query, result);
      }),
    diagnostics: normalizeSearchDiagnostics((data as { diagnostics?: unknown })?.diagnostics),
  };

  if (shouldSupplementWithAppSearch(requestQuery, response)) {
    try {
      const supplemental = await searchAppFragrances(requestQuery, { signal: options?.signal }, query);
      response.results = mergeSearchResults(
        response.results,
        supplemental.results.filter(hasResolvedSearchHouse),
      );
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw err;
      if (response.results.length === 0) {
        throw err;
      }
    }
  }

  response.results = rankSearchResultsByQuery(query, response.results);
  return response;
}

async function searchAppFragrances(
  query: string,
  options?: { signal?: AbortSignal },
  originalQuery = query,
): Promise<FragranceSearchResponse> {
  const res = await fetch(
    appApiUrl(`/api/fragrances/search?q=${encodeURIComponent(query)}`),
    { signal: options?.signal },
  );

  if (!res.ok) {
    throw new Error(await apiErrorMessage(res, `App fragrance search failed: ${res.status}`));
  }

  const data = await parseJsonResponse<unknown>(res, "App fragrance search");
  const payload = objectRecord(data);
  const rawResults: unknown[] = Array.isArray(data)
    ? data
    : Array.isArray(payload.results)
      ? (payload.results as unknown[])
      : [];

  const results = rawResults
    .map((result) => normalizeFragranceSearchResult(result, query, "app"))
    .filter((result): result is FragranceSearchResult => {
      return result !== null && hasDisplayableSearchIdentity(originalQuery, result);
    });

  return {
    query: originalQuery,
    results: rankSearchResultsByQuery(originalQuery, results),
    diagnostics: normalizeSearchDiagnostics(payload.diagnostics),
  };
}

type FragranceDetailRequestOptions = {
  origin?: FragranceSearchOrigin;
  recover_incomplete?: boolean;
};

export type FragranceDetailRequestPayload =
  | ({ id: string; source_url?: string } & FragranceDetailRequestOptions)
  | ({ source_url: string; id?: never } & FragranceDetailRequestOptions);

export async function getFragranceDetails(
  payload: FragranceDetailRequestPayload,
  options?: { signal?: AbortSignal },
): Promise<FragranceDetailResponse> {
  const id = "id" in payload && typeof payload.id === "string" ? payload.id : "";
  const useAppApi =
    payload.origin === "app" ||
    id.startsWith("catalog:") ||
    id.startsWith("dataset:") ||
    id.startsWith("local:");
  const requestBody = {
    ...("id" in payload ? { id: payload.id } : {}),
    ...("source_url" in payload && payload.source_url ? { source_url: payload.source_url } : {}),
    ...(payload.recover_incomplete ? { recover_incomplete: true } : {}),
  };
  const requestInit: RequestInit = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
    signal: options?.signal,
  };

  const fetchAppDetails = () => fetch(appApiUrl("/api/fragrances/details"), requestInit);
  const parseAppDetailsFallback = async (): Promise<FragranceDetailResponse> => {
    const fallbackRes = await fetchAppDetails();
    if (fallbackRes.ok) {
      return parseJsonResponse<FragranceDetailResponse>(fallbackRes, "Fragrance detail");
    }
    throw new Error(await apiErrorMessage(fallbackRes, `Fragrance detail fetch failed: ${fallbackRes.status}`));
  };
  let res: Response;
  try {
    res = useAppApi
      ? await fetchAppDetails()
      : await fetchFragranceEngine("/fragrances/details", requestInit, { retryBackoffMs: [] });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw err;
    if (!useAppApi && isFragranceEngineTransportError(err)) {
      res = await fetchAppDetails();
    } else {
      throw err;
    }
  }

  if (!res.ok) {
    if (!useAppApi && res.status >= 500) {
      return parseAppDetailsFallback();
    }
    throw new Error(await apiErrorMessage(res, `Fragrance detail fetch failed: ${res.status}`));
  }

  try {
    return await parseJsonResponse<FragranceDetailResponse>(res, "Fragrance detail");
  } catch (err) {
    if (!useAppApi && isResponseBodyError(err)) {
      return parseAppDetailsFallback();
    }
    throw err;
  }
}

export async function requeueFragranceDetails(
  payload: FragranceDetailRequeuePayload,
  options?: { signal?: AbortSignal },
): Promise<FragranceDetailRequeueResponse> {
  const id = firstNonEmptyString(payload.id);
  const sourceUrl = firstNonEmptyString(payload.source_url);
  if (!id && !sourceUrl) {
    throw new Error("Fragrance refresh needs an engine id or source URL.");
  }

  const res = await fetchFragranceEngine("/fragrances/details/requeue", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ...(id ? { id } : {}),
      ...(sourceUrl ? { source_url: sourceUrl } : {}),
      priority: typeof payload.priority === "number" ? payload.priority : 10,
    }),
    signal: options?.signal,
  });

  if (!res.ok) {
    throw new Error(await apiErrorMessage(res, `Fragrance refresh requeue failed: ${res.status}`));
  }

  return parseJsonResponse<FragranceDetailRequeueResponse>(res, "Fragrance refresh");
}

export type FragranceRawReview = { text: string; source?: string };

export type SummarizedComment = {
  text: string;
  theme: "performance" | "season" | "vibe" | "general";
};

const reviewSummaryMemoryCache = new Map<string, SummarizedComment[]>();

const REVIEW_SUMMARY_STORAGE_PREFIX = "scent_review_summary:";
const REVIEW_SUMMARY_THEMES = ["performance", "season", "vibe", "general"] as const;

/** FNV-1a 32-bit — compact, stable sessionStorage key (avoids 6k-char keys). */
function hashReviewCacheKey(key: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function coerceSummarizedComments(value: unknown): SummarizedComment[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((c): SummarizedComment | null => {
      if (c && typeof c === "object" && typeof (c as any).text === "string") {
        const rawTheme = (c as any).theme;
        const themeVal =
          typeof rawTheme === "string" &&
          (REVIEW_SUMMARY_THEMES as readonly string[]).includes(rawTheme.toLowerCase())
            ? (rawTheme.toLowerCase() as SummarizedComment["theme"])
            : "general";
        return { text: (c as any).text.trim(), theme: themeVal };
      }
      return null;
    })
    .filter((c): c is SummarizedComment => c !== null && c.text.length > 0);
}

/** Reads a previously persisted summary for this exact key (survives reloads within the session). */
function readPersistedReviewSummary(cacheKey: string): SummarizedComment[] | undefined {
  if (typeof sessionStorage === "undefined") return undefined;
  try {
    const raw = sessionStorage.getItem(REVIEW_SUMMARY_STORAGE_PREFIX + hashReviewCacheKey(cacheKey));
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as { k?: unknown; c?: unknown };
    // Verify the full key to guard against the (rare) 32-bit hash collision.
    if (!parsed || parsed.k !== cacheKey) return undefined;
    const comments = coerceSummarizedComments(parsed.c);
    return comments.length > 0 ? comments : undefined;
  } catch {
    return undefined;
  }
}

function persistReviewSummary(cacheKey: string, comments: SummarizedComment[]): void {
  if (typeof sessionStorage === "undefined" || comments.length === 0) return;
  try {
    sessionStorage.setItem(
      REVIEW_SUMMARY_STORAGE_PREFIX + hashReviewCacheKey(cacheKey),
      JSON.stringify({ k: cacheKey, c: comments }),
    );
  } catch {
    /* quota / privacy mode — the in-memory cache still serves this session */
  }
}

/** Stable key for in-session review summary cache (matches server `makeLookupKey` + review text). */
export function reviewSummaryCacheKey(
  name: string | undefined,
  brand: string | undefined,
  reviews: FragranceRawReview[],
): string {
  const b = (brand ?? "").trim().toLowerCase();
  const n = (name ?? "").trim().toLowerCase();
  const body = reviews.map((r) => r.text).join("\0").slice(0, 6000);
  return `${b}::${n}::${body}`;
}

export function getCachedReviewSummary(cacheKey: string): SummarizedComment[] | undefined {
  const hit = reviewSummaryMemoryCache.get(cacheKey);
  if (hit?.length) return hit;
  const persisted = readPersistedReviewSummary(cacheKey);
  if (persisted) {
    reviewSummaryMemoryCache.set(cacheKey, persisted);
    return persisted;
  }
  return undefined;
}

/** Pulls the raw scraped reviews off a fragrance detail payload (engine puts them on `raw.reviews`). */
export function extractDetailReviews(detail: FragranceDetail | null | undefined): FragranceRawReview[] {
  const raw = detail?.raw?.reviews;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      const obj = objectRecord(entry);
      const text = typeof obj.text === "string" ? obj.text.trim() : "";
      const source = typeof obj.source === "string" ? obj.source.trim() : undefined;
      return { text, source };
    })
    .filter((r) => r.text.length > 0);
}

/**
 * Fetch the raw scraped reviews for a single wardrobe row on demand. The
 * wardrobe list/poll responses strip review text to keep Supabase egress down,
 * so the detail modal pulls reviews for just the item it's showing. Always
 * resolves (never throws) — on any failure it returns an empty list so the
 * review panel degrades quietly to "no reviews yet".
 */
export async function getWardrobeReviews(
  fragranceId: string,
  options?: { authToken?: string | null; signal?: AbortSignal },
): Promise<FragranceRawReview[]> {
  if (!fragranceId) return [];
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (options?.authToken) headers["Authorization"] = `Bearer ${options.authToken}`;
    const res = await fetch(appApiUrl(`/api/wardrobe/${encodeURIComponent(fragranceId)}/reviews`), {
      headers,
      signal: options?.signal,
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { reviews?: unknown };
    const raw = Array.isArray(data.reviews) ? data.reviews : [];
    return raw
      .map((entry) => {
        const obj = objectRecord(entry);
        const text = typeof obj.text === "string" ? obj.text.trim() : "";
        const source = typeof obj.source === "string" ? obj.source.trim() : undefined;
        return { text, source };
      })
      .filter((r) => r.text.length > 0);
  } catch {
    return [];
  }
}

/**
 * Asks the Express API to distill scraped reviews into short, original display
 * comments. Always resolves (never throws) — on any failure it returns an empty
 * list so the detail view degrades quietly.
 */
export async function summarizeReviews(
  input: { name?: string; brand?: string; reviews: FragranceRawReview[] },
  options?: { signal?: AbortSignal },
): Promise<SummarizedComment[]> {
  if (!input.reviews.length) return [];
  const cacheKey = reviewSummaryCacheKey(input.name, input.brand, input.reviews);
  const memoryHit = getCachedReviewSummary(cacheKey);
  if (memoryHit) return memoryHit;
  try {
    const res = await fetch(appApiUrl("/api/reviews/summarize"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: input.name ?? "",
        brand: input.brand ?? "",
        reviews: input.reviews,
      }),
      signal: options?.signal,
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { comments?: unknown };
    if (!Array.isArray(data.comments)) return [];
    const validThemes = ["performance", "season", "vibe", "general"];
    const comments = data.comments
      .map((c): SummarizedComment | null => {
        if (typeof c === "string") {
          return { text: c.trim(), theme: "general" };
        }
        if (c && typeof c === "object" && "text" in c && typeof (c as any).text === "string") {
          const textVal = (c as any).text.trim();
          const rawTheme = (c as any).theme;
          const themeVal = typeof rawTheme === "string" && validThemes.includes(rawTheme.toLowerCase())
            ? (rawTheme.toLowerCase() as SummarizedComment["theme"])
            : "general";
          return { text: textVal, theme: themeVal };
        }
        return null;
      })
      .filter((c): c is SummarizedComment => c !== null && c.text.length > 0);

    if (comments.length > 0) {
      reviewSummaryMemoryCache.set(cacheKey, comments);
      persistReviewSummary(cacheKey, comments);
    }
    return comments;
  } catch {
    return [];
  }
}
