import dotenv from "dotenv";
import { db } from "./index";
import { userFragrancesTable } from "./schema/userFragrances";

// Load environment variables
dotenv.config({ path: "../../ScentCast.env" });

async function run() {
  console.log("Querying user_fragrances using Drizzle...");
  try {
    const rows = await db.select().from(userFragrancesTable).limit(1);
    console.log("Success! Query returned rows:", rows);
  } catch (err) {
    console.error("Drizzle query failed:", err);
  }
}

run();
