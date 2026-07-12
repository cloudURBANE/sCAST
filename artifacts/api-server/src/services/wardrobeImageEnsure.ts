import sharp from "sharp";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { userFragrancesTable } from "@workspace/db/schema";
import { logger } from "../lib/logger";
import { getCatalogEntry, saveCatalogEntry } from "./catalogService";
import { normalizeFragrance } from "./fragrancePayload";
import {
  resolveSharedImageReference,
  type SharedImageReference,
} from "./imageHydration";
import {
  getImageObjectStorage,
  processedStoragePathFromUrl,
} from "./imageObjectStorage";
import { resolveProcessedFragranceImage } from "./imagePipeline";
import { isCrawledImageProvenance } from "./imageProvenanceCore";
import { UnsafeImageUrlError, fetchExternalImage } from "./safeImageFetch";
import type { ScentProfile } from "./scentEngineCore";
import {
  WardrobeImageRecoveryDeduper,
  canonicalWardrobeImageUrl,
  sameWardrobeImageUrl,
  storedWardrobeImageProvider,
  storedWardrobeImageUrl,
  wardrobeImageRecoveryKey,
  wardrobeImageReplacementGuard,
  type RowImageReplacementGuard,
} from "./wardrobeImageEnsureCore";

export type WardrobeImageEnsureRow = {
  id: string;
  fragranceData: unknown;
};

export type WardrobeImageEnsureResult =
  | { status: "ready"; item: Record<string, unknown> }
  | { status: "pending" };

type VerifiableImageReference = SharedImageReference & {
  imageHash?: string | null;
  storageProvider?: string | null;
};

type ImageVerification = "ready" | "dead" | "transient";

type PersistedImagePatch = {
  imageUrl: string;
  storagePath: string | null;
  imageHash: string | null;
  storageProvider: string | null;
  sourceProvider: string | null;
  imageProperties: unknown | null;
};

const MAX_FAILED_URL_LENGTH = 4_096;
const RECOVERY_MAX_CANDIDATES = 3;
const DECODABLE_RASTER_FORMATS = new Set(["jpeg", "png", "webp", "gif", "avif", "heif"]);
const verificationFlights = new Map<string, Promise<ImageVerification>>();

const recoveryDeduper = new WardrobeImageRecoveryDeduper((error) => {
  logger.error(
    { err: error instanceof Error ? error.message : String(error) },
    "wardrobe image ensure: background recovery failed",
  );
});

export function parseWardrobeFailedImageUrl(value: unknown):
  | { ok: true; value: string | null }
  | { ok: false } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false };
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, value: null };
  if (trimmed.length > MAX_FAILED_URL_LENGTH) return { ok: false };
  // This value is compare-only. It is never fetched, so accepting the original
  // client URL (including a proxy/cache-busting form) creates no SSRF surface.
  return { ok: true, value: trimmed };
}

function rowData(row: WardrobeImageEnsureRow): Record<string, unknown> {
  return row.fragranceData && typeof row.fragranceData === "object" && !Array.isArray(row.fragranceData)
    ? row.fragranceData as Record<string, unknown>
    : {};
}

function rowImageReference(row: WardrobeImageEnsureRow): VerifiableImageReference | null {
  const data = rowData(row);
  const imageUrl = storedWardrobeImageUrl(data);
  if (!imageUrl) return null;
  return {
    imageUrl,
    sourceProvider: storedWardrobeImageProvider(data),
    storagePath: typeof data.storagePath === "string" ? data.storagePath : null,
    imageHash: typeof data.imageHash === "string" ? data.imageHash : null,
    storageProvider: typeof data.storageProvider === "string" ? data.storageProvider : null,
    imageProperties: data.imageProperties ?? null,
  };
}

function sameRowImageSnapshot(left: WardrobeImageEnsureRow, right: WardrobeImageEnsureRow): boolean {
  const a = rowData(left);
  const b = rowData(right);
  return storedWardrobeImageUrl(a) === storedWardrobeImageUrl(b)
    && storedWardrobeImageProvider(a) === storedWardrobeImageProvider(b);
}

