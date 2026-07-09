// Integration-test harness (production-readiness F3): a real Postgres engine
// (pglite, in-memory) with this app's versioned migrations applied. Reusable
// seed for query/route integration tests that need genuine SQL semantics —
// unique constraints, tenant scoping, indexed lookups — which pure unit tests
// can't cover. Grows with the WS-C auth work.
//
// It talks raw SQL rather than importing the drizzle schema barrel: that barrel
// re-exports its modules extensionless (`export * from "./tenants"`), which the
// esbuild bundle resolves but `node --test` (ESM, no bundler) does not. Raw SQL
// against the REAL migrated schema is the honest integration surface anyway.
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

// Repo-root-relative: this file is artifacts/api-server/src/test-support/.
// fileURLToPath (not URL.pathname, which yields the unusable `/C:/...` form on
// Windows) so the harness runs on dev machines as well as CI.
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../../../lib/db/migrations", import.meta.url));

export type Harness = {
  client: PGlite;
  query: <T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => Promise<T[]>;
  close: () => Promise<void>;
};

/**
 * Spin up an in-memory Postgres with the full migration journal applied. The
 * baseline needs the pg_trgm extension (catalog-search gin indexes), loaded via
 * the contrib bundle. Always `close()` in a test's finally / after hook.
 */
export async function createTestDb(): Promise<Harness> {
  const client = new PGlite({ extensions: { pg_trgm } });
  // migrate() needs a drizzle instance but no schema — it only replays the SQL
  // files and stamps the __drizzle_migrations journal.
  await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });
  return {
    client,
    query: async (sql, params = []) => (await client.query(sql, params)).rows as never,
    close: () => client.close(),
  };
}
