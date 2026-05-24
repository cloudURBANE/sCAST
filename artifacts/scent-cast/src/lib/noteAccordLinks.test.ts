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

test("weighted family match: common fruit notes match fruity accord", () => {
  const rows: MainAccordDisplayRow[] = [{ label: "Fruity", pct: 74 }];
  const links = resolveNoteAccordLinks(["Pear", "Peach"], rows);
  assert.equal(links.get("Pear")?.row.label, "Fruity");
  assert.equal(links.get("Peach")?.row.label, "Fruity");
});

test("weighted family match: mandarin orange prefers citrus over fruity", () => {
  const rows: MainAccordDisplayRow[] = [
    { label: "Fruity", pct: 95 },
    { label: "Citrus", pct: 55 },
  ];
  const links = resolveNoteAccordLinks(["Mandarin Orange"], rows);
  assert.equal(links.get("Mandarin Orange")?.row.label, "Citrus");
});

test("weighted family match: bergamot prefers citrus over fresh when both exist", () => {
  const rows: MainAccordDisplayRow[] = [
    { label: "Fresh", pct: 100 },
    { label: "Citrus", pct: 45 },
  ];
  const links = resolveNoteAccordLinks(["Bergamot"], rows);
  assert.equal(links.get("Bergamot")?.row.label, "Citrus");
});

test("weighted family match: bergamot can match fresh when citrus is absent", () => {
  const rows: MainAccordDisplayRow[] = [{ label: "Fresh", pct: 86 }];
  const links = resolveNoteAccordLinks(["Bergamot"], rows);
  assert.equal(links.get("Bergamot")?.row.label, "Fresh");
});

test("weighted family guard: fresh spicy is treated as spicy, not broad fresh", () => {
  const rows: MainAccordDisplayRow[] = [{ label: "Fresh Spicy", pct: 86 }];
  const links = resolveNoteAccordLinks(["Bergamot"], rows);
  assert.ok(!links.has("Bergamot"));
});

test("scent-family match: requested aromatic and floral materials match main accords", () => {
  const rows: MainAccordDisplayRow[] = [
    { label: "Aromatic", pct: 80 },
    { label: "Floral", pct: 78 },
  ];
  const links = resolveNoteAccordLinks(["Fennel", "Mahonial", "Mahonil", "Mahonnel", "Violet", "Hyacinth"], rows);
  assert.equal(links.get("Fennel")?.row.label, "Aromatic");
  assert.equal(links.get("Mahonial")?.row.label, "Floral");
  assert.equal(links.get("Mahonil")?.row.label, "Floral");
  assert.equal(links.get("Mahonnel")?.row.label, "Floral");
  assert.equal(links.get("Violet")?.row.label, "Floral");
  assert.equal(links.get("Hyacinth")?.row.label, "Floral");
});

test("scent-family match: requested resins and smoke materials match main accords", () => {
  const rows: MainAccordDisplayRow[] = [
    { label: "Balsamic", pct: 82 },
    { label: "Smoky", pct: 76 },
    { label: "Musky", pct: 70 },
  ];
  const links = resolveNoteAccordLinks(
    ["Myrrh", "Elemi Resin", "Elmi Resin", "Labdanum", "Lamb", "Incense", "Musk"],
    rows,
  );
  assert.equal(links.get("Myrrh")?.row.label, "Balsamic");
  assert.equal(links.get("Elemi Resin")?.row.label, "Balsamic");
  assert.equal(links.get("Elmi Resin")?.row.label, "Balsamic");
  assert.equal(links.get("Labdanum")?.row.label, "Balsamic");
  assert.equal(links.get("Lamb")?.row.label, "Balsamic");
  assert.equal(links.get("Incense")?.row.label, "Smoky");
  assert.equal(links.get("Musk")?.row.label, "Musky");
});

test("scent-family match: requested green, woody, and spicy materials match main accords", () => {
  const rows: MainAccordDisplayRow[] = [
    { label: "Woody", pct: 72 },
    { label: "Green", pct: 68 },
    { label: "Warm Spicy", pct: 64 },
  ];
  const links = resolveNoteAccordLinks(["Fir", "Fir Resin", "Bullrush", "Bulrush", "Tomato", "Curry"], rows);
  assert.equal(links.get("Fir")?.row.label, "Woody");
  assert.equal(links.get("Fir Resin")?.row.label, "Woody");
  assert.equal(links.get("Bullrush")?.row.label, "Green");
  assert.equal(links.get("Bulrush")?.row.label, "Green");
  assert.equal(links.get("Tomato")?.row.label, "Green");
  assert.equal(links.get("Curry")?.row.label, "Warm Spicy");
});

test("scent-family match: sandalwood prefers woody accord", () => {
  const rows: MainAccordDisplayRow[] = [
    { label: "Musky", pct: 58 },
    { label: "Woody", pct: 72 },
  ];
  const links = resolveNoteAccordLinks(["Sandalwood"], rows);
  assert.equal(links.get("Sandalwood")?.row.label, "Woody");
});

test("weighted family match: sandalwood can match musky when woody is absent", () => {
  const rows: MainAccordDisplayRow[] = [{ label: "Musky", pct: 90 }];
  const links = resolveNoteAccordLinks(["Sandalwood"], rows);
  assert.equal(links.get("Sandalwood")?.row.label, "Musky");
});

test("weighted priority: exact accord label beats family match with higher pct", () => {
  const rows: MainAccordDisplayRow[] = [
    { label: "Floral", pct: 100 },
    { label: "Rose", pct: 35 },
  ];
  const links = resolveNoteAccordLinks(["Rose"], rows);
  assert.equal(links.get("Rose")?.row.label, "Rose");
});

test("weighted priority: stronger family confidence beats higher display pct", () => {
  const rows: MainAccordDisplayRow[] = [
    { label: "Fresh", pct: 100 },
    { label: "Citrus", pct: 42 },
  ];
  const links = resolveNoteAccordLinks(["Bergamot"], rows);
  assert.equal(links.get("Bergamot")?.row.label, "Citrus");
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