function definitelyMissingProcessedObject(error: unknown): boolean {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : null;
  const code = typeof record?.code === "string" ? record.code : "";
  const message = error instanceof Error ? error.message : String(error);
  return code === "ENOENT"
    || code === "storage/object-not-found"
    || /(?:^|\D)404(?:\D|$)|not[ -]?found|no such (?:file|object)/i.test(message);
}

async function bytesAreDecodableRaster(buffer: Buffer): Promise<boolean> {
  if (buffer.length === 0) return false;
  try {
    const metadata = await sharp(buffer, { limitInputPixels: 64_000_000 }).metadata();
    return !!metadata.format
      && DECODABLE_RASTER_FORMATS.has(metadata.format)
      && (metadata.width ?? 0) > 0
      && (metadata.height ?? 0) > 0;
  } catch {
    return false;
  }
}

async function verifyImageReferenceBytesUncached(
  reference: VerifiableImageReference,
): Promise<ImageVerification> {
  const imageUrl = canonicalWardrobeImageUrl(reference.imageUrl);
  if (!imageUrl || isCrawledImageProvenance({
    imageUrl,
    sourceProvider: reference.sourceProvider,
    storagePath: reference.storagePath,
  })) {
    return "dead";
  }

  // Processed object URLs are checked by authenticated provider access. Never
  // infer health from a public URL/metadata row: the object itself must exist
  // and contain a decodable raster image.
  const processedPath = processedStoragePathFromUrl(imageUrl);
  if (processedPath) {
    try {
      const { buffer } = await getImageObjectStorage().getObjectBytes(processedPath);
      return await bytesAreDecodableRaster(buffer) ? "ready" : "dead";
    } catch (error) {
      return definitelyMissingProcessedObject(error) ? "dead" : "transient";
    }
  }

  if (!/^https?:\/\//i.test(imageUrl)) return "dead";
  try {
    const downloaded = await fetchExternalImage(imageUrl);
    return await bytesAreDecodableRaster(downloaded.buffer) ? "ready" : "dead";
  } catch (error) {
    if (error instanceof UnsafeImageUrlError) return error.transient ? "transient" : "dead";
    return "transient";
  }
}

/** In-flight-only dedup: every later ensure still proves the bytes anew. */
export async function verifyWardrobeImageReferenceBytes(
  reference: VerifiableImageReference,
): Promise<ImageVerification> {
  const key = canonicalWardrobeImageUrl(reference.imageUrl) ?? reference.imageUrl;
  const existing = verificationFlights.get(key);
  if (existing) return existing;

  let flight!: Promise<ImageVerification>;
  flight = verifyImageReferenceBytesUncached(reference).finally(() => {
    if (verificationFlights.get(key) === flight) verificationFlights.delete(key);
  });
  verificationFlights.set(key, flight);
  return flight;
}

function imagePatch(reference: VerifiableImageReference): PersistedImagePatch {
  const imageUrl = canonicalWardrobeImageUrl(reference.imageUrl) ?? reference.imageUrl.trim();
  // Derive the key from the URL instead of trusting a potentially stale
  // storagePath left beside a later external/manual URL.
  const storagePath = processedStoragePathFromUrl(imageUrl);
  return {
    imageUrl,
    storagePath,
    imageHash: storagePath && typeof reference.imageHash === "string" ? reference.imageHash : null,
    storageProvider: storagePath && typeof reference.storageProvider === "string"
      ? reference.storageProvider
      : null,
    sourceProvider: typeof reference.sourceProvider === "string" ? reference.sourceProvider : null,
    imageProperties: reference.imageProperties ?? null,
  };
}

async function loadExactOwnedRow(
  tenantId: string,
  userId: string,
  rowId: string,
): Promise<WardrobeImageEnsureRow | null> {
  const rows = await db
    .select({
      id: userFragrancesTable.id,
      fragranceData: userFragrancesTable.fragranceData,
    })
    .from(userFragrancesTable)
    .where(and(
      eq(userFragrancesTable.tenantId, tenantId),
      eq(userFragrancesTable.userId, userId),
      eq(userFragrancesTable.id, rowId as any),
    ))
    .limit(1);
  return rows[0] ?? null;
}

/** Atomic JSONB merge guarded by the exact failed/empty image snapshot. */
async function persistExactRowImage(
  tenantId: string,
  userId: string,
  rowId: string,
  guard: RowImageReplacementGuard,
  patch: PersistedImagePatch,
): Promise<WardrobeImageEnsureRow | null> {
  if (guard.kind === "never") return null;

  const data = userFragrancesTable.fragranceData;
  const currentUrl = sql<string | null>`coalesce(
    nullif(trim(${data} ->> 'imageUrl'), ''),
    nullif(trim(${data} ->> 'image_url'), '')
  )`;
  const currentProvider = sql<string>`coalesce(
    nullif(trim(${data} ->> 'sourceProvider'), ''),
    nullif(trim(${data} ->> 'source_provider'), ''),
    ''
  )`;
  const snapshotCondition = guard.kind === "empty"
    ? sql`${currentUrl} is null`
    : and(
        sql`${currentUrl} = ${guard.imageUrl}`,
        sql`${currentProvider} = ${guard.sourceProvider ?? ""}`,
      );

  const rows = await db
    .update(userFragrancesTable)
    .set({ fragranceData: sql`${data} || ${JSON.stringify(patch)}::jsonb` })
    .where(and(
      eq(userFragrancesTable.tenantId, tenantId),
      eq(userFragrancesTable.userId, userId),
      eq(userFragrancesTable.id, rowId as any),
      snapshotCondition,
    ))
    .returning({
      id: userFragrancesTable.id,
      fragranceData: userFragrancesTable.fragranceData,
    });
  return rows[0] ?? null;
}

function readyItem(row: WardrobeImageEnsureRow): Record<string, unknown> {
  const normalized = normalizeFragrance(rowData(row) as Record<string, any>);
  return { ...normalized, _dbId: row.id };
}

async function verifiedStableReady(
  tenantId: string,
  userId: string,
  initial: WardrobeImageEnsureRow,
): Promise<WardrobeImageEnsureResult | null> {
  let candidate = initial;
  // One retry covers a manual image change that lands during byte verification
  // without allowing an unbounded loop under a rapidly edited row.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const reference = rowImageReference(candidate);
    if (!reference || await verifyWardrobeImageReferenceBytes(reference) !== "ready") return null;

    const latest = await loadExactOwnedRow(tenantId, userId, candidate.id);
    if (!latest) return null;
    if (sameRowImageSnapshot(candidate, latest)) {
      return { status: "ready", item: readyItem(latest) };
    }
    candidate = latest;
  }
  return null;
}

