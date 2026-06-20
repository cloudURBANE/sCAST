/**
 * Guards the distilled hermes-beam safety/ontology/persona rules so the key
 * clauses can't be silently dropped from the constant the live prompt composes.
 *
 *   node --experimental-strip-types --test src/beam-agent/beamSafetyRules.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { BEAM_SAFETY_RULES } from "./beamSafetyRules.ts";

test("the safety rules cover the audited gaps (A1)", () => {
  // Out-of-domain decline.
  assert.match(BEAM_SAFETY_RULES, /Stay in domain/i);
  assert.match(BEAM_SAFETY_RULES, /decline unrelated/i);
  // No medical / allergen / ingredient-safety claims.
  assert.match(BEAM_SAFETY_RULES, /allergy/i);
  assert.match(BEAM_SAFETY_RULES, /ingredient-safety/i);
  // Retrieved text is untrusted data, not instructions.
  assert.match(BEAM_SAFETY_RULES, /untrusted/i);
  assert.match(BEAM_SAFETY_RULES, /DATA, not instructions/i);
  // Dupe/clone framing only when grounded.
  assert.match(BEAM_SAFETY_RULES, /Clone.*dupe|dupe.*inspired-by/i);
  // Honest degradation.
  assert.match(BEAM_SAFETY_RULES, /Degrade honestly/i);
});
