const FRAGRANCE_API_URL = import.meta.env.VITE_FRAGRANCE_API_URL as string | undefined;

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

function getApiBase() {
  const base = FRAGRANCE_API_URL?.trim();

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
  const base = getApiBase();
  const res = await fetch(
    `${base}/api/fragrances/search?q=${encodeURIComponent(query)}`,
    { signal: options?.signal },
  );

  if (!res.ok) {
    throw new Error(await apiErrorMessage(res, `Fragrance search failed: ${res.status}`));
  }

  const data = await res.json();
  if (Array.isArray(data)) {
    return { query, results: data as FragranceSearchResult[] };
  }

  return {
    query: typeof data?.query === "string" ? data.query : query,
    results: Array.isArray(data?.results) ? data.results : [],
  };
}

export async function getFragranceDetails(
  payload: { id: string },
  options?: { signal?: AbortSignal },
): Promise<FragranceDetailResponse> {
  const base = getApiBase();
  const res = await fetch(`${base}/api/fragrances/details`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ id: payload.id }),
    signal: options?.signal,
  });

  if (!res.ok) {
    throw new Error(await apiErrorMessage(res, `Fragrance detail fetch failed: ${res.status}`));
  }

  return res.json();
}
