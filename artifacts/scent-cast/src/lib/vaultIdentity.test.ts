import test from "node:test";
import assert from "node:assert/strict";
import { vaultIdentityKey } from "./vaultIdentity.ts";

test("vault identity canonicalizes aliases, punctuation, and diacritics", () => {
  assert.equal(
    vaultIdentityKey("YSL", "L’Eau Électrique"),
    vaultIdentityKey("Yves Saint Laurent", "L'Eau Electrique"),
  );
});
