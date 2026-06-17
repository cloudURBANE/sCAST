import { Router } from "express";
import { AuthRequest, requireAuth } from "../middlewares/auth";
import { logger } from "../lib/logger";
import { listPendingCurationForUser } from "../services/curationService";

const router = Router();

/**
 * List the signed-in user's Beam-curation queue.
 *
 *   GET /api/beam-agent/curation/pending
 *
 * Returns the fragrances the Beam Agent recommended that weren't in our catalog
 * and so were queued for enrichment, tagged to THIS user. The SPA reads this on
 * return (and after a `?curation=<jobKey>` deep-link) to surface the ready ones
 * for "add to vault". The user scope comes from `requireAuth` (req.user.id) — it
 * is never taken from a query/body arg — so one shared queue row is only ever
 * shown to the user who asked for it.
 *
 * Best-effort by construction: the service degrades to `[]` when the
 * enrichment_jobs schema isn't provisioned, so this endpoint can't 500 on a
 * migration lag.
 */
router.get("/beam-agent/curation/pending", requireAuth, async (req: AuthRequest, res) => {
  if (!req.user) {
    res.status(401).json({ error: "Authentication required." });
    return;
  }
  try {
    const items = await listPendingCurationForUser(req.user.id);
    res.json({ items });
  } catch (err) {
    logger.warn({ err }, "pending curation lookup failed");
    res.status(500).json({ error: "Could not load pending curation." });
  }
});

export default router;
