import test from "node:test";
import assert from "node:assert/strict";
import {
  buildJobKey,
  canonicalizeFgUrl,
  computeEnrichmentUpsert,
  EnrichmentQueueError,
  normalizeText,
  resolveJobType,
  resolveQueryText,
  statusMessage,
  type EnrichmentJobInput,
  type ExistingJobRow,
} from "./enrichmentQueueCore.ts";

// --- normalization -----------------------------------------------------------

test("normalizeText lowercases, trims, and collapses whitespace", () => {
  assert.equal(normalizeText("  Dior   Sauvage  "), "dior sauvage");
  assert.equal(normalizeText("EAU\tDE\nPARFUM"), "eau de parfum");
  assert.equal(normalizeText(null), "");
  assert.equal(normalizeText(undefined), "");
});

test("canonicalizeFgUrl strips tracking params, fragment, trailing slash, and lowercases", () => {
  assert.equal(
    canonicalizeFgUrl("https://www.Fragrantica.com/perfume/Dior/Sauvage-31861.html"),
    "https://www.fragrantica.com/perfume/dior/sauvage-31861.html",
  );
  assert.equal(
    canonicalizeFgUrl(
      "https://www.fragrantica.com/perfume/Dior/Sauvage-31861.html?utm_source=ig&fbclid=abc#reviews",
    ),
    "https://www.fragrantica.com/perfume/dior/sauvage-31861.html",
  );
  // Trailing slash is dropped, but a non-tracking query param is preserved.
  assert.equal(
    canonicalizeFgUrl("https://example.com/path/?id=7&utm_medium=x"),
    "https://example.com/path?id=7",
  );
});

test("canonicalizeFgUrl preserves path identity so distinct fragrances never collide", () => {
  const a = canonicalizeFgUrl("https://www.fragrantica.com/perfume/Dior/Sauvage-31861.html");
  const b = canonicalizeFgUrl("https://www.fragrantica.com/perfume/Dior/Sauvage-Elixir-62621.html");
  assert.notEqual(a, b);
});

// --- query + job key ---------------------------------------------------------

test("resolveQueryText synthesizes a query from house + name when none is given", () => {
  assert.equal(resolveQueryText({ query: "explicit query" }), "explicit query");
  assert.equal(resolveQueryText({ house: "Dior", name: "Sauvage" }), "Dior Sauvage");
  assert.equal(resolveQueryText({ name: "Sauvage" }), "Sauvage");
  assert.equal(resolveQueryText({}), null);
});

test("buildJobKey prefers a canonical fg_url", () => {
  const key = buildJobKey({
    fgUrl: "https://www.fragrantica.com/perfume/Dior/Sauvage-31861.html?utm_source=x",
    query: "dior sauvage",
  });
  assert.equal(key, "fg:https://www.fragrantica.com/perfume/dior/sauvage-31861.html");
});

test("buildJobKey falls back to normalized query + house + name", () => {
  assert.equal(
    buildJobKey({ query: "Sauvage", house: "Dior", name: "Sauvage EDT" }),
    "q:sauvage|dior|sauvage edt",
  );
});

test("buildJobKey falls back to normalized query only", () => {
  assert.equal(buildJobKey({ query: "  Creed   Aventus  " }), "q:creed aventus");
});

test("buildJobKey throws when there is no usable identity", () => {
  assert.throws(() => buildJobKey({}), EnrichmentQueueError);
});

test("buildJobKey is deterministic for equivalent inputs", () => {
  const a = buildJobKey({ query: "Dior Sauvage" });
  const b = buildJobKey({ query: "  dior   SAUVAGE " });
  assert.equal(a, b);
});

test("resolveJobType is detail_only with an fg_url, identity_and_detail without", () => {
  assert.equal(resolveJobType({ fgUrl: "https://fragrantica.com/x" }), "detail_only");
  assert.equal(resolveJobType({ query: "Dior Sauvage" }), "identity_and_detail");
  assert.equal(resolveJobType({ query: "x", jobType: "repair" }), "repair");
});

// --- upsert planning ---------------------------------------------------------

const NOW_1 = new Date("2026-05-14T18:30:00.000Z");
const NOW_2 = new Date("2026-05-14T19:00:00.000Z");

function rowFromInsert(input: EnrichmentJobInput, now: Date): ExistingJobRow {
  const plan = computeEnrichmentUpsert(null, input, now);
  assert.equal(plan.action, "insert");
  if (plan.action !== "insert") throw new Error("unreachable");
  const v = plan.values;
  return {
    jobKey: v.jobKey,
    jobType: v.jobType,
    query: v.query,
    normalizedQuery: v.normalizedQuery,
    name: v.name,
    house: v.house,
    year: v.year,
    bnUrl: v.bnUrl,
    fgUrl: v.fgUrl,
    sourceId: v.sourceId,
    status: v.status,
    priority: v.priority,
    requestedCount: v.requestedCount,
    metadataJson: v.metadataJson,
  };
}

