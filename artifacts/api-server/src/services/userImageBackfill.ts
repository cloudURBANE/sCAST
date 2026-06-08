/**
 * BE-2 — user wardrobe image backfill.
 *
 * A deferred scent-profile save returns `imageUrl: ""`; the frontend persists
 * the `user_fragrances` row (image stored *inside* the `fragrance_data` JSONB
 * blob, not a column) before the background Serper pass finishes. Without this,
 * the resolved image only ever reaches the shared `global_fragrances` catalog,
 * and the user's own tile stays empty until a full reload.
 *
 * When the background pass succeeds, scentEngineCore calls this to push the
 * image into every still-imageless wardrobe row for the same fragrance.
 *
 * The matching/patch semantics live in the pure `userImageBackfillCore` (unit-
 * tested); the SQL WHERE below is the parameterized mirror of
 * `matchesBackfillTarget`. Safety invariants enforced there and here:
 *   - Only fills rows whose image is currently empty/absent — never overwrites
 *     an existing image or a user override (the image-IS-NULL guard).
 *   - Matches exact name (case/trim-insensitive) AND any spelling that
 *     canonicalizes to the same brand. No fuzzy matching — cannot bleed across
 *     fragrances.
 *   - Merges into the JSONB with `||` so all other keys are preserved.
 *   - Best-effort: callers wrap it so a failure is non-fatal.
 */
import { db } from "@workspace/db";
import { userFragrancesTable } from "@workspace/db/schema";
import { sql } from "drizzle-orm";
import { brandSpellings } from "./brandAliasCore";
import { buildImagePatch, normalizeBackfillText } from "./userImageBackfillCore";
import type { ProcessedImageRef } from "./scentEngineCore";

export async function backfillUserFragranceImages(
  brand: string,
  name: string,
  image: ProcessedImageRef,
): Promise<void> {
  if (!image?.imageUrl) return;

  const normalizedName = normalizeBackfillText(name);
  if (!normalizedName) return;

  const spellings = brandSpellings(brand);
  if (spellings.length === 0) return;

  const patch = buildImagePatch(image);

  const data = userFragrancesTable.fragranceData;
  const brandList = sql.join(
    spellings.map((s) => sql`${s}`),
    sql`, `,
  );

  await db
    .update(userFragrancesTable)
    .set({ fragranceData: sql`${data} || ${JSON.stringify(patch)}::jsonb` })
    .where(sql`
      lower(trim(${data} ->> 'name')) = ${normalizedName}
      AND lower(trim(${data} ->> 'brand')) IN (${brandList})
      AND coalesce(
        nullif(${data} ->> 'imageUrl', ''),
        nullif(${data} ->> 'image_url', '')
      ) IS NULL
    `);
}
