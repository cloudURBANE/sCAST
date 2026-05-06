import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?\n" +
      "On Railway: add a Postgres service and reference its DATABASE_URL variable.",
  );
}

// Validate that DATABASE_URL is a parseable PostgreSQL connection string before
// handing it to pg. pg-connection-string throws a bare "TypeError: Invalid URL"
// that is hard to diagnose; this check surfaces a clear message instead.
function validateDatabaseUrl(url: string): void {
  const trimmed = url.trim();
  if (!trimmed.startsWith("postgresql://") && !trimmed.startsWith("postgres://")) {
    throw new Error(
      `DATABASE_URL must begin with "postgresql://" or "postgres://". ` +
        `Got: "${trimmed.slice(0, 40)}${trimmed.length > 40 ? "…" : ""}"\n` +
        "On Railway: reference the Postgres service variable — e.g. ${{Postgres.DATABASE_URL}}",
    );
  }
  try {
    new URL(trimmed);
  } catch {
    throw new Error(
      `DATABASE_URL is not a valid URL: "${trimmed.slice(0, 80)}${trimmed.length > 80 ? "…" : ""}"\n` +
        "On Railway: reference the Postgres service variable — e.g. ${{Postgres.DATABASE_URL}}",
    );
  }
}

validateDatabaseUrl(databaseUrl);

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
