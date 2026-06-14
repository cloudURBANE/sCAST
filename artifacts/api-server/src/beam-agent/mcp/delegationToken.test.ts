/**
 * Unit tests for the agent delegation token (pure; Node built-in runner).
 *   node --experimental-strip-types --test src/beam-agent/mcp/delegationToken.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  signDelegationToken,
  verifyDelegationToken,
  BEAM_TOKEN_ISS,
  BEAM_TOKEN_AUD,
} from "./delegationToken.ts";

const SECRET = "test-secret-please-rotate";

test("sign → verify round-trips and preserves claims", () => {
  const token = signDelegationToken(
    { userId: "u1", tenantId: "t1", scope: ["beam:wardrobe:read"], nowSeconds: 1_000 },
    SECRET,
  );
  const result = verifyDelegationToken(token, SECRET, { nowSeconds: 1_010 });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.claims.sub, "u1");
    assert.equal(result.claims.tenantId, "t1");
    assert.equal(result.claims.iss, BEAM_TOKEN_ISS);
    assert.equal(result.claims.aud, BEAM_TOKEN_AUD);
    assert.deepEqual(result.claims.scope, ["beam:wardrobe:read"]);
    assert.ok(result.claims.jti.length > 0);
  }
});

test("rejects a tampered payload", () => {
  const token = signDelegationToken(
    { userId: "u1", tenantId: "t1", scope: ["beam:wardrobe:read"], nowSeconds: 1_000 },
    SECRET,
  );
  const [h, p, s] = token.split(".");
  // Flip a byte in the payload but keep the original signature.
  const forgedPayload = Buffer.from(
    JSON.stringify({
      iss: BEAM_TOKEN_ISS,
      aud: BEAM_TOKEN_AUD,
      sub: "attacker",
      tenantId: "t1",
      scope: ["beam:wardrobe:read"],
      iat: 1_000,
      exp: 9_999_999_999,
      jti: "x",
    }),
  ).toString("base64url");
  void p;
  const forged = `${h}.${forgedPayload}.${s}`;
  const result = verifyDelegationToken(forged, SECRET, { nowSeconds: 1_010 });
  assert.equal(result.ok, false);
});

test("rejects a token signed with a different secret", () => {
  const token = signDelegationToken(
    { userId: "u1", tenantId: "t1", scope: ["beam:catalog:read"], nowSeconds: 1_000 },
    "other-secret",
  );
  const result = verifyDelegationToken(token, SECRET, { nowSeconds: 1_010 });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, "bad signature");
});

test("rejects an expired token (beyond leeway)", () => {
  const token = signDelegationToken(
    { userId: "u1", tenantId: "t1", scope: ["beam:score:read"], ttlSeconds: 60, nowSeconds: 1_000 },
    SECRET,
  );
  const result = verifyDelegationToken(token, SECRET, { nowSeconds: 1_200, leewaySeconds: 30 });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, "expired");
});

test("rejects malformed tokens and empty secrets", () => {
  assert.equal(verifyDelegationToken("not-a-token", SECRET).ok, false);
  assert.equal(verifyDelegationToken("a.b.c.d", SECRET).ok, false);
  assert.equal(verifyDelegationToken("", SECRET).ok, false);
  const good = signDelegationToken(
    { userId: "u1", tenantId: "t1", scope: [], nowSeconds: 1_000 },
    SECRET,
  );
  assert.equal(verifyDelegationToken(good, "").ok, false);
});

test("signing requires a secret and identity", () => {
  assert.throws(() => signDelegationToken({ userId: "u1", tenantId: "t1", scope: [] }, ""));
  assert.throws(() => signDelegationToken({ userId: "", tenantId: "t1", scope: [] }, SECRET));
});
