import { Router, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { affiliateLinksTable } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
import { logger } from "../lib/logger";

const router = Router();

function withSafeSid(rawUrl: string, rawSid: unknown): string | null {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;

    const sid = typeof rawSid === "string" ? rawSid.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) : "";
    if (sid) {
      url.searchParams.set("sid", sid);
    } else if (!url.searchParams.has("sid")) {
      url.searchParams.set("sid", "scentcast");
    }

    return url.toString();
  } catch {
    return null;
  }
}

async function handleAffiliateRedirect(req: Request, res: Response, label: string) {
  try {
    const affiliateLinkId = String(req.params.id ?? "");
    const rows = await db
      .select()
      .from(affiliateLinksTable)
      .where(eq(affiliateLinksTable.id, affiliateLinkId))
      .limit(1);
    const link = rows[0];

    if (!link || link.status !== "active") {
      res.redirect(302, "/");
      return;
    }

    const redirectUrl = withSafeSid(link.affiliateUrl, req.query.sid);
    if (!redirectUrl) {
      res.redirect(302, "/");
      return;
    }

    await db
      .update(affiliateLinksTable)
      .set({
        clickCount: sql`${affiliateLinksTable.clickCount} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(affiliateLinksTable.id, link.id));

    res.redirect(302, redirectUrl);
  } catch (err) {
    logger.warn({ err, affiliateLinkId: req.params.id }, `${label} redirect failed`);
    res.redirect(302, "/");
  }
}

router.get("/go/cj/:id", async (req, res) => {
  await handleAffiliateRedirect(req, res, "CJ");
});

router.get("/go/affiliate/:id", async (req, res) => {
  await handleAffiliateRedirect(req, res, "affiliate");
});

export default router;
