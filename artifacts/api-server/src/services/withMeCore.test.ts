import assert from "node:assert/strict";
import test from "node:test";
import { parseWithMeUpdate, scopeRowsWithMe } from "./withMeCore.ts";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

test("parseWithMeUpdate preserves an explicitly empty active set", () => {
  const parsed = parseWithMeUpdate({ enabled: true, fragranceIds: [], updatedAt: null });
  assert.deepEqual(parsed, {
    ok: true,
    value: { enabled: true, fragranceIds: [], updatedAt: null },
  });
});

test("parseWithMeUpdate de-duplicates ids and clears membership when disabled", () => {
  const parsed = parseWithMeUpdate({ enabled: false, fragranceIds: [A, A], updatedAt: "2026-07-17T12:00:00Z" });
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.deepEqual(parsed.value.fragranceIds, []);
    assert.equal(parsed.value.updatedAt, "2026-07-17T12:00:00.000Z");
  }
});

test("parseWithMeUpdate rejects non-row ids and missing versions", () => {
  assert.equal(parseWithMeUpdate({ enabled: true, fragranceIds: ["mine"], updatedAt: null }).ok, false);
  assert.equal(parseWithMeUpdate({ enabled: true, fragranceIds: [A] }).ok, false);
});

test("scopeRowsWithMe distinguishes full, selected, and active-empty scopes", () => {
  const rows = [{ id: A, name: "A" }, { id: B, name: "B" }];
  assert.equal(scopeRowsWithMe(rows, { enabled: false, fragranceIds: [] }), rows);
  assert.deepEqual(scopeRowsWithMe(rows, { enabled: true, fragranceIds: [B] }), [rows[1]]);
  assert.deepEqual(scopeRowsWithMe(rows, { enabled: true, fragranceIds: [] }), []);
});

