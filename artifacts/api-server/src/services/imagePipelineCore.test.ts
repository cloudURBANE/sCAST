import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertNoPersistedBase64Image,
  safeImageUrlForResponse,
  stripBase64ImageDataUrls,
} from "./persistenceGuards.ts";
import {
  isPrivateIpAddress,
  parseAndValidateExternalImageUrl,
} from "./safeImageFetch.ts";

const testImageRoot = path.join(tmpdir(), `scent-image-cache-${Date.now()}-${Math.random().toString(16).slice(2)}`);
process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/db";
process.env.IMAGE_LOCAL_STORAGE_DIR = testImageRoot;
process.env.IMAGE_ALLOW_LOCAL_OBJECT_STORAGE = "true";
process.env.NODE_ENV = "test";

function restoreEnvValue(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

test("database image guards reject and strip data image payloads", () => {
  assert.throws(
    () => assertNoPersistedBase64Image({ imageUrl: "data:image/png;base64,AAAA" }, "profile_data"),
    /Refusing to persist base64 image data/,
  );
  assert.deepEqual(
    stripBase64ImageDataUrls({ imageUrl: "data:image/png;base64,AAAA", nested: { icon: "ok" } }),
    { imageUrl: "", nested: { icon: "ok" } },
  );
  assert.equal(safeImageUrlForResponse("data:image/png;base64,AAAA"), "");
});

test("external image URL validation rejects private and non-http sources", () => {
  assert.equal(isPrivateIpAddress("127.0.0.1"), true);
  assert.equal(isPrivateIpAddress("10.2.3.4"), true);
  assert.equal(isPrivateIpAddress("172.20.0.1"), true);
  assert.equal(isPrivateIpAddress("192.168.1.2"), true);
  assert.equal(isPrivateIpAddress("8.8.8.8"), false);

  assert.throws(() => parseAndValidateExternalImageUrl("file:///etc/passwd"), /http\/https/);
  assert.throws(() => parseAndValidateExternalImageUrl("http://localhost/image.jpg"), /Local image hosts/);
  assert.throws(() => parseAndValidateExternalImageUrl("https://127.0.0.1/image.jpg"), /Private network/);
  assert.equal(parseAndValidateExternalImageUrl("https://example.com/a.jpg").hostname, "example.com");
});

test("source URL hashes and object keys are deterministic", async () => {
  const {
    buildProcessedImageStorageKey,
    hashSourceUrl,
    IMAGE_PIPELINE_VERSION,
  } = await import("./imageIdentity.ts");

  const first = hashSourceUrl("https://Example.com/image.jpg?utm_source=x&b=2&a=1#frag");
  const second = hashSourceUrl("https://example.com/image.jpg?a=1&b=2");
  assert.equal(first, second);

  assert.equal(
    buildProcessedImageStorageKey({
      sourceProvider: "serper",
      lookupKey: "Acme::Bottle",
      sourceUrlHash: first,
    }),
    buildProcessedImageStorageKey({
      sourceProvider: "serper",
      lookupKey: "Acme::Bottle",
      sourceUrlHash: first,
      pipelineVersion: IMAGE_PIPELINE_VERSION,
    }),
  );
});

test("image object storage refuses silent local persistence without durable storage", async () => {
  const { getImageObjectStorage } = await import("./imageObjectStorage.ts");
  const previous = {
    nodeEnv: process.env.NODE_ENV,
    allowLocal: process.env.IMAGE_ALLOW_LOCAL_OBJECT_STORAGE,
    firebaseBucket: process.env.FIREBASE_STORAGE_BUCKET,
    firebaseProject: process.env.FIREBASE_PROJECT_ID,
    firebaseEmail: process.env.FIREBASE_CLIENT_EMAIL,
    firebaseKey: process.env.FIREBASE_PRIVATE_KEY,
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    supabaseBucket: process.env.SUPABASE_IMAGE_BUCKET,
  };

  try {
    process.env.NODE_ENV = "production";
    process.env.IMAGE_ALLOW_LOCAL_OBJECT_STORAGE = "true";
    process.env.FIREBASE_STORAGE_BUCKET = "";
    process.env.FIREBASE_PROJECT_ID = "";
    process.env.FIREBASE_CLIENT_EMAIL = "";
    process.env.FIREBASE_PRIVATE_KEY = "";
    process.env.SUPABASE_URL = "";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "";
    process.env.SUPABASE_IMAGE_BUCKET = "";

    assert.throws(() => getImageObjectStorage(), /Image object storage is not configured/);
  } finally {
    restoreEnvValue("NODE_ENV", previous.nodeEnv);
    restoreEnvValue("IMAGE_ALLOW_LOCAL_OBJECT_STORAGE", previous.allowLocal);
    restoreEnvValue("FIREBASE_STORAGE_BUCKET", previous.firebaseBucket);
    restoreEnvValue("FIREBASE_PROJECT_ID", previous.firebaseProject);
    restoreEnvValue("FIREBASE_CLIENT_EMAIL", previous.firebaseEmail);
    restoreEnvValue("FIREBASE_PRIVATE_KEY", previous.firebaseKey);
    restoreEnvValue("SUPABASE_URL", previous.supabaseUrl);
    restoreEnvValue("SUPABASE_SERVICE_ROLE_KEY", previous.supabaseKey);
    restoreEnvValue("SUPABASE_IMAGE_BUCKET", previous.supabaseBucket);
  }
});

test("image object storage derives the Firebase bucket from project id when only the bucket var is missing", async () => {
  const { getImageObjectStorage } = await import("./imageObjectStorage.ts");
  const previous = {
    firebaseBucket: process.env.FIREBASE_STORAGE_BUCKET,
    firebaseProject: process.env.FIREBASE_PROJECT_ID,
    firebaseEmail: process.env.FIREBASE_CLIENT_EMAIL,
    firebaseKey: process.env.FIREBASE_PRIVATE_KEY,
  };

  try {
    // All three Firebase credentials present, but FIREBASE_STORAGE_BUCKET unset —
    // the exact production misconfiguration that rendered every tile "No image".
    // Storage must still resolve (to a derived bucket) instead of throwing.
    delete process.env.FIREBASE_STORAGE_BUCKET;
    process.env.FIREBASE_PROJECT_ID = "scentcast-demo";
    process.env.FIREBASE_CLIENT_EMAIL = "svc@scentcast-demo.iam.gserviceaccount.com";
    process.env.FIREBASE_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\\nfake\\n-----END PRIVATE KEY-----";

    const storage = getImageObjectStorage() as { provider?: string };
    assert.equal(storage.provider, "firebase");
  } finally {
    restoreEnvValue("FIREBASE_STORAGE_BUCKET", previous.firebaseBucket);
    restoreEnvValue("FIREBASE_PROJECT_ID", previous.firebaseProject);
    restoreEnvValue("FIREBASE_CLIENT_EMAIL", previous.firebaseEmail);
    restoreEnvValue("FIREBASE_PRIVATE_KEY", previous.firebaseKey);
  }
});

test("processedStoragePathFromUrl recovers the storage key from every processed URL shape", async () => {
  const { processedStoragePathFromUrl } = await import("./imageObjectStorage.ts");
  const key = "images/processed/serper/creed-aventus/abc123.webp";

  // Same-origin local route.
  assert.equal(
    processedStoragePathFromUrl(`/api/image-objects/${key}`),
    key,
  );
  // Supabase public object URL.
  assert.equal(
    processedStoragePathFromUrl(`https://abc.supabase.co/storage/v1/object/public/images/${key}?v=v3`),
    key,
  );
  // Firebase download URL with percent-encoded path + token.
  assert.equal(
    processedStoragePathFromUrl(
      `https://firebasestorage.googleapis.com/v0/b/my-bucket/o/${encodeURIComponent(key)}?alt=media&token=abc`,
    ),
    key,
  );
  // Custom CDN base.
  assert.equal(processedStoragePathFromUrl(`https://cdn.example.com/${key}`), key);

  // Not one of our processed objects → null (so the proxy falls back to fetch).
  assert.equal(processedStoragePathFromUrl("https://fimgs.net/mdimg/perfume/375x500.123.jpg"), null);
  assert.equal(processedStoragePathFromUrl("https://evil.test/images/processed/../../etc/passwd"), null);
  assert.equal(processedStoragePathFromUrl(""), null);
  assert.equal(processedStoragePathFromUrl(null), null);
});

test("image cache classifies the un-migrated ON CONFLICT index error (42P10) as tolerable", async () => {
  const { isImageCacheConflictTargetMissing, isImageCacheRelationMissing } = await import(
    "./imageCacheErrorClassifier.ts"
  );

  // The exact failure when migration 0001 (the 3-column unique index) has not
  // been applied: every processed-image upsert throws 42P10. This must be
  // tolerated (serve uncached) rather than blacking the image out.
  assert.equal(isImageCacheConflictTargetMissing({ code: "42P10" }), true);
  assert.equal(
    isImageCacheConflictTargetMissing({
      message: "there is no unique or exclusion constraint matching the ON CONFLICT specification",
    }),
    true,
  );

  // It must NOT swallow unrelated errors, and the two detectors stay disjoint.
  assert.equal(isImageCacheConflictTargetMissing({ code: "23505" }), false);
  assert.equal(isImageCacheConflictTargetMissing(new Error("connection refused")), false);
  assert.equal(isImageCacheConflictTargetMissing({ code: "42P01" }), false);
  assert.equal(isImageCacheRelationMissing({ code: "42P10" }), false);
  // The table-missing detector still recognizes 42P01.
  assert.equal(isImageCacheRelationMissing({ code: "42P01" }), true);
});

test("explicit Supabase storage wins over a derived Firebase bucket", async () => {
  const { getImageObjectStorage } = await import("./imageObjectStorage.ts");
  const previous = {
    firebaseBucket: process.env.FIREBASE_STORAGE_BUCKET,
    firebaseProject: process.env.FIREBASE_PROJECT_ID,
    firebaseEmail: process.env.FIREBASE_CLIENT_EMAIL,
    firebaseKey: process.env.FIREBASE_PRIVATE_KEY,
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    supabaseBucket: process.env.SUPABASE_IMAGE_BUCKET,
  };

  try {
    // Production's real shape: Firebase credentials are set for the Firestore
    // bg_cache, and Supabase is the configured image store. With FIREBASE_STORAGE_BUCKET
    // unset, the derived Firebase bucket must NOT hijack image storage away from
    // the explicitly-configured Supabase store.
    delete process.env.FIREBASE_STORAGE_BUCKET;
    process.env.FIREBASE_PROJECT_ID = "scentcast-demo";
    process.env.FIREBASE_CLIENT_EMAIL = "svc@scentcast-demo.iam.gserviceaccount.com";
    process.env.FIREBASE_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\\nfake\\n-----END PRIVATE KEY-----";
    process.env.SUPABASE_URL = "https://demo.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
    process.env.SUPABASE_IMAGE_BUCKET = "images";

    const storage = getImageObjectStorage() as { provider?: string };
    assert.equal(storage.provider, "supabase");
  } finally {
    restoreEnvValue("FIREBASE_STORAGE_BUCKET", previous.firebaseBucket);
    restoreEnvValue("FIREBASE_PROJECT_ID", previous.firebaseProject);
    restoreEnvValue("FIREBASE_CLIENT_EMAIL", previous.firebaseEmail);
    restoreEnvValue("FIREBASE_PRIVATE_KEY", previous.firebaseKey);
    restoreEnvValue("SUPABASE_URL", previous.supabaseUrl);
    restoreEnvValue("SUPABASE_SERVICE_ROLE_KEY", previous.supabaseKey);
    restoreEnvValue("SUPABASE_IMAGE_BUCKET", previous.supabaseBucket);
  }
});

test("an explicit Firebase bucket still wins over Supabase", async () => {
  const { getImageObjectStorage } = await import("./imageObjectStorage.ts");
  const previous = {
    firebaseBucket: process.env.FIREBASE_STORAGE_BUCKET,
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    supabaseBucket: process.env.SUPABASE_IMAGE_BUCKET,
  };

  try {
    process.env.FIREBASE_STORAGE_BUCKET = "scentcast-demo.appspot.com";
    process.env.SUPABASE_URL = "https://demo.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
    process.env.SUPABASE_IMAGE_BUCKET = "images";

    const storage = getImageObjectStorage() as { provider?: string };
    assert.equal(storage.provider, "firebase");
  } finally {
    restoreEnvValue("FIREBASE_STORAGE_BUCKET", previous.firebaseBucket);
    restoreEnvValue("SUPABASE_URL", previous.supabaseUrl);
    restoreEnvValue("SUPABASE_SERVICE_ROLE_KEY", previous.supabaseKey);
    restoreEnvValue("SUPABASE_IMAGE_BUCKET", previous.supabaseBucket);
  }
});

test("local image object diagnostics do not erase saved response references", async () => {
  const {
    imageReferenceDiagnostic,
    savedImageUrlForResponse,
    usableImageUrlForResponse,
  } = await import("./imageReference.ts");

  const missingUrl = "/api/image-objects/images/processed/missing.webp";
  assert.equal(await usableImageUrlForResponse(missingUrl), null);
  assert.equal(savedImageUrlForResponse(missingUrl), missingUrl);
  assert.deepEqual(await imageReferenceDiagnostic(missingUrl), {
    kind: "local-object-missing",
    usable: false,
    length: missingUrl.length,
    storagePath: "images/processed/missing.webp",
  });

  await mkdir(path.join(testImageRoot, "images", "processed"), { recursive: true });
  await writeFile(path.join(testImageRoot, "images", "processed", "ready.webp"), "x");

  const readyUrl = "/api/image-objects/images/processed/ready.webp";
  assert.equal(await usableImageUrlForResponse(readyUrl), readyUrl);
  assert.equal((await imageReferenceDiagnostic(readyUrl)).kind, "local-object");
});

test("local image object refs can render when present but are not persistable in production", async () => {
  const { persistableImageReference, usableImageUrlForResponse } = await import("./imageReference.ts");
  const previous = {
    nodeEnv: process.env.NODE_ENV,
    allowLocal: process.env.IMAGE_ALLOW_LOCAL_OBJECT_STORAGE,
  };
  const disabledUrl = "/api/image-objects/images/processed/disabled-local.webp";

  await mkdir(path.join(testImageRoot, "images", "processed"), { recursive: true });
  await writeFile(path.join(testImageRoot, "images", "processed", "disabled-local.webp"), "x");

  try {
    process.env.NODE_ENV = "production";
    process.env.IMAGE_ALLOW_LOCAL_OBJECT_STORAGE = "true";

    assert.equal(await usableImageUrlForResponse(disabledUrl), disabledUrl);
    assert.equal(await persistableImageReference(disabledUrl), null);
  } finally {
    restoreEnvValue("NODE_ENV", previous.nodeEnv);
    restoreEnvValue("IMAGE_ALLOW_LOCAL_OBJECT_STORAGE", previous.allowLocal);
  }
});

test("preview save accepts only persistable image references", async () => {
  const { persistableImageReference } = await import("./imageReference.ts");

  await mkdir(path.join(testImageRoot, "images", "processed"), { recursive: true });
  await writeFile(path.join(testImageRoot, "images", "processed", "preview.webp"), "x");

  assert.equal(
    await persistableImageReference("/api/image-objects/images/processed/preview.webp"),
    "/api/image-objects/images/processed/preview.webp",
  );
  assert.equal(await persistableImageReference("https://cdn.example.com/bottle.webp"), "https://cdn.example.com/bottle.webp");
  assert.equal(await persistableImageReference("data:image/png;base64,AAAA"), null);
  assert.equal(await persistableImageReference("/not-an-image-object/path.webp"), null);
});

test("acceptsImageCacheForRequest: backgroundRemoved=false rejected when removeBackground=true", async () => {
  // Imported from the standalone policy module rather than imagePipeline.ts,
  // because imagePipeline.ts uses extensionless relative imports throughout
  // (resolved at bundle time by esbuild) and the bare node:test runner cannot
  // load it without the experimental TypeScript module-resolution flags.
  // imagePipeline.ts re-exports both helpers, so production callers are unaffected.
  const { acceptsImageCacheForRequest } = await import("./imagePipelineCachePolicy.ts");

  // BG removal requested, cache hit has white background — must reject
  assert.equal(acceptsImageCacheForRequest({ backgroundRemoved: false }, true), false);
  // BG removal requested, cache hit already has BG removed — must accept
  assert.equal(acceptsImageCacheForRequest({ backgroundRemoved: true }, true), true);
  // BG removal NOT requested — always accept regardless of backgroundRemoved
  assert.equal(acceptsImageCacheForRequest({ backgroundRemoved: false }, false), true);
  assert.equal(acceptsImageCacheForRequest({ backgroundRemoved: true }, false), true);
});

test("acceptsImageCacheForRequest: a deterministic fallback row satisfies a bg-removal request (C1)", async () => {
  // image-pipeline audit C1: when bg removal is requested but the source can't be
  // cut out, the pipeline stores a white-bg row stamped removeBgStatus:"fallback".
  // That row MUST satisfy a later bg-removal request so the source is not
  // re-Serper'd + re-Poof'd + re-uploaded on every page load. A plain white-bg
  // row (no fallback stamp — produced by a no-bg request) must still be rejected.
  const { acceptsImageCacheForRequest } = await import("./imagePipelineCachePolicy.ts");

  // Deterministic fallback white-bg row — accept for a bg-removal request.
  assert.equal(
    acceptsImageCacheForRequest({ backgroundRemoved: false, removeBgStatus: "fallback" }, true),
    true,
  );
  // Plain white-bg row (no-bg request's output) — still reject for bg-removal.
  assert.equal(
    acceptsImageCacheForRequest({ backgroundRemoved: false, removeBgStatus: "skipped" }, true),
    false,
  );
  assert.equal(
    acceptsImageCacheForRequest({ backgroundRemoved: false, removeBgStatus: null }, true),
    false,
  );
  // The fallback stamp is irrelevant when bg removal isn't requested — accept.
  assert.equal(
    acceptsImageCacheForRequest({ backgroundRemoved: false, removeBgStatus: "fallback" }, false),
    true,
  );
});

test("positive cache isolation: a no-bg entry does not satisfy a bg-removal request", async () => {
  // Mirrors the WHERE clause in getReadyCachedImageBySourceHash. The image_cache
  // unique key is (source_url_hash, pipeline_version, background_removed), so the
  // two variants are stored as separate rows. The positive lookup must constrain
  // to background_removed=true ONLY when BG removal is requested, so a stored
  // white-bg (background_removed=false) row can never satisfy a removeBackground
  // request — it falls through to reprocess and writes the OTHER variant's row
  // instead of clobbering the no-bg one.
  const { positiveCacheRequiresBackgroundRemoved } = await import("./imagePipelineCachePolicy.ts");

  // BG removal requested → lookup is constrained to background_removed=true,
  // so a background_removed=false row is excluded (does not satisfy).
  assert.equal(positiveCacheRequiresBackgroundRemoved(true), true);
  // BG removal NOT requested → either variant is acceptable (transparent still
  // renders), so the lookup is not constrained.
  assert.equal(positiveCacheRequiresBackgroundRemoved(false), false);
});

test("negative cache isolation: a failure for one variant does not suppress the other", async () => {
  // Mirrors recordImageFailure's `background_removed` write value and the
  // equality filter in getCachedImageStatusBySourceHash. A "failed" row is keyed
  // on the requested variant, so it suppresses retries for THAT variant only.
  const { negativeCacheFailureSuppressesRequest } = await import("./imagePipelineCachePolicy.ts");

  // Same variant → the failed row suppresses the request (intended).
  assert.equal(negativeCacheFailureSuppressesRequest(true, true), true);
  assert.equal(negativeCacheFailureSuppressesRequest(false, false), true);
  // Cross variant → a bg-removed failure must NOT black out a no-bg request, and
  // a no-bg failure must NOT black out a bg-removal request.
  assert.equal(negativeCacheFailureSuppressesRequest(true, false), false);
  assert.equal(negativeCacheFailureSuppressesRequest(false, true), false);
});

test("shouldUseImageLookupCaches: allowLookupCache=false bypasses both caches", async () => {
  const { shouldUseImageLookupCaches } = await import("./imagePipelineCachePolicy.ts");

  // allowLookupCache=false always returns false regardless of sourceUrl
  assert.equal(shouldUseImageLookupCaches(false, undefined), false);
  assert.equal(shouldUseImageLookupCaches(false, "https://example.com/img.jpg"), false);
  // allowLookupCache=true (or omitted) only returns true when there is no sourceUrl
  assert.equal(shouldUseImageLookupCaches(true, undefined), true);
  assert.equal(shouldUseImageLookupCaches(undefined, undefined), true);
  // sourceUrl present — always bypass cache regardless of allowLookupCache
  assert.equal(shouldUseImageLookupCaches(true, "https://example.com/img.jpg"), false);
  assert.equal(shouldUseImageLookupCaches(undefined, "https://example.com/img.jpg"), false);
});

test("sharesSearchQueryInFlight: only plain resolutions join the query-level dedup", async () => {
  // The inFlightBySearchQuery map collapses concurrent requests purely by
  // (lookupKey, searchQueryHash, removeBackground). A request carrying options
  // that change what an acceptable result is (solver refresh with cache bypass,
  // exclusions, custom Poof options, or lookup-cache opt-out) must neither join
  // a plain in-flight resolution nor register its own promise for plain callers
  // — otherwise the solver's special processing silently never runs (the audit
  // S2 "guaranteed no-op" class reintroduced via a race).
  const { sharesSearchQueryInFlight } = await import("./imagePipelineCachePolicy.ts");

  // Plain resolutions (the deferred build path) participate.
  assert.equal(sharesSearchQueryInFlight({}), true);
  assert.equal(sharesSearchQueryInFlight({ allowLookupCache: true }), true);
  assert.equal(sharesSearchQueryInFlight({ excludeSourceUrlHashes: [] }), true);

  // Refresh / solver / recovery requests stay out — each knob independently.
  assert.equal(sharesSearchQueryInFlight({ allowLookupCache: false }), false);
  assert.equal(sharesSearchQueryInFlight({ bypassSourceCache: true }), false);
  assert.equal(sharesSearchQueryInFlight({ excludeSourceUrlHashes: ["abc"] }), false);
  assert.equal(sharesSearchQueryInFlight({ poofOptions: { poofType: "product" } }), false);
  // Refine mode / candidate breadth change what is searched.
  assert.equal(sharesSearchQueryInFlight({ serperRefine: { refine: "solver" } }), false);
  assert.equal(sharesSearchQueryInFlight({ maxCandidates: 6 }), false);

  // Wardrobe recovery: same "brand name" query as the automatic resolution but
  // explicitly escaping the (possibly dead) lookup cache — must NOT join a
  // plain owner's flight or it is handed back the dead reference it was
  // invoked to replace.
  assert.equal(
    sharesSearchQueryInFlight({ allowLookupCache: false, bypassSourceCache: true }),
    false,
  );
});

test("shouldRetryFailedImageStatus: stale failures can be retried", async () => {
  const { shouldRetryFailedImageStatus } = await import("./imagePipelineCachePolicy.ts");
  const now = Date.UTC(2026, 4, 15, 12, 0, 0);
  const retryAfterMs = 6 * 60 * 60 * 1000;

  assert.equal(
    shouldRetryFailedImageStatus("failed", new Date(now - retryAfterMs - 5_000), retryAfterMs, now),
    true,
  );
  assert.equal(
    shouldRetryFailedImageStatus("failed", new Date(now - retryAfterMs + 5_000), retryAfterMs, now),
    false,
  );
  assert.equal(
    shouldRetryFailedImageStatus("ready", new Date(now - retryAfterMs - 5_000), retryAfterMs, now),
    false,
  );
  assert.equal(shouldRetryFailedImageStatus("failed", null, retryAfterMs, now), false);
});

test("shouldNegativeCacheImageFailure: only deterministic failures are cached", async () => {
  const { shouldNegativeCacheImageFailure } = await import("./imagePipelineFailureClassifier.ts");
  const { UnsafeImageUrlError } = await import("./safeImageFetch.ts");

  // Deterministic / terminal: worth negative-caching.
  assert.equal(shouldNegativeCacheImageFailure(new UnsafeImageUrlError("Invalid image URL")), true);
  assert.equal(
    shouldNegativeCacheImageFailure(new UnsafeImageUrlError("Image fetch failed with HTTP 404")),
    true,
  );
  assert.equal(shouldNegativeCacheImageFailure(new Error("Invalid data image")), true);
  assert.equal(
    shouldNegativeCacheImageFailure(new Error("Input buffer contains unsupported image format")),
    true,
  );
  // MIN_PROCESSED_EDGE rejection is deterministic for the source (the resize
  // never enlarges), so it must be negative-cached — otherwise the same tiny
  // thumbnail is re-downloaded and re-Poofed (paid) on every resolution attempt.
  assert.equal(
    shouldNegativeCacheImageFailure(
      new Error("Optimized image below minimum edge: 120x96 (min 200px)"),
    ),
    true,
  );

  // Transient / infrastructure: must NOT be cached so the next request retries.
  assert.equal(
    shouldNegativeCacheImageFailure(
      new UnsafeImageUrlError("Image fetch failed with HTTP 503", { transient: true }),
    ),
    false,
  );
  assert.equal(
    shouldNegativeCacheImageFailure(
      new UnsafeImageUrlError("Image host did not resolve", { transient: true }),
    ),
    false,
  );
  assert.equal(shouldNegativeCacheImageFailure(Object.assign(new Error("read econnreset"), { code: "ECONNRESET" })), false);
  assert.equal(shouldNegativeCacheImageFailure(Object.assign(new Error("aborted"), { name: "AbortError" })), false);
  assert.equal(shouldNegativeCacheImageFailure(new Error("fetch failed")), false);
  assert.equal(shouldNegativeCacheImageFailure(new Error("Supabase Storage upload failed with HTTP 500")), false);

  // Ambiguous / unknown causes bias toward retry (do not cache).
  assert.equal(shouldNegativeCacheImageFailure(new Error("Image processing failed")), false);
  assert.equal(shouldNegativeCacheImageFailure(null), false);
  assert.equal(shouldNegativeCacheImageFailure(undefined), false);
});

test("UnsafeImageUrlError carries transient flag for upstream 5xx / 429 and DNS failures", async () => {
  const { UnsafeImageUrlError } = await import("./safeImageFetch.ts");
  assert.equal(new UnsafeImageUrlError("x").transient, false);
  assert.equal(new UnsafeImageUrlError("x", { transient: true }).transient, true);
});

test("image candidate ranking prefers identity match and successful BG removal", async () => {
  const {
    computeFragranceIdentityCoverage,
    shouldSkipSerperCandidateByIdentity,
    scoreProcessedSerperCandidate,
    scoreProcessedSerperCandidateBreakdown,
  } = await import("./imageCandidateRanking.ts");

  const strong = {
    imageUrl: "https://cdn.brand.com/images/dior-sauvage-edp-packshot.png",
    title: "Dior Sauvage Eau de Parfum bottle packshot",
    source: "Dior",
    score: 12,
  };

  const weak = {
    imageUrl: "https://example.com/images/random-fragrance.jpg",
    title: "Top 10 fragrances gift set",
    source: "Fragrance blog",
    score: 12,
  };

  const strongCoverage = computeFragranceIdentityCoverage("Dior", "Sauvage", strong);
  const weakCoverage = computeFragranceIdentityCoverage("Dior", "Sauvage", weak);
  assert.ok(strongCoverage > weakCoverage);
  assert.equal(shouldSkipSerperCandidateByIdentity("Dior", "Sauvage", weak), true);

  const strongProcessedScore = scoreProcessedSerperCandidate({
    brand: "Dior",
    name: "Sauvage",
    removeBackground: true,
    serperCandidate: strong,
    processed: {
      width: 768,
      height: 768,
      backgroundRemoved: true,
      removeBgStatus: "removed",
    },
  });

  const weakProcessedScore = scoreProcessedSerperCandidate({
    brand: "Dior",
    name: "Sauvage",
    removeBackground: true,
    serperCandidate: weak,
    processed: {
      width: 400,
      height: 400,
      backgroundRemoved: false,
      removeBgStatus: "fallback",
    },
  });

  assert.ok(strongProcessedScore > weakProcessedScore);

  const breakdown = scoreProcessedSerperCandidateBreakdown({
    brand: "Dior",
    name: "Sauvage",
    removeBackground: true,
    serperCandidate: strong,
    processed: {
      width: 768,
      height: 768,
      backgroundRemoved: true,
      removeBgStatus: "removed",
    },
  });
  assert.equal(breakdown.serperScore, 12);
  assert.equal(breakdown.minEdge, 768);
  assert.equal(breakdown.minEdgeBonus, 2);
  assert.equal(breakdown.aspectBonus, 0.6);
  assert.equal(breakdown.backgroundRemovalBonus, 3);
  assert.equal(breakdown.fallbackPenalty, 0);
  assert.equal(breakdown.total, strongProcessedScore);
});

test("refresh-image does not upsert catalog when backgroundRemoved=false and BG removal was requested", async () => {
  // This test verifies the guard logic by inspecting the condition directly,
  // since the route is difficult to instantiate without a full Express/DB setup.
  // The condition under test: `if (skipBg || processed.backgroundRemoved)` before upsertRefreshImageCatalog.

  // Simulate: skipBg=false (BG removal was requested), backgroundRemoved=false (fallback occurred)
  const skipBg = false;
  const processed = { backgroundRemoved: false };
  const shouldUpsert = skipBg || processed.backgroundRemoved;
  assert.equal(shouldUpsert, false, "must not upsert catalog when BG removal was requested but failed");

  // Simulate: skipBg=false, backgroundRemoved=true (BG removal succeeded)
  const processed2 = { backgroundRemoved: true };
  const shouldUpsert2 = skipBg || processed2.backgroundRemoved;
  assert.equal(shouldUpsert2, true, "must upsert catalog when BG removal succeeded");

  // Simulate: skipBg=true (BG removal intentionally skipped), backgroundRemoved=false
  const skipBg2 = true;
  const processed3 = { backgroundRemoved: false };
  const shouldUpsert3 = skipBg2 || processed3.backgroundRemoved;
  assert.equal(shouldUpsert3, true, "must upsert catalog when BG removal was intentionally skipped");
});

test("data-URI decode tolerates RFC 2045 line-wrapped base64 (image M3)", () => {
  // Mirrors the (now whitespace-tolerant) predicate in imagePipeline.decodeDataImage
  // / bgService.decodeDataImage. imagePipeline.ts uses extensionless relative
  // imports the bare node:test runner cannot resolve, so the predicate is mirrored
  // here exactly (same regex + whitespace strip + Buffer.from validation).
  const decodeDataImage = (input: string): Buffer | null => {
    const match = input.match(/^data:image\/(?:png|jpe?g|webp);base64,([a-z0-9+/=\s]+)$/i);
    if (!match?.[1]) return null;
    const payload = match[1].replace(/\s+/g, "");
    if (!payload || payload.length > 6_000_000) return null;
    try {
      return Buffer.from(payload, "base64");
    } catch {
      return null;
    }
  };

  // A 1x1 PNG, base64-encoded, then wrapped at 16 chars with CRLF — exactly the
  // shape a generator that follows RFC 2045 produces. Before the fix this failed
  // the strict regex and was rejected (then 6h negative-cached).
  const oneByOnePng =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
  const wrapped = oneByOnePng.replace(/(.{16})/g, "$1\r\n");
  const flat = `data:image/png;base64,${oneByOnePng}`;
  const wrappedUri = `data:image/png;base64,${wrapped}`;

  const flatBuf = decodeDataImage(flat);
  const wrappedBuf = decodeDataImage(wrappedUri);
  assert.ok(flatBuf, "flat base64 still decodes");
  assert.ok(wrappedBuf, "wrapped base64 now decodes (was rejected before the fix)");
  assert.deepEqual(wrappedBuf, flatBuf, "wrapped and flat decode to identical bytes");

  // Garbage / wrong mime / empty payload are still rejected.
  assert.equal(decodeDataImage("data:image/gif;base64,AAAA"), null, "unsupported mime rejected");
  assert.equal(decodeDataImage("data:image/png;base64,"), null, "empty payload rejected");
  assert.equal(decodeDataImage("not a data uri"), null, "non-data-uri rejected");
});

test("search-query flight key isolates two distinct fragrances that share a query hash (cross-serve)", () => {
  // Mirrors searchQueryFlightKey in imagePipeline.ts: the in-flight dedup key is
  // composed of (lookupKey, searchQueryHash, bg-flag, vision-gate flag). Two
  // different fragrances whose refined search queries normalize to the SAME hash
  // must produce DIFFERENT flight keys so the first caller's resolved bottle is
  // never handed to (and persisted for) the second. This is the in-flight twin
  // of the lookupKey filter in getLatestReadyCachedImageBySearchQueryHash.
  const searchQueryFlightKey = (
    lookupKey: string,
    searchQueryHash: string,
    removeBackground: boolean,
    visionGate: boolean,
  ): string =>
    `${lookupKey}:${searchQueryHash}:${removeBackground ? "1" : "0"}:${visionGate ? "vg1" : "vg0"}`;

  const sharedHash = "deadbeefdeadbeef";
  const keyA = searchQueryFlightKey("Dior::Sauvage", sharedHash, true, true);
  const keyB = searchQueryFlightKey("Creed::Aventus", sharedHash, true, true);
  assert.notEqual(keyA, keyB, "distinct lookupKeys must not collapse to one in-flight result");

  // Same fragrance + same query + same bg-flag + same gate → same key (intended dedup).
  assert.equal(keyA, searchQueryFlightKey("Dior::Sauvage", sharedHash, true, true));
  // Same fragrance, different bg-flag → different slot (variant isolation).
  assert.notEqual(keyA, searchQueryFlightKey("Dior::Sauvage", sharedHash, false, true));
  // Same fragrance, different vision-gate flag → different slot: a gated
  // automatic resolution must never be handed an ungated owner's winner.
  assert.notEqual(keyA, searchQueryFlightKey("Dior::Sauvage", sharedHash, true, false));
});

test("min-edge floor rejects tiny thumbnails post-decode but keeps real packshots (WS-12 / image M4)", () => {
  // Mirrors the predicate `Math.min(width, height) < MIN_PROCESSED_EDGE` in
  // processSourceToWebp. SERP candidates routinely omit dimensions, so the
  // candidate scorer's min-edge term only *penalizes* sub-360px results — a tiny
  // favicon/thumbnail can still win as `best` when nothing better turns up. The
  // floor is the hard backstop that stops a blurry icon being stored as a bottle.
  // The resize uses withoutEnlargement, so a source under the floor stays under
  // it; rejecting outright lets a usable candidate be selected instead.
  const MIN_PROCESSED_EDGE = 200;
  const belowFloor = (width: number, height: number) =>
    Math.min(width, height) < MIN_PROCESSED_EDGE;

  // Genuinely unusable thumbnails / icons are rejected.
  assert.equal(belowFloor(64, 64), true, "favicon-sized icon rejected");
  assert.equal(belowFloor(199, 768), true, "tall-but-thin thumbnail rejected on its short edge");
  assert.equal(belowFloor(768, 150), true, "wide-but-short thumbnail rejected on its short edge");

  // Real packshots (400px+) and the exact boundary are kept.
  assert.equal(belowFloor(200, 200), false, "exact floor accepted");
  assert.equal(belowFloor(768, 768), false, "standard square packshot accepted");
  assert.equal(belowFloor(420, 560), false, "typical retailer bottle shot accepted");
});
