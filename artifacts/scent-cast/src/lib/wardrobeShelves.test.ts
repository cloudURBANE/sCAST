import test from "node:test";
import assert from "node:assert/strict";
import {
  addFragranceShelfIndex,
  chunkWardrobeShelves,
} from "./wardrobeShelves.ts";

test("chunkWardrobeShelves splits into rows of 4", () => {
  assert.deepEqual(chunkWardrobeShelves([], 4), []);
  assert.deepEqual(chunkWardrobeShelves([1, 2, 3], 4), [[1, 2, 3]]);
  assert.deepEqual(chunkWardrobeShelves([1, 2, 3, 4], 4), [[1, 2, 3, 4]]);
  assert.deepEqual(chunkWardrobeShelves([1, 2, 3, 4, 5], 4), [[1, 2, 3, 4], [5]]);
  assert.deepEqual(
    chunkWardrobeShelves([1, 2, 3, 4, 5, 6, 7, 8], 4),
    [
      [1, 2, 3, 4],
      [5, 6, 7, 8],
    ],
  );
});

test("addFragranceShelfIndex: empty wardrobe has no shelf for the add card", () => {
  assert.equal(addFragranceShelfIndex(0), null);
  assert.equal(addFragranceShelfIndex(-3), null);
});

test("addFragranceShelfIndex: partial last shelf hosts the add card", () => {
  assert.equal(addFragranceShelfIndex(1), 0);
  assert.equal(addFragranceShelfIndex(3), 0);
  assert.equal(addFragranceShelfIndex(5), 1); // shelf 0 full, shelf 1 partial
  assert.equal(addFragranceShelfIndex(7), 1);
});

test("addFragranceShelfIndex: full last shelf (multiple of 4) still shows the add card — the regression this guards", () => {
  // Before the fix the add card was hidden whenever the last shelf was full, so
  // these counts left no way to add another fragrance.
  assert.equal(addFragranceShelfIndex(4), 0);
  assert.equal(addFragranceShelfIndex(8), 1);
  assert.equal(addFragranceShelfIndex(12), 2);
});

test("addFragranceShelfIndex always points at the final shelf for any positive count", () => {
  for (let count = 1; count <= 40; count++) {
    const shelves = chunkWardrobeShelves(Array.from({ length: count }), 4);
    assert.equal(addFragranceShelfIndex(count), shelves.length - 1);
  }
});
