import { Router } from "express";
import { AuthRequest, requireAuth } from "../middlewares/auth";
import { getUsageTotals } from "../services/apiUsageLedger";
import { logger } from "../lib/logger";

const router = Router();

router.get("/usage/total", requireAuth, async (req: AuthRequest, res) => {
  try {
    const totals = await getUsageTotals(req.user!.id);
    res.json(totals);
  } catch (err: any) {
    logger.error({ err: err?.message }, "usage/total failed");
    res.status(500).json({ error: err?.message || "Failed to read usage totals" });
  }
});

export default router;
