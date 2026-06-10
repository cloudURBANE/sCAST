import { Router } from "express";
import { AuthRequest, requireAuth } from "../middlewares/auth";
import { getTenantId } from "../middlewares/tenant";
import { logger } from "../lib/logger";
import {
  searchCatalogBrandCandidates,
  searchCatalogCandidates,
  flattenProfile,
} from "../services/catalogService";
import { getScentFacts } from "../lib/scent-facts/engine";
import { searchScentSources } from "../lib/scent-facts/jina";
import { buildProfile, searchFragrances as searchDatasetFragrances } from "../services/scentEngine";
import {
  candidateFromProfile,
  candidateFromSourceUrl,
  decodeIdentityId,
  parseFragranceSourceUrl,
  scentFactProfileToDetail,
  type FragranceSearchCandidate,
} from "../services/fragranceApiCore";
import {
  hasKnownFragranceBrandSignal,
  scoreFragranceCandidate,
  searchFragranceDatasetByBrand,
  shouldSearchExternalFragranceSources,
} from "../services/fragranceNameResolver";
import {
  buyLinkResponse,
  findFragranceRow,
  findFragranceRowsForUser,
  isShareHidden,
  parseBatchIds,
  resolveBuyLinkForFragrance,
  resolvePublicBuyLinksForRows,
} from "../services/buyLinks";
import { resolveShareUser } from "../services/shareUsers";

const router = Router();

const SOURCE_SEARCH_RESPONSE_BUDGET_MS = 1200;
const SOURCE_DETAIL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SOURCE_DETAIL_FAILURE_TTL_MS = 10 * 60 * 1000;

type SourceDetailCacheEntry = {
  status: "pending" | "ready" | "failed";
  detail: Record<string, unknown>;
  expiresAt: number;
};

const sourceDetailCache = new Map<string, SourceDetailCacheEntry>();

function canonicalSourceUrl(value: string): string {
  try {
    const parsed = new URL(value.trim());
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return value.trim();
  }
}

function getCachedSourceDetail(cacheKey: string): SourceDetailCacheEntry | null {
  const entry = sourceDetailCache.get(cacheKey);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    sourceDetailCache.delete(cacheKey);
    return null;
  }
  return entry;
}

function cleanQueryParam(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 180) : "";
}

function searchQueryWithFragranceIntent(query: string): string {
  return /\b(?:cologne|fragrance|perfume|parfum|edt|edp|edc|eau\s+de|extrait)\b/i.test(query)
    ? query
    : `${query} perfume`;
}

