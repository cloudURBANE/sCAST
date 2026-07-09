// Integration coverage for the bearer-token auth contract (production-readiness
// F3 / S2). Runs against a real Postgres engine (pglite) with the versioned
// migrations applied, so it proves the schema those migrations produce actually
// supports the session lookup — and that tenant scoping isolates rows at the
// SQL level. Uses the REAL migrated schema and the REAL hashToken /
// evaluateTokenExpiry, so a schema or contract regression turns it red.
//
// It replicates getUserByToken's lookup (user_tokens session by hash, then the
// user row by id, tenant-scoped) at the SQL level rather than importing the
// middleware, which is bound to the production `db` singleton; the query shape
// is asserted against the real engine — coverage pure unit tests can't provide.
import test from "node:test";
import assert from "node:assert/strict";
import { hashToken, evaluateTokenExpiry, resolveTokenTtl } from "../lib/tokenAuth.ts";
import { createTestDb, type Harness } from "./pgliteHarness.ts";

const TOKEN_A = "11111111-1111-4111-8111-111111111111";
const TOKEN_B = "22222222-2222-4222-8222-222222222222";

type SessionRow = {
  id: string;
  user_id: string;
  issued_at: Date | null;
  last_used_at: Date | null;
};

async function insertTenant(h: Harness, slug: string): Promise<string> {
  const rows = await h.query<{ id: string }>(
    `INSERT INTO tenants (name, slug) VALUES ($1, $2) RETURNING id`,
    [slug, slug],
  );
  return rows[0]!.id;
}

async function insertUser(h: Harness, tenantId: string, email: string): Promise<string> {
  const rows = await h.query<{ id: string }>(
    `INSERT INTO users (tenant_id, email) VALUES ($1, $2) RETURNING id`,
    [tenantId, email],
  );
  return rows[0]!.id;
}

// Mirrors oauth.ts mintSessionToken: only the SHA-256 hash is ever written.
async function insertSession(
  h: Harness,
  userId: string,
  token: string,
  timestamps?: { issuedAt: Date; lastUsedAt?: Date },
): Promise<void> {
  await h.query(
    `INSERT INTO user_tokens (user_id, token_hash, issued_at, last_used_at)
       VALUES ($1, $2, COALESCE($3, now()), $4)`,
    [userId, hashToken(token), timestamps?.issuedAt ?? null, timestamps?.lastUsedAt ?? null],
  );
}

