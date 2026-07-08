// CLI entrypoint: apply all pending versioned migrations, then exit.
// Usage: DATABASE_URL=... pnpm --filter @workspace/db run migrate
// This is the ONLY sanctioned way schema changes reach production
// (drizzle-kit push stays local-dev; see the preflight guard).
import { pool } from "./index";
import { resolveMigrationsFolder, runMigrations } from "./migrateCore";

try {
  const folder = resolveMigrationsFolder();
  console.log(`[migrate] applying pending migrations from ${folder}`);
  await runMigrations();
  console.log("[migrate] done");
} finally {
  await pool.end();
}