// External search engines return URLs in raw indexer order, which for nickname
// queries (e.g. "Liam Grey", the community name for the grey Liam bottle) often
// floats a flanker ("Liam Blue Shine") above the base fragrance ("Liam").
// Re-rank URL-derived candidates by their fuzzy match score against the query so
// the closest identity wins; the score penalizes candidate names that add
// unmatched variant tokens, so the base scores above its flankers.
function rankSourceCandidatesByQuery(
  candidates: FragranceSearchCandidate[],
  query: string,
): FragranceSearchCandidate[] {
  return candidates
    .map((candidate, index) => ({
      candidate,
      index,
      score: scoreFragranceCandidate(query, { brand: candidate.brand, name: candidate.name }, 0).score,
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.candidate);
}

function dedupeCandidates(candidates: FragranceSearchCandidate[]): FragranceSearchCandidate[] {
  const seen = new Set<string>();
  const deduped: FragranceSearchCandidate[] = [];
  for (const candidate of candidates) {
    const key = candidate.source_url
      ? `url:${candidate.source_url.toLowerCase()}`
      : `id:${candidate.id.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(candidate);
  }
  return deduped;
}

function sourceUrlFromDetailBody(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const data = body as Record<string, unknown>;
  if (typeof data.source_url === "string" && data.source_url.trim()) {
    return data.source_url.trim();
  }
  if (typeof data.sourceUrl === "string" && data.sourceUrl.trim()) {
    return data.sourceUrl.trim();
  }
  if (typeof data.id === "string" && data.id.startsWith("source:")) {
    return data.id.slice("source:".length).trim();
  }
  return null;
}

function identityIdFromDetailBody(body: unknown): { brand: string; name: string } | null {
  if (!body || typeof body !== "object") return null;
  const data = body as Record<string, unknown>;
  if (typeof data.id === "string") return decodeIdentityId(data.id);
  return null;
}

async function buildDetailFromIdentity(input: {
  id: string;
  brand: string;
  name: string;
  sourceUrl?: string | null;
}): Promise<Record<string, unknown>> {
  const profile = await buildProfile(input.name, input.brand, undefined, {
    allowCatalogFuzzy: false,
    imageResolution: "deferred",
  });
  if (!("product" in profile)) {
    return {
      id: input.id,
      name: input.name,
      house: input.brand,
      brand: input.brand,
      source_url: input.sourceUrl ?? null,
      source_coverage: { complete: false, derived_metrics: "none" },
      enrichment: {
        status: "failed",
        requested_count: 0,
        message: profile.error,
      },
    };
  }

  return {
    ...flattenProfile(profile),
    id: input.id,
    source_url: input.sourceUrl ?? null,
    source_coverage: { complete: false, derived_metrics: "partial" },
    enrichment: {
      status: "not_needed",
      requested_count: 0,
      message: "Detail is available locally.",
    },
  };
}

function markSourceDetailPending(
  detail: Record<string, unknown>,
  input: {
    id: string;
    sourceUrl: string;
    brand?: string;
    name: string;
  },
): Record<string, unknown> {
  return {
    ...detail,
    id: input.id,
    name: typeof detail.name === "string" && detail.name.trim() ? detail.name : input.name,
    house:
      typeof detail.house === "string" && detail.house.trim()
        ? detail.house
        : input.brand || undefined,
    brand:
      typeof detail.brand === "string" && detail.brand.trim()
        ? detail.brand
        : input.brand || undefined,
    source_url: input.sourceUrl,
    source_coverage:
      detail.source_coverage && typeof detail.source_coverage === "object"
        ? detail.source_coverage
        : { complete: false, derived_metrics: "partial" },
    enrichment: {
      status: "pending",
      requested_count: 1,
      message: "Source detail enrichment is running in the background.",
    },
  };
}

async function buildEnrichedSourceDetail(input: {
  id: string;
  sourceUrl: string;
  brand?: string;
  name: string;
  fragranceName: string;
}): Promise<Record<string, unknown>> {
  const facts = await getScentFacts({
    fragranceName: input.fragranceName,
    sourceUrl: input.sourceUrl,
    save: false,
  });
  const flatNotes = [
    ...facts.profile.top_notes,
    ...facts.profile.heart_notes,
    ...facts.profile.base_notes,
  ];
  const imageProfile = await buildProfile(
    facts.profile.name || input.name,
    facts.profile.brand || input.brand || "",
    {
      notes: flatNotes,
      family: facts.profile.accords[0],
      pyramid: {
        top: facts.profile.top_notes,
        heart: facts.profile.heart_notes,
        base: facts.profile.base_notes,
      },
    },
    {
      preferEngineData: true,
      allowCatalogFuzzy: false,
      imageResolution: "deferred",
    },
  ).catch((err) => {
    logger.warn(
      {
        err,
        area: "fragrances.sourceDetail.buildProfile",
        sourceUrl: input.sourceUrl,
        fragranceName: input.fragranceName,
      },
      "Non-fatal buildProfile failed during source detail enrichment",
    );
    return null;
  });

  return scentFactProfileToDetail({
    id: input.id,
    sourceUrl: input.sourceUrl,
    profile: facts.profile,
    proof: facts.proof,
    imageProfile: imageProfile && "product" in imageProfile ? flattenProfile(imageProfile) : undefined,
    provisional: facts.provisional,
  });
}

function queueSourceDetailEnrichment(input: {
  cacheKey: string;
  provisional: Record<string, unknown>;
  id: string;
  sourceUrl: string;
  brand?: string;
  name: string;
  fragranceName: string;
}): void {
  const existing = getCachedSourceDetail(input.cacheKey);
  if (existing?.status === "pending") return;

  sourceDetailCache.set(input.cacheKey, {
    status: "pending",
    detail: input.provisional,
    expiresAt: Date.now() + SOURCE_DETAIL_CACHE_TTL_MS,
  });

  void buildEnrichedSourceDetail(input)
    .then((detail) => {
      sourceDetailCache.set(input.cacheKey, {
        status: "ready",
        detail,
        expiresAt: Date.now() + SOURCE_DETAIL_CACHE_TTL_MS,
      });
    })
    .catch((err) => {
      logger.warn({ err, sourceUrl: input.sourceUrl }, "fragrance source detail background enrichment failed");
      sourceDetailCache.set(input.cacheKey, {
        status: "failed",
        detail: {
          ...input.provisional,
          enrichment: {
            status: "failed",
            requested_count: 1,
            message: err instanceof Error ? err.message : "Source detail enrichment failed.",
          },
        },
        expiresAt: Date.now() + SOURCE_DETAIL_FAILURE_TTL_MS,
      });
    });
}

async function searchScentSourcesWithResponseBudget(
  query: string,
  options: Parameters<typeof searchScentSources>[1],
): Promise<{ urls: string[]; timedOut: boolean }> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      searchScentSources(query, options).then((urls) => ({ urls, timedOut: false })),
      new Promise<{ urls: string[]; timedOut: boolean }>((resolve) => {
        timeout = setTimeout(
          () => resolve({ urls: [], timedOut: true }),
          SOURCE_SEARCH_RESPONSE_BUDGET_MS,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

router.get("/fragrances/search", async (req, res) => {
  const query = cleanQueryParam(req.query.q ?? req.query.query);
  if (!query) {
    res.status(400).json({ error: "Query is required" });
    return;
  }

  const candidates: FragranceSearchCandidate[] = [];
  let sourceLookupTimedOut = false;

  try {
    const catalogHits = await searchCatalogCandidates(query, { limit: 5 });
    candidates.push(...catalogHits.map((hit) => candidateFromProfile("catalog", hit.profile)));
  } catch (err) {
    logger.warn({ err }, "fragrance search catalog lookup failed");
  }

  for (const item of searchDatasetFragrances(query)) {
    candidates.push(
      candidateFromProfile("dataset", {
        product: { brand: item.brand, name: item.name, perfumer: item.perfumer },
      }),
    );
  }

  if (shouldSearchExternalFragranceSources(query)) {
    try {
      const { urls, timedOut } = await searchScentSourcesWithResponseBudget(query, { maxCandidates: 16 });
      sourceLookupTimedOut ||= timedOut;
      const sourceCandidates: FragranceSearchCandidate[] = [];
      for (const url of urls) {
        const candidate = candidateFromSourceUrl(url, query);
        if (candidate) sourceCandidates.push(candidate);
      }
      candidates.push(...rankSourceCandidatesByQuery(sourceCandidates, query));
    } catch (err) {
      logger.warn({ err }, "fragrance search source lookup failed");
    }
  }

  if (candidates.length === 0) {
    try {
      const fallbackQuery = searchQueryWithFragranceIntent(query);
      const { urls, timedOut } = await searchScentSourcesWithResponseBudget(fallbackQuery, { maxCandidates: 16 });
      sourceLookupTimedOut ||= timedOut;
      const sourceCandidates: FragranceSearchCandidate[] = [];
      for (const url of urls) {
        const candidate = candidateFromSourceUrl(url, query);
        if (candidate) sourceCandidates.push(candidate);
      }
      candidates.push(...rankSourceCandidatesByQuery(sourceCandidates, query));
    } catch (err) {
      logger.warn({ err }, "fragrance search broad source fallback failed");
    }
  }

  // Brand expansion: supplemental fill for brand-only queries, added last so
  // real fuzzy-scored results always take priority.
  if (candidates.length < 16 && hasKnownFragranceBrandSignal(query)) {
    try {
      const catalogBrandHits = await searchCatalogBrandCandidates(query, { limit: 8 });
      candidates.push(...catalogBrandHits.map((hit) => candidateFromProfile("catalog", hit.profile)));
    } catch (err) {
      logger.warn({ err }, "fragrance search catalog brand lookup failed");
    }

    for (const item of searchFragranceDatasetByBrand(query, 8)) {
      candidates.push(
        candidateFromProfile("dataset", {
          product: { brand: item.brand, name: item.name, perfumer: item.perfumer },
        }),
      );
    }
  }

  res.json({
    query,
    results: dedupeCandidates(candidates).slice(0, 16),
    ...(sourceLookupTimedOut
      ? { diagnostics: { source_lookup_timeout: true, source_lookup_budget_ms: SOURCE_SEARCH_RESPONSE_BUDGET_MS } }
      : {}),
  });
});

router.post("/fragrances/details", async (req, res) => {
  const sourceUrl = sourceUrlFromDetailBody(req.body);
  const identityFromId = identityIdFromDetailBody(req.body);

  if (sourceUrl) {
    const cacheKey = canonicalSourceUrl(sourceUrl);
    const identity = parseFragranceSourceUrl(cacheKey);
    if (!identity) {
      res.status(422).json({ error: "source_url must identify a fragrance page." });
      return;
    }

    const fragranceName = [identity.brand, identity.name].filter(Boolean).join(" ").trim();
    const id = `source:${identity.sourceUrl}`;
    const cached = getCachedSourceDetail(cacheKey);
    if (cached?.status === "ready" || cached?.status === "failed") {
      res.json(cached.detail);
      return;
    }
    if (cached?.status === "pending") {
      res.json(cached.detail);
      return;
    }

    const fallback = await buildDetailFromIdentity({
      id,
      brand: identity.brand ?? "",
      name: identity.name,
      sourceUrl: identity.sourceUrl,
    });
    const provisional = markSourceDetailPending(fallback, {
      id,
      sourceUrl: identity.sourceUrl,
      brand: identity.brand,
      name: identity.name,
    });

    queueSourceDetailEnrichment({
      cacheKey,
      provisional,
      id,
      sourceUrl: identity.sourceUrl,
      brand: identity.brand,
      name: identity.name,
      fragranceName,
    });
    res.json(provisional);
    return;
  }

  if (identityFromId) {
    res.json(
      await buildDetailFromIdentity({
        id: typeof req.body?.id === "string" ? req.body.id : "",
        brand: identityFromId.brand,
        name: identityFromId.name,
      }),
    );
    return;
  }

  res.status(400).json({ error: "Provide id or source_url." });
});

router.get("/share/:userRef/fragrances/:id/buy-link", async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const user = await resolveShareUser(req.params.userRef as string, tenantId);
    if (!user) {
      res.status(404).json(buyLinkResponse("rakuten", "unavailable", undefined, "FRAGRANCE_NOT_FOUND"));
      return;
    }

    const fragrance = await findFragranceRow(tenantId, user.id, req.params.id as string);
    if (!fragrance || isShareHidden(fragrance)) {
      res.status(404).json(buyLinkResponse("rakuten", "unavailable", undefined, "FRAGRANCE_NOT_FOUND"));
      return;
    }

    const buyLink = await resolveBuyLinkForFragrance(fragrance, { allowLiveRakuten: false });
    res.json(buyLink);
  } catch (err) {
    logger.warn({ err }, "public share buy-link resolver failed");
    res.json(buyLinkResponse("rakuten", "unavailable", undefined, "BUY_LINK_RESOLUTION_FAILED"));
  }
});

router.get("/share/:userRef/buy-links", async (req, res) => {
  try {
    const ids = parseBatchIds(req.query.ids);
    if (ids.length === 0) {
      res.json({ buyLinks: {} });
      return;
    }

    const tenantId = getTenantId(req);
    const user = await resolveShareUser(req.params.userRef as string, tenantId);
    if (!user) {
      res.status(404).json({ buyLinks: {} });
      return;
    }

    const rows = await findFragranceRowsForUser(tenantId, user.id);
    const buyLinks = await resolvePublicBuyLinksForRows(rows, ids);

    res.json({ buyLinks });
  } catch (err) {
    logger.warn({ err }, "public share batch buy-link resolver failed");
    res.json({ buyLinks: {} });
  }
});

router.get("/fragrances/:id/buy-link", requireAuth, async (req: AuthRequest, res) => {
  try {
    if (!req.user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const fragrance = await findFragranceRow(getTenantId(req), req.user.id, req.params.id as string);
    if (!fragrance) {
      res.status(404).json(buyLinkResponse("rakuten", "unavailable", undefined, "FRAGRANCE_NOT_FOUND"));
      return;
    }
    const buyLink = await resolveBuyLinkForFragrance(fragrance, { allowLiveRakuten: true });
    res.json(buyLink);
  } catch (err) {
    logger.warn({ err }, "fragrance buy-link resolver failed");
    res.json(buyLinkResponse("rakuten", "unavailable", undefined, "BUY_LINK_RESOLUTION_FAILED"));
  }
});

export default router;
