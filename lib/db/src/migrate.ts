// Versioned-migration runner (production-readiness E1).
//
// Modes:
//   pnpm --filter @workspace/db run migrate          apply pending migrations
//   pnpm --filter @workspace/db run migrate:stamp    record migrations as applied
//                                                    WITHOUT executing them
//
// Apply is the normal path: runs every journal entry newer than the last row in
// drizzle.__drizzle_migrations (drizzle-orm's own migrator), transactionally.
//
// Stamp exists for exactly one situation: adopting the journal on a database
// that was ALREADY provisioned by the historical push/hand-SQL era
// (supabase/migrations/*.sql + migrations/pre-baseline/). There the baseline's
// plain CREATE TABLE statements would fail against existing tables, so the
// operator verifies the schema matches and stamps instead. Because stamping a
// migration that was NOT actually applied silently corrupts the journal, it is
// double-gated behind ALLOW_MIGRATION_STAMP=yes.
//
// Standalone on purpose: this runs under bare `node --experimental-strip-types`,
// which can't resolve the package's extensionless ESM imports, so it builds its
// own single-connection pool instead of importing the ./index.ts barrel. TLS
// policy is shared with the app via ./sslConfig.ts.
import path from "node:path";
import { sql } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { resolveSslConfig, stripPgSslParams } from "./sslConfig.ts";

const MIGRATIONS_FOLDER = path.resolve(import.meta.dirname, "../migrations");
// drizzle-orm defaults, spelled out so the stamp path and the apply path can
// never drift apart.
const MIGRATIONS_SCHEMA = "drizzle";
const MIGRATIONS_TABLE = "__drizzle_migrations";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("[migrate] DATABASE_URL must be set.");
  process.exit(1);
}

const { ssl, warning: sslWarning } = resolveSslConfig(databaseUrl, {
  DATABASE_SSL_CA: process.env.DATABASE_SSL_CA,
  DATABASE_SSL_REJECT_UNAUTHORIZED: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED,
});
if (sslWarning) console.warn(`[migrate] ${sslWarning}`);

const pool = new pg.Pool({
  connectionString: ssl ? stripPgSslParams(databaseUrl) : databaseUrl,
  ssl,
  max: 1,
});
const db = drizzle(pool);

async function stamp(): Promise<void> {
  if (process.env.ALLOW_MIGRATION_STAMP !== "yes") {
    console.error(
      "[migrate] --stamp records migrations as applied WITHOUT running them.\n" +
        "[migrate] Only for adopting the journal on a database already provisioned\n" +
        "[migrate] by the pre-journal SQL (verify the schema matches first!).\n" +
        "[migrate] Re-run with ALLOW_MIGRATION_STAMP=yes to proceed.",
    );
    process.exitCode = 1;
    return;
  }

  const migrations = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER });

  // Same bookkeeping DDL drizzle-orm's migrator creates, so a stamped database
  // is indistinguishable from an applied one.
  await db.execute(
    sql`CREATE SCHEMA IF NOT EXISTS ${sql.identifier(MIGRATIONS_SCHEMA)}`,
  );
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS ${sql.identifier(MIGRATIONS_SCHEMA)}.${sql.identifier(MIGRATIONS_TABLE)} (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `);

  const rows = await db.execute(
    sql`SELECT created_at FROM ${sql.identifier(MIGRATIONS_SCHEMA)}.${sql.identifier(MIGRATIONS_TABLE)} ORDER BY created_at DESC LIMIT 1`,
  );
  const last = rows.rows[0]?.["created_at"];
  const lastApplied = last == null ? -1 : Number(last);

  let stamped = 0;
  for (const migration of migrations) {
    // Mirror the migrator's own "is this pending?" condition exactly.
    if (migration.folderMillis > lastApplied) {
      await db.execute(
        sql`INSERT INTO ${sql.identifier(MIGRATIONS_SCHEMA)}.${sql.identifier(MIGRATIONS_TABLE)} ("hash", "created_at") VALUES (${migration.hash}, ${migration.folderMillis})`,
      );
      stamped += 1;
    }
  }
  console.log(
    `[migrate] stamped ${stamped} migration(s) as applied (${migrations.length} in journal). No SQL was executed.`,
  );
}

async function apply(): Promise<void> {
  const before = Date.now();
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  console.log(`[migrate] up to date (${Date.now() - before}ms).`);
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode !== undefined && mode !== "--stamp") {
    console.error(`[migrate] unknown argument "${mode}" — expected no argument or --stamp.`);
    process.exitCode = 1;
    return;
  }
  if (mode === "--stamp") {
    await stamp();
  } else {
    await apply();
  }
}

main()
  .catch((error) => {
    console.error("[migrate] failed:", error);
    process.exitCode = 1;
  })
  .finally(() => void pool.end());
