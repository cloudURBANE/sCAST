const FRAGRANCE_SEARCH_CACHE_STORAGE_KEY = "scentcast.fragranceSearchCache.v2";
const FRAGRANCE_SEARCH_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const FRAGRANCE_SEARCH_CACHE_MAX_ENTRIES = 100;
const SUPPLEMENTAL_SEARCH_MIN_RESULTS = 8;

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
  fallbackOrigin: FragranceSearchOrigin = "srt",
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
  const origin = result.origin === "app" || result.origin === "srt" ? result.origin : fallbackOrigin;

  return {
    ...(result as FragranceSearchResult),
    id,
    name: name ?? fallbackQuery.trim(),
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

function viteEnv(key: string): string | undefined {
  return (
    (import.meta as { env?: Record<string, string | undefined> }).env?.[key] ??
    (typeof process !== "undefined" ? process.env?.[key] : undefined)
  );
}

function getFragranceEngineApiBase() {
  const base = viteEnv("VITE_FRAGRANCE_API_URL")?.trim();

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

function fragranceIdentityKey(result: FragranceSearchResult): string {
  const house = normalizeForDedupe(result.house ?? result.brand);
  const name = normalizeForDedupe(result.name);
  if (house || name) return `${house}::${name}`;
  return normalizeForDedupe(result.source_url ?? result.id);
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

export async function searchFragrances(
  query: string,
  options?: { signal?: AbortSignal },
): Promise<FragranceSearchResponse> {
  const cached = getCachedFragranceSearch(query);
  if (cached) return cached;

  const base = getSearchApiBase();
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

  const response: FragranceSearchResponse = {
    query: typeof data?.query === "string" ? data.query : query,
    results: rawResults
      .map((result) => normalizeFragranceSearchResult(result, query, "srt"))
      .filter((result): result is FragranceSearchResult => result !== null),
    diagnostics: normalizeSearchDiagnostics(data?.diagnostics),
  };

  let usedSupplementalSearch = false;
  if (shouldSupplementWithAppSearch(query, response)) {
    try {
      const supplemental = await searchAppFragrances(query, { signal: options?.signal });
      usedSupplementalSearch = true;
      response.results = mergeSearchResults(response.results, supplemental.results);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw err;
      if (response.results.length === 0) {
        throw err;
      }
    }
  }

  if (!usedSupplementalSearch) {
    cacheFragranceSearch(query, response);
  }
  return response;
}

async function searchAppFragrances(
  query: string,
  options?: { signal?: AbortSignal },
): Promise<FragranceSearchResponse> {
  const res = await fetch(
    appApiUrl(`/api/fragrances/search?q=${encodeURIComponent(query)}`),
    { signal: options?.signal },
  );

  if (!res.ok) {
    throw new Error(await apiErrorMessage(res, `App fragrance search failed: ${res.status}`));
  }

  const data = await res.json();
  const rawResults: unknown[] = Array.isArray(data)
    ? data
    : Array.isArray(data?.results)
      ? data.results
      : [];

  return {
    query: typeof data?.query === "string" ? data.query : query,
    results: rawResults
      .map((result) => normalizeFragranceSearchResult(result, query, "app"))
      .filter((result): result is FragranceSearchResult => result !== null),
    diagnostics: normalizeSearchDiagnostics(data?.diagnostics),
  };
}

export type FragranceDetailRequestPayload =
  | { id: string; source_url?: string; origin?: FragranceSearchOrigin }
  | { source_url: string; id?: never; origin?: FragranceSearchOrigin };

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
  const url =
    useAppApi
      ? appApiUrl("/api/fragrances/details")
      : `${getFragranceEngineApiBase()}/api/fragrances/details`;
  const requestBody = {
    ...("id" in payload ? { id: payload.id } : {}),
    ...("source_url" in payload && payload.source_url ? { source_url: payload.source_url } : {}),
  };

  const res = await fetch(url, {
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

export async function requeueFragranceDetails(
  payload: FragranceDetailRequeuePayload,
  options?: { signal?: AbortSignal },
): Promise<FragranceDetailRequeueResponse> {
  const id = firstNonEmptyString(payload.id);
  const sourceUrl = firstNonEmptyString(payload.source_url);
  if (!id && !sourceUrl) {
    throw new Error("Fragrance refresh needs an engine id or Fragrantica source URL.");
  }

  const res = await fetch(`${getFragranceEngineApiBase()}/api/fragrances/details/requeue`, {
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

  return res.json();
}
