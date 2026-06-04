import assert from "node:assert/strict";
import test from "node:test";
import { deriveAppState, WARDROBE_ONBOARDING_THRESHOLD } from "./appStateCore.ts";

test("new user below the threshold is not completed and not discovery-ready", () => {
  const { state, shouldPersistCompletion } = deriveAppState({
    authenticated: true,
    wardrobeCount: 1,
    onboardingCompletedFlag: false,
  });
  assert.equal(state.wardrobeOnboardingCompleted, false);
  assert.equal(state.discoveryReady, false);
  assert.equal(shouldPersistCompletion, false);
});

test("crossing the threshold marks completion and requests persistence", () => {
  const { state, shouldPersistCompletion } = deriveAppState({
    authenticated: true,
    wardrobeCount: WARDROBE_ONBOARDING_THRESHOLD,
    onboardingCompletedFlag: false,
  });
  assert.equal(state.wardrobeOnboardingCompleted, true);
  assert.equal(state.discoveryReady, true);
  assert.equal(shouldPersistCompletion, true);
});

test("already-completed user with an empty wardrobe stays discovery-ready", () => {
  // This is the core fix: a slow/empty/401 wardrobe load must not drop a
  // completed user back into the add-3 flow.
  const { state, shouldPersistCompletion } = deriveAppState({
    authenticated: true,
    wardrobeCount: 0,
    onboardingCompletedFlag: true,
  });
  assert.equal(state.wardrobeOnboardingCompleted, true);
  assert.equal(state.discoveryReady, true);
  assert.equal(shouldPersistCompletion, false);
});

test("completion is not re-persisted once the flag is already set", () => {
  const { shouldPersistCompletion } = deriveAppState({
    authenticated: true,
    wardrobeCount: 9,
    onboardingCompletedFlag: true,
  });
  assert.equal(shouldPersistCompletion, false);
});

test("non-finite or negative counts are clamped to zero", () => {
  const { state } = deriveAppState({
    authenticated: true,
    wardrobeCount: Number.NaN,
    onboardingCompletedFlag: false,
  });
  assert.equal(state.wardrobeCount, 0);
  assert.equal(state.discoveryReady, false);
});
