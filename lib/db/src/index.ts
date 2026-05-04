import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

function parseSslMode(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get("sslmode");
  } catch {
    return null;
  }
}

function resolveSslConfig(url: string): pg.PoolConfig["ssl"] | undefined {
  const override = process.env.DATABASE_SSL_REJECT_UNAUTHORIZED
    ?.trim()
    .toLowerCase();
  if (override === "true") return { rejectUnauthorized: true };
  if (override === "false") return { rejectUnauthorized: false };

  const sslMode = parseSslMode(url)?.toLowerCase();
  if (!sslMode || sslMode === "disable") {
    return undefined;
  }

  // Most managed Postgres providers expose a public CA chain that may not
  // validate cleanly in all runtimes. Treat sslmode hints as TLS-on with
  // relaxed verification unless explicitly overridden above.
  return { rejectUnauthorized: false };
}

export const pool = new Pool({
  connectionString: databaseUrl,
  ssl: resolveSslConfig(databaseUrl),
});
export const db = drizzle(pool, { schema });

export * from "./schema";
