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
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

// fileURLToPath (not URL.pathname, which yields the unusable `/C:/...` form on
// Windows) so the suite runs on dev machines as well as CI.
const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

async function tableColumns(client: PGlite, table: string): Promise<string[]> {
  const res = await client.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  return res.rows.map((r) => r.column_name);
}

async function tableIndexes(client: PGlite, table: string): Promise<string[]> {
  const res = await client.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1`,
    [table],
  );
  return res.rows.map((r) => r.indexname);
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

test("migrations: repairs the legacy image-cache index before provider-scoped upserts", async () => {
  const client = new PGlite({ extensions: { pg_trgm } });
  try {
    // Recreate the affected production shape: full push-era schema, but only the
    // obsolete global image-cache uniqueness rule and no migration journal.
    for (const stmt of baselineStatements()) {
      await client.exec(stmt);
    }
    await client.exec(`
      DROP INDEX IF EXISTS image_cache_source_pipeline_bg_serper_unique_idx;
      DROP INDEX IF EXISTS image_cache_source_pipeline_bg_nonserper_unique_idx;
      CREATE UNIQUE INDEX image_cache_source_pipeline_bg_unique_idx
        ON image_cache (source_url_hash, pipeline_version, background_removed);
    `);

    await migrate(drizzle(client), { migrationsFolder });

    const indexes = await tableIndexes(client, "image_cache");
    assert.ok(indexes.includes("image_cache_source_pipeline_bg_serper_unique_idx"));
    assert.ok(indexes.includes("image_cache_source_pipeline_bg_nonserper_unique_idx"));
    assert.ok(!indexes.includes("image_cache_source_pipeline_bg_unique_idx"));

    // The repaired Serper index must allow the same source bytes to be scoped to
    // two fragrances. The obsolete index rejects the second row here.
    await client.exec(`
      INSERT INTO image_cache (
        lookup_key, source_provider, source_url, source_url_hash,
        pipeline_version, storage_provider, storage_path, background_removed
      ) VALUES
        ('dior:sauvage', 'serper', 'https://cdn.example.test/shared.webp', 'same-hash',
         'v-test', 'supabase', 'images/processed/serper/dior/a.webp', true),
        ('chanel:bleu', 'serper', 'https://cdn.example.test/shared.webp', 'same-hash',
         'v-test', 'supabase', 'images/processed/serper/chanel/b.webp', true);
    `);
    const rows = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM image_cache WHERE source_url_hash = 'same-hash'`,
    );
    assert.equal(rows.rows[0]?.count, 2);
  } finally {
    await client.close();
  }
});
