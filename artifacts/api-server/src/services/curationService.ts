/**
 * DB-backed Beam curation service.
 *
 * Thin persistence/integration layer over the pure logic in
 * curationServiceCore.ts. It reuses the EXISTING enrichment queue and push
 * seams — it does not reinvent either:
 *   - enqueue → `upsertEnrichmentJob` (enrichmentQueue.ts) with our metadata;
 *   - completion notify → `sendCategoryPushToUser` (pushService.ts);
 *   - pending list → a `metadata_json`-filtered read of `enrichment_jobs`.
 *
 * Every entry point is BEST-EFFORT and tolerates an unprovisioned schema the
 * same way pushService does (42P01 undefined_table / 42703 undefined_column →
 * degrade, never throw). Nothing here may 500 a request or break the beam loop:
 * enqueue is fire-and-forget from the route, the push fires off the worker, and
 * the pending read returns `[]` on any schema gap.
 */
import { eq, desc, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { enrichmentJobsTable, type EnrichmentJob } from "@workspace/db/schema";
import { logger } from "../lib/logger";
import { upsertEnrichmentJob } from "./enrichmentQueue";
import { sendCategoryPushToUser } from "./pushService";
import {
  BEAM_CURATION_SOURCE,
  buildCurationMetadata,
  curationPushCopy,
  pendingCurationItemFromRow,
  type BeamCurationInput,
  type BeamCurationMetadata,
  type PendingCurationItem,
} from "./curationServiceCore";

/** Default page size for the pending-curation list. */
const DEFAULT_PENDING_LIMIT = 50;
const MAX_PENDING_LIMIT = 100;

// 42P01 undefined_table (enrichment_jobs not provisioned yet) or 42703
// undefined_column — either means a migration hasn't landed; degrade rather than
// throw, exactly like pushService.isMissingColumnOrTable. drizzle wraps driver
// errors and moves `code` onto `cause`, so walk the cause chain.
function isMissingColumnOrTable(err: unknown): boolean {
  for (let current = err, depth = 0; typeof current === "object" && current !== null && depth < 5; depth++) {
    const code = (current as { code?: string }).code;
    if (code === "42P01" || code === "42703") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Enqueue a Beam-recommended (but uncatalogued) fragrance for enrichment, tagged
 * to the requesting user via the curation metadata. Delegates to the shared
 * `upsertEnrichmentJob` so identity/idempotency stay single-sourced — a repeat
 * recommendation of the same fragrance just bumps the existing row.
 *
 * `house` carries the brand so the worker's engine resolve has both halves of the
 * identity; the metadata carries the user/tenant scope + the original name/brand.
 * Best-effort: a missing enrichment_jobs table degrades to a logged no-op so the
 * beam loop never breaks when the queue schema isn't provisioned.
 */
export async function enqueueBeamCuration(input: BeamCurationInput): Promise<{ enqueued: boolean }> {
  const name = input.name?.trim();
  if (!name) return { enqueued: false };

  const metadata: BeamCurationMetadata = buildCurationMetadata({ ...input, name });
  try {
    await upsertEnrichmentJob({
      name,
      house: input.brand?.trim() || null,
      jobType: "identity_and_detail",
      metadata: metadata as unknown as Record<string, unknown>,
    });
    return { enqueued: true };
  } catch (err) {
    if (isMissingColumnOrTable(err)) {
      logger.warn("[curation] enrichment_jobs not provisioned yet — beam curation enqueue skipped");
      return { enqueued: false };
    }
    throw err;
  }
}

const PENDING_COLUMNS = {
  jobKey: enrichmentJobsTable.jobKey,
  status: enrichmentJobsTable.status,
  name: enrichmentJobsTable.name,
  house: enrichmentJobsTable.house,
  lastRequestedAt: enrichmentJobsTable.lastRequestedAt,
  metadataJson: enrichmentJobsTable.metadataJson,
} as const;

/**
 * List the curation jobs this user has queued, newest-requested first.
 *
 * Filters `enrichment_jobs` on the JSONB metadata stamped at enqueue time —
 * `metadata_json->>'source' = 'beam' AND metadata_json->>'userId' = <user>` — so
 * one shared queue row is only ever surfaced to the user who asked for it. The
 * userId is the authenticated caller's id (route-supplied), never a client arg.
 * Best-effort: any schema gap degrades to `[]`.
 */
export async function listPendingCurationForUser(
  userId: string,
  limit = DEFAULT_PENDING_LIMIT,
): Promise<PendingCurationItem[]> {
  const safeLimit = Math.max(1, Math.min(MAX_PENDING_LIMIT, Math.floor(limit) || DEFAULT_PENDING_LIMIT));
  try {
    const rows = await db
      .select(PENDING_COLUMNS)
      .from(enrichmentJobsTable)
      .where(
        sql`${enrichmentJobsTable.metadataJson}->>'source' = ${BEAM_CURATION_SOURCE} and ${enrichmentJobsTable.metadataJson}->>'userId' = ${userId}`,
      )
      .orderBy(desc(enrichmentJobsTable.lastRequestedAt))
      .limit(safeLimit);

    return rows.map((row) =>
      pendingCurationItemFromRow({
        jobKey: row.jobKey,
        status: row.status,
        name: row.name,
        house: row.house,
        lastRequestedAt: row.lastRequestedAt,
        metadataJson: (row.metadataJson as Record<string, unknown> | null) ?? null,
      }),
    );
  } catch (err) {
    if (isMissingColumnOrTable(err)) return [];
    throw err;
  }
}

/**
 * Fire the "ready to add" completion push for a finished beam-curation job.
 *
 * Targets ONLY the job's own user (read off the stamped metadata, not any request
 * input) and rides the existing per-category push seam, so it respects the user's
 * `notify_curation` opt-in, the app-icon badge, and the VAPID-unconfigured no-op.
 * The payload deep-links the SPA back to the recommendation
 * (`/?curation=<jobKey>`). Best-effort by contract: any failure is swallowed so
 * it can never affect the worker's terminal "completed"/"failed" result.
 */
export async function notifyBeamCurationComplete(job: EnrichmentJob): Promise<void> {
  const metadata = (job.metadataJson ?? {}) as Partial<BeamCurationMetadata>;
  if (metadata.source !== BEAM_CURATION_SOURCE) return;
  const userId = typeof metadata.userId === "string" ? metadata.userId : "";
  if (!userId) return;

  const name = (typeof metadata.name === "string" ? metadata.name : job.name) ?? "";
  const brand = (typeof metadata.brand === "string" ? metadata.brand : job.house) ?? null;
  const { title, body } = curationPushCopy({ name, brand });

  try {
    await sendCategoryPushToUser(userId, "curation", {
      title,
      body,
      url: `/?curation=${encodeURIComponent(job.jobKey)}`,
      tag: `curation:${job.jobKey}`,
    });
  } catch (err) {
    // The notify is a courtesy; a push failure must never bubble into the worker
    // and flip a real "completed" enrichment to "failed".
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), jobKey: job.jobKey },
      "[curation] completion push failed (ignored)",
    );
  }
}
