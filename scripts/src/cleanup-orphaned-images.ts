import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Load environment variables from the monorepo root .env file
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

import { db } from "@workspace/db";
import {
  userFragrancesTable,
  imageCacheTable,
  globalFragrancesTable,
} from "@workspace/db/schema";
import { eq, inArray } from "drizzle-orm";
import { getImageObjectStorage } from "../../artifacts/api-server/src/services/imageObjectStorage";
import { deleteCachedImage } from "../../artifacts/api-server/src/services/firebaseCache";

function makeLookupKey(brand: string, name: string): string {
  return `${brand.trim().toLowerCase()}::${name.trim().toLowerCase()}`;
}

async function main() {
  console.log("[GC] Starting garbage collection of orphaned image and catalog data...");

  // 1. Fetch all user fragrances to determine active lookup keys
  const userFragrances = await db.select().from(userFragrancesTable);
  const activeLookupKeys = new Set<string>();

  for (const row of userFragrances) {
    const existing = row.fragranceData as Record<string, any>;
    if (!existing) continue;

    const name = (existing.name as string | undefined)?.trim()
      || (existing.product?.name as string | undefined)?.trim()
      || "";
    const brand = (existing.brand as string | undefined)?.trim()
      || (existing.product?.brand as string | undefined)?.trim()
      || "";

    if (brand && name) {
      activeLookupKeys.add(makeLookupKey(brand, name));
    }
  }

  console.log(`[GC] Found ${activeLookupKeys.size} active lookup keys across all user wardrobes.`);

  // 2. Fetch all cached images
  const cachedImages = await db.select({
    id: imageCacheTable.id,
    lookupKey: imageCacheTable.lookupKey,
    storagePath: imageCacheTable.storagePath,
  }).from(imageCacheTable);

  const orphanedImageRows = cachedImages.filter(row => {
    return !row.lookupKey || !activeLookupKeys.has(row.lookupKey);
  });

  console.log(`[GC] Found ${orphanedImageRows.length} orphaned rows in image_cache.`);

  // 3. Fetch all global fragrances
  const globalFragrances = await db.select({
    id: globalFragrancesTable.id,
    lookupKey: globalFragrancesTable.lookupKey,
    brand: globalFragrancesTable.brand,
    name: globalFragrancesTable.name,
  }).from(globalFragrancesTable);

  const orphanedGlobalRows = globalFragrances.filter(row => {
    return !row.lookupKey || !activeLookupKeys.has(row.lookupKey);
  });

  console.log(`[GC] Found ${orphanedGlobalRows.length} orphaned rows in global_fragrances.`);

  // 4. Delete storage objects for orphaned images
  if (orphanedImageRows.length > 0) {
    const storage = getImageObjectStorage();
    if (typeof storage.deleteObject === "function") {
      console.log(`[GC] Cleaning up files from object storage...`);
      for (const row of orphanedImageRows) {
        if (row.storagePath) {
          try {
            await storage.deleteObject(row.storagePath);
            console.log(`[GC] Deleted storage file: ${row.storagePath}`);
          } catch (err: any) {
            console.error(`[GC] Failed to delete file ${row.storagePath}: ${err?.message}`);
          }
        }
      }
    } else {
      console.log("[GC] Object storage provider does not support deleteObject or deleteObject is not a function.");
    }

    // Delete image_cache rows
    const imageCacheIdsToDelete = orphanedImageRows.map(row => row.id);
    // Batch deletes in chunks of 50
    const chunkSize = 50;
    for (let i = 0; i < imageCacheIdsToDelete.length; i += chunkSize) {
      const chunk = imageCacheIdsToDelete.slice(i, i + chunkSize);
      await db.delete(imageCacheTable).where(inArray(imageCacheTable.id, chunk));
    }
    console.log(`[GC] Deleted database rows from image_cache.`);
  }

  // 5. Clean up Firestore cache & delete global_fragrances rows
  if (orphanedGlobalRows.length > 0) {
    console.log("[GC] Cleaning up Firestore bg_cache and global_fragrances rows...");
    for (const row of orphanedGlobalRows) {
      if (row.brand && row.name) {
        try {
          await deleteCachedImage(row.brand, row.name);
          console.log(`[GC] Deleted Firestore cache entry: ${row.brand} ${row.name}`);
        } catch (err: any) {
          console.error(`[GC] Failed to delete Firestore cache for ${row.brand} ${row.name}: ${err?.message}`);
        }
      }
    }

    const globalIdsToDelete = orphanedGlobalRows.map(row => row.id);
    const chunkSize = 50;
    for (let i = 0; i < globalIdsToDelete.length; i += chunkSize) {
      const chunk = globalIdsToDelete.slice(i, i + chunkSize);
      await db.delete(globalFragrancesTable).where(inArray(globalFragrancesTable.id, chunk));
    }
    console.log(`[GC] Deleted database rows from global_fragrances.`);
  }

  // Clean up any remaining orphaned image cache entries that didn't have a matching global fragrance
  const imageKeysToPurgeFirebase = orphanedImageRows
    .map(row => row.lookupKey)
    .filter((key): key is string => !!key);

  for (const key of imageKeysToPurgeFirebase) {
    // Check if we already deleted it via global_fragrances row
    const alreadyDeleted = orphanedGlobalRows.some(row => row.lookupKey === key);
    if (!alreadyDeleted) {
      const parts = key.split("::");
      if (parts.length >= 2) {
        const brand = parts[0];
        const name = parts.slice(1).join("::");
        try {
          await deleteCachedImage(brand, name);
          console.log(`[GC] Deleted Firestore cache entry (from lookup key fallback): ${brand} ${name}`);
        } catch (err: any) {
          console.error(`[GC] Failed to delete Firestore cache for fallback key ${key}: ${err?.message}`);
        }
      }
    }
  }

  console.log("[GC] Garbage collection complete successfully.");
}

main().catch(err => {
  console.error("[GC] Garbage collection failed:", err);
  process.exit(1);
});
