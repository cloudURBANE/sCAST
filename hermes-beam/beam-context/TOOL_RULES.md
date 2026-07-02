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

### `beam_analyze_collection` — deterministic; call first for collection questions
Input: none. Runs the evidence-gated analysis of the owned collection: family
distribution + diversity, signature accords/notes, occasion/season coverage with
explicit `gaps`, redundancy clusters, and a `reliable` flag. For any "what are my
gaps / what should I add / is it well-rounded" question, call this FIRST and answer
from its fields — never compute gaps or redundancy yourself from the raw wardrobe.
When `reliable` is false, say the data is too thin to judge (use `dataQualityNote`)
instead of guessing.

### `beam_search_catalog`
Input: `query` (brand and/or name), optional `limit`, optional `excludeOwned`. Returns
candidate packets for **real** catalog fragrances. The server caps the result count —
don't try to widen it. Prefer specific queries.

### `beam_get_fragrance_details`
Input: `names` (an array — **batch them**). Returns best-effort research facts per
name with a `found` flag. Read-only; nothing is saved. Missing facts → lower
confidence, not invention.

### `beam_score_candidates` — deterministic
Input: optional `destination` (Staying In | Going Out | Work | Night Out | Date | Gym),
`energy` (Calm | Focused | Confident | Social | Relaxed), `limit` (how many ranked
picks — server caps at 3), and a trip override `locationLabel` (e.g. `'Tokyo, June'`)
plus `weatherOverride` ({ temperature_f, humidity_percent, wind_speed_mph, is_raining,
condition }) to score against a destination's climate instead of today's local
weather. Returns `{ recommendation, picks[], scoredFor }`: `recommendation` is the top
pick, `picks` the ranked set (each with `score` + `reason`). **Never** compute or
adjust scores yourself — report what the tool returns. (Note: over the Hermes/MCP path
the vault is scored single-best, so `limit > 1` still returns one pick for now.)

### `beam_compare_overlap` — deterministic redundancy radar
Input: `query` (the candidate brand/name), optional `limit` (owned bottles to return,
ranked by overlap). Resolves the query to a REAL catalog fragrance, then compares its
note pyramid (base notes weighted most) and accords against every bottle in the vault.
Returns `{ resolved, candidate, vaultCount, closestMatch{band}, items[] }`. Call this
**before** recommending a purchase, or for "do I already own something like this?" —
do not estimate overlap yourself.

### `beam_research_web` — live freshness only
Input: `query` (the specific fact), optional `entityType` and `depth`. Cost-capped,
cached web lookup for CURRENT external facts: live price, availability,
discontinued/reformulated/newly-released status, missing metadata, sample sellers.
Returns a synthesized fact + sources, or a `note` when live research is unavailable
(then answer from cached knowledge and say it is not freshly verified). Do NOT use it
for normal recommendations, weather/occasion fits, ranking, or comparing common scents.

## Discipline

- Only recommend `fragranceId`s / fragrances that appeared in a packet from a tool.
- Never surface internal bookkeeping to the user: tool mechanics, retries, or counts
  that disagree between tool results. `beam_get_wardrobe`'s count is the vault size;
  if another summary disagrees, use the wardrobe count and move on silently.
- Batch detail calls; don't loop single lookups.
- Stop as soon as the request is satisfied — respect the tool-call budget.
- If a tool errors, surface a graceful fallback (see AGENTS.md) — don't retry blindly.
