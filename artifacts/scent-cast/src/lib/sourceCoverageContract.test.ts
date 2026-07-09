// Cross-service contract test (readiness gap X2): the SPA's completeness
// predicate is exercised against the shared source_coverage fixture set. The
// engine repo (srt-scent-engine) carries a byte-identical copy of the fixture
// file and asserts _source_coverage PRODUCES the engine_producible shapes, so
// either side changing the contract turns its own CI red — the two repos deploy
// independently and nothing else would catch the drift. See the _contract note
// inside the fixture file before editing it.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isSourceCoverageComplete, type SourceCoverage } from "./fragranceApi.ts";

type Fixture = {
  name: string;
  description: string;
  engine_producible: boolean;
  coverage: Record<string, unknown>;
  spa_complete: boolean;
};

const fixtureFile = fileURLToPath(
  new URL("./sourceCoverageContractFixtures.json", import.meta.url),
);
const { fixtures } = JSON.parse(readFileSync(fixtureFile, "utf8")) as { fixtures: Fixture[] };

test("X2 contract: fixture set is non-trivial and covers both verdicts", () => {
  assert.ok(fixtures.length >= 5);
  assert.ok(fixtures.some((f) => f.spa_complete));
  assert.ok(fixtures.some((f) => !f.spa_complete));
  assert.ok(
    fixtures.some((f) => f.engine_producible),
    "at least one fixture must pin the live engine output shape",
  );
});

for (const fixture of fixtures) {
  test(`X2 contract: isSourceCoverageComplete(${fixture.name}) === ${fixture.spa_complete}`, () => {
    assert.equal(
      isSourceCoverageComplete(fixture.coverage as SourceCoverage),
      fixture.spa_complete,
      fixture.description,
    );
  });
}

test("X2 contract: null/undefined coverage is never complete", () => {
  assert.equal(isSourceCoverageComplete(null), false);
  assert.equal(isSourceCoverageComplete(undefined), false);
});
