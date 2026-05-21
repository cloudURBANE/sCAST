import { Router } from "express";
import { AuthRequest, requireAuth } from "../middlewares/auth";
import { db } from "@workspace/db";
import { affiliateLinksTable, userFragrancesTable } from "@workspace/db/schema";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { normalizeFragrance } from "../services/fragrancePayload";
import {
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
import { shouldSearchExternalFragranceSources } from "../services/fragranceNameResolver";
import { createRakutenProvider, rakutenEnvReady } from "../services/rakutenProvider";
import {
  buildAmazonAffiliateUrl,
  buildAmazonSearchUrl,
  isAmazonProductUrl,
} from "../server/affiliate/providers/amazon/amazonAffiliateUrl";
import { resolveShareUser } from "../services/shareUsers";

const router = Router();

type BuyLinkStatus = "active" | "unavailable";
type UserFragranceRow = typeof userFragrancesTable.$inferSelect;
type BuyLinkResponseOptions = {
  buyUrl?: string | null;
  affiliateApplied?: boolean;
  affiliateUnavailableReason?: string;
  network?: string;
};
type BuyLinkResolveOptions = {
  allowLiveRakuten: boolean;
};

function cleanQueryParam(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 180) : "";
}

function searchQueryWithFragranceIntent(query: string): string {
  return /\b(?:cologne|fragrance|perfume|parfum|edt|edp|edc|eau\s+de|extrait)\b/i.test(query)
    ? query
    : `${query} perfume`;
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

function isUuidish(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function buyLinkResponse(
  provider: string,
  status: BuyLinkStatus,
  affiliateLinkId?: string,
  reason?: string,
  options: BuyLinkResponseOptions = {},
) {
  return {
    provider,
    ...(options.network ? { network: options.network } : {}),
    buyUrl: options.buyUrl ?? (status === "active" && affiliateLinkId ? `/go/affiliate/${affiliateLinkId}` : null),
    status,
    ...(typeof options.affiliateApplied === "boolean" ? { affiliateApplied: options.affiliateApplied } : {}),
    ...(options.affiliateUnavailableReason
      ? { affiliateUnavailableReason: options.affiliateUnavailableReason }
      : {}),
    ...(reason ? { reason } : {}),
  };
}

async function findFragranceRow(userId: string, id: string) {
  if (isUuidish(id)) {
    const byDbId = await db
      .select()
      .from(userFragrancesTable)
      .where(sql`${userFragrancesTable.id} = ${id} AND ${userFragrancesTable.userId} = ${userId}`)
      .limit(1);

    if (byDbId[0]) return byDbId[0];
  }

  const byPayloadId = await db
    .select()
    .from(userFragrancesTable)
    .where(sql`${userFragrancesTable.userId} = ${userId} AND ${userFragrancesTable.fragranceData}->>'id' = ${id}`)
    .limit(1);

  return byPayloadId[0] ?? null;
}

function isShareHidden(fragrance: UserFragranceRow): boolean {
  const data = fragrance.fragranceData;
  return Boolean(data && typeof data === "object" && (data as Record<string, unknown>).shareHidden);
}

async function findCachedAffiliateLink(fragranceId: string, provider: string) {
  const rows = await db
    .select()
    .from(affiliateLinksTable)
    .where(sql`${affiliateLinksTable.fragranceId} = ${fragranceId} and ${affiliateLinksTable.provider} = ${provider} and ${affiliateLinksTable.status} = 'active'`)
    .limit(1);

  return rows[0] ?? null;
}

async function findCachedAffiliateLinkSafe(fragranceId: string, provider: string) {
  try {
    return await findCachedAffiliateLink(fragranceId, provider);
  } catch (err) {
    logger.warn({ err, fragranceId, provider }, "affiliate link cache lookup failed");
    return null;
  }
}

router.get("/fragrances/search", async (req, res) => {
  const query = cleanQueryParam(req.query.q ?? req.query.query);
  if (!query) {
    res.status(400).json({ error: "Query is required" });
    return;
  }

  const candidates: FragranceSearchCandidate[] = [];

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
      const urls = await searchScentSources(query, { maxCandidates: 16 });
      for (const url of urls) {
        const candidate = candidateFromSourceUrl(url, query);
        if (candidate) candidates.push(candidate);
      }
    } catch (err) {
      logger.warn({ err }, "fragrance search source lookup failed");
    }
  }

  if (candidates.length === 0) {
    try {
      const fallbackQuery = searchQueryWithFragranceIntent(query);
      const urls = await searchScentSources(fallbackQuery, { maxCandidates: 16 });
      for (const url of urls) {
        const candidate = candidateFromSourceUrl(url, query);
        if (candidate) candidates.push(candidate);
      }
    } catch (err) {
      logger.warn({ err }, "fragrance search broad source fallback failed");
    }
  }

  res.json({
    query,
    results: dedupeCandidates(candidates).slice(0, 16),
  });
});

