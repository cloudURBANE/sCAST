import assert from "node:assert/strict";
import test from "node:test";
import {
  collectLinkableMainAccordRows,
  resolveNoteAccordLinks,
} from "./noteAccordLinks.ts";
import type { MainAccordDisplayRow } from "./fragranceApi.ts";

test("exact match: Rose matches Rose accord", () => {
  const rows: MainAccordDisplayRow[] = [{ label: "Rose", pct: 80 }];
  const links = resolveNoteAccordLinks(["Rose"], rows);
  assert.ok(links.has("Rose"));
  assert.equal(links.get("Rose")!.row.label, "Rose");
});

test("alias match: Agarwood (Oud) matches Oud accord", () => {
  const rows: MainAccordDisplayRow[] = [{ label: "Oud", pct: 72 }];
  const links = resolveNoteAccordLinks(["Agarwood (Oud)"], rows);
  assert.ok(links.has("Agarwood (Oud)"));
  assert.equal(links.get("Agarwood (Oud)")!.row.label, "Oud");
});

test("word-boundary match: Dark Patchouli matches Patchouli accord", () => {
  const rows: MainAccordDisplayRow[] = [{ label: "Patchouli", pct: 60 }];
  const links = resolveNoteAccordLinks(["Dark Patchouli"], rows);
  assert.ok(links.has("Dark Patchouli"));
  assert.equal(links.get("Dark Patchouli")!.row.label, "Patchouli");
});

test("word-boundary match: punctuation separates note words", () => {
  const rows: MainAccordDisplayRow[] = [{ label: "Rose", pct: 62 }];
  const links = resolveNoteAccordLinks(["Rose, Turkish"], rows);
  assert.ok(links.has("Rose, Turkish"));
  assert.equal(links.get("Rose, Turkish")!.row.label, "Rose");
});

test("no match: Pepper does not match Rose accord", () => {
  const rows: MainAccordDisplayRow[] = [{ label: "Rose", pct: 70 }];
  const links = resolveNoteAccordLinks(["Pepper"], rows);
  assert.ok(!links.has("Pepper"));
});

test("word-boundary guard: Rosewood does not match Rose accord", () => {
  const rows: MainAccordDisplayRow[] = [{ label: "Rose", pct: 65 }];
  const links = resolveNoteAccordLinks(["Rosewood"], rows);
  assert.ok(!links.has("Rosewood"));
});

test("scent-family match: florals match floral accord", () => {
  const rows: MainAccordDisplayRow[] = [{ label: "Floral", pct: 74 }];
  const links = resolveNoteAccordLinks(["Peony", "Lily of the Valley"], rows);
  assert.equal(links.get("Peony")?.row.label, "Floral");
  assert.equal(links.get("Lily of the Valley")?.row.label, "Floral");
});

test("scent-family match: musk note matches musky accord", () => {
  const rows: MainAccordDisplayRow[] = [{ label: "Musky", pct: 68 }];
  const links = resolveNoteAccordLinks(["Musk"], rows);
  assert.equal(links.get("Musk")?.row.label, "Musky");
});

test("scent-family match: sandalwood prefers woody accord", () => {
  const rows: MainAccordDisplayRow[] = [
    { label: "Musky", pct: 58 },
    { label: "Woody", pct: 72 },
  ];
  const links = resolveNoteAccordLinks(["Sandalwood"], rows);
  assert.equal(links.get("Sandalwood")?.row.label, "Woody");
});

test("multiple accord matches: picks accord with higher displayPct", () => {
  const rows: MainAccordDisplayRow[] = [
    { label: "Rose", pct: 40 },
    { label: "Rose", pct: 85 },
  ];
  const links = resolveNoteAccordLinks(["Rose"], rows);
  assert.ok(links.has("Rose"));
  assert.equal(links.get("Rose")!.displayPct, 85);
});

test("collectLinkableMainAccordRows: object-shaped scent_vector returns empty", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const main = { scent_vector: { freshness: 8, woodiness: 6, warmth: 5 } } as any;
  const rows = collectLinkableMainAccordRows(main);
  assert.deepEqual(rows, []);
});

test("collectLinkableMainAccordRows: object-shaped scent_vector does not fall through to top_accords", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const main = {
    scent_vector: { freshness: 8, woodiness: 6, warmth: 5 },
    top_accords: ["Freshness", "Woodiness"],
  } as any;
  const rows = collectLinkableMainAccordRows(main);
  assert.deepEqual(rows, []);
});

test("resolveNoteAccordLinks: empty notes returns empty map", () => {
  const rows: MainAccordDisplayRow[] = [{ label: "Rose", pct: 80 }];
  const links = resolveNoteAccordLinks([], rows);
  assert.equal(links.size, 0);
});

test("resolveNoteAccordLinks: empty accord rows returns empty map", () => {
  const links = resolveNoteAccordLinks(["Rose"], []);
  assert.equal(links.size, 0);
});
