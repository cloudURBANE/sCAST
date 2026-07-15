import { Router } from "express";
import { logger } from "../lib/logger";
import { rateLimitMiddleware } from "../lib/rateLimit";
import {
  EnrichmentQueueError,
  getEnrichmentStatus,
} from "../services/enrichmentQueue";

const router = Router();

// Public + DB-backed, so cap it per IP: the SPA polls at most a handful of
// tiles at once, while an anonymous scraper could otherwise turn this into a
// free DB query loop.
const enrichmentStatusRateLimit = rateLimitMiddleware({
  name: "enrichment-status",
  limit: 60,
  windowMs: 60_000,
});

/**
 * Public enrichment status lookup.
 *
 *   GET /api/enrichment/status?fg_url=<url>
 *   GET /api/enrichment/status?job_key=<key>
 *
 * Pass 1: read-only. Returns a `not_found` shape when no job matches. No
 * endpoint creates enrichment jobs automatically yet.
 */
router.get("/enrichment/status", enrichmentStatusRateLimit, async (req, res) => {
  const fgUrl = typeof req.query.fg_url === "string" ? req.query.fg_url : undefined;
  const jobKey = typeof req.query.job_key === "string" ? req.query.job_key : undefined;

  if (!fgUrl && !jobKey) {
    res.status(400).json({
      status: "error",
      requested_count: 0,
      message: "Provide fg_url or job_key.",
    });
    return;
  }

  try {
    const status = await getEnrichmentStatus({ fgUrl, jobKey });
    res.json(status);
  } catch (err) {
    if (err instanceof EnrichmentQueueError) {
      res.status(400).json({ status: "error", requested_count: 0, message: err.message });
      return;
    }
    logger.warn({ err }, "enrichment status lookup failed");
    res.status(500).json({
      status: "error",
      requested_count: 0,
      message: "Enrichment status lookup failed.",
    });
  }
});

export default router;
