import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const connectionString = process.env.DATABASE_URL ?? process.env.SUPABASE_DATABASE_URL;

if (!connectionString) {
  throw new Error("Set DATABASE_URL or SUPABASE_DATABASE_URL before running this script.");
}

// Clear query parameters like ssl/sslmode to prevent node-postgres from overriding rejectUnauthorized
let cleanConnectionString = connectionString;
try {
  const parsed = new URL(connectionString);
  parsed.searchParams.delete("ssl");
  parsed.searchParams.delete("sslmode");
  parsed.searchParams.delete("sslcert");
  parsed.searchParams.delete("sslkey");
  parsed.searchParams.delete("sslrootcert");
  cleanConnectionString = parsed.toString();
} catch (err) {
  console.warn("Could not parse connection string as URL:", err);
}

const { Client } = pg;

async function run() {
  const client = new Client({
    connectionString: cleanConnectionString,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  console.log("Connected to database.");

  const migrationPath = path.resolve(
    process.cwd(),
    "supabase/migrations/20260522103000_tenant_context_columns.sql",
  );
  console.log("Reading migration file from:", migrationPath);
  const sql = fs.readFileSync(migrationPath, "utf8");

  console.log("Executing migration SQL...");
  await client.query(sql);
  console.log("Migration executed successfully!");

  await client.end();
}

run().catch(console.error);
