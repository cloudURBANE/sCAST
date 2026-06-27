import assert from "node:assert/strict";
import test from "node:test";
import {
  clearImageRefKeys,
  extractPersistedImageUrl,
  isDeadPersistedImageUrl,
  shouldRepairImageData,
  type ImageRepairPolicy,
} from "./imageRepairCore.ts";

const PROD_POLICY: ImageRepairPolicy = { localObjectUrlsAreDead: true, deadUrlPrefixes: [] };
const DEV_POLICY: ImageRepairPolicy = { localObjectUrlsAreDead: false, deadUrlPrefixes: [] };

test("isDeadPersistedImageUrl flags base64 data URLs regardless of policy", () => {
  assert.equal(isDeadPersistedImageUrl("data:image/png;base64,AAAA", PROD_POLICY), true);
  assert.equal(isDeadPersistedImageUrl("data:image/webp;base64,AAAA", DEV_POLICY), true);
});

test("isDeadPersistedImageUrl flags local-object URLs only when policy says they are dead", () => {
  const local = "/api/image-objects/images/processed/serper/abc/def.webp";
  assert.equal(isDeadPersistedImageUrl(local, PROD_POLICY), true);
  // In a dev environment where the local file still exists, do NOT treat it as dead.
  assert.equal(isDeadPersistedImageUrl(local, DEV_POLICY), false);
});

test("isDeadPersistedImageUrl flags only URLs under an operator-supplied dead prefix", () => {
  const policy: ImageRepairPolicy = {
    localObjectUrlsAreDead: true,
    deadUrlPrefixes: ["https://old-bucket.firebasestorage.app/"],
  };
  assert.equal(
    isDeadPersistedImageUrl("https://old-bucket.firebasestorage.app/o/x.webp?alt=media", policy),
    true,
  );
  // A live bucket URL that does NOT match the dead prefix is preserved.
  assert.equal(
    isDeadPersistedImageUrl("https://live-bucket.firebasestorage.app/o/x.webp?alt=media", policy),
    false,
  );
});

test("isDeadPersistedImageUrl preserves ordinary http(s) URLs and treats empty/non-strings as not-dead", () => {
  assert.equal(isDeadPersistedImageUrl("https://cdn.example.com/a.webp", PROD_POLICY), false);
  assert.equal(isDeadPersistedImageUrl("", PROD_POLICY), false);
  assert.equal(isDeadPersistedImageUrl("   ", PROD_POLICY), false);
  assert.equal(isDeadPersistedImageUrl(undefined, PROD_POLICY), false);
  assert.equal(isDeadPersistedImageUrl(null, PROD_POLICY), false);
});

test("extractPersistedImageUrl prefers camelCase then legacy snake_case, else null", () => {
  assert.equal(extractPersistedImageUrl({ imageUrl: "https://a/x.webp" }), "https://a/x.webp");
  assert.equal(extractPersistedImageUrl({ image_url: "https://b/y.webp" }), "https://b/y.webp");
  assert.equal(
    extractPersistedImageUrl({ imageUrl: "https://camel/x.webp", image_url: "https://snake/y.webp" }),
    "https://camel/x.webp",
  );
  assert.equal(extractPersistedImageUrl({ imageUrl: "  " }), null);
  assert.equal(extractPersistedImageUrl({}), null);
});

test("shouldRepairImageData repairs a dead camel URL but not when the active URL is healthy", () => {
  assert.equal(
    shouldRepairImageData({ imageUrl: "/api/image-objects/images/processed/a/b.webp" }, PROD_POLICY),
    true,
  );
  assert.equal(shouldRepairImageData({ imageUrl: "https://cdn.example.com/a.webp" }, PROD_POLICY), false);
  // A healthy camel URL shields a dead legacy snake URL (coalesce picks camel).
  assert.equal(
    shouldRepairImageData(
      { imageUrl: "https://cdn.example.com/a.webp", image_url: "data:image/png;base64,AAAA" },
      PROD_POLICY,
    ),
    false,
  );
});

test("clearImageRefKeys removes only the image-locating keys and preserves the rest", () => {
  const before = {
    name: "Aventus",
    brand: "Creed",
    imageUrl: "/api/image-objects/images/processed/a/b.webp",
    image_url: "data:image/png;base64,AAAA",
    imageHash: "abc",
    storagePath: "images/processed/a/b.webp",
    storageProvider: "local",
    sourceProvider: "serper",
  };
  assert.deepEqual(clearImageRefKeys(before), {
    name: "Aventus",
    brand: "Creed",
    sourceProvider: "serper",
  });
  // Input is not mutated.
  assert.equal(before.imageUrl, "/api/image-objects/images/processed/a/b.webp");
});
