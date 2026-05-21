import { Router } from "express";
import {
  summarizeFragranceReviews,
  type RawReview,
} from "../services/reviewSummaryService";

const router = Router();

/**
 * Distill scraped fragrance reviews into short, original display comments.
 *
 * The SPA fetches fragrance details (including `raw.reviews`) from the external
 * engine, then posts those reviews here. Results are cached per fragrance, so
 * repeated views of the same fragrance do not re-spend an LLM call.
 *
 * Degrades gracefully: with no reviews, no LLM key, or an LLM failure it
 * responds 200 with an empty `comments` array rather than surfacing an error.
 */
router.post("/reviews/summarize", async (req, res) => {
  const body = (req.body ?? {}) as {
    name?: unknown;
    brand?: unknown;
    reviews?: unknown;
  };

  const reviews: RawReview[] = Array.isArray(body.reviews)
    ? body.reviews
        .map((r) => {
          const obj = (r ?? {}) as { text?: unknown; source?: unknown };
          return {
            text: typeof obj.text === "string" ? obj.text : "",
            source: typeof obj.source === "string" ? obj.source : undefined,
          };
        })
        .filter((r) => r.text.trim().length > 0)
    : [];

  try {
    const result = await summarizeFragranceReviews({
      name: typeof body.name === "string" ? body.name : "",
      brand: typeof body.brand === "string" ? body.brand : "",
      reviews,
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    // LLM/network failure must not break the detail view — return empty.
    res.json({
      ok: false,
      comments: [],
      cached: false,
      error: error instanceof Error ? error.message : "Unknown review summary error.",
    });
  }
});

export default router;
