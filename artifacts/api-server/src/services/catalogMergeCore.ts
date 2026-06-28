import type { ScentProfile } from "./scentEngineCore";

/**
 * WS-8 — "don't downgrade the shared catalog."
 *
 * The global catalog is shared across every user. A single user's minimal /
 * pending add (no notes, no real family, no image) must never overwrite a row
 * that another path already populated, and a richer save that merely *lacks* an
 * image must not blank out an image the row already had. These pure predicates +
 * merge encode that policy so it can be unit-tested without a DB.
 */

function hasText(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function nonEmptyStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.some((v) => typeof v === "string" && v.trim().length > 0);
}

export function isRealFamily(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const f = value.trim().toLowerCase();
  return f.length > 0 && f !== "unknown family" && f !== "unknown";
}

function pyramidHasContent(pyramid: ScentProfile["pyramid"]): boolean {
  if (!pyramid) return false;
  return (
    nonEmptyStringArray(pyramid.top) ||
    nonEmptyStringArray(pyramid.heart) ||
    nonEmptyStringArray(pyramid.base)
  );
}

/**
 * True when the profile carries no real scent identity yet — i.e. saving it can
 * only ever degrade an existing populated row. Such saves are create-only.
 */
export function catalogProfileIsMinimal(profile: ScentProfile): boolean {
  return (
    !nonEmptyStringArray(profile.notes) &&
    !isRealFamily(profile.family) &&
    !hasText(profile.imageUrl) &&
    !pyramidHasContent(profile.pyramid) &&
    !nonEmptyStringArray(profile.accords)
  );
}

/**
 * Merge an incoming (non-minimal) profile over the existing stored row without
 * downgrading fields the incoming save happens to lack. Incoming wins by default
 * for every field; we only restore the existing value where incoming is empty:
 *
 *  - notes / family / pyramid / accords: a sparser re-save keeps the richer prose.
 *  - image columns are treated as a unit so a new url is never paired with a
 *    stale storage path (or an existing image blanked by a notes-only enrichment).
 */
export function mergeCatalogProfilePreserveRicher(
  existing: ScentProfile,
  incoming: ScentProfile,
): ScentProfile {
  const merged: ScentProfile = { ...existing, ...incoming };

  if (!nonEmptyStringArray(incoming.notes) && nonEmptyStringArray(existing.notes)) {
    merged.notes = existing.notes;
  }
  if (!isRealFamily(incoming.family) && isRealFamily(existing.family)) {
    merged.family = existing.family;
  }
  if (!pyramidHasContent(incoming.pyramid) && pyramidHasContent(existing.pyramid)) {
    merged.pyramid = existing.pyramid;
  }
  if (!nonEmptyStringArray(incoming.accords) && nonEmptyStringArray(existing.accords)) {
    merged.accords = existing.accords;
  }
  if (!hasText(incoming.imageUrl) && hasText(existing.imageUrl)) {
    merged.imageUrl = existing.imageUrl;
    merged.storagePath = existing.storagePath;
    merged.imageHash = existing.imageHash;
    merged.storageProvider = existing.storageProvider;
    merged.sourceProvider = existing.sourceProvider;
  }

  return merged;
}
