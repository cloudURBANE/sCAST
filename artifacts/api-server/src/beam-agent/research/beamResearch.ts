/**
 * Beam research lane — orchestrator (cache → mode → web → cache).
 *
 * Pure control flow with all IO injected (cache reads/writes, the web call,
 * model/engine/domain resolution, the enabled flag, the clock), so the lane is
 * unit-tested with fakes and the route wires the real DB + provider. Never
 * throws: any failure degrades to a `note` result so the agent's tool handler
 * always gets a usable answer and can fall back to cached knowledge.
 */
import {
  DEGRADED_CONFIG,
  MODE_CONFIG,
  classifyEntityType,
  inferResearchSignals,
  modeFromDepth,
  normalizeResearchQuery,
  selectResearchMode,
  ttlMsForEntityType,
  type ResearchEntityType,
  type ResearchMode,
  type ResearchResult,
  type ResearchSource,
} from "./researchPolicy.ts";

export type ResearchProviderParams = {
  query: string;
  model: string;
  engine: string;
  includeDomains: string[];
  maxResults: number;
  maxOutputTokens: number;
};

export type ResearchProviderResult = {
  synthesizedFact: string;
  sources: ResearchSource[];
  confidence: number;
  costUsd: number;
  model: string;
  engine: string;
};

/** The shared shape between a cache row and a fresh result. */
export type CachedResearch = {
  synthesizedFact: string;
  sources: ResearchSource[];
  confidence: number;
  mode: ResearchMode;
  entityType: ResearchEntityType;
  model: string;
  engine: string;
  costUsd: number;
};

export type SaveResearchRecord = CachedResearch & {
  normalizedQuery: string;
  expiresAtMs: number;
};

/** Everything the orchestrator needs from the outside world. */
export type ResearchIO = {
  loadCache: (normalizedQuery: string, entityType: ResearchEntityType) => Promise<CachedResearch | null>;
  saveCache: (record: SaveResearchRecord) => Promise<void>;
  runWebResearch: (params: ResearchProviderParams) => Promise<ResearchProviderResult>;
  modelFor: (mode: ResearchMode) => string;
  degradedModel: () => string;
  engine: () => string;
  includeDomains: () => string[];
  isEnabled: () => boolean;
  now?: () => number;
};

export type ResearcherOptions = { entityType?: string; depth?: string };

const ENTITY_TYPES: ResearchEntityType[] = [
  "fragrance",
  "brand",
  "seller",
  "price",
  "availability",
  "note_claim",
  "general",
];

function coerceEntityType(value: string | undefined): ResearchEntityType | undefined {
  if (!value) return undefined;
  const v = value.trim().toLowerCase() as ResearchEntityType;
  return ENTITY_TYPES.includes(v) ? v : undefined;
}

function emptyResult(note: string): ResearchResult {
  return {
    synthesizedFact: "",
    sources: [],
    confidence: 0,
    mode: "no_search_use_cache",
    entityType: "general",
    model: "",
    engine: "",
    costUsd: 0,
    cached: false,
    note,
  };
}

function toCached(result: ResearchResult): CachedResearch {
  return {
    synthesizedFact: result.synthesizedFact,
    sources: result.sources,
    confidence: result.confidence,
    mode: result.mode,
    entityType: result.entityType,
    model: result.model,
    engine: result.engine,
    costUsd: result.costUsd,
  };
}

/** Build the `researchWeb` dep from injected IO. */
export function createBeamResearcher(io: ResearchIO) {
  const now = io.now ?? (() => Date.now());

  return async function researchWeb(
    rawQuery: string,
    opts: ResearcherOptions = {},
  ): Promise<ResearchResult> {
    const normalizedQuery = normalizeResearchQuery(typeof rawQuery === "string" ? rawQuery : "");
    if (!normalizedQuery) return emptyResult("a non-empty query is required");
    if (!io.isEnabled()) {
      return emptyResult(
        "live web research is not enabled; answer from cached catalog and wardrobe knowledge",
      );
    }

    const entityType = coerceEntityType(opts.entityType) ?? classifyEntityType(normalizedQuery);

    // 1) Serve a fresh cached result if one exists (non-fatal on read error).
    try {
      const cached = await io.loadCache(normalizedQuery, entityType);
      if (cached) return { ...cached, cached: true };
    } catch {
      /* fall through to a live call */
    }

    // 2) Choose the lane. The agent explicitly invoked research, so never "no search".
    let mode = modeFromDepth(opts.depth) ?? selectResearchMode(inferResearchSignals(normalizedQuery));
    if (mode === "no_search_use_cache") mode = "single_source_check";
    const cfg = MODE_CONFIG[mode];

    // 3) Run the web call, with a single degraded retry on failure.
    let provider: ResearchProviderResult;
    try {
      provider = await io.runWebResearch({
        query: normalizedQuery,
        model: io.modelFor(mode),
        engine: io.engine(),
        includeDomains: io.includeDomains(),
        maxResults: cfg.maxResults,
        maxOutputTokens: cfg.maxOutputTokens,
      });
    } catch {
      try {
        provider = await io.runWebResearch({
          query: normalizedQuery,
          model: io.degradedModel(),
          engine: io.engine(),
          includeDomains: io.includeDomains(),
          maxResults: DEGRADED_CONFIG.maxResults,
          maxOutputTokens: DEGRADED_CONFIG.maxOutputTokens,
        });
        mode = "single_source_check";
      } catch {
        return emptyResult(
          "live research is temporarily unavailable; answer from cached knowledge and say it is not freshly verified",
        );
      }
    }

    const result: ResearchResult = {
      synthesizedFact: provider.synthesizedFact,
      sources: provider.sources,
      confidence: provider.confidence,
      mode,
      entityType,
      model: provider.model,
      engine: provider.engine,
      costUsd: provider.costUsd,
      cached: false,
    };

    // 4) Cache the result for reuse (best-effort; a write failure never fails the turn).
    if (result.synthesizedFact) {
      try {
        await io.saveCache({
          ...toCached(result),
          normalizedQuery,
          expiresAtMs: now() + ttlMsForEntityType(entityType),
        });
      } catch {
        /* non-fatal */
      }
    }

    return result;
  };
}
