// Integration coverage for wardrobe multi-tenant data isolation (production-
// readiness S4). This is the guarantee nothing executed before: host A's user
// must never read host B's wardrobe rows, and a user must never read another
// user's rows on the same tenant. Runs against a real Postgres engine (pglite)
// with the versioned migrations applied — the same (tenant_id, user_id) WHERE
// shape routes/wardrobe.ts uses — so a scoping or schema regression turns red
// in CI instead of in production.
import test from "node:test";
import assert from "node:assert/strict";
import { createTestDb, type Harness } from "./pgliteHarness.ts";

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

// Mirrors the wardrobe add: fragrance_data JSONB keyed by a client-side id.
async function addWardrobeRow(
  h: Harness,
  tenantId: string,
  userId: string,
  clientId: string,
  name: string,
): Promise<void> {
  await h.query(
    `INSERT INTO user_fragrances (tenant_id, user_id, fragrance_data) VALUES ($1, $2, $3)`,
    [tenantId, userId, JSON.stringify({ id: clientId, name })],
  );
}

// Mirrors routes/wardrobe.ts GET: rows scoped by BOTH tenant_id and user_id.
async function listWardrobe(h: Harness, tenantId: string, userId: string) {
  return h.query<{ name: string }>(
    `SELECT fragrance_data->>'name' AS name FROM user_fragrances
       WHERE tenant_id = $1 AND user_id = $2 ORDER BY created_at`,
    [tenantId, userId],
  );
}

test("S4 round-trip: a wardrobe write is read back by the owning (tenant, user) scope", async () => {
  const h = await createTestDb();
  try {
    const tenantId = await insertTenant(h, "t");
    const userId = await insertUser(h, tenantId, "owner@example.com");

    await addWardrobeRow(h, tenantId, userId, "frag-1", "Vetiver Extraordinaire");
    await addWardrobeRow(h, tenantId, userId, "frag-2", "Timbuktu");

    const rows = await listWardrobe(h, tenantId, userId);
    assert.deepEqual(
      rows.map((r) => r.name),
      ["Vetiver Extraordinaire", "Timbuktu"],
      "write → read round-trip persists both rows",
    );
  } finally {
    await h.close();
  }
});

test("S4 user isolation: a user cannot read another user's rows on the same tenant", async () => {
  const h = await createTestDb();
  try {
    const tenantId = await insertTenant(h, "t");
    const alice = await insertUser(h, tenantId, "alice@example.com");
    const bob = await insertUser(h, tenantId, "bob@example.com");

    await addWardrobeRow(h, tenantId, alice, "frag-1", "Private Blend");

    assert.equal((await listWardrobe(h, tenantId, alice)).length, 1);
    assert.equal((await listWardrobe(h, tenantId, bob)).length, 0, "bob sees nothing of alice's");
  } finally {
    await h.close();
  }
});

test("S4 tenant isolation: host A's rows never resolve under host B's tenant scope", async () => {
  const h = await createTestDb();
  try {
    const tA = await insertTenant(h, "host-a");
    const tB = await insertTenant(h, "host-b");
    const userA = await insertUser(h, tA, "user@a.com");

    await addWardrobeRow(h, tA, userA, "frag-1", "Tenant A Exclusive");

    assert.equal((await listWardrobe(h, tA, userA)).length, 1, "visible on its own tenant");
    // The cross-tenant probe uses the SAME user id under the other tenant's
    // scope — exactly what a forged/mis-scoped request would attempt.
    assert.equal(
      (await listWardrobe(h, tB, userA)).length,
      0,
      "invisible under tenant B even with a valid user id",
    );
  } finally {
    await h.close();
  }
});

test("S4/WS-5: re-adding the same client fragrance id is blocked by the DB backstop", async () => {
  const h = await createTestDb();
  try {
    const tenantId = await insertTenant(h, "t");
    const userId = await insertUser(h, tenantId, "dup@example.com");

    await addWardrobeRow(h, tenantId, userId, "frag-1", "Original");
    await assert.rejects(
      () => addWardrobeRow(h, tenantId, userId, "frag-1", "Duplicate"),
      /user_fragrances_user_client_id_unique_idx|duplicate key/,
      "unique (user_id, fragrance_data->>'id') index must reject the duplicate",
    );

    // A DIFFERENT user adding the same client id is fine — the backstop is
    // per-user, not global.
    const other = await insertUser(h, tenantId, "other@example.com");
    await addWardrobeRow(h, tenantId, other, "frag-1", "Their Own Copy");
    assert.equal((await listWardrobe(h, tenantId, other)).length, 1);
  } finally {
    await h.close();
  }
});

test("S4 account deletion: wardrobe rows cascade with the user row", async () => {
  const h = await createTestDb();
  try {
    const tenantId = await insertTenant(h, "t");
    const userId = await insertUser(h, tenantId, "gone@example.com");
    await addWardrobeRow(h, tenantId, userId, "frag-1", "Soon Deleted");

    await h.query(`DELETE FROM users WHERE id = $1`, [userId]);

    const orphans = await h.query(`SELECT 1 FROM user_fragrances WHERE user_id = $1`, [userId]);
    assert.equal(orphans.length, 0, "wardrobe rows must not outlive the account");
  } finally {
    await h.close();
  }
});
