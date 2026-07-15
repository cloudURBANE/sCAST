import { defineConfig } from "drizzle-kit";
import { getTableName, is, Table } from "drizzle-orm";
import * as schema from "./src/schema/index";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

// SAFETY: our DATABASE_URL can point at a SHARED Supabase project whose `public`
// schema also holds another app's tables (worker_*, magic_links, mobile_sessions,
// ...). `drizzle-kit push` diffs the WHOLE schema and would propose DROPping any
// table it sees in the DB but not in our schema — and `push-force` (--force)
// would execute those drops with no prompt.
//
// `tablesFilter` scopes drizzle-kit to only the tables WE declare, so foreign
// tables are never introspected and can never be dropped or renamed. The list is
// derived from the runtime schema barrel (src/schema/index.ts) so it stays in
// sync automatically: add a table to the barrel and it's covered; tables not in
// the barrel (foreign apps) are left untouched.
const appTables = Object.values(schema)
  .filter((value): value is Table => is(value, Table))
  .map((table) => getTableName(table));

function parseDatabaseUrl(url: string) {
  const parsed = new URL(url);
  const database = parsed.pathname.replace(/^\/+/, "");
  const sslOverride = process.env.DATABASE_SSL_REJECT_UNAUTHORIZED
    ?.trim()
    .toLowerCase();
  const sslMode = parsed.searchParams.get("sslmode")?.toLowerCase();

  return {
    host: parsed.hostname,
    port: Number(parsed.port || 5432),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database,
    ssl:
      sslOverride === "true"
        ? "verify-full"
        : sslOverride === "false" || (sslMode && sslMode !== "disable")
          ? "require"
          : undefined,
  };
}

export default defineConfig({
  schema: "./src/schema/index.ts",
  dialect: "postgresql",
  // The schema surface is the runtime barrel (index.ts), NOT a glob over the
  // directory. conversations.ts / messages.ts (the beam_conversations /
  // beam_messages transcript store, W-11) are now wired into the barrel and are
  // managed like any other app table.
  // Versioned migrations (drizzle-kit generate → SQL files + meta/_journal.json).
  // Prod applies ONLY these reviewed files (src/migrate.ts); `push` stays a
  // local-dev convenience behind the preflight guard. pre-baseline/ holds the
  // historical hand-applied SQL from the push era — not part of the journal.
  out: "./migrations",
  // Only ever manage our own tables (see SAFETY note above).
  tablesFilter: appTables,
  dbCredentials: parseDatabaseUrl(process.env.DATABASE_URL),
});
