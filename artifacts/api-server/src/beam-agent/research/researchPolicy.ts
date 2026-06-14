/**
 * Beam research lane — PURE policy.
 *
 * Dependency-free (no DB, no network, no workspace imports) so it unit-tests in
 * isolation with `node --experimental-strip-types --test`. It decides *whether*
 * and *how hard* to research, normalizes the cache key, picks a TTL, and guards
 * against the cost-unbounded OpenRouter defaults. The network call and the cache
 * IO live in sibling modules and build on these decisions.
 *
 * Cost discipline (see docs/beam-agent/08-live-research-lane.md): cached
 * fragrance intelligence by default, cheap live search only when freshness
 * matters, premium research only for deep/high-stakes workflows.
 */

export type ResearchEntityType =
  | "fragrance"
  | "brand"
  | "seller"
  | "price"
  | "availability"
  | "note_claim"
  | "general";

export type ResearchMode =
  | "no_search_use_cache"
  | "single_source_check"
  | "standard_research"
  | "premium_research";

export type ResearchSourceType =
  | "official"
  | "retailer"
  | "database"
  | "review"
  | "forum"
  | "unknown";

export type ResearchSource = {
  url: string;
  title: string;
  excerpt: string;
  sourceType: ResearchSourceType;
  retrievedAt: string;
};

/** What the agent's `beam_research_web` tool returns (also the cached shape). */
export type ResearchResult = {
  synthesizedFact: string;
  sources: ResearchSource[];
  confidence: number;
  mode: ResearchMode;
  entityType: ResearchEntityType;
  model: string;
  engine: string;
  costUsd: number;
  cached: boolean;
  /** Present only when no live result was produced (disabled / failed / capped). */
  note?: string;
};

/** Signals that drive mode selection — inferred from the query or passed in. */
export type ResearchSignals = {
  requiresFreshness: boolean;
  requiresCitation: boolean;
  hasUnknownEntity: boolean;
  conflictingEvidence?: boolean;
  collectorTier?: boolean;
  highPurchaseImpact?: boolean;
  intent?:
    | "verify_single_fact"
    | "check_availability"
    | "price_compare"
    | "sample_finder"
    | "research_house"
    | "other";
};

/** Per-mode cost caps and request shape. `maxResults`/`maxOutputTokens` are the
 * STRUCTURAL enforcement (they bound the search + synthesis spend); the dollar
 * figures are targets/alerts for telemetry, not a post-hoc kill switch. */
export type ModeConfig = {
  maxResults: number;
  maxOutputTokens: number;
  targetCostUsd: number;
  hardCapUsd: number;
};

export const MODE_CONFIG: Record<Exclude<ResearchMode, "no_search_use_cache">, ModeConfig> = {
  single_source_check: { maxResults: 1, maxOutputTokens: 450, targetCostUsd: 0.01, hardCapUsd: 0.025 },
  standard_research: { maxResults: 2, maxOutputTokens: 700, targetCostUsd: 0.025, hardCapUsd: 0.06 },
  premium_research: { maxResults: 5, maxOutputTokens: 1200, targetCostUsd: 0.09, hardCapUsd: 0.15 },
};

/** Degraded fallback used only when a primary research call fails. */
export const DEGRADED_CONFIG: ModeConfig = {
  maxResults: 1,
  maxOutputTokens: 450,
  targetCostUsd: 0.01,
  hardCapUsd: 0.025,
};

/* ------------------------------------------------------------------ */
/* Query normalization + entity/signal inference                       */
/* ------------------------------------------------------------------ */

const MAX_QUERY_LENGTH = 240;

