import test from "node:test";
import assert from "node:assert/strict";
import type { NextFunction, Request, Response } from "express";
import { requireAdminSecret } from "./adminSecret.ts";

function mockRes() {
  let statusCode = 200;
  let body: unknown;
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(payload: unknown) {
      body = payload;
      return res;
    },
  } as unknown as Response;
  return {
    res,
    getStatus: () => statusCode,
    getBody: () => body,
  };
}

function runMiddleware(
  headers: Record<string, string | undefined>,
  next: NextFunction = () => {},
) {
  const { res, getStatus, getBody } = mockRes();
  const req = { headers } as Request;
  requireAdminSecret(req, res, next);
  return { getStatus, getBody };
}

test("requireAdminSecret rejects when ADMIN_SECRET unset", () => {
  const saved = process.env.ADMIN_SECRET;
  delete process.env.ADMIN_SECRET;
  try {
    const { getStatus, getBody } = runMiddleware({ "x-admin-secret": "secret" });
    // WS-18: a missing ADMIN_SECRET is a server misconfiguration (503), distinct
    // from a wrong/missing caller secret (401).
    assert.equal(getStatus(), 503);
    assert.deepEqual(getBody(), { error: "Admin endpoints are not configured" });
  } finally {
    if (saved !== undefined) process.env.ADMIN_SECRET = saved;
    else delete process.env.ADMIN_SECRET;
  }
});

test("requireAdminSecret rejects missing or wrong header", () => {
  const saved = process.env.ADMIN_SECRET;
  process.env.ADMIN_SECRET = "correct-secret";
  try {
    assert.equal(runMiddleware({}).getStatus(), 401);
    assert.equal(runMiddleware({ "x-admin-secret": "wrong" }).getStatus(), 401);
  } finally {
    if (saved !== undefined) process.env.ADMIN_SECRET = saved;
    else delete process.env.ADMIN_SECRET;
  }
});

test("requireAdminSecret calls next when secret matches", () => {
  const saved = process.env.ADMIN_SECRET;
  process.env.ADMIN_SECRET = "correct-secret";
  try {
    let nextCalled = false;
    const { getStatus } = runMiddleware(
      { "x-admin-secret": "correct-secret" },
      () => {
        nextCalled = true;
      },
    );
    assert.equal(getStatus(), 200);
    assert.equal(nextCalled, true);
  } finally {
    if (saved !== undefined) process.env.ADMIN_SECRET = saved;
    else delete process.env.ADMIN_SECRET;
  }
});
