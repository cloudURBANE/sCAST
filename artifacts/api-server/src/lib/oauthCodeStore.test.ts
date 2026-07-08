import test from "node:test";
import assert from "node:assert/strict";
import {
  mintHandoffCode,
  redeemHandoffCode,
  _resetHandoffStore,
} from "./oauthCodeStore.ts";

test("mint → redeem returns the handoff once (single-use)", () => {
  _resetHandoffStore();
  const code = mintHandoffCode({ token: "t-1", email: "a@example.com", pictureUrl: "http://p/x.png" });
  assert.match(code, /^[A-Za-z0-9_-]+$/); // base64url, no URL-unsafe chars
  const first = redeemHandoffCode(code);
  assert.deepEqual(first, { token: "t-1", email: "a@example.com", pictureUrl: "http://p/x.png" });
  // second redemption fails — the code is consumed
  assert.equal(redeemHandoffCode(code), null);
});

test("redeem is null for an unknown code", () => {
  _resetHandoffStore();
  assert.equal(redeemHandoffCode("never-minted"), null);
});

test("expired code (past 60s TTL) does not redeem", () => {
  _resetHandoffStore();
  const t0 = 1_000_000;
  const code = mintHandoffCode({ token: "t-2", email: "b@example.com" }, t0);
  assert.equal(redeemHandoffCode(code, t0 + 60_001), null);
});

test("code within TTL redeems", () => {
  _resetHandoffStore();
  const t0 = 2_000_000;
  const code = mintHandoffCode({ token: "t-3", email: "c@example.com" }, t0);
  assert.deepEqual(redeemHandoffCode(code, t0 + 59_000), { token: "t-3", email: "c@example.com" });
});

test("mint prunes expired entries so an abandoned login can't accumulate", () => {
  _resetHandoffStore();
  const t0 = 3_000_000;
  const stale = mintHandoffCode({ token: "old", email: "old@example.com" }, t0);
  // Minting far in the future prunes the stale entry; redeeming it then fails.
  mintHandoffCode({ token: "new", email: "new@example.com" }, t0 + 120_000);
  assert.equal(redeemHandoffCode(stale, t0 + 120_000), null);
});
