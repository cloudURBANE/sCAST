import assert from "node:assert/strict";
import test from "node:test";

import { evaluateReadiness } from "./check-readiness.mjs";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

test("accepts the API readiness contract", async () => {
  const result = await evaluateReadiness(
    "api",
    "https://api.scentbeam.com/api/readyz",
    jsonResponse({ status: "ready", checks: { db: "ok", redis: "ok" } }),
  );
  assert.equal(result.ok, true);
});

test("accepts the engine readiness contract", async () => {
  const result = await evaluateReadiness(
    "engine",
    "https://srt-scent-engine-production.up.railway.app/readyz",
    jsonResponse({ ok: true, db: "ok" }),
  );
  assert.equal(result.ok, true);
});

test("rejects an unhealthy dependency even when HTTP is 200", async () => {
  const result = await evaluateReadiness(
    "api",
    "https://api.scentbeam.com/api/readyz",
    jsonResponse({ status: "ready", checks: { db: "ok", redis: "error" } }),
  );
  assert.equal(result.ok, false);
  assert.match(result.summary, /expected contract/i);
});

test("rejects a non-200 response before parsing its body", async () => {
  const result = await evaluateReadiness(
    "engine",
    "https://srt-scent-engine-production.up.railway.app/readyz",
    jsonResponse({ ok: true, db: "ok" }, 503),
  );
  assert.equal(result.ok, false);
  assert.match(result.summary, /HTTP 503/);
});

test("rejects non-JSON content", async () => {
  const result = await evaluateReadiness(
    "api",
    "https://api.scentbeam.com/api/readyz",
    new Response("ready", { status: 200, headers: { "content-type": "text/plain" } }),
  );
  assert.equal(result.ok, false);
  assert.match(result.summary, /application\/json/i);
});
