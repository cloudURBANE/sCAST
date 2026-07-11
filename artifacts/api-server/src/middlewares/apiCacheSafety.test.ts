import test from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import { apiCacheSafety } from "./apiCacheSafety.ts";

function mockRes() {
  const headers = new Map<string, string | string[]>();
  let writeHeadCalls = 0;
  const res = {
    getHeader(name: string) {
      return headers.get(name.toLowerCase());
    },
    setHeader(name: string, value: string | string[]) {
      headers.set(name.toLowerCase(), value);
      return res;
    },
    removeHeader(name: string) {
      headers.delete(name.toLowerCase());
    },
    writeHead(..._args: unknown[]) {
      writeHeadCalls += 1;
      return res;
    },
  } as unknown as Response;
  return {
    res,
    header: (name: string) => headers.get(name.toLowerCase()),
    getWriteHeadCalls: () => writeHeadCalls,
  };
}

function runMiddleware(res: Response) {
  let nextCalled = false;
  apiCacheSafety({} as Request, res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
}

test("api cache safety: defaults a bare response to private, no-store", () => {
  const { res, header, getWriteHeadCalls } = mockRes();
  runMiddleware(res);

  res.writeHead(200);

  assert.equal(header("cache-control"), "private, no-store");
  assert.equal(getWriteHeadCalls(), 1, "the original writeHead must still run");
});

test("api cache safety: preserves a route's own Cache-Control", () => {
  const { res, header } = mockRes();
  runMiddleware(res);

  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  res.writeHead(200);

  assert.equal(header("cache-control"), "public, max-age=31536000, immutable");
});

test("api cache safety: a Set-Cookie response is forced private even when cacheable", () => {
  const { res, header } = mockRes();
  runMiddleware(res);

  res.setHeader("Cache-Control", "public, max-age=86400");
  res.setHeader("Set-Cookie", ["oauth_state=abc; HttpOnly"]);
  res.setHeader("CDN-Cache-Control", "max-age=86400");
  res.writeHead(302);

  assert.equal(header("cache-control"), "private, no-store");
  assert.equal(header("cdn-cache-control"), undefined, "CDN override headers must be dropped");
});
