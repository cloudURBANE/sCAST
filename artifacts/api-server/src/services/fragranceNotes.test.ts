import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPyramidFromFlatNotes,
  hasTieredPyramidNotes,
  normalizeNoteList,
  normalizePyramidNotes,
  resolvePyramidNotes,
} from "./fragranceNotes.ts";

test("normalizeNoteList splits comma-delimited values and dedupes case-insensitively", () => {
  assert.deepEqual(
    normalizeNoteList(["Lemon, Cedrat", "lemon", ["Sandalwood"]]),
    ["Lemon", "Cedrat", "Sandalwood"],
  );
});

test("normalizePyramidNotes accepts middle as heart notes", () => {
  assert.deepEqual(
    normalizePyramidNotes({ top: ["Lemon"], middle: ["Coconut"], base: ["Sandalwood"] }),
    { top: ["Lemon"], heart: ["Coconut"], base: ["Sandalwood"] },
  );
});

test("resolvePyramidNotes fills empty primary tiers from fallback pyramid", () => {
  const pyramid = resolvePyramidNotes(
    { flat: ["Sandalwood", "Leather", "Cardamom"] } as any,
    { top: ["Cardamom"], heart: ["Sandalwood"], base: ["Leather"] },
  );

  assert.deepEqual(pyramid, {
    top: ["Cardamom"],
    heart: ["Sandalwood"],
    base: ["Leather"],
  });
});

test("resolvePyramidNotes classifies flat-only notes when no tiered pyramid exists", () => {
  const pyramid = resolvePyramidNotes({ flat: ["Lemon", "Coconut", "Sandalwood"] } as any);

  assert.deepEqual(pyramid, {
    top: ["Lemon"],
    heart: ["Coconut"],
    base: ["Sandalwood"],
  });
  assert.equal(hasTieredPyramidNotes(pyramid), true);
});

test("buildPyramidFromFlatNotes groups common accord-only payloads", () => {
  assert.deepEqual(buildPyramidFromFlatNotes(["Rum", "Tobacco", "Vanilla", "Cinnamon"]), {
    top: [],
    heart: ["Rum", "Cinnamon"],
    base: ["Tobacco", "Vanilla"],
  });
});
