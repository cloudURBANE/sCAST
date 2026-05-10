import { Router } from "express";
import { db } from "@workspace/db";
import { affiliateLinksTable, userFragrancesTable } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { normalizeFragrance } from "../services/fragrancePayload";
import { createRakutenProvider, rakutenEnvReady } from "../services/rakutenProvider";
import {
  buildAmazonAffiliateUrl,
  buildAmazonSearchUrl,
  isAmazonProductUrl,
} from "../server/affiliate/providers/amazon/amazonAffiliateUrl";

const router = Router();

type BuyLinkStatus = "active" | "unavailable";
type BuyLinkResponseOptions = {
  buyUrl?: string | null;
  affiliateApplied?: boolean;
  affiliateUnavailableReason?: string;
  network?: string;
};

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

async function findFragranceRow(id: string) {
  if (isUuidish(id)) {
    const byDbId = await db
      .select()
      .from(userFragrancesTable)
      .where(eq(userFragrancesTable.id, id))
      .limit(1);

    if (byDbId[0]) return byDbId[0];
  }

  const byPayloadId = await db
    .select()
    .from(userFragrancesTable)
    .where(sql`${userFragrancesTable.fragranceData}->>'id' = ${id}`)
    .limit(1);

  return byPayloadId[0] ?? null;
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

function buildFragranceQuery(fragrance: typeof userFragrancesTable.$inferSelect): string {
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

router.get("/fragrances/:id/buy-link", async (req, res) => {
  try {
    const fragrance = await findFragranceRow(req.params.id);
    if (!fragrance) {
      res.status(404).json(buyLinkResponse("rakuten", "unavailable", undefined, "FRAGRANCE_NOT_FOUND"));
      return;
    }
    let fallbackReason: string | undefined;

    const cachedRakuten = await findCachedAffiliateLinkSafe(fragrance.id, "rakuten");
    if (cachedRakuten) {
      res.json(buyLinkResponse("rakuten", "active", cachedRakuten.id));
      return;
    }

    if (rakutenEnvReady()) {
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
            res.json(buyLinkResponse("rakuten", "active", created.id));
            return;
          }

          res.json(
            buyLinkResponse("rakuten", "active", undefined, "AFFILIATE_LINK_CACHE_BYPASSED", {
              network: "rakuten",
              buyUrl: product.affiliateUrl,
              affiliateApplied: true,
            }),
          );
          return;
        }

        logger.info({ fragranceId: fragrance.id, reason: result.reason }, "[rakuten] buy-link unavailable");
        fallbackReason = result.reason;
      }
    }

    const cachedCj = await findCachedAffiliateLinkSafe(fragrance.id, "cj");
    if (cachedCj) {
      res.json({
        provider: "cj",
        buyUrl: `/go/cj/${cachedCj.id}`,
        status: "active",
      });
      return;
    }

    const originalAmazonUrl = findAmazonProductUrl(fragrance.fragranceData);
    if (originalAmazonUrl) {
      const amazon = buildAmazonAffiliateUrl({
        productUrl: originalAmazonUrl,
        associateTag: amazonAssociateTag(),
        enabled: amazonAffiliateEnabled(),
      });

      res.json(
        buyLinkResponse("amazon", "active", undefined, amazon.reason, {
          network: "amazon",
          buyUrl: amazon.url,
          affiliateApplied: amazon.affiliateApplied,
          affiliateUnavailableReason: amazon.reason,
        }),
      );
      return;
    }

    const searchQuery = buildFragranceQuery(fragrance);
    const amazonSearch = buildAmazonSearchUrl({
      query: searchQuery,
      marketplace: amazonMarketplace(),
      associateTag: amazonAssociateTag(),
      enabled: amazonAffiliateEnabled(),
    });
    if (amazonSearch) {
      res.json(
        buyLinkResponse("amazon", "active", undefined, "AMAZON_SEARCH_FALLBACK", {
          network: "amazon",
          buyUrl: amazonSearch.url,
          affiliateApplied: amazonSearch.affiliateApplied,
          affiliateUnavailableReason: amazonSearch.reason,
        }),
      );
      return;
    }

    res.json(
      buyLinkResponse(
        "rakuten",
        "unavailable",
        undefined,
        fallbackReason ?? (rakutenEnvReady() ? "EMPTY_FRAGRANCE_QUERY" : "RAKUTEN_CREDENTIALS_MISSING"),
      ),
    );
  } catch (err) {
    logger.warn({ err }, "fragrance buy-link resolver failed");
    res.json(buyLinkResponse("rakuten", "unavailable", undefined, "BUY_LINK_RESOLUTION_FAILED"));
  }
});

export default router;
