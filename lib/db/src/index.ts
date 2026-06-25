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

function stripPgSslParams(url: string): string {
  try {
    const parsed = new URL(url);
    for (const key of ["ssl", "sslmode", "sslcert", "sslkey", "sslrootcert"]) {
      parsed.searchParams.delete(key);
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

const ssl = resolveSslConfig(databaseUrl);

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export const pool = new Pool({
  // node-postgres parses sslmode from connectionString after spreading config,
  // which can overwrite our explicit rejectUnauthorized override.
  connectionString: ssl ? stripPgSslParams(databaseUrl) : databaseUrl,
  ssl,
  // Bound the pool so a burst of requests can't open unbounded connections
  // against a shared/managed Postgres (Supabase) and exhaust its limit.
  max: parsePositiveInt(process.env.DATABASE_POOL_MAX, 10),
  // Fail fast instead of hanging a request forever when no connection is
  // available, and release idle sockets so the pool doesn't pin connections.
  connectionTimeoutMillis: parsePositiveInt(process.env.DATABASE_CONNECTION_TIMEOUT_MS, 10_000),
  idleTimeoutMillis: parsePositiveInt(process.env.DATABASE_IDLE_TIMEOUT_MS, 30_000),
});
export const db = drizzle(pool, { schema });

export * from "./schema";