router.post("/fragrances/details", async (req, res) => {
  const sourceUrl = sourceUrlFromDetailBody(req.body);
  const identityFromId = identityIdFromDetailBody(req.body);

  if (sourceUrl) {
    const identity = parseFragranceSourceUrl(sourceUrl);
    if (!identity) {
      res.status(422).json({ error: "source_url must identify a fragrance page." });
      return;
    }

    const fragranceName = [identity.brand, identity.name].filter(Boolean).join(" ").trim();
    const id = `source:${identity.sourceUrl}`;

    try {
      const facts = await getScentFacts({
        fragranceName,
        sourceUrl: identity.sourceUrl,
        save: false,
      });
      const flatNotes = [
        ...facts.profile.top_notes,
        ...facts.profile.heart_notes,
        ...facts.profile.base_notes,
      ];
      const imageProfile = await buildProfile(
        facts.profile.name || identity.name,
        facts.profile.brand || identity.brand || "",
        {
          notes: flatNotes,
          family: facts.profile.accords[0],
          pyramid: {
            top: facts.profile.top_notes,
            heart: facts.profile.heart_notes,
            base: facts.profile.base_notes,
          },
        },
        { preferEngineData: true, allowCatalogFuzzy: false },
      ).catch((err) => {
        logger.warn(
          {
            err,
            area: "fragrances.sourceDetail.buildProfile",
            sourceUrl: identity.sourceUrl,
            fragranceName,
          },
          "Non-fatal buildProfile failed during source detail enrichment",
        );
        return null;
      });

      res.json(
        scentFactProfileToDetail({
          id,
          sourceUrl: identity.sourceUrl,
          profile: facts.profile,
          proof: facts.proof,
          imageProfile: imageProfile && "product" in imageProfile ? flattenProfile(imageProfile) : undefined,
          provisional: facts.provisional,
        }),
      );
      return;
    } catch (err) {
      logger.warn({ err, sourceUrl: identity.sourceUrl }, "fragrance source detail enrichment failed");
      const fallback = await buildDetailFromIdentity({
        id,
        brand: identity.brand ?? "",
        name: identity.name,
        sourceUrl: identity.sourceUrl,
      });
      res.json(fallback);
      return;
    }
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

function buildFragranceQuery(fragrance: UserFragranceRow): string {
  const normalized = normalizeFragrance(fragrance.fragranceData as Record<string, any>);
  return [normalized.brand, normalized.name].filter(Boolean).join(" ").trim();
}

function amazonAffiliateEnabled(): boolean {
  return process.env.AMAZON_AFFILIATE_ENABLED?.trim().toLowerCase() === "true";
}

function amazonAssociateTag(): string | undefined {
  return process.env.AMAZON_ASSOCIATE_TAG?.trim() || undefined;
}

function amazonMarketplace(): string | undefined {
  return process.env.AMAZON_MARKETPLACE?.trim() || undefined;
}

function findAmazonProductUrl(value: unknown): string | null {
  const stack: unknown[] = [value];
  const seen = new Set<unknown>();

  while (stack.length > 0 && seen.size < 200) {
    const current = stack.pop();
    if (!current || seen.has(current)) continue;
    seen.add(current);

    if (typeof current === "string") {
      const trimmed = current.trim();
      if (trimmed && isAmazonProductUrl(trimmed)) return trimmed;
      continue;
    }

    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }

    if (typeof current === "object") {
      stack.push(...Object.values(current as Record<string, unknown>));
    }
  }

  return null;
}

async function resolveBuyLinkForFragrance(
  fragrance: UserFragranceRow,
  options: BuyLinkResolveOptions,
) {
  let fallbackReason: string | undefined = options.allowLiveRakuten ? undefined : "BUY_LINK_NOT_CACHED";

  const cachedRakuten = await findCachedAffiliateLinkSafe(fragrance.id, "rakuten");
  if (cachedRakuten) {
    return buyLinkResponse("rakuten", "active", cachedRakuten.id);
  }

  if (options.allowLiveRakuten && rakutenEnvReady()) {
    const query = buildFragranceQuery(fragrance);
    if (query) {
      const rakuten = createRakutenProvider();
      const result = await rakuten.resolveBuyLink({ query });

      if (result.status === "active") {
        const product = result.product;
        let created: typeof affiliateLinksTable.$inferSelect | undefined;
        try {
          [created] = await db
            .insert(affiliateLinksTable)
            .values({
              fragranceId: fragrance.id,
              provider: "rakuten",
              advertiserId: product.advertiserId,
              advertiserName: product.advertiserName,
              productTitle: product.title,
              productBrand: product.brand,
              destinationUrl: product.destinationUrl,
              affiliateUrl: product.affiliateUrl,
              imageUrl: product.imageUrl,
              price: product.salePrice ?? product.price,
              currency: product.currency,
              matchScore: product.matchScore,
              status: "active",
              fetchedAt: new Date(),
              lastVerifiedAt: new Date(),
            })
            .returning();
        } catch (err) {
          logger.warn({ err, fragranceId: fragrance.id }, "[rakuten] active buy-link cache insert failed");
        }

        if (created) {
          return buyLinkResponse("rakuten", "active", created.id);
        }

        return buyLinkResponse("rakuten", "active", undefined, "AFFILIATE_LINK_CACHE_BYPASSED", {
          network: "rakuten",
          buyUrl: product.affiliateUrl,
          affiliateApplied: true,
        });
      }

      logger.info({ fragranceId: fragrance.id, reason: result.reason }, "[rakuten] buy-link unavailable");
      fallbackReason = result.reason;
    }
  }

  const cachedCj = await findCachedAffiliateLinkSafe(fragrance.id, "cj");
  if (cachedCj) {
    return {
      provider: "cj",
      buyUrl: `/go/cj/${cachedCj.id}`,
      status: "active",
    };
  }

  const originalAmazonUrl = findAmazonProductUrl(fragrance.fragranceData);
  if (originalAmazonUrl) {
    const amazon = buildAmazonAffiliateUrl({
      productUrl: originalAmazonUrl,
      associateTag: amazonAssociateTag(),
      enabled: amazonAffiliateEnabled(),
    });

    return buyLinkResponse("amazon", "active", undefined, amazon.reason, {
      network: "amazon",
      buyUrl: amazon.url,
      affiliateApplied: amazon.affiliateApplied,
      affiliateUnavailableReason: amazon.reason,
    });
  }

  const searchQuery = buildFragranceQuery(fragrance);
  const amazonSearch = buildAmazonSearchUrl({
    query: searchQuery,
    marketplace: amazonMarketplace(),
    associateTag: amazonAssociateTag(),
    enabled: amazonAffiliateEnabled(),
  });
  if (amazonSearch) {
    return buyLinkResponse("amazon", "active", undefined, "AMAZON_SEARCH_FALLBACK", {
      network: "amazon",
      buyUrl: amazonSearch.url,
      affiliateApplied: amazonSearch.affiliateApplied,
      affiliateUnavailableReason: amazonSearch.reason,
    });
  }

  return buyLinkResponse(
    "rakuten",
    "unavailable",
    undefined,
    fallbackReason ?? (rakutenEnvReady() ? "EMPTY_FRAGRANCE_QUERY" : "RAKUTEN_CREDENTIALS_MISSING"),
  );
}

router.get("/share/:userRef/fragrances/:id/buy-link", async (req, res) => {
  try {
    const user = await resolveShareUser(req.params.userRef as string);
    if (!user) {
      res.status(404).json(buyLinkResponse("rakuten", "unavailable", undefined, "FRAGRANCE_NOT_FOUND"));
      return;
    }

    const fragrance = await findFragranceRow(user.id, req.params.id as string);
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

router.get("/fragrances/:id/buy-link", requireAuth, async (req: AuthRequest, res) => {
  try {
    if (!req.user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const fragrance = await findFragranceRow(req.user.id, req.params.id as string);
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
