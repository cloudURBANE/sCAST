// Pure derivation of a user's app-state from their wardrobe count and the
// persisted onboarding flag. Kept free of DB/Express imports so it can be unit
// tested directly (see appStateCore.test.ts) and reused by the /api/me/app-state
// route without pulling in the data layer.

export const WARDROBE_ONBOARDING_THRESHOLD = 3;

export interface AppStateInput {
  authenticated: boolean;
  wardrobeCount: number;
  /** The durable `user_settings.wardrobe_onboarding_completed` flag. */
  onboardingCompletedFlag: boolean;
}

export interface AppState {
  authenticated: boolean;
  /** Server responses are authoritative, so the client can treat this as loaded. */
  wardrobeLoaded: boolean;
  wardrobeCount: number;
  wardrobeOnboardingCompleted: boolean;
  /** Whether the discover CTA should be unlocked. */
  discoveryReady: boolean;
}

export interface AppStateResult {
  state: AppState;
  /**
   * True when the persisted flag is still false but the live count has crossed
   * the threshold — the caller should write completion = true so the decision
   * survives a later empty/slow wardrobe load.
   */
  shouldPersistCompletion: boolean;
}

function normalizeCount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

export function deriveAppState(input: AppStateInput): AppStateResult {
  const wardrobeCount = normalizeCount(input.wardrobeCount);
  const reachedThreshold = wardrobeCount >= WARDROBE_ONBOARDING_THRESHOLD;
  const wardrobeOnboardingCompleted = input.onboardingCompletedFlag || reachedThreshold;

  return {
    state: {
      authenticated: input.authenticated,
      wardrobeLoaded: true,
      wardrobeCount,
      wardrobeOnboardingCompleted,
      discoveryReady: wardrobeOnboardingCompleted,
    },
    shouldPersistCompletion: !input.onboardingCompletedFlag && reachedThreshold,
  };
}