/** Lower-case, collapse whitespace, strip surrounding punctuation, cap length. */
export function normalizeResearchQuery(query: string): string {
  return query
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^[\s"'.,!?-]+|[\s"'.,!?-]+$/g, "")
    .trim()
    .slice(0, MAX_QUERY_LENGTH);
}

const PRICE_RE = /\b(price|prices|pricing|cost|how much|\$\d|under \$|cheapest|deal|on sale)\b/;
const AVAILABILITY_RE =
  /\b(available|availability|in stock|sold out|where to buy|still (sell|sold|made|around)|find (me|a))\b/;
const SELLER_RE = /\b(sample|samples|decant|decants|split|splits|seller|sellers|retailer|where to buy)\b/;
const FRESHNESS_RE =
  /\b(discontinued|reformulat|new release|just released|latest|recently|2026|this year|current|now)\b/;
const CITATION_RE = /\b(cite|cited|citation|source|sources|proof|evidence|link|links)\b/;
const NOTE_CLAIM_RE = /\b(perfumer|nose|release year|year released|concentration|notes? are|reformulation)\b/;
const BRAND_RE = /\b(house|brand|maison|niche house|the brand)\b/;

/** Best-effort entity classification from the query text. */
export function classifyEntityType(normalizedQuery: string): ResearchEntityType {
  if (PRICE_RE.test(normalizedQuery)) return "price";
  if (AVAILABILITY_RE.test(normalizedQuery)) return "availability";
  if (SELLER_RE.test(normalizedQuery)) return "seller";
  if (NOTE_CLAIM_RE.test(normalizedQuery)) return "note_claim";
  if (BRAND_RE.test(normalizedQuery)) return "brand";
  return "fragrance";
}

/**
 * Deterministic, no-extra-LLM signal inference. The spec describes a "freshness
 * router" model; we default to this cheap keyword pass (the model already gated
 * by *choosing* to call the research tool) and leave a model router as a later,
 * optional layer.
 */
export function inferResearchSignals(normalizedQuery: string): ResearchSignals {
  const requiresFreshness =
    PRICE_RE.test(normalizedQuery) ||
    AVAILABILITY_RE.test(normalizedQuery) ||
    FRESHNESS_RE.test(normalizedQuery);
  const requiresCitation = CITATION_RE.test(normalizedQuery);
  const hasUnknownEntity = NOTE_CLAIM_RE.test(normalizedQuery);

  let intent: ResearchSignals["intent"] = "other";
  if (PRICE_RE.test(normalizedQuery)) intent = "price_compare";
  else if (AVAILABILITY_RE.test(normalizedQuery)) intent = "check_availability";
  else if (SELLER_RE.test(normalizedQuery)) intent = "sample_finder";
  else if (NOTE_CLAIM_RE.test(normalizedQuery)) intent = "verify_single_fact";
  else if (BRAND_RE.test(normalizedQuery)) intent = "research_house";

  return { requiresFreshness, requiresCitation, hasUnknownEntity, intent };
}

/* ------------------------------------------------------------------ */
/* Mode selection                                                      */
/* ------------------------------------------------------------------ */

/**
 * Pick the research lane from signals (mirrors the spec's selectResearchMode).
 * Note: when the agent *explicitly* invokes the research tool, the orchestrator
 * upgrades a `no_search_use_cache` decision to `single_source_check` — the model
 * has already decided live evidence is warranted; we only choose how hard.
 */
export function selectResearchMode(signals: ResearchSignals): ResearchMode {
  if (signals.conflictingEvidence || signals.collectorTier || signals.highPurchaseImpact) {
    return "premium_research";
  }
  if (!signals.requiresFreshness && !signals.requiresCitation && !signals.hasUnknownEntity) {
    return "no_search_use_cache";
  }
  if (signals.intent === "verify_single_fact" || signals.intent === "check_availability") {
    return "single_source_check";
  }
  if (signals.intent === "price_compare" || signals.intent === "sample_finder") {
    return "standard_research";
  }
  return "standard_research";
}

/** Map a coarse user/model-supplied depth hint onto a concrete mode. */
export function modeFromDepth(depth: string | undefined): ResearchMode | null {
  switch ((depth ?? "").toLowerCase()) {
    case "single":
    case "quick":
    case "check":
      return "single_source_check";
    case "standard":
      return "standard_research";
    case "premium":
    case "deep":
      return "premium_research";
    case "auto":
    case "":
      return null;
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */
/* TTLs                                                                 */
/* ------------------------------------------------------------------ */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Cache lifetime by entity type (see the spec's TTL table). */
export function ttlMsForEntityType(entityType: ResearchEntityType): number {
  switch (entityType) {
    case "price":
      return 12 * HOUR;
    case "availability":
      return 48 * HOUR;
    case "seller":
      return 24 * HOUR;
    case "note_claim":
    case "fragrance":
      return 60 * DAY;
    case "brand":
      return 30 * DAY;
    case "general":
    default:
      return 24 * HOUR;
  }
}

/* ------------------------------------------------------------------ */
/* Banned-default guard + cost estimate                                */
/* ------------------------------------------------------------------ */

/**
 * Reject the cost-opaque OpenRouter defaults the spec bans: any `:online`
 * variant, `openrouter/auto`, and `openrouter/fusion`. Used to validate an
 * env-supplied model slug before it ever hits the wire.
 */
export function isBannedResearchModel(model: string): boolean {
  const m = model.trim().toLowerCase();
  if (!m) return true;
  if (m.endsWith(":online")) return true;
  if (m === "openrouter/auto" || m === "openrouter/fusion") return true;
  return false;
}

/** Coarse per-MTok rates (USD) for the default research models; fallback only. */
const MODEL_RATES: Array<{ match: RegExp; input: number; output: number }> = [
  { match: /qwen3?\.?7?-?plus/, input: 0.32, output: 1.28 },
  { match: /minimax-m3/, input: 0.3, output: 1.2 },
  { match: /step-3\.?\d?-flash/, input: 0.2, output: 1.15 },
  { match: /kimi-k2/, input: 0.6, output: 2.5 },
];

/** Exa/Parallel search billing: $0.005 up to 10 results, then $0.001 each. */
export function searchCostUsd(maxResults: number): number {
  const extra = Math.max(0, maxResults - 10);
  return 0.005 + extra * 0.001;
}

/**
 * Estimate request cost when the provider didn't return an authoritative number.
 * Prefer the real `usage.cost` from OpenRouter; this is only the fallback.
 */
export function estimateCostUsd(args: {
  model: string;
  inputTokens: number;
  outputTokens: number;
  maxResults: number;
}): number {
  const rate = MODEL_RATES.find((r) => r.match.test(args.model.toLowerCase()));
  const inRate = rate?.input ?? 0.5;
  const outRate = rate?.output ?? 2.0;
  const tokenCost = (args.inputTokens / 1e6) * inRate + (args.outputTokens / 1e6) * outRate;
  return Number((searchCostUsd(args.maxResults) + tokenCost).toFixed(6));
}
