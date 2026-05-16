const FRAGRANCE_SEARCH_CACHE_STORAGE_KEY = "scentcast.fragranceSearchCache.v1";
const FRAGRANCE_SEARCH_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const FRAGRANCE_SEARCH_CACHE_MAX_ENTRIES = 100;

export type SourceCoverage = {
  basenotes?: boolean;
  fragrantica?: boolean;
  fragrantica_cached?: boolean;
  fragrantica_cache_source?: string;
  basenotes_linked?: boolean;
  fragrantica_linked?: boolean;
  derived_metrics?: "none" | "partial" | "complete" | "full" | string;
  complete?: boolean;
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
    /** Railway engine shape — accords + model scores */
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
};

export type FragranceSearchResponse = {
  query: string;
  results: FragranceSearchResult[];
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

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string" && typeof value !== "number") continue;
    const trimmed = String(value).trim();
    if (trimmed) return trimmed;
  }
  return undefined;
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
  return entry.response.results.length > 0 ? entry.response : null;
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
): FragranceSearchResult | null {
  if (!value || typeof value !== "object") return null;

  const result = value as Record<string, unknown>;
  const sourceUrl = firstNonEmptyString(
    result.source_url,
    result.sourceUrl,
    result.url,
    result.fg_url,
  );
  const id = firstNonEmptyString(
    result.id,
    result.fragrance_id,
    result.source_id,
    result.slug,
    sourceUrl ? `source:${sourceUrl}` : undefined,
  );
  if (!id) return null;

  const name = firstNonEmptyString(
    result.name,
    result.fragrance_name,
    result.title,
    result.product_name,
    fallbackQuery,
  );
  const house = firstNonEmptyString(
    result.house,
    result.brand,
    result.brand_name,
    result.designer,
  );

  return {
    ...(result as FragranceSearchResult),
    id,
    name: name ?? fallbackQuery.trim(),
    house,
    brand: firstNonEmptyString(result.brand, house),
    year: typeof result.year === "number" ? result.year : null,
    gender: typeof result.gender === "string" ? result.gender : null,
    source_url: sourceUrl ?? null,
  };
}

/** Normalize engine main_accords whether the API used `items` or `scent_vector` / `top_accords`. */
export type MainAccordDisplayRow = { label: string; score?: number; pct?: number };

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

  const fromVector =
    main.scent_vector
      ?.map((row) => ({
        label: typeof row.accord === "string" ? row.accord.trim() : "",
        score: typeof row.score === "number" ? row.score : undefined,
      }))
      .filter((row) => row.label) ?? [];

  if (fromVector.length > 0) return fromVector;

  return (main.top_accords ?? [])
    .map((a) => ({ label: typeof a === "string" ? a.trim() : "", score: undefined as number | undefined }))
    .filter((row) => row.label);
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

export function isTerminalEnrichmentStatus(value: unknown): boolean {
  const status = normalizedStatus(value);
  return (
    status === "completed" ||
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

  const coverage = detail.source_coverage;
  const enrichmentStatus = normalizedStatus(detail.enrichment?.status);
  const hasMetrics = hasDerivedMetricsPayload(detail.derived_metrics);

  return Boolean(
    coverage?.complete === true ||
      isDerivedMetricsCompleteFlag(coverage?.derived_metrics) ||
      (hasMetrics && coverage?.fragrantica === true) ||
      (hasMetrics && (enrichmentStatus === "completed" || enrichmentStatus === "not_needed")),
  );
}

export function normalizeSourceCoverage(
  coverage?: SourceCoverage | null,
  metrics?: DerivedMetrics | null,
  enrichment?: FragranceDetail["enrichment"] | null,
): SourceCoverage | undefined {
  const hasCoverage = coverage && Object.keys(coverage).length > 0;
  const hasMetrics = hasDerivedMetricsPayload(metrics);
  if (!hasCoverage && !hasMetrics) return coverage ?? undefined;

  const next: SourceCoverage = { ...(coverage ?? {}) };
  const enrichmentStatus = normalizedStatus(enrichment?.status);
  const effectivelyComplete =
    next.complete === true ||
    isDerivedMetricsCompleteFlag(next.derived_metrics) ||
    (hasMetrics && next.fragrantica === true) ||
    (hasMetrics && (enrichmentStatus === "completed" || enrichmentStatus === "not_needed"));

  if (effectivelyComplete) {
    next.complete = true;
    if (!isDerivedMetricsCompleteFlag(next.derived_metrics)) {
      next.derived_metrics = "complete";
    }
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

function getApiBase() {
  const base = (
    (import.meta as { env?: Record<string, string | undefined> }).env
      ?.VITE_FRAGRANCE_API_URL ??
    (typeof process !== "undefined" ? process.env?.VITE_FRAGRANCE_API_URL : undefined)
  )?.trim();

  if (!base) {
    throw new Error(
      [
        "Missing VITE_FRAGRANCE_API_URL (fragrance catalog / search backend).",
        "For local dev: add it to artifacts/scent-cast/.env.local, or define it in ScentCast.env at the repo root, then restart the Vite dev server.",
        "For production: add VITE_FRAGRANCE_API_URL in the frontend host env (e.g. Vercel) and redeploy.",
      ].join(" "),
    );
  }

  return base.replace(/\/+$/, "");
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

export async function searchFragrances(
  query: string,
  options?: { signal?: AbortSignal },
): Promise<FragranceSearchResponse> {
  const cached = getCachedFragranceSearch(query);
  if (cached) return cached;

  const base = getApiBase();
  const res = await fetch(
    `${base}/api/fragrances/search?q=${encodeURIComponent(query)}`,
    { signal: options?.signal },
  );

  if (!res.ok) {
    throw new Error(await apiErrorMessage(res, `Fragrance search failed: ${res.status}`));
  }

  const data = await res.json();
  const rawResults: unknown[] = Array.isArray(data)
    ? data
    : Array.isArray(data?.results)
      ? data.results
      : [];

  const response = {
    query: typeof data?.query === "string" ? data.query : query,
    results: rawResults
      .map((result) => normalizeFragranceSearchResult(result, query))
      .filter((result): result is FragranceSearchResult => result !== null),
  };
  cacheFragranceSearch(query, response);
  return response;
}

export type FragranceDetailRequestPayload =
  | { id: string; source_url?: string }
  | { source_url: string; id?: never };

export async function getFragranceDetails(
  payload: FragranceDetailRequestPayload,
  options?: { signal?: AbortSignal },
): Promise<FragranceDetailResponse> {
  const base = getApiBase();
  const requestBody = {
    ...("id" in payload ? { id: payload.id } : {}),
    ...("source_url" in payload ? { source_url: payload.source_url } : {}),
  };

  const res = await fetch(`${base}/api/fragrances/details`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
    signal: options?.signal,
  });

  if (!res.ok) {
    throw new Error(await apiErrorMessage(res, `Fragrance detail fetch failed: ${res.status}`));
  }

  return res.json();
}
