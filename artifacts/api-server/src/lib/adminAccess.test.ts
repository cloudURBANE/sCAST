import test from "node:test";
import assert from "node:assert/strict";
import { isAdminEmail, isAdminUser } from "./adminAccess";

function withAdminEmails<T>(value: string | undefined, fn: () => T): T {
  const saved = process.env.ADMIN_EMAILS;
  if (value === undefined) delete process.env.ADMIN_EMAILS;
  else process.env.ADMIN_EMAILS = value;
  try {
    return fn();
  } finally {
    if (saved !== undefined) process.env.ADMIN_EMAILS = saved;
    else delete process.env.ADMIN_EMAILS;
  }
}

test("isAdminEmail: no allowlist means no admins", () => {
  withAdminEmails(undefined, () => {
    assert.equal(isAdminEmail("anyone@example.com"), false);
  });
  withAdminEmails("", () => {
    assert.equal(isAdminEmail("anyone@example.com"), false);
  });
});

test("isAdminEmail: matches case-insensitively and trims", () => {
  withAdminEmails("Admin@Example.com, second@example.com", () => {
    assert.equal(isAdminEmail("admin@example.com"), true);
    assert.equal(isAdminEmail("  ADMIN@EXAMPLE.COM  "), true);
    assert.equal(isAdminEmail("second@example.com"), true);
    assert.equal(isAdminEmail("nope@example.com"), false);
  });
});

test("isAdminEmail: accepts whitespace/newline separated lists", () => {
  withAdminEmails("a@example.com\n b@example.com\tc@example.com", () => {
    assert.equal(isAdminEmail("a@example.com"), true);
    assert.equal(isAdminEmail("b@example.com"), true);
    assert.equal(isAdminEmail("c@example.com"), true);
  });
});

test("isAdminEmail: null/empty email is never admin", () => {
  withAdminEmails("admin@example.com", () => {
    assert.equal(isAdminEmail(null), false);
    assert.equal(isAdminEmail(undefined), false);
    assert.equal(isAdminEmail(""), false);
  });
});

test("isAdminUser: reads the user's email", () => {
  withAdminEmails("admin@example.com", () => {
    assert.equal(isAdminUser({ email: "admin@example.com" }), true);
    assert.equal(isAdminUser({ email: "user@example.com" }), false);
    assert.equal(isAdminUser(null), false);
    assert.equal(isAdminUser({}), false);
  });
});
