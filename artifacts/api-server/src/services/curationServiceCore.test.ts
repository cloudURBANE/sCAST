import test from "node:test";
import assert from "node:assert/strict";
import {
  BEAM_CURATION_SOURCE,
  buildCurationMetadata,
  curationPushCopy,
  pendingCurationItemFromRow,
  type CurationJobRow,
} from "./curationServiceCore.ts";

// --- metadata payload ---------------------------------------------------------

test("buildCurationMetadata stamps source + user and trims/echoes name/brand", () => {
  const meta = buildCurationMetadata({
    userId: "user-1",
    tenantId: "tenant-1",
    name: "  Aventus  ",
    brand: "  Creed  ",
  });
  assert.deepEqual(meta, {
    source: BEAM_CURATION_SOURCE,
    userId: "user-1",
    tenantId: "tenant-1",
    name: "  Aventus  ", // name is preserved as-given; the DB layer trims before stamping
    brand: "Creed",
  });
});

test("buildCurationMetadata omits optional fields when absent or blank", () => {
  const meta = buildCurationMetadata({ userId: "user-2", name: "Bleu" });
  assert.deepEqual(meta, { source: BEAM_CURATION_SOURCE, userId: "user-2", name: "Bleu" });
  assert.equal("tenantId" in meta, false);
  assert.equal("brand" in meta, false);

  const blank = buildCurationMetadata({ userId: "user-2", name: "Bleu", brand: "   ", tenantId: "  " });
  assert.equal("tenantId" in blank, false);
  assert.equal("brand" in blank, false);
});

// --- row → pending item -------------------------------------------------------

function row(overrides: Partial<CurationJobRow>): CurationJobRow {
  return {
    jobKey: "q:creed aventus",
    status: "pending",
    name: null,
    house: null,
    lastRequestedAt: new Date("2026-06-17T12:00:00.000Z"),
    metadataJson: { source: BEAM_CURATION_SOURCE, userId: "user-1", name: "Aventus", brand: "Creed" },
    ...overrides,
  };
}

test("pendingCurationItemFromRow prefers metadata name/brand and is not ready while pending", () => {
  const item = pendingCurationItemFromRow(row({}));
  assert.deepEqual(item, {
    jobKey: "q:creed aventus",
    status: "pending",
    name: "Aventus",
    brand: "Creed",
    ready: false,
    enrichmentLevel: "none",
    lastRequestedAt: "2026-06-17T12:00:00.000Z",
  });
});

test("pendingCurationItemFromRow is ready only when status is completed", () => {
  assert.equal(pendingCurationItemFromRow(row({ status: "completed" })).ready, true);
  assert.equal(pendingCurationItemFromRow(row({ status: "processing" })).ready, false);
  assert.equal(pendingCurationItemFromRow(row({ status: "failed" })).ready, false);
});

test("pendingCurationItemFromRow reports the observed enrichment level", () => {
  // A completed job is full by definition, regardless of the stamped level.
  assert.equal(
    pendingCurationItemFromRow(row({ status: "completed" })).enrichmentLevel,
    "full",
  );
  // A still-running job surfaces the worker's last stamped level.
  assert.equal(
    pendingCurationItemFromRow(
      row({
        status: "failed",
        metadataJson: { source: BEAM_CURATION_SOURCE, userId: "u", enrichLevel: "partial" },
      }),
    ).enrichmentLevel,
    "partial",
  );
  // Garbage/missing level degrades to "none".
  assert.equal(
    pendingCurationItemFromRow(
      row({ status: "pending", metadataJson: { source: BEAM_CURATION_SOURCE, userId: "u", enrichLevel: "??" } }),
    ).enrichmentLevel,
    "none",
  );
});

test("pendingCurationItemFromRow falls back to row name/house when metadata lacks them", () => {
  const item = pendingCurationItemFromRow(
    row({ name: "Sauvage", house: "Dior", metadataJson: { source: BEAM_CURATION_SOURCE, userId: "u" } }),
  );
  assert.equal(item.name, "Sauvage");
  assert.equal(item.brand, "Dior");
});

test("pendingCurationItemFromRow tolerates a null/empty metadata blob", () => {
  const item = pendingCurationItemFromRow(row({ name: null, house: null, metadataJson: null }));
  assert.equal(item.name, "");
  assert.equal(item.brand, null);
});

// --- push copy ----------------------------------------------------------------

test("curationPushCopy builds a brand+name label when both are present", () => {
  const { title, body } = curationPushCopy({ name: "Aventus", brand: "Creed" });
  assert.equal(title, "Ready to add to your vault");
  assert.match(body, /Creed Aventus/);
});

test("curationPushCopy degrades gracefully without a brand or name", () => {
  assert.match(curationPushCopy({ name: "Aventus", brand: null }).body, /Aventus/);
  assert.match(curationPushCopy({ name: "", brand: null }).body, /A recommendation is ready/);
});
