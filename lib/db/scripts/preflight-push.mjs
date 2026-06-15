// Preflight guard for `drizzle-kit push`.
//
// WHY: our DATABASE_URL can point at a SHARED Supabase project that also holds
// another app's tables. `tablesFilter` (drizzle.config.ts) stops push from
// dropping FOREIGN tables, but `push` / `push-force --force` can still ALTER,
// DROP or RENAME OUR OWN columns on that shared/prod DB — and `--force` does it
// with no prompt. This gate refuses any push to a NON-LOCAL host unless the
// operator explicitly acknowledges it, so an accidental `pnpm run push` (or an
// auto-run post-merge hook) can never quietly rewrite a production schema.
//
// Override (deliberate prod push):
//   bash/git-bash:  ALLOW_PROD_DB_PUSH=yes pnpm --filter @workspace/db run push
//   PowerShell:     $env:ALLOW_PROD_DB_PUSH='yes'; pnpm --filter @workspace/db run push

const url = process.env.DATABASE_URL;

// No URL: don't block — let drizzle-kit's own config throw its clear
// "DATABASE_URL, ensure the database is provisioned" error.
if (!url) process.exit(0);

let host;
let db;
try {
  const parsed = new URL(url);
  host = parsed.hostname;
  db = parsed.pathname.replace(/^\/+/, "") || "(default)";
} catch {
  process.stderr.write("\n[db push guard] DATABASE_URL is not a valid URL — aborting.\n\n");
  process.exit(1);
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);
const isLocal = LOCAL_HOSTS.has(host) || host.endsWith(".local");
const acked = ["1", "yes", "true"].includes(
  String(process.env.ALLOW_PROD_DB_PUSH ?? "").trim().toLowerCase(),
);

process.stderr.write(`\n[db push guard] target host: ${host}   db: ${db}\n`);

if (isLocal) {
  process.stderr.write("[db push guard] local database — proceeding.\n\n");
  process.exit(0);
}
if (acked) {
  process.stderr.write("[db push guard] non-local push explicitly acknowledged — proceeding.\n\n");
  process.exit(0);
}

process.stderr.write(
  `
REFUSED: '${host}' is not a local database.

This DATABASE_URL may point at the SHARED Supabase project that also holds
another app's tables. 'drizzle-kit push' rewrites schema in place:
  - tablesFilter protects FOREIGN tables (they will NOT be dropped), but
  - push / --force can still ALTER, DROP or RENAME OUR OWN columns on this DB,
    and --force does it with no confirmation prompt.

If you really intend to push to this host, re-run with an explicit ack:

  bash/git-bash:  ALLOW_PROD_DB_PUSH=yes pnpm --filter @workspace/db run push
  PowerShell:     $env:ALLOW_PROD_DB_PUSH='yes'; pnpm --filter @workspace/db run push

`,
);
process.exit(1);