function catalogFallbackFromRow(
  row: WardrobeImageEnsureRow,
  brand: string,
  name: string,
): ScentProfile {
  const normalized = normalizeFragrance(rowData(row) as Record<string, any>);
  const product = normalized.product && typeof normalized.product === "object" && !Array.isArray(normalized.product)
    ? normalized.product as Record<string, unknown>
    : {};
  return {
    ...normalized,
    product: { ...product, brand, name },
  } as unknown as ScentProfile;
}

async function saveRecoveredCatalogImage(
  row: WardrobeImageEnsureRow,
  brand: string,
  name: string,
  reference: VerifiableImageReference,
): Promise<void> {
  let latest: ScentProfile | null = null;
  try {
    latest = await getCatalogEntry(brand, name);
  } catch (error) {
    logger.warn(
      { err: error instanceof Error ? error.message : String(error), brand, name },
      "wardrobe image ensure: catalog read failed before recovery save",
    );
  }
  const base = latest ?? catalogFallbackFromRow(row, brand, name);
  const patch = imagePatch(reference);
  await saveCatalogEntry(brand, name, {
    ...base,
    imageUrl: patch.imageUrl,
    storagePath: patch.storagePath ?? undefined,
    imageHash: patch.imageHash,
    storageProvider: patch.storageProvider ?? undefined,
    sourceProvider: patch.sourceProvider ?? undefined,
  });
}

