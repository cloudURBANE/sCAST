import type { ScentMissionWardrobeItem } from "@workspace/scent-weather-engine";

const BRAND_ALIASES = new Map<string, string>([
  ["ysl", "yves saint laurent"],
  ["yves st laurent", "yves saint laurent"],
  ["yves saint laurent", "yves saint laurent"],
]);

export function normalizeFragranceIdentityPart(
  value: string | null | undefined,
): string {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function canonicalBrand(value: string | null | undefined): string {
  const normalized = normalizeFragranceIdentityPart(value);
  return BRAND_ALIASES.get(normalized) ?? normalized;
}

export function fragranceIdentityKey(
  brand: string | null | undefined,
  name: string | null | undefined,
): string {
  const normalizedName = normalizeFragranceIdentityPart(name);
  if (!normalizedName) return "";
  return `${canonicalBrand(brand)}|${normalizedName}`;
}

export type OwnedFragranceIndex = {
  fullKeys: Set<string>;
  unbrandedNames: Set<string>;
  brandsByName: Map<string, Set<string>>;
};

export function buildOwnedFragranceIndex(
  items: ScentMissionWardrobeItem[],
): OwnedFragranceIndex {
  const fullKeys = new Set<string>();
  const unbrandedNames = new Set<string>();
  const brandsByName = new Map<string, Set<string>>();
  for (const item of items) {
    const name = normalizeFragranceIdentityPart(item?.name);
    if (!name) continue;
    const brand = canonicalBrand(item.brand);
    if (!brand) {
      unbrandedNames.add(name);
      continue;
    }
    fullKeys.add(`${brand}|${name}`);
    const brands = brandsByName.get(name) ?? new Set<string>();
    brands.add(brand);
    brandsByName.set(name, brands);
  }
  return { fullKeys, unbrandedNames, brandsByName };
}

/** Conservative ownership check: a bare name only matches when it identifies one house. */
export function isOwnedFragrance(
  index: OwnedFragranceIndex,
  brand: string | null | undefined,
  name: string,
): boolean {
  const normalizedName = normalizeFragranceIdentityPart(name);
  if (!normalizedName) return false;
  const normalizedBrand = canonicalBrand(brand);
  if (
    normalizedBrand &&
    index.fullKeys.has(`${normalizedBrand}|${normalizedName}`)
  )
    return true;
  if (index.unbrandedNames.has(normalizedName)) return true;
  if (normalizedBrand) return false;
  return (index.brandsByName.get(normalizedName)?.size ?? 0) === 1;
}

export function findOwnedVaultItem(
  items: ScentMissionWardrobeItem[],
  brand: string | null | undefined,
  name: string,
): ScentMissionWardrobeItem | undefined {
  const normalizedName = normalizeFragranceIdentityPart(name);
  const normalizedBrand = canonicalBrand(brand);
  if (!normalizedName) return undefined;
  if (normalizedBrand) {
    return items.find(
      (item) =>
        normalizeFragranceIdentityPart(item.name) === normalizedName &&
        canonicalBrand(item.brand) === normalizedBrand,
    );
  }
  const matches = items.filter(
    (item) => normalizeFragranceIdentityPart(item.name) === normalizedName,
  );
  return matches.length === 1 ? matches[0] : undefined;
}
