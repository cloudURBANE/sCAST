import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";
import { resolveSslConfig } from "./sslConfig";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
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

// TLS verification policy lives in sslConfig.ts (pure + unit-tested).
// Production target: DATABASE_SSL_CA set → rejectUnauthorized:true against the
// provider CA. TLS-without-CA keeps working but warns at boot.
const { ssl, warning: sslWarning } = resolveSslConfig(databaseUrl, {
  DATABASE_SSL_CA: process.env.DATABASE_SSL_CA,
  DATABASE_SSL_REJECT_UNAUTHORIZED: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED,
});
if (sslWarning) {
  // console (not pino): this package is dependency-light and loads before any
  // app logger exists; the message must reach ops regardless of consumer.
  console.warn(`[db] ${sslWarning}`);
}

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

// node-postgres emits 'error' on the Pool for IDLE clients when the backend
// drops a connection (managed/shared Postgres like the Supabase pooler does
// this routinely on idle timeout, failover, or a network blip). An EventEmitter
// with no 'error' listener rethrows, which surfaces as an uncaughtException and
// crashes the whole process — killing in-flight requests and bypassing graceful
// shutdown. Log and swallow so the pool can self-heal (console, not pino: this
// package loads before any app logger exists — matches the sslWarning above).
pool.on("error", (err) => {
  console.error("[db] idle client error (pool will recover)", err);
});

export const db = drizzle(pool, { schema });

export * from "./schema";
