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

test("reconcileWardrobeItems keeps a current image when an incoming refresh is imageless", () => {
  const current = [
    {
      id: "oud",
      _dbId: "row-1",
      name: "Oud Wood",
      brand: "Tom Ford",
      imageUrl: "/images/oud.webp?v=stable",
      imageHash: "stable",
    },
  ];
  const incoming = [
    {
      id: "oud",
      _dbId: "row-1",
      name: "Oud Wood",
      brand: "Tom Ford",
      imageUrl: "",
    },
  ];

  const reconciled = reconcileWardrobeItems(current, incoming);

  assert.equal(reconciled, current);
  assert.equal(reconciled[0], current[0]);
  assert.equal(reconciled[0]?.imageUrl, "/images/oud.webp?v=stable");
  assert.equal(reconciled[0]?.imageHash, "stable");
});

test("reconcileWardrobeItems preserves the current hash when keeping a current image", () => {
  const current = [
    {
      id: "oud",
      _dbId: "row-1",
      name: "Oud Wood",
      brand: "Tom Ford",
      imageUrl: "/images/oud.webp?v=stable",
      imageHash: "stable",
      season: "Winter",
    },
  ];
  const incoming = [
    {
      id: "oud",
      _dbId: "row-1",
      name: "Oud Wood",
      brand: "Tom Ford",
      imageUrl: "/images/oud.webp?v=poll",
      season: "Evening",
    },
  ];

  const reconciled = reconcileWardrobeItems(current, incoming);

  assert.notEqual(reconciled, current);
  assert.equal(reconciled[0]?.imageUrl, "/images/oud.webp?v=stable");
  assert.equal(reconciled[0]?.imageHash, "stable");
  assert.equal((reconciled[0] as { season?: string })?.season, "Evening");
});

test("reconcileWardrobeItems ignores key order when content is unchanged (WS-15)", () => {
  const current = [
    { id: "oud", _dbId: "row-1", name: "Oud Wood", brand: "Tom Ford", imageUrl: "/oud.webp" },
  ];
  // Same content, different key insertion order (as a server re-serialization or
  // spread-rebuilt row would produce).
  const incoming = [
    { imageUrl: "/oud.webp", brand: "Tom Ford", name: "Oud Wood", _dbId: "row-1", id: "oud" },
  ];

  const reconciled = reconcileWardrobeItems(current, incoming);

  assert.equal(reconciled, current);
  assert.equal(reconciled[0], current[0]);
});

test("reconcileWardrobeItems keeps incoming order while reusing unchanged rows", () => {
  const first = { id: "one", name: "One", brand: "A", imageUrl: "/one.webp" };
  const second = { id: "two", name: "Two", brand: "B", imageUrl: "/two.webp" };

  const reconciled = reconcileWardrobeItems([first, second], [second, first]);

  assert.deepEqual(reconciled.map((item) => item.id), ["two", "one"]);
  assert.equal(reconciled[0], second);
  assert.equal(reconciled[1], first);
});
