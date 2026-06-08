/**
 * Pure, dependency-free brand canonicalization (BE-6 / BE-2).
 *
 * No runtime imports — kept separate from catalogService.ts (which imports the
 * DB pool at module load) so the node:test runner can unit-test it in isolation.
 * catalogService re-exports these for its public API.
 */

// Canonical brand spellings, keyed by every alias we expect to see inbound.
// Direction matters: each alias maps to the spelling ALREADY stored in
// global_fragrances, so canonicalizing aligns lookups to existing rows instead
// of orphaning them. Verified 2026-06-08 against live data — every YSL row is
// stored as `yves saint laurent::…` (no `ysl::` / `saint laurent::` variants),
// so folding "YSL" / "Saint Laurent" into "yves saint laurent" can only ever
// *hit* the canonical row, never strand one. Add an alias here only after
// confirming the target spelling is the one actually persisted.
export const BRAND_ALIASES: Record<string, string> = {
  ysl: "yves saint laurent",
  "saint laurent": "yves saint laurent",
  "yves st laurent": "yves saint laurent",
  "yves st. laurent": "yves saint laurent",
};

export function canonicalizeBrand(brand: string): string {
  const normalized = brand.trim().toLowerCase().replace(/\s+/g, " ");
  return BRAND_ALIASES[normalized] ?? normalized;
}

/**
 * Every lowercased spelling that canonicalizes to the same brand as `brand`
 * (the canonical form plus all of its aliases). Used by the BE-2 user-image
 * backfill to match wardrobe rows regardless of which spelling each was stored
 * under (e.g. a row saved as `YSL` and another as `Yves Saint Laurent` both
 * match). For a non-aliased brand this is just `[canonical]`.
 */
export function brandSpellings(brand: string): string[] {
  const canonical = canonicalizeBrand(brand);
  const aliases = Object.entries(BRAND_ALIASES)
    .filter(([, target]) => target === canonical)
    .map(([alias]) => alias);
  return Array.from(new Set([canonical, ...aliases]));
}
