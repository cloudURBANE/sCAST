import test from "node:test";
import assert from "node:assert/strict";
import { parseAllowedOrigins } from "./corsOrigins.ts";

test("corsOrigins: unset env disables cross-origin access entirely", () => {
  assert.equal(parseAllowedOrigins(undefined), false);
});

test("corsOrigins: empty string disables cross-origin access entirely", () => {
  assert.equal(parseAllowedOrigins(""), false);
  assert.equal(parseAllowedOrigins("  ,  ,"), false);
});

test("corsOrigins: comma-separated origins are trimmed and preserved", () => {
  assert.deepEqual(
    parseAllowedOrigins(" https://app.example.com , http://localhost:5173 "),
    ["https://app.example.com", "http://localhost:5173"],
  );
});

test("corsOrigins: single origin works", () => {
  assert.deepEqual(parseAllowedOrigins("https://scentbeam.app"), ["https://scentbeam.app"]);
});
