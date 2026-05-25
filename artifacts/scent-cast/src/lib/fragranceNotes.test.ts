import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPyramidFromFlatNotes,
  hasTieredPyramidNotes,
  normalizeNoteList,
  normalizePyramidNotes,
  resolveDisplayPyramid,
} from "./fragranceNotes.ts";

test("normalizeNoteList splits comma-delimited note strings and dedupes", () => {
  assert.deepEqual(
    normalizeNoteList(["Lemon, Cedrat", "lemon", ["Sandalwood"]]),
    ["Lemon", "Cedrat", "Sandalwood"],
  );
});

test("normalizePyramidNotes accepts middle as a heart-note alias", () => {
  assert.deepEqual(
    normalizePyramidNotes({
      top: ["Lemon"],
      middle: ["Coconut"],
      base: ["Sandalwood"],
    }),
    {
      top: ["Lemon"],
      heart: ["Coconut"],
      base: ["Sandalwood"],
      flat: [],
    },
  );
});

test("resolveDisplayPyramid lets legacy tiers fill empty derived note tiers", () => {
  const pyramid = resolveDisplayPyramid(
    { has_pyramid: false, flat: ["Sandalwood", "Leather", "Cardamom"] } as any,
    {
      top: ["Cardamom"],
      heart: ["Sandalwood"],
      base: ["Leather"],
    },
  );

  assert.deepEqual(pyramid.top, ["Cardamom"]);
  assert.deepEqual(pyramid.heart, ["Sandalwood"]);
  assert.deepEqual(pyramid.base, ["Leather"]);
  assert.deepEqual(pyramid.flat, ["Sandalwood", "Leather", "Cardamom"]);
});

test("resolveDisplayPyramid classifies flat-only notes when no tiers exist", () => {
  const pyramid = resolveDisplayPyramid({ flat: ["Lemon", "Coconut", "Sandalwood"] } as any);

  assert.deepEqual(pyramid.top, ["Lemon"]);
  assert.deepEqual(pyramid.heart, ["Coconut"]);
  assert.deepEqual(pyramid.base, ["Sandalwood"]);
  assert.equal(hasTieredPyramidNotes(pyramid), true);
});

test("buildPyramidFromFlatNotes groups common flat note payloads", () => {
  assert.deepEqual(buildPyramidFromFlatNotes(["Rum", "Tobacco", "Vanilla", "Cinnamon"]), {
    top: [],
    heart: ["Rum", "Cinnamon"],
    base: ["Tobacco", "Vanilla"],
  });
});
