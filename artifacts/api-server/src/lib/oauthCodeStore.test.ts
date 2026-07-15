import test from "node:test";
import assert from "node:assert/strict";
import {
  mintHandoffCode,
  redeemHandoffCode,
  _resetHandoffStore,
} from "./oauthCodeStore.ts";

// REDIS_URL is unset in the test environment, so these exercise the in-memory
// fallback path — the same store production uses until Redis is provisioned.

test("mint → redeem returns the handoff once (single-use)", async () => {
  _resetHandoffStore();
  const code = await mintHandoffCode({ token: "t-1", email: "a@example.com", pictureUrl: "http://p/x.png" });
  assert.match(code, /^[A-Za-z0-9_-]+$/); // base64url, no URL-unsafe chars
  const first = await redeemHandoffCode(code);
  assert.deepEqual(first, { token: "t-1", email: "a@example.com", pictureUrl: "http://p/x.png" });
  // second redemption fails — the code is consumed
  assert.equal(await redeemHandoffCode(code), null);
});

test("redeem is null for an unknown code", async () => {
  _resetHandoffStore();
  assert.equal(await redeemHandoffCode("never-minted"), null);
});

test("expired code (past 60s TTL) does not redeem", async () => {
  _resetHandoffStore();
  const t0 = 1_000_000;
  const code = await mintHandoffCode({ token: "t-2", email: "b@example.com" }, t0);
  assert.equal(await redeemHandoffCode(code, t0 + 60_001), null);
});

test("code within TTL redeems", async () => {
  _resetHandoffStore();
  const t0 = 2_000_000;
  const code = await mintHandoffCode({ token: "t-3", email: "c@example.com" }, t0);
  assert.deepEqual(await redeemHandoffCode(code, t0 + 59_000), { token: "t-3", email: "c@example.com" });
});

test("mint prunes expired entries so an abandoned login can't accumulate", async () => {
  _resetHandoffStore();
  const t0 = 3_000_000;
  const stale = await mintHandoffCode({ token: "old", email: "old@example.com" }, t0);
  // Minting far in the future prunes the stale entry; redeeming it then fails.
  await mintHandoffCode({ token: "new", email: "new@example.com" }, t0 + 120_000);
  assert.equal(await redeemHandoffCode(stale, t0 + 120_000), null);
});
