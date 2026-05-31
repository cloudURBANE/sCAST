import assert from "node:assert/strict";
import test from "node:test";
import { reconcileWardrobeItems } from "./wardrobeReconcile.ts";

test("reconcileWardrobeItems preserves object and array references for cache-version-only image changes", () => {
  const current = [
    {
      id: "oud",
      _dbId: "row-1",
      name: "Oud Wood",
      brand: "Tom Ford",
      imageUrl: "/images/oud.webp?v=stable",
    },
  ];
  const incoming = [
    {
      id: "oud",
      _dbId: "row-1",
      name: "Oud Wood",
      brand: "Tom Ford",
      imageUrl: "/images/oud.webp?v=poll",
    },
  ];

  const reconciled = reconcileWardrobeItems(current, incoming);

  assert.equal(reconciled, current);
  assert.equal(reconciled[0], current[0]);
  assert.equal(reconciled[0]?.imageUrl, "/images/oud.webp?v=stable");
});

test("reconcileWardrobeItems accepts a new cache version when the image hash changes", () => {
  const current = [
    {
      id: "oud",
      _dbId: "row-1",
      name: "Oud Wood",
      brand: "Tom Ford",
      imageUrl: "/images/oud.webp?v=old",
      imageHash: "old",
    },
  ];
  const incoming = [
    {
      id: "oud",
      _dbId: "row-1",
      name: "Oud Wood",
      brand: "Tom Ford",
      imageUrl: "/images/oud.webp?v=new",
      imageHash: "new",
    },
  ];

  const reconciled = reconcileWardrobeItems(current, incoming);

  assert.notEqual(reconciled, current);
  assert.equal(reconciled[0]?.imageUrl, "/images/oud.webp?v=new");
  assert.equal(reconciled[0]?.imageHash, "new");
});

test("reconcileWardrobeItems keeps incoming order while reusing unchanged rows", () => {
  const first = { id: "one", name: "One", brand: "A", imageUrl: "/one.webp" };
  const second = { id: "two", name: "Two", brand: "B", imageUrl: "/two.webp" };

  const reconciled = reconcileWardrobeItems([first, second], [second, first]);

  assert.deepEqual(reconciled.map((item) => item.id), ["two", "one"]);
  assert.equal(reconciled[0], second);
  assert.equal(reconciled[1], first);
});
