/**
 * Beam Agent — honest price/budget gating for recommendation picks.
 *
 * The product rule (audit F): "enforce when KNOWN, degrade silently when UNKNOWN."
 *   - A pick whose price we actually captured AND that exceeds the user's numeric
 *     ceiling is flagged `over_budget` and downranked (never silently dropped — a
 *     thin honest pool beats an empty one, same backstop as avoidFilter).
 *   - A pick with no captured price, or any pick when the user gave no NUMERIC
 *     ceiling, is `unknown`: it rides through untouched and is NEVER presented as
 *     "within budget". We never fabricate a price or a verdict.
 *
 * PURE + dependency-free so it unit-tests in isolation. Price capture itself is
 * opportunistic and lives upstream (engine `/details` price, `beam_research_web`);
 * this module only reasons over a ceiling + an already-known price.
 */

export type PriceStatus = "within_budget" | "over_budget" | "unknown";

/**
 * Extract a NUMERIC USD ceiling from the `budget` slot, or null when there isn't
 * an honest number to enforce. The slot is produced by `missionState.parseBudget`
 * and is one of: `"$80"`, `"$50-100"` (a range — the high end is the ceiling),
 * a bare number, or a QUALITATIVE word (`"Budget-friendly"`, `"Premium"`). The
 * qualitative cases return null on purpose: there is no real number to gate on, so
 * inventing one would be exactly the "fake numeric budget filtering" the audit bans.
 */
export function parseBudgetCeiling(budget: string | undefined | null): number | null {
  if (!budget) return null;
  const text = String(budget).trim();
  if (!text) return null;

  // Range like "$50-100" / "50 to 100" — the upper bound is the ceiling.
  const range = /(\d{1,5})\s*(?:-|–|to|and)\s*\$?\s*(\d{1,5})/i.exec(text);
  if (range?.[1] && range?.[2]) {
    const hi = Math.max(Number(range[1]), Number(range[2]));
    return Number.isFinite(hi) && hi > 0 ? hi : null;
  }

  // A single number anywhere in the slot ("$80", "under 150", "100").
  const single = /(\d{1,5})/.exec(text);
  if (single?.[1]) {
    const n = Number(single[1]);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  // Qualitative ("Budget-friendly", "Premium") — no honest number to enforce.
  return null;
}

/**
 * Classify one pick against a ceiling. Unknown price OR no ceiling => `unknown`
 * (no enforcement, never a false "within"). A captured price decides the rest.
 */
export function priceStatusFor(
  price: number | undefined | null,
  ceiling: number | null,
): PriceStatus {
  if (ceiling === null || ceiling <= 0) return "unknown";
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) return "unknown";
  return price <= ceiling ? "within_budget" : "over_budget";
}

/**
 * Annotate + reorder picks against a ceiling. Within-budget first, then
 * unknown-price, then over-budget — a stable, explainable ordering that keeps
 * over-budget picks available (downranked, not dropped) so the agent can still
 * mention "a bit above your budget" rather than returning nothing. When the
 * ceiling is null this is an identity pass (everything `unknown`, original order).
 */
export function annotateBudget<T extends { price?: number | null }>(
  items: T[],
  ceiling: number | null,
): Array<T & { priceStatus: PriceStatus }> {
  const ranked = items.map((item, index) => ({
    item,
    index,
    status: priceStatusFor(item.price ?? null, ceiling),
  }));
  const order: Record<PriceStatus, number> = { within_budget: 0, unknown: 1, over_budget: 2 };
  ranked.sort((a, b) => order[a.status] - order[b.status] || a.index - b.index);
  return ranked.map(({ item, status }) => ({ ...item, priceStatus: status }));
}
