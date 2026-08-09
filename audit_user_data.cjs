process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const { Client } = require("./lib/db/node_modules/pg");

const rawUrl = process.env.DATABASE_URL || "postgresql://postgres:DfXNcWkuBRTYtjZYWzTDnGBXqlKQRUKg@viaduct.proxy.rlwy.net:55251/scast_api_restored";

async function main() {
  console.log("Connecting to Railway database (scast_api_restored)...");
  const client = new Client({
    connectionString: rawUrl,
    ssl: { rejectUnauthorized: false }
  });

  try {
    await client.connect();
    console.log("Connected successfully to Railway DB!");

    // 1. Audit users for email dkyleaustin@gmail.com
    console.log("\n--- USERS AUDIT (email: dkyleaustin@gmail.com) ---");
    const usersRes = await client.query(`
      SELECT id, email, created_at, tenant_id, token, oauth_subject 
      FROM users 
      WHERE email ILIKE '%dkyle%' OR email ILIKE '%austin%' OR email ILIKE '%gmail.com%';
    `);
    console.log(`Found ${usersRes.rows.length} users:`);
    console.log(JSON.stringify(usersRes.rows, null, 2));

    const allUsersRes = await client.query(`SELECT id, email, tenant_id, oauth_subject, created_at FROM users;`);
    console.log(`\nALL USERS (${allUsersRes.rows.length}):`);
    console.log(JSON.stringify(allUsersRes.rows, null, 2));

    // 2. Audit user_fragrances table
    console.log("\n--- USER_FRAGRANCES AUDIT ---");
    const fragCountsRes = await client.query(`
      SELECT user_id, tenant_id, count(*) as item_count 
      FROM user_fragrances 
      GROUP BY user_id, tenant_id;
    `);
    console.log("Fragrances count grouped by user_id and tenant_id:");
    console.log(JSON.stringify(fragCountsRes.rows, null, 2));

    // Select all user_fragrances to inspect who owns what
    const allFragsRes = await client.query(`
      SELECT id, user_id, tenant_id, fragrance_data->>'id' as client_id, fragrance_data->>'name' as name, fragrance_data->>'brand' as brand, fragrance_data->>'imageUrl' as image_url, created_at
      FROM user_fragrances;
    `);
    console.log(`\nTOTAL user_fragrances rows: ${allFragsRes.rows.length}`);
    console.log("Sample user_fragrances rows:");
    console.log(JSON.stringify(allFragsRes.rows.slice(0, 10), null, 2));

    // 3. Audit image_cache table
    console.log("\n--- IMAGE_CACHE AUDIT ---");
    const imageCacheCountRes = await client.query(`SELECT count(*) FROM image_cache;`);
    console.log(`Total rows in image_cache: ${imageCacheCountRes.rows[0].count}`);

    const sampleImageCache = await client.query(`
      SELECT id, public_url, storage_path, storage_provider, created_at
      FROM image_cache
      ORDER BY created_at DESC
      LIMIT 10;
    `);
    console.log("Sample image_cache entries:");
    console.log(JSON.stringify(sampleImageCache.rows, null, 2));

    await client.end();
  } catch (err) {
    console.error("DB Connection / Query Error:", err);
  }
}

main();
