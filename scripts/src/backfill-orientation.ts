import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Load environment variables from the monorepo root .env file.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

import { and, eq, isNull, ne, or } from "drizzle-orm";
// Dynamic import AFTER dotenv: @workspace/db reads DATABASE_URL at module-init and
// static ESM imports hoist above dotenv.config().
const { db } = await import("@workspace/db");
const { imageCacheTable } = await import("@workspace/db/schema");
import {
  ORIENTATION_VERSION,
  encodeOrientedWebp,
  orientPackshot,
  probeImageSize,
} from "../../artifacts/api-server/src/services/orientationEngine";
import {
  getImageObjectStorage,
  readLocalImageObject,
} from "../../artifacts/api-server/src/services/imageObjectStorage";
import { buildProcessedImageStorageKey, hashBuffer } from "../../artifacts/api-server/src/services/imageIdentity";

/*
 * Offline Orientation Engine backfill.
 *
 * Upgrades existing background-removed `image_cache` rows to a uniform 1024x1024
 * baseline-aligned square IN PLACE — it re-orients the ALREADY-PROCESSED stored
 * image, so it makes ZERO Serper / Poof calls ($0 external cost). New objects are
 * written under content-hash storage keys (immutable Cache-Control safe) and the
 * row is repointed; the image_cache read-through then serves the normalized
 * bytes everywhere.
 *
 * It does NOT touch user_fragrances / global_fragrances or any manual crop
 * adjustments — per the "preserve & log, reset later" decision, clearing legacy
 * crops is a separate, supervised step run only after these images are eyeballed.
 *
 * Usage (from huge_monorepo/):
 *   corepack pnpm --filter @workspace/scripts exec tsx ./src/backfill-orientation.ts            # DRY RUN (default)
 *   corepack pnpm --filter @workspace/scripts exec tsx ./src/backfill-orientation.ts --apply    # write changes
 *   ... --limit=200        # cap rows processed this run (batching)
 *   ... --concurrency=4     # parallel workers (default 4)
 */

type Row = typeof imageCacheTable.$inferSelect;

function parseIntArg(name: string, fallback: number): number {
  const raw = process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const APPLY = process.argv.includes("--apply");
const LIMIT = parseIntArg("limit", 0); // 0 = no cap
const CONCURRENCY = parseIntArg("concurrency", 4);

async function loadImageBytes(row: Row): Promise<Buffer | null> {
  // Local dev storage: read straight off disk.
  if (row.storageProvider === "local") {
    if (!row.storagePath) return null;
    try {
      return await readLocalImageObject(row.storagePath);
    } catch {
      return null;
    }
  }
  // Hosted storage: fetch the already-public processed object. No third-party
  // image search / background-removal API is involved.
  const url = row.publicUrl;
  if (!url || !/^https?:\/\//i.test(url)) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

type Outcome = "normalized" | "skipped_not_oriented" | "skipped_no_bytes" | "error";

async function processRow(row: Row): Promise<Outcome> {
  const bytes = await loadImageBytes(row);
  if (!bytes) return "skipped_no_bytes";

  const oriented = await orientPackshot(bytes);
  if (!oriented.ok) return "skipped_not_oriented";

  if (!APPLY) return "normalized"; // dry run: report only, write nothing

  try {
    const webp = await encodeOrientedWebp(oriented.buffer);
    const contentHash = hashBuffer(webp);
    // Record the ACTUAL encoded dimensions rather than a hardcoded constant — the
    // engine canvas size is configurable (now 1024²), so reading it back keeps the
    // row honest if the canvas ever changes again.
    const { width: outWidth, height: outHeight } = await probeImageSize(webp);
    const storageKey = buildProcessedImageStorageKey({
      sourceProvider: row.sourceProvider,
      lookupKey: row.lookupKey,
      sourceUrlHash: row.sourceUrlHash,
      contentHash,
    });

    const storage = getImageObjectStorage();
    const uploaded = await storage.uploadProcessedImage({
      buffer: webp,
      contentType: "image/webp",
      key: storageKey,
    });
    const publicUrl = uploaded.publicUrl ?? uploaded.signedUrl ?? row.publicUrl;

    await db
      .update(imageCacheTable)
      .set({
        storageProvider: uploaded.provider,
        storagePath: uploaded.storagePath,
        publicUrl,
        contentHash,
        mimeType: "image/webp",
        width: outWidth,
        height: outHeight,
        sizeBytes: uploaded.sizeBytes || webp.length,
        originalWidth: oriented.metadata.originalWidth,
        originalHeight: oriented.metadata.originalHeight,
        boundingBox: oriented.metadata.boundingBox,
        aspectRatio: oriented.metadata.aspectRatio,
        orientationVersion: oriented.metadata.orientationVersion,
        baselineAlignment: oriented.metadata.baselineAlignment,
        updatedAt: new Date(),
      })
      .where(eq(imageCacheTable.id, row.id));

    return "normalized";
  } catch (err) {
    console.error(`[orient-backfill] row ${row.id} failed:`, err instanceof Error ? err.message : err);
    return "error";
  }
}

async function runPool(rows: Row[]): Promise<Record<Outcome, number>> {
  const tally: Record<Outcome, number> = {
    normalized: 0,
    skipped_not_oriented: 0,
    skipped_no_bytes: 0,
    error: 0,
  };
  let cursor = 0;
  let done = 0;

  async function worker() {
    while (cursor < rows.length) {
      const row = rows[cursor++];
      const outcome = await processRow(row);
      tally[outcome] += 1;
      done += 1;
      if (done % 25 === 0 || done === rows.length) {
        console.log(`[orient-backfill] ${done}/${rows.length} processed`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, CONCURRENCY) }, worker));
  return tally;
}

async function main() {
  console.log(
    `[orient-backfill] mode=${APPLY ? "APPLY" : "DRY-RUN"} target=${ORIENTATION_VERSION} ` +
      `limit=${LIMIT || "none"} concurrency=${CONCURRENCY}`,
  );

  // Eligible: a real cut-out, ready, with stored bytes, not already at the
  // current orientation version (null = legacy, or an older version).
  const rows = await db
    .select()
    .from(imageCacheTable)
    .where(
      and(
        eq(imageCacheTable.backgroundRemoved, true),
        eq(imageCacheTable.processingStatus, "ready"),
        ne(imageCacheTable.storagePath, ""),
        or(
          isNull(imageCacheTable.orientationVersion),
          ne(imageCacheTable.orientationVersion, ORIENTATION_VERSION),
        ),
      ),
    );

  const work = LIMIT > 0 ? rows.slice(0, LIMIT) : rows;
  console.log(`[orient-backfill] ${rows.length} eligible row(s); processing ${work.length}`);
  if (work.length === 0) {
    console.log("[orient-backfill] nothing to do.");
    return;
  }

  const tally = await runPool(work);

  console.log("[orient-backfill] summary:");
  console.log(`  normalized:            ${tally.normalized}${APPLY ? "" : " (would normalize)"}`);
  console.log(`  skipped (not a cut-out): ${tally.skipped_not_oriented}`);
  console.log(`  skipped (no bytes):    ${tally.skipped_no_bytes}`);
  console.log(`  errors:                ${tally.error}`);
  if (!APPLY) {
    console.log("[orient-backfill] DRY RUN — no rows or storage objects were written. Re-run with --apply to commit.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[orient-backfill] failed:", err);
    process.exit(1);
  });
