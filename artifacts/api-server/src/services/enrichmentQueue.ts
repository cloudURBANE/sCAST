/**
 * DB-backed enrichment queue service.
 *
 * Thin persistence layer over the pure logic in enrichmentQueueCore.ts. All
 * decisions (job-key generation, insert-vs-update planning, field merging) live
 * in the core module so they stay unit-testable without a database.
 *
 * Pass 1 scope: foundation only. `enqueueEnrichmentJob` is the integration seam
 * a later pass will call once the repo exposes a real "incomplete result /
 * source coverage" signal. No production endpoint calls it automatically yet.
 *
 * Stale `failed` jobs are proactively reopened to `pending` via a background
 * sweeper and lazily on `getEnrichmentStatus` once backoff has elapsed.
 */
import { db } from "@workspace/db";
import { enrichmentJobsTable, type EnrichmentJob } from "@workspace/db/schema";
import { eq, inArray } from "drizzle-orm";
import { logger } from "../lib/logger";
import {
  buildJobKey,
  canonicalizeFgUrl,
  computeEnrichmentUpsert,
  EnrichmentQueueError,
  failedJobReopenPatch,
  shouldReopenFailedEnrichmentJob,
  statusMessage,
  TERMINAL_SKIP_STATUSES,
  type EnrichmentJobInput,
  type EnrichmentJobStatus,
  type ExistingJobRow,
} from "./enrichmentQueueCore";

export { EnrichmentQueueError } from "./enrichmentQueueCore";
export type { EnrichmentJobInput } from "./enrichmentQueueCore";

/** Postgres unique-constraint violation. */
const PG_UNIQUE_VIOLATION = "23505";

const DEFAULT_FAILED_RETRY_MS = 6 * 60 * 60 * 1000;
const DEFAULT_FAILED_RETRY_SWEEP_MS = 15 * 60 * 1000;

/** Backoff before a `failed` job is automatically reopened; `<= 0` disables retry. */
export function failedEnrichmentRetryMs(): number {
  const raw = process.env.ENRICHMENT_FAILED_RETRY_MS;
  if (!raw) return DEFAULT_FAILED_RETRY_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_FAILED_RETRY_MS;
  return parsed;
}

function failedEnrichmentRetrySweepMs(): number {
  const raw = process.env.ENRICHMENT_FAILED_RETRY_SWEEP_MS;
  if (!raw) return DEFAULT_FAILED_RETRY_SWEEP_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_FAILED_RETRY_SWEEP_MS;
  return parsed;
}

function toExistingJobRow(row: EnrichmentJob): ExistingJobRow {
  return {
    jobKey: row.jobKey,
    jobType: row.jobType,
    query: row.query,
    normalizedQuery: row.normalizedQuery,
    name: row.name,
    house: row.house,
    year: row.year,
    bnUrl: row.bnUrl,
    fgUrl: row.fgUrl,
    sourceId: row.sourceId,
    status: row.status,
    priority: row.priority,
    requestedCount: row.requestedCount,
    metadataJson: (row.metadataJson as Record<string, unknown> | null) ?? null,
  };
}

