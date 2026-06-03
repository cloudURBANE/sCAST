import { Router } from "express";
import { AuthRequest, requireAuth } from "../middlewares/auth";
import { getUsageTotals } from "../services/apiUsageLedger";
import { logger } from "../lib/logger";

const router = Router();

router.get("/usage/total", requireAuth, async (_req: AuthRequest, res) => {
  try {
    // App-wide operational cost meter ("Reimagine spend so far"), not per-user
    // billing. The /reimagine-bottle-image route is intentionally unauthenticated
    // (it supports the anonymous preview-then-save flow), so every api_usage_ledger
    // row is recorded with userId = null. Scoping this read by req.user.id therefore
    // matches zero rows and zeroes out the meter — read the global total instead.
    // requireAuth still gates the endpoint so the figure is not publicly exposed.
    const totals = await getUsageTotals();
    res.json(totals);
  } catch (err: any) {
    logger.error({ err: err?.message }, "usage/total failed");
    res.status(500).json({ error: err?.message || "Failed to read usage totals" });
  }
});

export default router;
