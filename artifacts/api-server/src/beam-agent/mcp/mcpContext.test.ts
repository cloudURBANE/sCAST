/**
 * Unit tests for MCP scope→tool mapping + context derivation (pure).
 *   node --experimental-strip-types --test src/beam-agent/mcp/mcpContext.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALL_READ_SCOPES,
  allowedToolNames,
  parseBearer,
  deriveRunContext,
} from "./mcpContext.ts";
import type { DelegationClaims } from "./delegationToken.ts";

test("a full owner token unlocks exactly the five read tools", () => {
  const names = allowedToolNames(ALL_READ_SCOPES);
  assert.deepEqual(
    [...names].sort(),
    [
      "beam_get_fragrance_details",
      "beam_get_user_context",
      "beam_get_wardrobe",
      "beam_score_candidates",
      "beam_search_catalog",
    ],
  );
});

test("a narrow token only unlocks its scope's tools", () => {
  const names = allowedToolNames(["beam:wardrobe:read"]);
  assert.deepEqual([...names], ["beam_get_wardrobe"]);
  assert.equal(names.has("beam_search_catalog"), false);
});

test("no scopes unlocks no tools", () => {
  assert.equal(allowedToolNames([]).size, 0);
});

test("parseBearer handles valid, case-insensitive, and invalid headers", () => {
  assert.equal(parseBearer("Bearer abc.def.ghi"), "abc.def.ghi");
  assert.equal(parseBearer("bearer   token123"), "token123");
  assert.equal(parseBearer("Basic abc"), null);
  assert.equal(parseBearer(undefined), null);
  assert.equal(parseBearer("Bearer "), null);
  assert.equal(parseBearer(""), null);
});

test("run context derives tenant/user from claims, never from input", () => {
  const claims: DelegationClaims = {
    iss: "scentbeam-api",
    aud: "beam-tools",
    sub: "user-42",
    tenantId: "tenant-9",
    scope: ALL_READ_SCOPES,
    iat: 1_000,
    exp: 9_999,
    jti: "jti-abc",
    runId: "run-xyz",
  };
  const ctx = deriveRunContext(claims);
  assert.equal(ctx.userId, "user-42");
  assert.equal(ctx.tenantId, "tenant-9");
  assert.equal(ctx.runId, "run-xyz");
  assert.equal(ctx.sessionId, "beam_jti-abc");
});

test("run context generates ids when the token omits them", () => {
  const claims: DelegationClaims = {
    iss: "scentbeam-api",
    aud: "beam-tools",
    sub: "u",
    tenantId: "t",
    scope: [],
    iat: 1,
    exp: 2,
    jti: "",
  };
  const ctx = deriveRunContext(claims);
  assert.match(ctx.runId, /^run_/);
  assert.match(ctx.sessionId, /^beam_/);
});
