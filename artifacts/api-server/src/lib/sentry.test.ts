import test from "node:test";
import assert from "node:assert/strict";
import { captureException, flushSentry } from "./sentry.ts";

// initSentry() is intentionally not exercised here: it dynamically imports
// @sentry/node only when SENTRY_DSN is set, and doing that against a live
// (even fake) DSN in a unit test would attempt a real network call. The
// no-op/degrade-gracefully behavior below is what every call site actually
// depends on when Sentry isn't configured — verified end-to-end (module
// resolution, boot without crashing, and a real dynamic import with a DSN
// present) via a live boot smoke instead of here.

test("captureException: no-op before initSentry() has run", () => {
  // Must not throw even with a real-looking Error.
  assert.doesNotThrow(() => captureException(new Error("boom")));
});

test("flushSentry: resolves immediately before initSentry() has run", async () => {
  const before = Date.now();
  await flushSentry(2000);
  assert.ok(Date.now() - before < 100, "should not wait for the flush timeout when unconfigured");
});