async function findJobByKey(jobKey: string): Promise<EnrichmentJob | null> {
  const rows = await db
    .select()
    .from(enrichmentJobsTable)
    .where(eq(enrichmentJobsTable.jobKey, jobKey))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Reopen eligible stale `failed` rows to `pending`. Returns the number reopened.
 */
export async function reopenStaleFailedEnrichmentJobs(opts?: {
  now?: Date;
  limit?: number;
}): Promise<number> {
  const retryAfterMs = failedEnrichmentRetryMs();
  if (retryAfterMs <= 0) return 0;

  const now = opts?.now ?? new Date();
  const limit = opts?.limit ?? 50;

  const rows = await db
    .select()
    .from(enrichmentJobsTable)
    .where(eq(enrichmentJobsTable.status, "failed"))
    .limit(limit);

  const eligibleIds = rows
    .filter((row) =>
      shouldReopenFailedEnrichmentJob(
        row.status,
        row.failedAt,
        row.updatedAt,
        retryAfterMs,
        now.getTime(),
      ),
    )
    .map((row) => row.id);

  if (eligibleIds.length === 0) return 0;

  await db
    .update(enrichmentJobsTable)
    .set(failedJobReopenPatch(now))
    .where(inArray(enrichmentJobsTable.id, eligibleIds));

  logger.info({ count: eligibleIds.length }, "reopened stale failed enrichment jobs");
  return eligibleIds.length;
}

/** Reopen a single `failed` row when backoff has elapsed; otherwise return as-is. */
export async function maybeReopenFailedEnrichmentJob(
  job: EnrichmentJob,
): Promise<EnrichmentJob> {
  const retryAfterMs = failedEnrichmentRetryMs();
  if (
    !shouldReopenFailedEnrichmentJob(
      job.status,
      job.failedAt,
      job.updatedAt,
      retryAfterMs,
    )
  ) {
    return job;
  }

  const now = new Date();
  const [updated] = await db
    .update(enrichmentJobsTable)
    .set(failedJobReopenPatch(now))
    .where(eq(enrichmentJobsTable.jobKey, job.jobKey))
    .returning();

  return updated ?? job;
}

/** Background sweeper; no-op when automatic retry is disabled. */
export function startEnrichmentFailedJobRetrySweeper(): void {
  const retryAfterMs = failedEnrichmentRetryMs();
  if (retryAfterMs <= 0) return;

  const sweepMs = failedEnrichmentRetrySweepMs();
  const timer = setInterval(() => {
    reopenStaleFailedEnrichmentJobs().catch((err) => {
      logger.error({ err }, "enrichment failed job retry sweeper error");
    });
  }, sweepMs);
  timer.unref();
}

export type UpsertEnrichmentJobResult = {
  job: EnrichmentJob;
  created: boolean;
};

/**
 * Idempotently create or update an enrichment job.
 *
 * One row per canonical job key: a first request inserts, every repeat request
 * for the same key bumps `requested_count` / `last_requested_at` on that same
 * row instead of creating a duplicate. A concurrent insert that loses the
 * unique-index race is transparently retried as an update.
 */
export async function upsertEnrichmentJob(
  input: EnrichmentJobInput,
): Promise<UpsertEnrichmentJobResult> {
  const jobKey = buildJobKey(input);
  const existing = await findJobByKey(jobKey);
  const plan = computeEnrichmentUpsert(
    existing ? toExistingJobRow(existing) : null,
    input,
    new Date(),
  );

  if (plan.action === "insert") {
    try {
      const [job] = await db
        .insert(enrichmentJobsTable)
        .values(plan.values)
        .returning();
      return { job, created: true };
    } catch (err) {
      // Lost the race to a concurrent insert of the same job_key — fall through
      // and apply this request as an update against the row that won.
      if ((err as { code?: string })?.code !== PG_UNIQUE_VIOLATION) throw err;
      logger.info({ jobKey }, "enrichment job insert raced; retrying as update");
      const winner = await findJobByKey(jobKey);
      if (!winner) throw err;
      const retryPlan = computeEnrichmentUpsert(
        toExistingJobRow(winner),
        input,
        new Date(),
      );
      if (retryPlan.action !== "update") throw err;
      const [job] = await db
        .update(enrichmentJobsTable)
        .set(retryPlan.values)
        .where(eq(enrichmentJobsTable.jobKey, jobKey))
        .returning();
      return { job, created: false };
    }
  }

  const [job] = await db
    .update(enrichmentJobsTable)
    .set(plan.values)
    .where(eq(enrichmentJobsTable.jobKey, jobKey))
    .returning();
  return { job, created: false };
}

/**
 * Integration seam for a later pass.
 *
 * This is the single named entry point a future pass will call *after* it
 * identifies a real, existing repo signal for an incomplete / enrichable detail
 * response. It applies the conservative skip rules (terminal statuses are left
 * untouched) and otherwise delegates to {@link upsertEnrichmentJob}.
 *
 * Pass 1 deliberately leaves this UNWIRED — no route invokes it — because the
 * repo does not currently expose the source-coverage contract the original
 * spec assumed. Do not invent that signal here.
 */
export async function enqueueEnrichmentJob(
  input: EnrichmentJobInput,
): Promise<{ job: EnrichmentJob; created: boolean; skipped: boolean }> {
  const jobKey = buildJobKey(input);
  const existing = await findJobByKey(jobKey);

  if (existing && TERMINAL_SKIP_STATUSES.has(existing.status as EnrichmentJobStatus)) {
    // completed / ignored / cancelled: do not reopen in Pass 1.
    logger.info(
      { jobKey, status: existing.status },
      "enrichment enqueue skipped: job in terminal status",
    );
    return { job: existing, created: false, skipped: true };
  }

  const { job, created } = await upsertEnrichmentJob(input);
  return { job, created, skipped: false };
}

export type EnrichmentStatusLookup = {
  fgUrl?: string | null;
  jobKey?: string | null;
};

export type EnrichmentStatusResponse = {
  status: string;
  requested_count: number;
  last_requested_at?: string;
  job_key?: string;
  message: string;
};

/**
 * Public status lookup by `fg_url` (canonicalized to its job key) or by
 * `job_key` directly. Returns a `not_found` shape when no row matches.
 */
export async function getEnrichmentStatus(
  lookup: EnrichmentStatusLookup,
): Promise<EnrichmentStatusResponse> {
  let jobKey: string | null = null;

  const directKey = typeof lookup.jobKey === "string" ? lookup.jobKey.trim() : "";
  if (directKey) {
    jobKey = directKey;
  } else if (typeof lookup.fgUrl === "string" && lookup.fgUrl.trim()) {
    const canonical = canonicalizeFgUrl(lookup.fgUrl);
    if (canonical) jobKey = `fg:${canonical}`;
  }

  if (!jobKey) {
    throw new EnrichmentQueueError("Provide fg_url or job_key to look up status.");
  }

  const job = await findJobByKey(jobKey);
  if (!job) {
    return {
      status: "not_found",
      requested_count: 0,
      message: statusMessage("not_found"),
    };
  }

  const resolved = await maybeReopenFailedEnrichmentJob(job);

  return {
    status: resolved.status,
    requested_count: resolved.requestedCount,
    last_requested_at: resolved.lastRequestedAt.toISOString(),
    job_key: resolved.jobKey,
    message: statusMessage(resolved.status),
  };
}
