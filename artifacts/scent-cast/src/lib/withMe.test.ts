import assert from "node:assert/strict";
import test from "node:test";
import {
  effectiveWithMeItems,
  reconcileWithMeIds,
  sameWithMeSelection,
  withMeItemId,
} from "./withMe.ts";

const items = [
  { id: "guest-a", _dbId: "row-a", name: "A" },
  { id: "guest-b", name: "B" },
];

test("withMeItemId prefers the durable server row id", () => {
  assert.equal(withMeItemId(items[0]!), "row-a");
  assert.equal(withMeItemId(items[1]!), "guest-b");
});

test("effectiveWithMeItems distinguishes full, selected, and intentionally empty", () => {
  assert.equal(effectiveWithMeItems(items, { enabled: false, fragranceIds: [] }), items);
  assert.deepEqual(effectiveWithMeItems(items, { enabled: true, fragranceIds: ["guest-b"] }), [items[1]]);
  assert.deepEqual(effectiveWithMeItems(items, { enabled: true, fragranceIds: [] }), []);
});

test("reconcileWithMeIds removes deleted and duplicate memberships", () => {
  assert.deepEqual(reconcileWithMeIds(items, ["row-a", "gone", "row-a", "guest-b"]), ["row-a", "guest-b"]);
});

test("sameWithMeSelection compares sets rather than draft order", () => {
  assert.equal(sameWithMeSelection(["a", "b"], ["b", "a"]), true);
  assert.equal(sameWithMeSelection(["a"], ["b"]), false);
});

