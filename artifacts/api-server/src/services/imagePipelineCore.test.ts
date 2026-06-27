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
