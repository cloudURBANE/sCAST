import { Router } from "express";
import { db } from "@workspace/db";
import { affiliateLinksTable, userFragrancesTable } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
import { logger } from "../lib/logger";

const router = Router();

type BuyLinkStatus = "active" | "unavailable";

function isUuidish(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function buyLinkResponse(status: BuyLinkStatus, affiliateLinkId?: string) {
  return {
    provider: "cj",
    buyUrl: status === "active" && affiliateLinkId ? `/go/cj/${affiliateLinkId}` : null,
    status,
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

async function findCachedCjAffiliateLink(fragranceId: string) {
  const rows = await db
    .select()
    .from(affiliateLinksTable)
    .where(sql`${affiliateLinksTable.fragranceId} = ${fragranceId} and ${affiliateLinksTable.provider} = 'cj' and ${affiliateLinksTable.status} = 'active'`)
    .limit(1);

  return rows[0] ?? null;
}

function cjEnvReady() {
  return Boolean(
    process.env.CJ_PERSONAL_ACCESS_TOKEN &&
      process.env.CJ_COMPANY_ID &&
      process.env.CJ_PROPERTY_ID &&
      (process.env.CJ_API_URL || "https://developers.cj.com/graphql"),
  );
}

router.get("/fragrances/:id/buy-link", async (req, res) => {
  try {
    const fragrance = await findFragranceRow(req.params.id);
    if (!fragrance) {
      res.status(404).json(buyLinkResponse("unavailable"));
      return;
    }

    const cached = await findCachedCjAffiliateLink(fragrance.id);
    if (cached) {
      res.json(buyLinkResponse("active", cached.id));
      return;
    }

    if (!cjEnvReady()) {
      res.json(buyLinkResponse("unavailable"));
      return;
    }

    // TODO: Add CJ Product Search GraphQL lookup once the CJ schema/query shape
    // is available, then cache the selected product in affiliate_links.
    res.json(buyLinkResponse("unavailable"));
  } catch (err) {
    logger.warn({ err }, "fragrance buy-link resolver failed");
    res.json(buyLinkResponse("unavailable"));
  }
});

export default router;
