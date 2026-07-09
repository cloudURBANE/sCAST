// Migration-suite verification against a real Postgres engine (pglite, in-memory).
// Two scenarios matter:
//   1. FRESH database — the journal applies 0000_baseline + everything after it
//      and the runtime schema surface exists.
//   2. PROD-SHAPED database — objects already exist (created in the push era)
//      but the drizzle journal is empty. The baseline must CONVERGE (all
//      statements are IF NOT EXISTS / duplicate_object-guarded), not fail.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

const migrationsFolder = new URL("../migrations", import.meta.url).pathname;

async function tableColumns(client: PGlite, table: string): Promise<string[]> {
  const res = await client.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  return res.rows.map((r) => r.column_name);
}

function baselineStatements(): string[] {
  const file = readdirSync(migrationsFolder).find((f) => f.startsWith("0000_"));
  assert.ok(file, "baseline migration exists");
  return readFileSync(path.join(migrationsFolder, file), "utf8")
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean);
}

test("migrations: fresh database gets the full runtime schema", async () => {
  const client = new PGlite({ extensions: { pg_trgm } });
  try {
    await migrate(drizzle(client), { migrationsFolder });

    const users = await tableColumns(client, "users");
    for (const col of ["id", "email", "token", "token_hash", "token_issued_at", "token_last_used_at"]) {
      assert.ok(users.includes(col), `users.${col} exists`);
    }
    // Spot-check breadth: a few tables from different corners of the schema.
    for (const table of ["tenants", "user_fragrances", "global_fragrances", "image_cache", "enrichment_jobs"]) {
      const cols = await tableColumns(client, table);
      assert.ok(cols.length > 0, `${table} exists`);
    }

    // Re-running is a no-op (journal-driven).
    await migrate(drizzle(client), { migrationsFolder });
  } finally {
    await client.close();
  }
});

test("migrations: baseline converges on an already-provisioned (push-era) database", async () => {
  const client = new PGlite({ extensions: { pg_trgm } });
  try {
    // Simulate production: objects exist, journal does not.
    for (const stmt of baselineStatements()) {
      await client.exec(stmt);
    }
    // Now the migrator applies the baseline over the existing objects — every
    // statement must be a no-op, not an error — plus everything after it.
    await migrate(drizzle(client), { migrationsFolder });

    const users = await tableColumns(client, "users");
    assert.ok(users.includes("token_hash"), "post-baseline migration applied on top");
  } finally {
    await client.close();
  }
});
