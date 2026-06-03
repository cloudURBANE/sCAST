import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

import { db } from "@workspace/db";
import { usersTable, userFragrancesTable } from "@workspace/db/schema";
import { sql } from "drizzle-orm";

function maskHost(url: string | undefined): string {
  if (!url) return "(unset)";
  try {
    const u = new URL(url);
    return `${u.hostname} db=${u.pathname.replace("/", "")}`;
  } catch {
    return "(unparseable)";
  }
}

async function main() {
  console.log("DB target:", maskHost(process.env.DATABASE_URL));
  console.log("");

  const users = await db
    .select({
      id: usersTable.id,
      email: usersTable.email,
      oauthSubject: usersTable.oauthSubject,
      createdAt: usersTable.createdAt,
    })
    .from(usersTable);

  const maskEmail = (e: string | null) => {
    if (!e) return "(none)";
    const [name, domain] = e.split("@");
    return `${name.slice(0, 2)}***@${domain ?? "?"}`;
  };

  console.log(`users (${users.length}):  [tokens intentionally NOT selected]`);
  for (const u of users) {
    console.log(
      `  id=${u.id}  email=${maskEmail(u.email)}  oauth=${u.oauthSubject ? "linked" : "none"}  created=${u.createdAt?.toISOString?.() ?? u.createdAt}`,
    );
  }
  console.log("");

  // fragrance counts grouped by the user_id they're attached to
  const counts = await db
    .select({
      userId: userFragrancesTable.userId,
      n: sql<number>`count(*)`,
    })
    .from(userFragrancesTable)
    .groupBy(userFragrancesTable.userId);

  const userIds = new Set(users.map((u) => u.id));
  console.log(`user_fragrances grouped by user_id (${counts.length} distinct owners):`);
  for (const c of counts) {
    const orphan = userIds.has(c.userId as string) ? "" : "   <-- ORPHAN (no matching users.id)";
    const owner = users.find((u) => u.id === c.userId);
    console.log(`  user_id=${c.userId}  count=${c.n}  ${owner ? `(${maskEmail(owner.email)})` : ""}${orphan}`);
  }
  console.log("");

  const totalFrag = counts.reduce((a, c) => a + Number(c.n), 0);
  const orphanFrag = counts
    .filter((c) => !userIds.has(c.userId as string))
    .reduce((a, c) => a + Number(c.n), 0);
  console.log(`TOTAL fragrances=${totalFrag}, orphaned=${orphanFrag}`);

  process.exit(0);
}

main().catch((e) => {
  console.error("DIAG ERROR:", e?.message || e);
  process.exit(1);
});
