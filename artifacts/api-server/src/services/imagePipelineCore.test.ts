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
process.env.IMAGE_LOCAL_STORAGE_DIR = testImageRoot;

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
  process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/db";
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
