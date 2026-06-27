/**
 * Dead-image-reference repair (DB layer).
 *
 * Clears provably-dead persisted image references from the two JSONB stores so
 * the live backfill (`imageUrl IS NULL` guard) and the read-path
 * `resolveSharedImageReference` substitution can re-engage and a fresh URL gets
 * written on the next resolution. See imageRepairCore for the deadness contract.
 *
 * The SQL predicate below is the parameterized mirror of
 * `extractPersistedImageUrl` + `isDeadPersistedImageUrl`; the key-stripping
 * mirror of `clearImageRefKeys`. Keep them in lockstep.
 *
 * Best-effort and reversible-in-effect: clearing a reference only causes the row
 * to be re-resolved on next view; it never deletes a stored object.
 */
import { db } from "@workspace/db";
import { globalFragrancesTable, userFragrancesTable } from "@workspace/db/schema";
import { sql, type SQL } from "drizzle-orm";
import { IMAGE_REF_KEYS, type ImageRepairPolicy } from "./imageRepairCore";

export type ImageRepairTableResult = {
  table: "user_fragrances" | "global_fragrances";
  /** Rows whose persisted image URL is dead under the policy. */
  matched: number;
  /** Rows actually cleared (0 in dry-run, or when nothing matched). */
  cleared: number;
};

/** `coalesce(nullif(data->>'imageUrl',''), nullif(data->>'image_url',''))` — mirrors extractPersistedImageUrl. */
function persistedUrlExpr(dataCol: unknown): SQL {
  return sql`coalesce(nullif(${dataCol} ->> 'imageUrl', ''), nullif(${dataCol} ->> 'image_url', ''))`;
}

/** Mirrors isDeadPersistedImageUrl: the active URL is present AND matches a dead pattern. */
function deadUrlCondition(dataCol: unknown, policy: ImageRepairPolicy): SQL {
  const url = persistedUrlExpr(dataCol);
  const patterns: SQL[] = [sql`${url} LIKE 'data:image/%'`];
  if (policy.localObjectUrlsAreDead) {
    patterns.push(sql`${url} LIKE '/api/image-objects/%'`);
  }
  for (const prefix of policy.deadUrlPrefixes) {
    if (!prefix) continue;
    // Escape LIKE wildcards in the operator-supplied prefix so it matches
    // literally, then anchor it as a prefix.
    const escaped = prefix.replace(/([%_\\])/g, "\\$1");
    patterns.push(sql`${url} LIKE ${`${escaped}%`} ESCAPE '\\'`);
  }
  return sql`${url} IS NOT NULL AND (${sql.join(patterns, sql` OR `)})`;
}

/** Mirrors clearImageRefKeys: chained jsonb `- key` removal of every image-locating key. */
function strippedDataExpr(dataCol: unknown): SQL {
  let expr = sql`${dataCol}`;
  for (const key of IMAGE_REF_KEYS) {
    expr = sql`(${expr} - ${key})`;
  }
  return expr;
}

async function countMatches(table: typeof userFragrancesTable | typeof globalFragrancesTable, condition: SQL): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(table)
    .where(condition);
  return row?.count ?? 0;
}

async function repairUserFragrances(policy: ImageRepairPolicy, apply: boolean): Promise<ImageRepairTableResult> {
  const data = userFragrancesTable.fragranceData;
  const condition = deadUrlCondition(data, policy);
  const matched = await countMatches(userFragrancesTable, condition);

  let cleared = 0;
  if (apply && matched > 0) {
    const updated = await db
      .update(userFragrancesTable)
      .set({ fragranceData: strippedDataExpr(data) })
      .where(condition)
      .returning({ id: userFragrancesTable.id });
    cleared = updated.length;
  }
  return { table: "user_fragrances", matched, cleared };
}

async function repairGlobalFragrances(policy: ImageRepairPolicy, apply: boolean): Promise<ImageRepairTableResult> {
  const data = globalFragrancesTable.profileData;
  const condition = deadUrlCondition(data, policy);
  const matched = await countMatches(globalFragrancesTable, condition);

  let cleared = 0;
  if (apply && matched > 0) {
    const updated = await db
      .update(globalFragrancesTable)
      .set({ profileData: strippedDataExpr(data), updatedAt: new Date() })
      .where(condition)
      .returning({ id: globalFragrancesTable.id });
    cleared = updated.length;
  }
  return { table: "global_fragrances", matched, cleared };
}

/**
 * Clear dead persisted image references from both JSONB stores.
 *
 * @param apply false (default) counts matches without mutating (dry run); true
 *              strips the dead keys.
 */
export async function repairDeadImageRefs(
  policy: ImageRepairPolicy,
  { apply = false }: { apply?: boolean } = {},
): Promise<ImageRepairTableResult[]> {
  return [
    await repairGlobalFragrances(policy, apply),
    await repairUserFragrances(policy, apply),
  ];
}
