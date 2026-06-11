import assert from "node:assert/strict";
import test from "node:test";
import {
  detailRefreshPatchFromBody,
  hasDetailRefreshPayload,
} from "./wardrobeDetailFacts.ts";

test("detailRefreshPatchFromBody promotes useful top-level facts", () => {
  const patch = detailRefreshPatchFromBody({
    year: "2019",
    gender: "Unisex",
    concentration: "Eau de Parfum",
    season: "fall",
    derived_metrics: { wear_profile: { primary_seasons: ["spring"] } },
  });

  assert.equal(patch.year, 2019);
  assert.equal(patch.gender, "Unisex");
  assert.equal(patch.concentration, "Eau de Parfum");
  assert.equal(patch.season, "fall");
});

test("detailRefreshPatchFromBody rejects placeholder facts", () => {
  const patch = detailRefreshPatchFromBody({
    year: "9999",
    gender: "Unknown",
    concentration: "N/A",
    season: "Universal",
    derived_metrics: { wear_profile: { primary_seasons: ["Universal", "unknown"] } },
    raw_engine_detail: {
      year: 1700,
      gender: "none",
      concentration: "null",
      season: "n.a.",
    },
  });

  assert.equal(patch.year, undefined);
  assert.equal(patch.gender, undefined);
  assert.equal(patch.concentration, undefined);
  assert.equal(patch.season, undefined);
});

test("detailRefreshPatchFromBody derives season from wear profile when explicit season is absent", () => {
  const patch = detailRefreshPatchFromBody({
    derived_metrics: {
      wear_profile: {
        primary_seasons: ["fall_winter", "spring", "spring", "Universal"],
      },
    },
  });

  assert.equal(patch.season, "Fall Winter / Spring");
});

test("detailRefreshPatchFromBody falls back to raw engine detail facts", () => {
  const patch = detailRefreshPatchFromBody({
    raw_engine_detail: {
      year: "2021",
      gender: "Women",
      concentration: "EDP",
      derived_metrics: {
        wear_profile: {
          primary_seasons: ["summer"],
        },
      },
    },
  });

  assert.equal(patch.year, 2021);
  assert.equal(patch.gender, "Women");
  assert.equal(patch.concentration, "EDP");
  assert.equal(patch.season, "Summer");
});

test("hasDetailRefreshPayload recognizes fact-only and raw detail updates", () => {
  assert.equal(hasDetailRefreshPayload({ year: "2020" }), true);
  assert.equal(hasDetailRefreshPayload({ raw_engine_detail: {} }), true);
  assert.equal(hasDetailRefreshPayload({ imageUrl: "https://example.com/bottle.jpg" }), false);
});
