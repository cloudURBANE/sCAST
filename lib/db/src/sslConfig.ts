import { readFileSync } from "node:fs";

export type SslResolution = {
  ssl: { rejectUnauthorized: boolean; ca?: string } | undefined;
  /** Human-readable boot warning when the connection is TLS'd but unverified. */
  warning?: string;
};

export type SslEnv = {
  DATABASE_SSL_CA?: string | undefined;
  DATABASE_SSL_REJECT_UNAUTHORIZED?: string | undefined;
};

function parseSslMode(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get("sslmode");
  } catch {
    return null;
  }
}

/**
 * Strip pg's SSL query params from a connection string. node-postgres parses
 * sslmode from connectionString AFTER spreading the config object, which would
 * overwrite an explicit `ssl` override — so when we pass one, the URL must not
 * carry its own SSL directives.
 */
export function stripPgSslParams(url: string): string {
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

/**
 * Resolve the CA material from DATABASE_SSL_CA. Two forms:
 * - inline PEM (contains "-----BEGIN"), with literal \n escapes allowed so the
 *   whole cert fits in a single-line env var (same convention as
 *   FIREBASE_PRIVATE_KEY);
 * - a filesystem path to a .pem file.
 */
function resolveCa(raw: string, readFile: (path: string) => string): string {
  if (raw.includes("-----BEGIN")) {
    return raw.replace(/\\n/g, "\n");
  }
  return readFile(raw);
}

/**
 * Decide the pg `ssl` config for DATABASE_URL. Priority:
 *
 * 1. DATABASE_SSL_CA set → VERIFIED TLS against that CA (production target;
 *    managed providers like Supabase use a project-scoped CA that isn't in the
 *    system trust store — fetch it from the provider dashboard).
 * 2. DATABASE_SSL_REJECT_UNAUTHORIZED=true → verified against the system trust
 *    store (works when the provider chain is publicly rooted).
 * 3. DATABASE_SSL_REJECT_UNAUTHORIZED=false → TLS without verification.
 *    LOCAL-DEV ESCAPE HATCH ONLY: a MITM between the app and the DB is
 *    invisible in this mode.
 * 4. sslmode present in the URL but none of the above → TLS without
 *    verification, WITH a boot warning. This preserves existing deploys while
 *    the CA env rolls out; the warning is the staged nudge before the default
 *    flips to verified.
 * 5. no sslmode / sslmode=disable → plaintext (local dev).
 */
export function resolveSslConfig(
  url: string,
  env: SslEnv,
  readFile: (path: string) => string = (p) => readFileSync(p, "utf8"),
): SslResolution {
  const ca = env.DATABASE_SSL_CA?.trim();
  if (ca) {
    return { ssl: { rejectUnauthorized: true, ca: resolveCa(ca, readFile) } };
  }

  const override = env.DATABASE_SSL_REJECT_UNAUTHORIZED?.trim().toLowerCase();
  if (override === "true") return { ssl: { rejectUnauthorized: true } };
  if (override === "false") return { ssl: { rejectUnauthorized: false } };

  const sslMode = parseSslMode(url)?.toLowerCase();
  if (!sslMode || sslMode === "disable") {
    return { ssl: undefined };
  }

  return {
    ssl: { rejectUnauthorized: false },
    warning:
      "DATABASE_URL requests TLS but no DATABASE_SSL_CA is configured — the connection is " +
      "encrypted but NOT verified (vulnerable to MITM). Set DATABASE_SSL_CA to the provider's " +
      "CA certificate (inline PEM with \\n escapes, or a file path) to verify it.",
  };
}
