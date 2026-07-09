// Integration coverage for the bearer-token auth contract (production-readiness
// F3, first WS-C test). Runs against a real Postgres engine (pglite) with the
// versioned migrations applied, so it proves the schema those migrations
// produce actually supports the C1/C2 lookup — and that tenant scoping isolates
// rows at the SQL level. Uses the REAL migrated schema and the REAL hashToken /
// evaluateTokenExpiry, so a schema or contract regression turns it red.
//
// It replicates getUserByToken's lookup (hash-first, plaintext fallback,
// tenant-scoped) at the SQL level rather than importing the middleware, which is
// bound to the production `db` singleton; the query shape is asserted against
// the real engine — the coverage pure unit tests can't provide.
import test from "node:test";
import assert from "node:assert/strict";
import { hashToken, evaluateTokenExpiry, resolveTokenTtl } from "../lib/tokenAuth.ts";
import { createTestDb, type Harness } from "./pgliteHarness.ts";

const TOKEN_A = "11111111-1111-4111-8111-111111111111";
const TOKEN_B = "22222222-2222-4222-8222-222222222222";
const TOKEN_LEGACY = "33333333-3333-4333-8333-333333333333";

type UserRow = {
  email: string;
  token_issued_at: Date | null;
  token_last_used_at: Date | null;
};

async function insertTenant(h: Harness, slug: string): Promise<string> {
  const rows = await h.query<{ id: string }>(
    `INSERT INTO tenants (name, slug) VALUES ($1, $2) RETURNING id`,
    [slug, slug],
  );
  return rows[0]!.id;
}

async function lookupByHashScoped(h: Harness, token: string, tenantId: string) {
  const rows = await h.query<UserRow>(
    `SELECT email, token_issued_at, token_last_used_at FROM users
       WHERE token_hash = $1 AND tenant_id = $2 LIMIT 1`,
    [hashToken(token), tenantId],
  );
  return rows[0] ?? null;
}

test("F3 harness: migrations produce a working users/tenants schema", async () => {
  const h = await createTestDb();
  try {
    const tenantId = await insertTenant(h, "default");
    const rows = await h.query<{ email: string }>(
      `INSERT INTO users (tenant_id, email, token, token_hash, token_issued_at)
         VALUES ($1, $2, $3, $4, now()) RETURNING email`,
      [tenantId, "a@example.com", TOKEN_A, hashToken(TOKEN_A)],
    );
    assert.equal(rows[0]?.email, "a@example.com");
  } finally {
    await h.close();
  }
});

test("C1: user is found by token_hash, never needing the plaintext token", async () => {
  const h = await createTestDb();
  try {
    const tenantId = await insertTenant(h, "t");
    await h.query(
      `INSERT INTO users (tenant_id, email, token, token_hash, token_issued_at)
         VALUES ($1, $2, $3, $4, now())`,
      [tenantId, "a@example.com", TOKEN_A, hashToken(TOKEN_A)],
    );

    assert.equal((await lookupByHashScoped(h, TOKEN_A, tenantId))?.email, "a@example.com");
    assert.equal(await lookupByHashScoped(h, TOKEN_B, tenantId), null, "wrong token hash → nobody");
  } finally {
    await h.close();
  }
});

test("tenant isolation: a token minted on tenant A does not resolve under tenant B", async () => {
  const h = await createTestDb();
  try {
    const tA = await insertTenant(h, "a");
    const tB = await insertTenant(h, "b");
    await h.query(
      `INSERT INTO users (tenant_id, email, token, token_hash, token_issued_at)
         VALUES ($1, $2, $3, $4, now())`,
      [tA, "user@a.com", TOKEN_A, hashToken(TOKEN_A)],
    );

    assert.ok(await lookupByHashScoped(h, TOKEN_A, tA), "resolves on its own tenant");
    assert.equal(await lookupByHashScoped(h, TOKEN_A, tB), null, "isolated from tenant B");
  } finally {
    await h.close();
  }
});

test("C1 fallback: a row with a NULL token_hash is still found by plaintext token", async () => {
  const h = await createTestDb();
  try {
    const tenantId = await insertTenant(h, "t");
    // Simulate a pre-backfill row: hash column not yet stamped.
    await h.query(`INSERT INTO users (tenant_id, email, token) VALUES ($1, $2, $3)`, [
      tenantId,
      "legacy@example.com",
      TOKEN_LEGACY,
    ]);

    assert.equal(await lookupByHashScoped(h, TOKEN_LEGACY, tenantId), null, "not found by hash");
    const byToken = await h.query<UserRow>(
      `SELECT email, token_issued_at, token_last_used_at FROM users
         WHERE token = $1 AND tenant_id = $2 LIMIT 1`,
      [TOKEN_LEGACY, tenantId],
    );
    assert.equal(byToken[0]?.email, "legacy@example.com", "found by plaintext fallback");
  } finally {
    await h.close();
  }
});

test("C2: an old token is rejected by the expiry check reading the stored timestamps", async () => {
  const h = await createTestDb();
  try {
    const tenantId = await insertTenant(h, "t");
    const longAgo = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000); // 200 days
    await h.query(
      `INSERT INTO users (tenant_id, email, token, token_hash, token_issued_at, token_last_used_at)
         VALUES ($1, $2, $3, $4, $5, $5)`,
      [tenantId, "stale@example.com", TOKEN_A, hashToken(TOKEN_A), longAgo],
    );

    const user = await lookupByHashScoped(h, TOKEN_A, tenantId);
    assert.ok(user, "row exists");
    const { expired, reason } = evaluateTokenExpiry({
      issuedAt: user.token_issued_at,
      lastUsedAt: user.token_last_used_at,
      now: Date.now(),
      ttl: resolveTokenTtl({}), // defaults: 90d absolute / 30d idle
    });
    assert.equal(expired, true);
    assert.ok(reason === "absolute" || reason === "idle");
  } finally {
    await h.close();
  }
});
