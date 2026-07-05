import { Router } from "express";
import { getScentFacts } from "../lib/scent-facts/engine";
import { rateLimitMiddleware } from "../lib/rateLimit";

const router = Router();

// Per-IP rate limit on the (intentionally unauthenticated) scent-facts
// endpoint. Every call is uncached and bills real spend — a Serper search
// (shared credit pool with the image pipeline), up to six Jina reads, and one
// LLM extraction call (OpenAI/Gemini) — so cap abuse hard. Nothing in the SPA
// consumes this route today (internal services import getScentFacts directly),
// which is why the default is far tighter than the reviews/mission throttles.
// Tunable via SCENT_FACTS_RATE_LIMIT (default 10 / 5 min / IP).
const scentFactsRateLimit = rateLimitMiddleware({
  name: "scent-facts-enrich",
  limit: (() => {
    const raw = Number(process.env.SCENT_FACTS_RATE_LIMIT?.trim());
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 10;
  })(),
  windowMs: 5 * 60_000,
});

router.post("/scent-facts/enrich", scentFactsRateLimit, async (req, res) => {
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
