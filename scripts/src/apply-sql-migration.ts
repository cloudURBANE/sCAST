import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Load env from the monorepo root .env BEFORE importing @workspace/db (its module
// init throws if DATABASE_URL is unset).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

// Dynamic import AFTER dotenv: @workspace/db reads DATABASE_URL at module-init,
// and static ESM imports are hoisted above dotenv.config() — so import it lazily.
const { pool } = await import("@workspace/db");

/*
 * Apply a single SQL migration file through the shared pg pool.
 *
 *   corepack pnpm --filter @workspace/scripts exec tsx ./src/apply-sql-migration.ts <file.sql>
 *
 * Defaults to the image_cache orientation-columns migration. The migration itself
 * must be idempotent (IF NOT EXISTS) — this runner adds a guard that the target
 * table exists and prints the resulting columns so the change is auditable.
 */

const DEFAULT_MIGRATION = "supabase/migrations/20260616015900_image_cache_orientation_columns.sql";

async function main() {
  const arg = process.argv.find((a) => a.endsWith(".sql"));
  const relPath = arg ?? DEFAULT_MIGRATION;
  // Anchor to the repo root (../../ from scripts/src) so it works regardless of
  // the cwd pnpm exec picks.
  const repoRoot = path.resolve(__dirname, "../../");
  const fullPath = path.isAbsolute(relPath) ? relPath : path.resolve(repoRoot, relPath);
  const sql = fs.readFileSync(fullPath, "utf8");

  // Mask credentials when echoing the target.
  const target = (process.env.DATABASE_URL ?? "").replace(/(:\/\/[^:]+:)[^@]+@/, "$1****@");
  console.log(`[migrate] target: ${target}`);
  console.log(`[migrate] file:   ${relPath}`);

  const client = await pool.connect();
  try {
    const guard = await client.query("SELECT to_regclass('public.image_cache') AS t");
    if (!guard.rows[0]?.t) {
      throw new Error("image_cache table not found on this database — aborting (wrong DATABASE_URL?).");
    }

    await client.query("BEGIN");
    await client.query(sql);
    await client.query("COMMIT");
    console.log("[migrate] applied successfully.");

    const cols = await client.query(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'image_cache'
          AND column_name IN ('original_width','original_height','bounding_box',
                              'aspect_ratio','orientation_version','baseline_alignment')
        ORDER BY column_name`,
    );
    console.log("[migrate] orientation columns now present:");
    for (const r of cols.rows) {
      console.log(`  - ${r.column_name} ${r.data_type} (nullable=${r.is_nullable})`);
    }
    if (cols.rows.length !== 6) {
      throw new Error(`expected 6 orientation columns, found ${cols.rows.length}`);
    }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

main()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error("[migrate] FAILED:", err instanceof Error ? err.message : err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
