/**
 * Beam research lane — Postgres cache IO.
 *
 * Implements the orchestrator's `loadCache` / `saveCache` against
 * `beam_research_cache`. Reads only fresh rows (expiresAt in the future) and
 * upserts by the unique (normalized_query, entity_type) key, so one live search
 * is reused until it expires. Best-effort hit-count bump on read.
 */
import { and, eq, gt, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { beamResearchCacheTable } from "@workspace/db/schema";
import type {
  CachedResearch,
  SaveResearchRecord,
} from "./beamResearch.ts";
import type { ResearchEntityType, ResearchSource } from "./researchPolicy.ts";

/** Return a fresh cached result, or null if absent/expired. */
export async function loadResearchCache(
  normalizedQuery: string,
  entityType: ResearchEntityType,
): Promise<CachedResearch | null> {
  const rows = await db
    .select()
    .from(beamResearchCacheTable)
    .where(
      and(
        eq(beamResearchCacheTable.normalizedQuery, normalizedQuery),
        eq(beamResearchCacheTable.entityType, entityType),
        gt(beamResearchCacheTable.expiresAt, new Date()),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  // Best-effort usage telemetry; never block or fail the read on it.
  void db
    .update(beamResearchCacheTable)
    .set({ hitCount: sql`${beamResearchCacheTable.hitCount} + 1`, updatedAt: new Date() })
    .where(eq(beamResearchCacheTable.id, row.id))
    .catch(() => {});

  return {
    synthesizedFact: row.synthesizedFact,
    sources: (row.sources as ResearchSource[]) ?? [],
    confidence: row.confidence ?? 0,
    mode: row.mode as CachedResearch["mode"],
    entityType: row.entityType as ResearchEntityType,
    model: row.model ?? "",
    engine: row.engine ?? "",
    costUsd: row.costUsd ?? 0,
  };
}

/** Upsert a research result keyed by (normalized_query, entity_type). */
export async function saveResearchCache(record: SaveResearchRecord): Promise<void> {
  const nowDate = new Date();
  const expiresAt = new Date(record.expiresAtMs);
  const shared = {
    mode: record.mode,
    synthesizedFact: record.synthesizedFact,
    sources: record.sources,
    confidence: record.confidence,
    model: record.model,
    engine: record.engine,
    costUsd: record.costUsd,
    retrievedAt: nowDate,
    expiresAt,
    updatedAt: nowDate,
  };

  await db
    .insert(beamResearchCacheTable)
    .values({
      normalizedQuery: record.normalizedQuery,
      entityType: record.entityType,
      ...shared,
    })
    .onConflictDoUpdate({
      target: [beamResearchCacheTable.normalizedQuery, beamResearchCacheTable.entityType],
      set: shared,
    });
}
