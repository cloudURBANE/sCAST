import test from "node:test";
import assert from "node:assert/strict";
import { validateEnv } from "./env.ts";

const BASE = { DATABASE_URL: "postgresql://u:p@h:5432/db", PORT: "3000" };

test("env: minimal valid env produces no fatal issues", () => {
  const report = validateEnv({ ...BASE });
  assert.deepEqual(report.fatal, []);
});

test("env: missing DATABASE_URL is fatal", () => {
  const report = validateEnv({ PORT: "3000" });
  assert.equal(report.fatal.length, 1);
  assert.match(report.fatal[0] ?? "", /DATABASE_URL/);
});

test("env: non-numeric PORT is fatal", () => {
  const report = validateEnv({ ...BASE, PORT: "eight-thousand" });
  assert.ok(report.fatal.some((m) => m.includes("PORT")));
});

test("env: typo'd boolean flag warns instead of silently meaning off", () => {
  const report = validateEnv({ ...BASE, ENRICHMENT_WORKER_ENABLED: "ture" });
  assert.ok(report.warnings.some((m) => m.includes("ENRICHMENT_WORKER_ENABLED")));
});

test("env: strict-parsed flags reject loose values the call site ignores", () => {
  // RUN_MIGRATIONS_ON_BOOT is compared with === \"true\"; \"yes\" silently means false.
  const report = validateEnv({ ...BASE, RUN_MIGRATIONS_ON_BOOT: "yes" });
  assert.ok(report.warnings.some((m) => m.includes("RUN_MIGRATIONS_ON_BOOT")));
});

test("env: loose-parsed flags accept the values their call sites accept", () => {
  const report = validateEnv({ ...BASE, ENRICHMENT_WORKER_ENABLED: "yes", IMAGE_ALLOW_LOCAL_OBJECT_STORAGE: "1" });
  assert.deepEqual(report.warnings, []);
});

test("env: malformed numbers warn", () => {
  const report = validateEnv({ ...BASE, TOKEN_ABSOLUTE_TTL_DAYS: "90d", OAUTH_RATE_LIMIT: "twenty" });
  assert.equal(report.warnings.filter((m) => m.includes("TOKEN_ABSOLUTE_TTL_DAYS") || m.includes("OAUTH_RATE_LIMIT")).length, 2);
});

test("env: unknown owned-prefix var is flagged as a possible typo", () => {
  const report = validateEnv({ ...BASE, BEAM_AGENT_ENABELD: "true" });
  assert.ok(report.warnings.some((m) => m.includes("BEAM_AGENT_ENABELD")));
});

test("env: foreign vars (PATH, HOME, ...) are never flagged", () => {
  const report = validateEnv({ ...BASE, PATH: "/usr/bin", HOME: "/root", RAILWAY_GIT_COMMIT_SHA: "abc" });
  assert.deepEqual(report.warnings, []);
});

test("env: integration summary reports on/off groups", () => {
  const report = validateEnv({ ...BASE, SERPER_API_KEY: "k", REDIS_URL: "redis://h" });
  assert.ok(report.integrationsOn.includes("serper"));
  assert.ok(report.integrationsOn.includes("redis"));
  assert.ok(report.integrationsOff.includes("sentry"));
});

test("env: malformed URL in integration var warns but is not fatal", () => {
  const report = validateEnv({ ...BASE, SUPABASE_URL: "not-a-url" });
  assert.deepEqual(report.fatal, []);
  assert.ok(report.warnings.some((m) => m.includes("SUPABASE_URL")));
});
