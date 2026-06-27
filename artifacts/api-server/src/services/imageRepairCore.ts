/**
 * Pure, dependency-free core of the dead-image-reference repair.
 *
 * Processed-image URLs are persisted INSIDE the JSONB blobs of two tables, not
 * in a column: `user_fragrances.fragrance_data.imageUrl` and
 * `global_fragrances.profile_data.imageUrl`. When an earlier deploy baked a URL
 * that no longer serves (a local `/api/image-objects/...` ref that is not durable
 * in production, a base64 data URL, or an http(s) URL to a decommissioned bucket)
 * into those blobs, the row keeps that dead string forever:
 *   - the live `backfillUserFragranceImages` only fills rows whose image IS NULL,
 *     so a non-empty dead string is never overwritten; and
 *   - the read-path `resolveSharedImageReference` can be pinned by a dead http URL
 *     that still looks "usable" (it is http, so `usableImageUrlForResponse`
 *     returns it as-is), so no substitution happens and the tile renders broken.
 *
 * The repair CLEARS the dead reference keys so both self-heal paths re-engage.
 * It is deliberately conservative: it only treats a reference as dead when that
 * can be proven offline, so it can never wipe a working URL. Operator-supplied
 * `deadUrlPrefixes` are the explicit escape hatch for a known-dead bucket.
 *
 * No runtime imports — kept separate from imageRepair.ts (which imports the DB
 * pool) so the node:test runner can unit-test the classification in isolation.
 * The SQL in imageRepair.ts MUST mirror `isDeadPersistedImageUrl` /
 * `extractPersistedImageUrl` exactly; these helpers are the single source of
 * truth for that contract and what the tests pin.
 */

export type ImageRepairPolicy = {
  /**
   * Treat `/api/image-objects/...` local-object URLs as dead. These are served
   * off the API process's local filesystem, which is ephemeral on hosts like
   * Railway, so in production they do not survive a redeploy. Set true when
   * repairing a production database (the default the ops script derives from
   * `isLocalImageObjectUrlPersistable()`), false in a local dev environment
   * where the `.image-cache/` files still exist.
   */
  localObjectUrlsAreDead: boolean;
  /**
   * http(s) URL prefixes that point at storage that no longer serves (e.g. a
   * decommissioned `https://old-bucket.firebasestorage.app/` bucket). Empty by
   * default so the repair never touches a live http URL unless an operator names
   * the dead origin explicitly.
   */
  deadUrlPrefixes: string[];
};

/**
 * The JSONB keys that together locate a persisted processed image. All are
 * stripped when the reference is dead so the row is treated as imageless and
 * re-resolved cleanly. `sourceProvider` is intentionally NOT stripped — it
 * describes where the ORIGINAL source image was found (serper/manual), not the
 * dead processed object, and is harmless metadata that can aid re-resolution.
 */
export const IMAGE_REF_KEYS = [
  "imageUrl",
  "image_url",
  "imageHash",
  "storagePath",
  "storageProvider",
] as const;

/** The active persisted image URL of a row, or null when absent (camel then legacy snake). */
export function extractPersistedImageUrl(data: Record<string, unknown>): string | null {
  const camel = typeof data.imageUrl === "string" ? data.imageUrl.trim() : "";
  if (camel) return camel;
  const snake = typeof data.image_url === "string" ? data.image_url.trim() : "";
  return snake || null;
}

/**
 * Whether a persisted image URL is PROVABLY dead under the policy. A null/empty
 * value is "absent", not "dead" (the NULL-guarded live backfill already handles
 * absent rows), so it returns false.
 */
export function isDeadPersistedImageUrl(value: unknown, policy: ImageRepairPolicy): boolean {
  if (typeof value !== "string") return false;
  const url = value.trim();
  if (!url) return false;

  // base64 data URLs are never servable as an <img> src in this app and are
  // already blanked on read; clearing them lets the row re-resolve a real URL.
  if (/^data:image\//i.test(url)) return true;

  if (policy.localObjectUrlsAreDead && url.startsWith("/api/image-objects/")) return true;

  for (const prefix of policy.deadUrlPrefixes) {
    if (prefix && url.startsWith(prefix)) return true;
  }

  return false;
}

/** Whether a row's persisted image data should be repaired (cleared) under the policy. */
export function shouldRepairImageData(
  data: Record<string, unknown>,
  policy: ImageRepairPolicy,
): boolean {
  const url = extractPersistedImageUrl(data);
  return url !== null && isDeadPersistedImageUrl(url, policy);
}

/** Returns a copy of the JSONB blob with every image-locating key removed. */
export function clearImageRefKeys(data: Record<string, unknown>): Record<string, unknown> {
  const out = { ...data };
  for (const key of IMAGE_REF_KEYS) delete out[key];
  return out;
}
