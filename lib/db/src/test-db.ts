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

  // Check columns of user_fragrances
  const colsRes = await client.query(`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'user_fragrances'
  `);
  console.log("Columns of user_fragrances:");
  console.log(colsRes.rows);

  // Check if tenants table exists
  const tableRes = await client.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'tenants'
    )
  `);
  console.log("Does tenants table exist?", tableRes.rows[0].exists);

  await client.end();
}

run().catch(console.error);