function queueBackgroundRecovery(input: {
  tenantId: string;
  userId: string;
  row: WardrobeImageEnsureRow;
  brand: string;
  name: string;
  guard: RowImageReplacementGuard;
}): void {
  const { tenantId, userId, row, brand, name, guard } = input;
  const key = wardrobeImageRecoveryKey(tenantId, userId, row.id, guard);
  recoveryDeduper.start(key, async () => {
    // The image pipeline has its own global concurrency limiter and wall-clock
    // candidate-loop budget. Three candidates bounds this repair further. A
    // lookup-cache bypass is essential: that cache may be the dead reference
    // which caused this request, while source bypass forces real reprocessing.
    const recovered = await resolveProcessedFragranceImage({
      brand,
      name,
      searchQuery: `${brand} ${name}`,
      userId,
      fragranceId: row.id,
      allowLookupCache: false,
      bypassSourceCache: true,
      removeBackground: true,
      visionGate: true,
      maxCandidates: RECOVERY_MAX_CANDIDATES,
      traceId: `wardrobe-image-ensure:${row.id}`,
    });
    if (!recovered?.imageUrl) return;
    if (await verifyWardrobeImageReferenceBytes(recovered) !== "ready") return;

    // Catalog failure must not strand this user's exact row; both writes are
    // attempted independently and the row write remains compare-and-set safe.
    await saveRecoveredCatalogImage(row, brand, name, recovered).catch((error) => {
      logger.warn(
        { err: error instanceof Error ? error.message : String(error), brand, name },
        "wardrobe image ensure: recovered catalog image save failed",
      );
    });
    await persistExactRowImage(tenantId, userId, row.id, guard, imagePatch(recovered));
  });
}

/**
 * Ensure a byte-backed image for one already-authenticated, owned wardrobe row.
 * The route owns the initial row lookup; every later write/read is exact-row +
 * tenant + user scoped again so background work cannot cross ownership bounds.
 */
export async function ensureOwnedWardrobeImage(input: {
  tenantId: string;
  userId: string;
  row: WardrobeImageEnsureRow;
  failedUrl: string | null;
}): Promise<WardrobeImageEnsureResult> {
  const { tenantId, userId, failedUrl } = input;
  let row = input.row;
  const initialData = rowData(row);
  const guard = wardrobeImageReplacementGuard(initialData, failedUrl);
  const current = rowImageReference(row);

  if (current) {
    const ready = await verifiedStableReady(tenantId, userId, row);
    if (ready) return ready;

    // Re-check the image snapshot after the byte read. If a manual selection
    // landed during verification, this request is stale and must have no write
    // side effects; the next image error (if any) will report that newer URL.
    const latest = await loadExactOwnedRow(tenantId, userId, row.id);
    if (!latest) return { status: "pending" };
    if (!sameRowImageSnapshot(row, latest)) {
      return (await verifiedStableReady(tenantId, userId, latest)) ?? { status: "pending" };
    }
    row = latest;

    // Nonempty rows are replaceable only when the caller reported this exact
    // URL as failed. This includes stale failedUrl requests and no-failedUrl
    // probes, neither of which may clear or overwrite the current image.
    if (guard.kind === "never") return { status: "pending" };
  }

  const normalized = normalizeFragrance(rowData(row) as Record<string, any>);
  const brand = typeof normalized.brand === "string" ? normalized.brand.trim() : "";
  const name = typeof normalized.name === "string" ? normalized.name.trim() : "";
  if (!brand || !name) return { status: "pending" };

  let shared: SharedImageReference | null = null;
  try {
    shared = await resolveSharedImageReference(brand, name);
  } catch {
    shared = null;
  }

  if (shared && await verifyWardrobeImageReferenceBytes(shared) === "ready") {
    const patch = imagePatch(shared);
    const updated = await persistExactRowImage(tenantId, userId, row.id, guard, patch);
    const latest = await loadExactOwnedRow(tenantId, userId, row.id);
    if (latest && sameWardrobeImageUrl(storedWardrobeImageUrl(rowData(latest)), patch.imageUrl)) {
      // `shared` was just byte-verified; the exact/latest row still points to it.
      return { status: "ready", item: readyItem(latest) };
    }
    if (!updated && latest) {
      // A manual write won the compare-and-set race. Return it only after its
      // own URL is byte-verified; never replace it with the shared reference.
      const manualReady = await verifiedStableReady(tenantId, userId, latest);
      if (manualReady) return manualReady;
    }
  }

  // Missing or non-byte-backed shared state gets one deduped, bounded recovery.
  // Only replaceable guards reach here; stale/newer manual images returned above.
  queueBackgroundRecovery({ tenantId, userId, row, brand, name, guard });
  return { status: "pending" };
}
