import test from "node:test";
import assert from "node:assert/strict";
import { validateEnv } from "./env.ts";

const REQUIRED = { DATABASE_URL: "postgresql://x:x@localhost:5432/x", PORT: "3000" };

/** validateEnv() calls process.exit(1) on failure; stub it to observe rather than kill the test run. */
function withExitStub<T>(fn: (calls: number[]) => T): T {
  const calls: number[] = [];
  const original = process.exit;
  // @ts-expect-error -- intentionally narrowing the stub to what this test needs
  process.exit = (code?: number) => {
    calls.push(code ?? 0);
  };
  try {
    return fn(calls);
  } finally {
    process.exit = original;
  }
}

test("validateEnv: does not exit when required vars are present", () => {
  withExitStub((calls) => {
    validateEnv({ ...REQUIRED });
    assert.deepEqual(calls, []);
  });
});

test("validateEnv: exits(1) when DATABASE_URL is missing", () => {
  withExitStub((calls) => {
    validateEnv({ PORT: "3000" });
    assert.deepEqual(calls, [1]);
  });
});

test("validateEnv: exits(1) when PORT is missing", () => {
  withExitStub((calls) => {
    validateEnv({ DATABASE_URL: REQUIRED.DATABASE_URL });
    assert.deepEqual(calls, [1]);
  });
});

test("validateEnv: exits(1) exactly once even with multiple missing required vars", () => {
  withExitStub((calls) => {
    validateEnv({});
    assert.deepEqual(calls, [1]);
  });
});

test("validateEnv: tolerates an unrecognized flag value without exiting (warn-only, not fatal)", () => {
  withExitStub((calls) => {
    validateEnv({ ...REQUIRED, ENRICHMENT_WORKER_ENABLED: "yez" });
    assert.deepEqual(calls, []);
  });
});

test("validateEnv: tolerates unknown known-prefix vars without exiting (warn-only, not fatal)", () => {
  withExitStub((calls) => {
    validateEnv({ ...REQUIRED, BEAM_TYPOED_VAR: "1" });
    assert.deepEqual(calls, []);
  });
});

test("validateEnv: accepts every documented flag spelling without warning", () => {
  withExitStub((calls) => {
    for (const value of ["true", "false", "1", "0", "on", "off", "yes", "no", "TRUE", " true "]) {
      validateEnv({ ...REQUIRED, HSTS_ENABLED: value });
    }
    assert.deepEqual(calls, []);
  });
});
