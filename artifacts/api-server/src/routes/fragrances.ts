import { Router } from "express";
import { db } from "@workspace/db";
import { affiliateLinksTable, userFragrancesTable } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { normalizeFragrance } from "../services/fragrancePayload";
import { createRakutenProvider, rakutenEnvReady } from "../services/rakutenProvider";

const router = Router();

type BuyLinkStatus = "active" | "unavailable";

function isUuidish(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function buyLinkResponse(provider: string, status: BuyLinkStatus, affiliateLinkId?: string, reason?: string) {
  return {
    provider,
    buyUrl: status === "active" && affiliateLinkId ? `/go/affiliate/${affiliateLinkId}` : null,
    status,
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

function buildFragranceQuery(fragrance: typeof userFragrancesTable.$inferSelect): string {
  const normalized = normalizeFragrance(fragrance.fragranceData as Record<string, any>);
  return [normalized.brand, normalized.name].filter(Boolean).join(" ").trim();
}

router.get("/fragrances/:id/buy-link", async (req, res) => {
  try {
    const fragrance = await findFragranceRow(req.params.id);
    if (!fragrance) {
      res.status(404).json(buyLinkResponse("rakuten", "unavailable", undefined, "FRAGRANCE_NOT_FOUND"));
      return;
    }

    const cachedRakuten = await findCachedAffiliateLink(fragrance.id, "rakuten");
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
          const [created] = await db
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

          if (created) {
            res.json(buyLinkResponse("rakuten", "active", created.id));
            return;
          }

          logger.warn({ fragranceId: fragrance.id }, "[rakuten] active buy-link insert returned no row");
          res.json(buyLinkResponse("rakuten", "unavailable", undefined, "AFFILIATE_LINK_INSERT_FAILED"));
          return;
        }

        logger.info({ fragranceId: fragrance.id, reason: result.reason }, "[rakuten] buy-link unavailable");
        res.json(buyLinkResponse("rakuten", "unavailable", undefined, result.reason));
        return;
      }
    }

    const cachedCj = await findCachedAffiliateLink(fragrance.id, "cj");
    if (cachedCj) {
      res.json({
        provider: "cj",
        buyUrl: `/go/cj/${cachedCj.id}`,
        status: "active",
      });
      return;
    }

    res.json(
      buyLinkResponse(
        "rakuten",
        "unavailable",
        undefined,
        rakutenEnvReady() ? "EMPTY_FRAGRANCE_QUERY" : "RAKUTEN_CREDENTIALS_MISSING",
      ),
    );
  } catch (err) {
    logger.warn({ err }, "fragrance buy-link resolver failed");
    res.json(buyLinkResponse("rakuten", "unavailable", undefined, "BUY_LINK_RESOLUTION_FAILED"));
  }
});

export default router;