// Mirrors getUserByToken's two-step lookup: session by hash, user by id + tenant.
async function lookupUserByToken(h: Harness, token: string, tenantId: string) {
  const sessions = await h.query<SessionRow>(
    `SELECT id, user_id, issued_at, last_used_at FROM user_tokens
       WHERE token_hash = $1 LIMIT 1`,
    [hashToken(token)],
  );
  const session = sessions[0];
  if (!session) return null;
  const users = await h.query<{ id: string; email: string }>(
    `SELECT id, email FROM users WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
    [session.user_id, tenantId],
  );
  return users[0] ? { user: users[0], session } : null;
}

test("F3 harness: migrations produce a working users/tenants/user_tokens schema", async () => {
  const h = await createTestDb();
  try {
    const tenantId = await insertTenant(h, "default");
    const userId = await insertUser(h, tenantId, "a@example.com");
    await insertSession(h, userId, TOKEN_A);
    const rows = await h.query<{ token_hash: string }>(
      `SELECT token_hash FROM user_tokens WHERE user_id = $1`,
      [userId],
    );
    assert.equal(rows[0]?.token_hash, hashToken(TOKEN_A));
  } finally {
    await h.close();
  }
});

test("S2: user resolves via user_tokens hash; no plaintext credential is stored", async () => {
  const h = await createTestDb();
  try {
    const tenantId = await insertTenant(h, "t");
    const userId = await insertUser(h, tenantId, "a@example.com");
    await insertSession(h, userId, TOKEN_A);

    assert.equal((await lookupUserByToken(h, TOKEN_A, tenantId))?.user.email, "a@example.com");
    assert.equal(await lookupUserByToken(h, TOKEN_B, tenantId), null, "wrong token → nobody");

    // The credential must not appear anywhere in the sessions table.
    const leak = await h.query(`SELECT 1 FROM user_tokens WHERE token_hash = $1`, [TOKEN_A]);
    assert.equal(leak.length, 0, "plaintext token stored where the hash belongs");
  } finally {
    await h.close();
  }
});

test("tenant isolation: a session minted on tenant A does not resolve under tenant B", async () => {
  const h = await createTestDb();
  try {
    const tA = await insertTenant(h, "a");
    const tB = await insertTenant(h, "b");
    const userId = await insertUser(h, tA, "user@a.com");
    await insertSession(h, userId, TOKEN_A);

    assert.ok(await lookupUserByToken(h, TOKEN_A, tA), "resolves on its own tenant");
    assert.equal(await lookupUserByToken(h, TOKEN_A, tB), null, "isolated from tenant B");
  } finally {
    await h.close();
  }
});

test("S2: multiple concurrent sessions per user, each independently valid", async () => {
  const h = await createTestDb();
  try {
    const tenantId = await insertTenant(h, "t");
    const userId = await insertUser(h, tenantId, "multi@example.com");
    await insertSession(h, userId, TOKEN_A);
    await insertSession(h, userId, TOKEN_B);

    assert.ok(await lookupUserByToken(h, TOKEN_A, tenantId), "device A session valid");
    assert.ok(await lookupUserByToken(h, TOKEN_B, tenantId), "device B session valid");
  } finally {
    await h.close();
  }
});

test("WS-18 logout: deleting a user's sessions invalidates every device", async () => {
  const h = await createTestDb();
  try {
    const tenantId = await insertTenant(h, "t");
    const userId = await insertUser(h, tenantId, "out@example.com");
    await insertSession(h, userId, TOKEN_A);
    await insertSession(h, userId, TOKEN_B);

    await h.query(`DELETE FROM user_tokens WHERE user_id = $1`, [userId]);

    assert.equal(await lookupUserByToken(h, TOKEN_A, tenantId), null);
    assert.equal(await lookupUserByToken(h, TOKEN_B, tenantId), null);
  } finally {
    await h.close();
  }
});

test("account deletion: user_tokens rows cascade with the user row", async () => {
  const h = await createTestDb();
  try {
    const tenantId = await insertTenant(h, "t");
    const userId = await insertUser(h, tenantId, "gone@example.com");
    await insertSession(h, userId, TOKEN_A);

    await h.query(`DELETE FROM users WHERE id = $1`, [userId]);

    const orphans = await h.query(`SELECT 1 FROM user_tokens WHERE user_id = $1`, [userId]);
    assert.equal(orphans.length, 0, "sessions must not outlive the account");
  } finally {
    await h.close();
  }
});

test("C2: an old session is rejected by the expiry check reading the stored timestamps", async () => {
  const h = await createTestDb();
  try {
    const tenantId = await insertTenant(h, "t");
    const userId = await insertUser(h, tenantId, "stale@example.com");
    const longAgo = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000); // 200 days
    await insertSession(h, userId, TOKEN_A, { issuedAt: longAgo, lastUsedAt: longAgo });

    const hit = await lookupUserByToken(h, TOKEN_A, tenantId);
    assert.ok(hit, "row exists");
    const { expired, reason } = evaluateTokenExpiry({
      issuedAt: hit.session.issued_at,
      lastUsedAt: hit.session.last_used_at,
      now: Date.now(),
      ttl: resolveTokenTtl({}), // defaults: 90d absolute / 30d idle
    });
    assert.equal(expired, true);
    assert.ok(reason === "absolute" || reason === "idle");
  } finally {
    await h.close();
  }
});

test("S2 migration 0002: backfill carries a legacy login over and the scrub kills the plaintext", async () => {
  const h = await createTestDb();
  try {
    // The harness applies 0002 to an empty DB, so replay the exact backfill +
    // scrub semantics on a legacy-shaped row to prove the statements do what the
    // rollout needs: session carried over by hash, plaintext no longer live.
    const tenantId = await insertTenant(h, "t");
    const rows = await h.query<{ id: string }>(
      `INSERT INTO users (tenant_id, email, token) VALUES ($1, $2, $3) RETURNING id`,
      [tenantId, "legacy@example.com", TOKEN_A],
    );
    const userId = rows[0]!.id;

    await h.query(
      `INSERT INTO user_tokens (user_id, token_hash, issued_at, last_used_at)
         SELECT id,
                COALESCE(token_hash, encode(sha256(convert_to(token::text, 'UTF8')), 'hex')),
                COALESCE(token_issued_at, now()),
                token_last_used_at
           FROM users
          WHERE token IS NOT NULL
         ON CONFLICT ON CONSTRAINT user_tokens_token_hash_unique DO NOTHING`,
    );
    await h.query(`UPDATE users SET token = gen_random_uuid()`);

    const hit = await lookupUserByToken(h, TOKEN_A, tenantId);
    assert.equal(hit?.user.email, "legacy@example.com", "legacy login survives the cutover");
    assert.ok(hit?.session.issued_at, "issued_at backfilled — S9 expiry coverage");

    const plaintext = await h.query(`SELECT 1 FROM users WHERE token = $1`, [TOKEN_A]);
    assert.equal(plaintext.length, 0, "plaintext token scrubbed from users");
  } finally {
    await h.close();
  }
});
