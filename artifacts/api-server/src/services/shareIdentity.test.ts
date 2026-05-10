import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveShareUserFromList,
  shareHandleFromEmail,
  shareIdForUser,
  type ShareIdentityUser,
} from "./shareIdentity.ts";

const USERS: ShareIdentityUser[] = [
  { id: "11111111-1111-4111-8111-111111111111", email: "alex@gmail.com" },
  { id: "22222222-2222-4222-8222-222222222222", email: "alex@yahoo.com" },
  { id: "33333333-3333-4333-8333-333333333333", email: "sam@example.com" },
];

test("email local-parts are normalized into share handles", () => {
  assert.equal(shareHandleFromEmail("The.User+tag@example.com"), "the-user-tag");
  assert.equal(shareHandleFromEmail("@example.com"), "user");
});

test("ambiguous handle refs do not resolve to an arbitrary user", () => {
  assert.equal(resolveShareUserFromList("@alex", USERS), null);
  assert.equal(resolveShareUserFromList("alex", USERS), null);
  assert.equal(resolveShareUserFromList("@sam", USERS)?.id, USERS[2].id);
});

test("uuid refs still resolve exact users when handles collide", () => {
  assert.equal(resolveShareUserFromList(USERS[0].id, USERS)?.email, "alex@gmail.com");
  assert.equal(resolveShareUserFromList(USERS[1].id.toUpperCase(), USERS)?.email, "alex@yahoo.com");
});

test("share ids stay friendly unless the handle collides", () => {
  assert.equal(shareIdForUser(USERS[0], USERS), USERS[0].id);
  assert.equal(shareIdForUser(USERS[1], USERS), USERS[1].id);
  assert.equal(shareIdForUser(USERS[2], USERS), "@sam");
});
