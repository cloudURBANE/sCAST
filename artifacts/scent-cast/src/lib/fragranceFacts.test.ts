import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveFragranceFacts,
  usefulFragranceFact,
} from "./fragranceFacts.ts";

test("usefulFragranceFact trims real facts and rejects placeholder noise", () => {
  assert.equal(usefulFragranceFact("  Eau de Parfum  "), "Eau de Parfum");
  for (const placeholder of ["Unknown", "N/A", "n.a.", "NA", "none", "null", "not available", ""]) {
    assert.equal(usefulFragranceFact(placeholder), undefined);
  }
  assert.equal(usefulFragranceFact("Universal"), "Universal");
  assert.equal(usefulFragranceFact("Universal", { rejectUniversal: true }), undefined);
});

test("resolveFragranceFacts preserves authoritative detail facts over pipeline placeholders", () => {
  const facts = resolveFragranceFacts({
    detail: {
      year: 2018,
      gender: "Women",
      concentration: "Eau de Parfum",
      season: "Autumn",
    },
    pipelineProfile: {
      year: 2024,
      gender: "Unknown",
      concentration: "N/A",
      season: "Universal",
    },
  });

  assert.deepEqual(facts, {
    year: 2018,
    gender: "Women",
    concentration: "Eau de Parfum",
    season: "Autumn",
  });
});

test("resolveFragranceFacts retains selected facts and uses useful pipeline fallbacks", () => {
  const facts = resolveFragranceFacts({
    detail: {
      year: null,
      gender: "Unknown",
      concentration: "N/A",
    },
    selected: {
      year: 2020,
      gender: "Unisex",
    },
    pipelineProfile: {
      year: 2024,
      gender: "Men",
      concentration: "EDT",
      season: "Summer",
    },
  });

  assert.deepEqual(facts, {
    year: 2020,
    gender: "Unisex",
    concentration: "EDT",
    season: "Summer",
  });
});

test("resolveFragranceFacts uses pipeline facts when upstream sources have only placeholders", () => {
  const facts = resolveFragranceFacts({
    detail: {
      year: "Unknown",
      gender: "N/A",
      concentration: "Unknown",
      season: "Universal",
    },
    pipelineProfile: {
      year: "2022",
      gender: "Men",
      concentration: "EDT",
      season: "Spring",
    },
  });

  assert.deepEqual(facts, {
    year: 2022,
    gender: "Men",
    concentration: "EDT",
    season: "Spring",
  });
});

test("resolveFragranceFacts derives environment from useful primary seasons", () => {
  const facts = resolveFragranceFacts({
    detail: {
      season: "Universal",
      derived_metrics: {
        wear_profile: {
          primary_seasons: ["fall_winter", "spring", "Spring", "unknown", "Universal"],
        },
      },
    },
  });

  assert.equal(facts.season, "Fall Winter / Spring");
});

test("resolveFragranceFacts omits unresolved placeholder facts", () => {
  assert.deepEqual(resolveFragranceFacts({
    detail: {
      year: "Unknown",
      gender: "Unknown",
      concentration: "N/A",
      season: "Universal",
      derived_metrics: {
        wear_profile: { primary_seasons: ["Unknown", "Universal"] },
      },
    },
  }), {});
});
