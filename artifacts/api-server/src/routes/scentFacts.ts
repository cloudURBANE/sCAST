import { Router } from "express";
import { getScentFacts } from "../lib/scent-facts/engine";

const router = Router();

router.post("/scent-facts/enrich", async (req, res) => {
  try {
    const body = req.body as {
      fragranceName?: unknown;
      sourceUrl?: unknown;
      save?: unknown;
    };

    const result = await getScentFacts({
      fragranceName: String(body.fragranceName || ""),
      sourceUrl: body.sourceUrl ? String(body.sourceUrl) : undefined,
      save: false,
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : "Unknown scent facts error.",
    });
  }
});

export default router;
