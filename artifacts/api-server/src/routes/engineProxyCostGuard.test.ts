import test from "node:test";
import assert from "node:assert/strict";
import type { Response } from "express";
import { createEngineProxyCostGuard, type GuardedRequest } from "./engineProxyCostGuard.ts";

function mockRes() {
  let statusCode = 200;
  let body: unknown;
  const res = {
    setHeader() {
      return res;
    },
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(payload: unknown) {
      body = payload;
      return res;
    },
    send(payload: unknown) {
      body = payload;
      return res;
    },
  } as unknown as Response;
  return { res, getStatus: () => statusCode, getBody: () => body };
}

function runGuard(
  guard: ReturnType<typeof createEngineProxyCostGuard>,
  req: { ip: string; user?: unknown },
) {
  const { res, getStatus, getBody } = mockRes();
  let nextCalled = false;
  guard({ headers: {}, ...req } as GuardedRequest, res, () => {
    nextCalled = true;
  });
  return { nextCalled, status: getStatus(), body: getBody() };
}

test("engine proxy guard: anonymous callers are capped per IP (blocked over the limit)", () => {
  const guard = createEngineProxyCostGuard({
    anonLimit: 2,
    authedLimit: 100,
    windowMs: 60_000,
  });

  assert.equal(runGuard(guard, { ip: "10.0.0.1" }).nextCalled, true); // 1st allowed
  assert.equal(runGuard(guard, { ip: "10.0.0.1" }).nextCalled, true); // 2nd allowed

  const third = runGuard(guard, { ip: "10.0.0.1" }); // 3rd over the anon cap
  assert.equal(third.nextCalled, false, "anonymous request over the cap must not proxy");
  assert.equal(third.status, 429);
});

test("engine proxy guard: authenticated callers bypass the strict anon cap", () => {
  const guard = createEngineProxyCostGuard({
    anonLimit: 1,
    authedLimit: 100,
    windowMs: 60_000,
  });

  // Exhaust the anonymous window for this IP.
  assert.equal(runGuard(guard, { ip: "10.0.0.2" }).nextCalled, true);
  assert.equal(runGuard(guard, { ip: "10.0.0.2" }).status, 429);

  // An authenticated caller from the SAME IP uses the separate generous window.
  const authed = runGuard(guard, { ip: "10.0.0.2", user: { id: "user-1" } });
  assert.equal(authed.nextCalled, true, "authenticated request must not be throttled by the anon cap");
});
