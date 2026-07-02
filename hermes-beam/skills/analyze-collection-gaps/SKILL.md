---
name: analyze-collection-gaps
description: Audit the user's owned collection for gaps, balance, and redundancy via the deterministic collection report, then suggest a few grounded fills. Use when the user asks "what gaps do I have", "what's missing", "what should I add next", or "is my collection well-rounded".
---

# Analyze collection gaps

Goal: a short, curated verdict on what the collection is and the 2–3 gaps most
worth filling — grounded entirely in the deterministic report, never a hand-rolled
audit of the raw wardrobe list.

> Read-only: you recommend; nothing is saved without the user's explicit Confirm in
> the app.

## Procedure

1. **Get the report.** Call `beam_analyze_collection`. It is the single source of
   truth for composition, coverage, gaps, and redundancy. Do NOT derive gaps
   yourself from `beam_get_wardrobe`, and do not ask clarifying questions first —
   this is a standing analytical question, not a trip kit.
2. **Honesty gate.** If `reliable` is false, say too few bottles are enriched to
   judge gaps yet (use `dataQualityNote`), offer to look at specific bottles
   instead, and stop.
3. **Curate, don't dump.** Answer with:
   - one line on the collection's character (the report's `summary`);
   - the top **2–3 gaps** by severity, each with its one-line evidence;
   - optionally ONE redundancy observation if the report flags a cluster.
   Never list the vault back at the user; cite at most 2–3 bottles as evidence.
4. **Fill gaps only when asked (or offer to).** For each gap the user wants filled:
   `beam_search_catalog` in the gap's direction with `excludeOwned: true`, deepen
   with `beam_get_fragrance_details` (batched), check `beam_compare_overlap`, then
   suggest **1–2 bottles per gap** — only names a tool returned.
5. **Close with one step.** Offer ONE follow-up (e.g. "want picks for the top
   gap?"), not a menu.

## Guardrails
- Only assert gap/composition/diversity/redundancy claims the report contains.
- Every suggested bottle must trace to a tool result — no memory picks.
- Budget: the whole reply fits one phone screen (~120 words). No Markdown tables.
- Never mention tool mechanics or count discrepancies between tool results.