test("first request plans an insert with requested_count = 1 and status pending", () => {
  const plan = computeEnrichmentUpsert(null, { query: "Dior Sauvage" }, NOW_1);
  assert.equal(plan.action, "insert");
  if (plan.action !== "insert") throw new Error("unreachable");
  assert.equal(plan.values.requestedCount, 1);
  assert.equal(plan.values.status, "pending");
  assert.equal(plan.values.jobType, "identity_and_detail");
  assert.equal(plan.values.createdAt, NOW_1);
  assert.equal(plan.values.lastRequestedAt, NOW_1);
  assert.equal(plan.jobKey, "q:dior sauvage");
});

test("duplicate request plans an update on the SAME job_key, not a new row", () => {
  const input: EnrichmentJobInput = { query: "Dior Sauvage" };
  const existing = rowFromInsert(input, NOW_1);
  const plan = computeEnrichmentUpsert(existing, input, NOW_2);
  assert.equal(plan.action, "update");
  assert.equal(plan.jobKey, existing.jobKey);
});

test("duplicate request increments requested_count and bumps last_requested_at", () => {
  const input: EnrichmentJobInput = { query: "Dior Sauvage" };
  const existing = rowFromInsert(input, NOW_1);
  const plan = computeEnrichmentUpsert(existing, input, NOW_2);
  if (plan.action !== "update") throw new Error("expected update");
  assert.equal(plan.values.requestedCount, 2);
  assert.equal(plan.values.lastRequestedAt, NOW_2);
  assert.equal(plan.values.updatedAt, NOW_2);
  // priority gets a small increment over the existing value
  assert.equal(plan.values.priority, existing.priority + 1);
});

test("three sequential requests reach requested_count = 3 on one job_key", () => {
  const input: EnrichmentJobInput = {
    fgUrl: "https://www.fragrantica.com/perfume/Dior/Sauvage-31861.html",
  };
  let row = rowFromInsert(input, NOW_1);
  assert.equal(row.requestedCount, 1);

  for (const now of [NOW_2, new Date("2026-05-14T20:00:00.000Z")]) {
    const plan = computeEnrichmentUpsert(row, input, now);
    if (plan.action !== "update") throw new Error("expected update");
    row = { ...row, requestedCount: plan.values.requestedCount, priority: plan.values.priority };
  }
  assert.equal(row.requestedCount, 3);
});

test("update fills missing identity fields but never clobbers existing data", () => {
  // First request captured a name but no house.
  const existing = rowFromInsert({ query: "Dior Sauvage", name: "Sauvage" }, NOW_1);
  assert.equal(existing.house, null);
  assert.equal(existing.name, "Sauvage");
  // A later request carries the missing house AND a conflicting name.
  const plan = computeEnrichmentUpsert(
    existing,
    { query: "Dior Sauvage", house: "Dior", name: "Different Name" },
    NOW_2,
  );
  if (plan.action !== "update") throw new Error("expected update");
  assert.equal(plan.values.house, "Dior"); // was null -> filled
  assert.equal(plan.values.name, "Sauvage"); // already set -> NOT clobbered
});

test("update plan never carries a status field — terminal jobs stay terminal", () => {
  const completed: ExistingJobRow = {
    ...rowFromInsert({ query: "Dior Sauvage" }, NOW_1),
    status: "completed",
  };
  const plan = computeEnrichmentUpsert(completed, { query: "Dior Sauvage" }, NOW_2);
  if (plan.action !== "update") throw new Error("expected update");
  assert.equal("status" in plan.values, false);
});

test("metadata is shallow-merged across requests", () => {
  const existing: ExistingJobRow = {
    ...rowFromInsert({ query: "Dior Sauvage", metadata: { a: 1 } }, NOW_1),
  };
  const plan = computeEnrichmentUpsert(
    existing,
    { query: "Dior Sauvage", metadata: { b: 2 } },
    NOW_2,
  );
  if (plan.action !== "update") throw new Error("expected update");
  assert.deepEqual(plan.values.metadataJson, { a: 1, b: 2 });
});

test("statusMessage maps known statuses and falls back gracefully", () => {
  assert.equal(statusMessage("pending"), "Enhanced metrics queued.");
  assert.equal(statusMessage("not_found"), "No enrichment request found.");
  assert.equal(statusMessage("weird"), "Enrichment status unknown.");
});
