import test from "node:test";
import assert from "node:assert/strict";
import { stableProposalItemId } from "./collectionCuration.ts";

test("proposal item ids are stable across retries and canonical aliases", () => {
  const a = { name: "L’Eau Électrique", brand: "YSL", notes: [], accords: [] };
  const b = {
    name: "L'Eau Electrique",
    brand: "Yves Saint Laurent",
    notes: [],
    accords: [],
  };
  assert.equal(stableProposalItemId(a), stableProposalItemId(b));
});

test("different fragrance identities receive different retry ids", () => {
  const a = { name: "Scent A", brand: "House", notes: [], accords: [] };
  const b = { name: "Scent B", brand: "House", notes: [], accords: [] };
  assert.notEqual(stableProposalItemId(a), stableProposalItemId(b));
});
