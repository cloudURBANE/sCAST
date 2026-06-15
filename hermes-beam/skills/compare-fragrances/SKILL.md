---
name: compare-fragrances
description: Compare two or more specific fragrances on notes, accords, performance, and best-use, to help the user choose. Use for "X vs Y", "which should I get", "how do these differ" requests.
---

# Compare fragrances

Goal: a clear, side-by-side comparison grounded in retrieved facts, ending with a
recommendation tied to the user's context.

## Procedure

1. **Identify the candidates.** If the user named fragrances, confirm them against
   real records: `beam_search_catalog` (or `beam_get_wardrobe` if they're owned).
2. **Gather facts in one batch.** `beam_get_fragrance_details` with all the names at
   once. Note any `found:false` / thin data as reduced confidence.
3. **Ground in the user.** `beam_get_user_context` so the verdict reflects their
   climate and the families they already lean toward.
4. **Compare on what matters:** top/heart/base notes, dominant accords/family,
   longevity & projection, and best-use (weather/occasion). Be specific, not generic.
5. **Give a verdict.** Recommend one for the user's likely use, and say when the other
   wins instead ("the warmer one for cold-weather evenings"). Acknowledge that taste
   is subjective.

If the comparison is really "do I already own something like this?" (one candidate vs
the whole vault), use `beam_compare_overlap` instead of hand-rolling it from details —
it returns deterministic per-bottle overlap scores and the closest owned match.

## Guardrails
- Only state attributes a tool returned; if data is missing for one fragrance, say the
  comparison is partial rather than filling gaps.
- No invented notes, performance numbers, or prices.
