import test from "node:test";
import assert from "node:assert/strict";
import {
  RefreshAttemptCounter,
  REFRESH_AUTO_PAUSE_ATTEMPTS,
  REFRESH_MAX_ATTEMPTS,
  decideRefreshThrottle,
  refreshAttemptKey,
} from "./refreshImageThrottle.ts";

test("decideRefreshThrottle: pauses auto-regeneration after 3 prior attempts without a solver", () => {
  assert.deepEqual(decideRefreshThrottle(0, false), { allowed: true });
  assert.deepEqual(decideRefreshThrottle(REFRESH_AUTO_PAUSE_ATTEMPTS, false), { allowed: true });
  assert.deepEqual(decideRefreshThrottle(REFRESH_AUTO_PAUSE_ATTEMPTS + 1, false), {
    allowed: false,
    reason: "needs-solver",
  });
});

test("decideRefreshThrottle: a chosen solver bypasses the auto-pause but not the absolute ceiling", () => {
  assert.deepEqual(decideRefreshThrottle(REFRESH_AUTO_PAUSE_ATTEMPTS + 1, true), { allowed: true });
  assert.deepEqual(decideRefreshThrottle(REFRESH_MAX_ATTEMPTS, true), { allowed: true });
  assert.deepEqual(decideRefreshThrottle(REFRESH_MAX_ATTEMPTS + 1, true), {
    allowed: false,
    reason: "exhausted",
  });
});

test("RefreshAttemptCounter: count only climbs — a client cannot reset it", () => {
  const counter = new RefreshAttemptCounter();
  const key = refreshAttemptKey("1.2.3.4", "Dior", "Sauvage");

  // Each request increments the SERVER count regardless of any client input.
  // This is the regression guard: the old gate trusted a client `refreshCount`
  // that could be reset to 0; here there is no input that resets the count.
  const counts = [1, 2, 3, 4, 5].map(() => counter.record(key));
  assert.deepEqual(counts, [1, 2, 3, 4, 5]);

  // Simulate a client trying to "reset": there is simply no such API. The very
  // next attempt keeps climbing and, without a solver, is now throttled.
  const priorAttempts = counter.record(key) - 1; // 6th attempt -> prior = 5
  assert.equal(priorAttempts, 5);
  assert.deepEqual(decideRefreshThrottle(priorAttempts, false), {
    allowed: false,
    reason: "needs-solver",
  });
});

test("RefreshAttemptCounter: window expiry starts a fresh count", () => {
  const counter = new RefreshAttemptCounter(1000);
  const key = refreshAttemptKey("9.9.9.9", "Chanel", "Bleu");
  assert.equal(counter.record(key, 0), 1);
  assert.equal(counter.record(key, 500), 2);
  assert.equal(counter.record(key, 1000), 1, "count resets once the window elapses");
});

test("refreshAttemptKey is case- and whitespace-insensitive per fragrance", () => {
  assert.equal(
    refreshAttemptKey("ip", " Dior ", " Sauvage "),
    refreshAttemptKey("ip", "dior", "sauvage"),
  );
});
