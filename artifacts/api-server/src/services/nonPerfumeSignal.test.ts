import test from "node:test";
import assert from "node:assert/strict";
import { nonPerfumeSignal } from "./nonPerfumeSignal.ts";

const FG_PERFUME = "https://www.fragrantica.com/perfume/Maison-Margiela/Bubble-Bath-12345.html";
const FG_BUBBLE_BATH_REAL = "https://www.fragrantica.com/perfume/Maison-Margiela/Replica-Bubble-Bath-9999.html";
const BN_ONLY = "https://basenotes.com/fragrances/pink-by-victorias-secret.10213293";

test("a real Fragrantica /perfume/ page is never flagged, even with a body-care-ish name", () => {
  // Margiela Replica "Bubble Bath"/"Beach Walk" are real perfumes — the page guard wins.
  assert.equal(nonPerfumeSignal("Bubble Bath", "Maison Margiela", [FG_BUBBLE_BATH_REAL]).flagged, false);
  assert.equal(nonPerfumeSignal("Beach Walk", "Maison Margiela", [FG_PERFUME]).flagged, false);
});

test("body-care brands with no real perfume page are flagged", () => {
  assert.equal(nonPerfumeSignal("Japanese Cherry Blossom", "Bath & Body Works", [BN_ONLY]).flagged, true);
  assert.equal(nonPerfumeSignal("Anything", "The Body Shop", []).flagged, true);
  assert.equal(nonPerfumeSignal("Anything", "Pull&Bear", []).flagged, true);
});

test("a body-care brand is NOT flagged when it resolved to a real perfume page", () => {
  // The brand list is only a fallback for the never-resolved state.
  assert.equal(nonPerfumeSignal("Some EDP", "Bath & Body Works", [FG_PERFUME]).flagged, false);
});

test("unambiguous product tokens are flagged regardless of brand", () => {
  assert.equal(nonPerfumeSignal("Velvet Rose Body Lotion", "Some Brand", [BN_ONLY]).flagged, true);
  assert.equal(nonPerfumeSignal("Eucalyptus Shower Gel", "Some Brand", []).flagged, true);
  assert.equal(nonPerfumeSignal("Lavender Reed Diffuser", "Some Brand", []).flagged, true);
});

test("test/placeholder identities are always junk", () => {
  assert.equal(nonPerfumeSignal("Empty-Notes Test", "Whatever", []).flagged, true);
  assert.equal(nonPerfumeSignal("Unique Uncached 3", "Whatever", []).flagged, true);
});

test("mixed-catalog brands (Victoria's Secret, Fresh) are never auto-flagged on brand alone", () => {
  // They make real perfumes; the engine-side review/purge handles their body mists by URL.
  assert.equal(nonPerfumeSignal("Tease", "Victoria's Secret", []).flagged, false);
  assert.equal(nonPerfumeSignal("Pink", "Victoria's Secret", [BN_ONLY]).flagged, false);
  assert.equal(nonPerfumeSignal("Index Pink Jasmine", "Fresh", [BN_ONLY]).flagged, false);
});

test("a genuine luxury perfume is never flagged", () => {
  assert.equal(nonPerfumeSignal("Aventus", "Creed", [FG_PERFUME]).flagged, false);
  assert.equal(nonPerfumeSignal("Oud Wood", "Tom Ford", []).flagged, false);
});
