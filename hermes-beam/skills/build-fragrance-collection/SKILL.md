---
name: build-fragrance-collection
description: Assemble a balanced multi-fragrance collection for a stated goal (budget, season, occasions) from the user's vault plus real catalog finds. Use when the user asks to "build", "put together", or "plan" a set/collection/rotation of several fragrances.
---

# Build a fragrance collection

Goal: propose a small, well-reasoned set (typically 4–6) that covers the user's
stated roles/occasions without redundancy, grounded entirely in tool results.

> Read-only phase: you **recommend** a set; you do not save it. If the user wants it
> saved to their account, say that saving arrives in a later release.

## Procedure

1. **Clarify only what's missing.** You need: how many bottles, budget (if any),
   season/climate, and the occasions/roles to cover (e.g. work, date, statement).
   Ask at most one concise question if these are absent — otherwise proceed.
2. **Ground in the user.** Call `beam_get_user_context` (vault size, dominant
   families, weather), then `beam_get_wardrobe` to see what they already own.
3. **Find real candidates.** Use `beam_search_catalog` for each role/gap (e.g. a
   fresh office scent, a warm evening scent). Set `excludeOwned: true` to avoid
   duplicating the vault. Only consider ids returned by the tool.
4. **Deepen evidence in batches.** Call `beam_get_fragrance_details` with several
   names at once for the shortlist. Lower confidence for thin/`found:false` entries.
5. **Rank with the engine.** Use `beam_score_candidates` (with the relevant
   destination/energy) for weather/occasion fit. Never invent scores.
6. **Remove redundancy.** Drop near-duplicate profiles (same family + accords filling
   the same role). Aim for coverage across the requested roles, not five variations
   of one idea.
7. **Assemble the set.** For each pick give: role it covers, why it fits (notes +
   weather + the user's taste), owned-vs-new, and price **only if a tool returned it**.
8. **Summarize honestly.** State total estimated cost (if prices were returned), where
   any overlap remains, which constraints are met, and any reduced-confidence picks.

## Guardrails
- Every fragrance must trace to a tool result. No invented bottles, notes, or prices.
- Respect disliked notes and budget; if you can't meet a constraint, say so plainly.
- Prefer the local catalog; if it's too thin to cover a role, say that rather than
  guessing (external discovery is a future phase).
