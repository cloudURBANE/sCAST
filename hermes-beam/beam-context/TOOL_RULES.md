# Beam tool rules

Authority lives in the tools. They enforce tenant/user scope, result limits, and
read-only access regardless of what you ask for. Use them as follows.

## Retrieval order (cheapest, most-grounded first) — plan §17

1. **The vault** — `beam_get_wardrobe` for anything about what the user owns.
2. **Local catalog** — `beam_search_catalog` for new/real candidates.
3. **Cached details / research** — `beam_get_fragrance_details` to deepen evidence.
4. Only after the above is exhausted should you tell the user the catalog is thin.
   (An external-search fallback and enrichment are future phases — not available yet.)

## The tools

### `beam_get_user_context` — call first
Input: none. Returns vault size, dominant scent families, and today's weather. Grounds
every recommendation. Cheap; always start here for personalized requests.

### `beam_get_wardrobe`
Input: none. Returns owned fragrances as **candidate packets**: `fragranceId`,
`canonicalName`, `brand`, `accords`, notes, performance, `sourceConfidence`,
`missingFields`. Use these ids when reasoning about what they own.

### `beam_search_catalog`
Input: `query` (brand and/or name), optional `limit`, optional `excludeOwned`. Returns
candidate packets for **real** catalog fragrances. The server caps the result count —
don't try to widen it. Prefer specific queries.

### `beam_get_fragrance_details`
Input: `names` (an array — **batch them**). Returns best-effort research facts per
name with a `found` flag. Read-only; nothing is saved. Missing facts → lower
confidence, not invention.

### `beam_score_candidates` — deterministic
Input: optional `destination` (Staying In | Going Out | Work | Night Out | Date | Gym)
and `energy` (Calm | Focused | Confident | Social | Relaxed). Returns the engine's
single best vault pick with a numeric `score` and a `reason`. **Never** compute or
adjust scores yourself — report what the tool returns.

## Discipline

- Only recommend `fragranceId`s / fragrances that appeared in a packet from a tool.
- Batch detail calls; don't loop single lookups.
- Stop as soon as the request is satisfied — respect the tool-call budget.
- If a tool errors, surface a graceful fallback (see AGENTS.md) — don't retry blindly.
