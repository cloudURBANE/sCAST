import { migrate } from "drizzle-orm/node-postgres/migrator";
import path from "node:path";
import { existsSync } from "node:fs";
import { db } from "./index";

/**
 * Resolve the migrations folder. The api-server bundle (esbuild) relocates
 * import.meta.url into dist/, so a source-relative path only works for
 * unbundled consumers — check the explicit env override first, then the
 * monorepo-root cwd layout (Docker/Railway run from the repo root), then the
 * source-relative path (tsx / node --experimental-strip-types).
 */
export function resolveMigrationsFolder(): string {
  const candidates = [
    process.env.MIGRATIONS_DIR,
    path.resolve(process.cwd(), "lib/db/migrations"),
    new URL("../migrations", import.meta.url).pathname,
  ].filter((p): p is string => Boolean(p));

  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, "meta", "_journal.json"))) return candidate;
  }
  throw new Error(
    `Could not locate the drizzle migrations folder (looked in: ${candidates.join(", ")}). ` +
      "Set MIGRATIONS_DIR to the directory containing meta/_journal.json.",
  );
}

/**
 * Apply all pending versioned migrations. Records progress in
 * drizzle.__drizzle_migrations and takes the migrator's advisory lock, so a
 * concurrent second migrator waits rather than double-applying.
 */
export async function runMigrations(): Promise<void> {
  await migrate(db, { migrationsFolder: resolveMigrationsFolder() });
}
