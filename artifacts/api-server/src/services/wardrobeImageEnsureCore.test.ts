import assert from "node:assert/strict";
import test from "node:test";
import {
  WardrobeImageRecoveryDeduper,
  sameWardrobeImageUrl,
  wardrobeImageRecoveryKey,
  wardrobeImageReplacementGuard,
} from "./wardrobeImageEnsureCore.ts";

test("replacement guard fills only an empty row", () => {
  assert.deepEqual(wardrobeImageReplacementGuard({ imageUrl: "" }, null), { kind: "empty" });
  assert.deepEqual(wardrobeImageReplacementGuard({ image_url: "   " }, null), { kind: "empty" });
});

test("replacement guard matches the reported failed URL and snapshots its provider", () => {
  const current = "https://cdn.example.com/bottle.webp?token=abc&v=old";
  assert.equal(
    sameWardrobeImageUrl(current, "https://cdn.example.com/bottle.webp?token=abc&v=new"),
    true,
  );
  assert.deepEqual(
    wardrobeImageReplacementGuard(
      { imageUrl: current, sourceProvider: "manual" },
      "https://cdn.example.com/bottle.webp?token=abc&v=new",
    ),
    { kind: "exact", imageUrl: current, sourceProvider: "manual" },
  );
});

test("a stale failed URL can never replace a newer row image", () => {
  const row = {
    imageUrl: "https://cdn.example.com/new-manual.webp",
    sourceProvider: "manual",
  };
  assert.deepEqual(
    wardrobeImageReplacementGuard(row, "https://cdn.example.com/old-broken.webp"),
    { kind: "never" },
  );
  assert.deepEqual(wardrobeImageReplacementGuard(row, null), { kind: "never" });
});

test("non-cache-busting URL changes remain stale", () => {
  assert.equal(
    sameWardrobeImageUrl(
      "https://cdn.example.com/bottle.webp?token=new",
      "https://cdn.example.com/bottle.webp?token=old",
    ),
    false,
  );
});

test("background recovery dedupes an identical guarded row and clears after settle", async () => {
  const deduper = new WardrobeImageRecoveryDeduper();
  const guard = { kind: "empty" } as const;
  const key = wardrobeImageRecoveryKey("tenant", "user", "row", guard);
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const task = async () => {
    calls += 1;
    await gate;
  };

  assert.equal(deduper.start(key, task), true);
  assert.equal(deduper.start(key, task), false);
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(deduper.inFlightCount, 1);

  release();
  await deduper.waitForIdle();
  assert.equal(deduper.inFlightCount, 0);

  assert.equal(deduper.start(key, async () => { calls += 1; }), true);
  await deduper.waitForIdle();
  assert.equal(calls, 2);
});

test("recovery keys separate newer failed-image snapshots", () => {
  const a = wardrobeImageRecoveryKey("t", "u", "r", {
    kind: "exact",
    imageUrl: "https://cdn.example.com/a.webp",
    sourceProvider: "manual",
  });
  const b = wardrobeImageRecoveryKey("t", "u", "r", {
    kind: "exact",
    imageUrl: "https://cdn.example.com/b.webp",
    sourceProvider: "manual",
  });
  assert.notEqual(a, b);
});
