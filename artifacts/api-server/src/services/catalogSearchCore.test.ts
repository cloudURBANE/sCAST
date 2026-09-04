import test from "node:test";
import assert from "node:assert/strict";
import { escapeSqlLike } from "./catalogSearchCore.ts";

test("escapeSqlLike: correctly escapes %, _, and \\", () => {
  assert.equal(escapeSqlLike("100%"), "100\\%");
  assert.equal(escapeSqlLike("under_score"), "under\\_score");
  assert.equal(escapeSqlLike("back\\slash"), "back\\\\slash");
  assert.equal(escapeSqlLike("Sauvage \\ %%% _"), "Sauvage \\\\ \\%\\%\\% \\_");
});

test("escapeSqlLike: leaves safe query text unchanged", () => {
  assert.equal(escapeSqlLike("Dior Sauvage"), "Dior Sauvage");
  assert.equal(escapeSqlLike("Chanel Bleu De Chanel EDP"), "Chanel Bleu De Chanel EDP");
  assert.equal(escapeSqlLike(""), "");
});
