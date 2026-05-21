/**
 * Pure, dependency-free core for fragrance-payload schema versioning.
 *
 * Lives separately from fragrancePayload.ts so the bare node:test runner
 * (--experimental-strip-types) can import these helpers without following the
 * extensionless-import chain in fragrancePayload.ts. Matches the *Core pattern
 * used by scentEngineCore.ts and imagePipelineCore.ts.
 */

/**
 * Bump when the persisted user_fragrances payload shape changes in a way that
 * requires reading code to migrate or rebuilding code to refresh. Stamped onto
 * every write by `sanitizeFragrance`; consumers can use `isLegacyVaultRow` to
 * tell whether a row was written before the current shape was finalized.
 */
export const CURRENT_VAULT_SCHEMA_VERSION = 1;

export function isLegacyVaultRow(
  fragrance: Record<string, any> | null | undefined,
): boolean {
  if (!fragrance) return true;
  const version = fragrance.schemaVersion;
  return typeof version !== "number" || version < CURRENT_VAULT_SCHEMA_VERSION;
}

export function stampVaultSchemaVersion(
  fragrance: Record<string, any>,
): Record<string, any> {
  return { ...fragrance, schemaVersion: CURRENT_VAULT_SCHEMA_VERSION };
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function chooseHydratedImageUrl(
  sharedImageUrl: unknown,
  currentImageUrl: unknown,
): string {
  return nonEmptyString(currentImageUrl) ?? nonEmptyString(sharedImageUrl) ?? "";
}
