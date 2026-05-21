import test from "node:test";
import assert from "node:assert/strict";
import {
  chooseHydratedImageUrl,
  CURRENT_VAULT_SCHEMA_VERSION,
  isLegacyVaultRow,
  stampVaultSchemaVersion,
} from "./fragrancePayloadCore.ts";

test("isLegacyVaultRow flags rows missing the schema-version stamp", () => {
  assert.equal(isLegacyVaultRow(null), true);
  assert.equal(isLegacyVaultRow(undefined), true);
  assert.equal(isLegacyVaultRow({}), true);
  assert.equal(isLegacyVaultRow({ name: "Sauvage" }), true);
  assert.equal(isLegacyVaultRow({ schemaVersion: "1" as any }), true);
});

test("isLegacyVaultRow flags rows stamped below the current version", () => {
  assert.equal(isLegacyVaultRow({ schemaVersion: 0 }), true);
  assert.equal(isLegacyVaultRow({ schemaVersion: CURRENT_VAULT_SCHEMA_VERSION - 1 }), true);
});

test("isLegacyVaultRow accepts rows at or above the current version", () => {
  assert.equal(isLegacyVaultRow({ schemaVersion: CURRENT_VAULT_SCHEMA_VERSION }), false);
  assert.equal(isLegacyVaultRow({ schemaVersion: CURRENT_VAULT_SCHEMA_VERSION + 1 }), false);
});

test("stampVaultSchemaVersion sets the current version on un-stamped rows", () => {
  const stamped = stampVaultSchemaVersion({ name: "Sauvage", brand: "Dior" });
  assert.equal(stamped.schemaVersion, CURRENT_VAULT_SCHEMA_VERSION);
  assert.equal(stamped.name, "Sauvage");
  assert.equal(stamped.brand, "Dior");
});

test("stampVaultSchemaVersion overrides any prior schema-version value", () => {
  // The write gate owns the value; clients cannot pin themselves to a future
  // version they aren't actually writing in.
  const stamped = stampVaultSchemaVersion({ schemaVersion: 999, name: "X" });
  assert.equal(stamped.schemaVersion, CURRENT_VAULT_SCHEMA_VERSION);
});

test("stampVaultSchemaVersion does not mutate its input", () => {
  const input = { name: "Sauvage" };
  const stamped = stampVaultSchemaVersion(input);
  assert.notEqual(stamped, input);
  assert.equal((input as Record<string, any>).schemaVersion, undefined);
});

test("stampVaultSchemaVersion preserves every other field, including falsy ones", () => {
  const input = {
    id: "f-123",
    name: "Sauvage",
    brand: "Dior",
    notes: ["bergamot", "ambroxan"],
    pyramid: { top: ["bergamot"], heart: [], base: ["ambroxan"] },
    imageUrl: "",
    shareHidden: false,
    season: "Universal",
  };
  const stamped = stampVaultSchemaVersion(input);
  for (const key of Object.keys(input) as (keyof typeof input)[]) {
    assert.deepEqual(stamped[key], input[key]);
  }
});

test("chooseHydratedImageUrl prefers a usable stored row image over a fresh shared image", () => {
  assert.equal(
    chooseHydratedImageUrl(
      "https://cdn.example.com/fresh.webp",
      "https://cdn.example.com/stale.webp",
    ),
    "https://cdn.example.com/stale.webp",
  );
});

test("chooseHydratedImageUrl falls back to the stored row image when shared lookup misses", () => {
  assert.equal(
    chooseHydratedImageUrl(null, "https://cdn.example.com/current.webp"),
    "https://cdn.example.com/current.webp",
  );
});

test("chooseHydratedImageUrl returns empty when neither source has an image", () => {
  assert.equal(chooseHydratedImageUrl("", "   "), "");
});
