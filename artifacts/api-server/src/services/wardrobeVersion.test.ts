import assert from "node:assert/strict";
import test from "node:test";
import { wardrobeVersionEtag } from "./wardrobeVersion.ts";

test("wardrobeVersionEtag is stable for identical inputs", () => {
  const d = new Date("2026-06-17T12:00:00.000Z");
  assert.equal(wardrobeVersionEtag(3, d), wardrobeVersionEtag(3, d));
});

test("wardrobeVersionEtag changes when the row count changes", () => {
  const d = new Date("2026-06-17T12:00:00.000Z");
  assert.notEqual(wardrobeVersionEtag(3, d), wardrobeVersionEtag(4, d));
});

test("wardrobeVersionEtag changes when the newest updated_at changes", () => {
  const a = wardrobeVersionEtag(3, new Date("2026-06-17T12:00:00.000Z"));
  const b = wardrobeVersionEtag(3, new Date("2026-06-17T12:00:01.000Z"));
  assert.notEqual(a, b);
});

test("wardrobeVersionEtag accepts an ISO string identically to a Date", () => {
  const iso = "2026-06-17T12:00:00.000Z";
  assert.equal(wardrobeVersionEtag(2, iso), wardrobeVersionEtag(2, new Date(iso)));
});

test("wardrobeVersionEtag treats an empty wardrobe as count 0, ms 0", () => {
  assert.equal(wardrobeVersionEtag(0, null), 'W/"wardrobe-0-0"');
});

test("wardrobeVersionEtag degrades unparseable inputs to 0 (never NaN)", () => {
  assert.equal(wardrobeVersionEtag(Number.NaN, "not-a-date"), 'W/"wardrobe-0-0"');
});

test("wardrobeVersionEtag emits a weak validator", () => {
  assert.ok(wardrobeVersionEtag(1, new Date()).startsWith('W/"'));
});
