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
import { eq, inArray, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import {
  buildJobKey,
  canonicalizeFgUrl,
  computeEnrichmentUpsert,
  EnrichmentQueueError,
  failedJobReopenPatch,
  runEnrichmentWorkerOnce,
  shouldReopenFailedEnrichmentJob,
  statusMessage,
  TERMINAL_SKIP_STATUSES,
  type EnrichmentJobInput,
  type EnrichmentJobStatus,
  type EnrichmentWorkerDeps,
  type EnrichmentWorkerProcessor,
  type ExistingJobRow,
} from "./enrichmentQueueCore";

export { runEnrichmentWorkerOnce } from "./enrichmentQueueCore";
export type { EnrichmentWorkerProcessor, EnrichmentWorkerDeps } from "./enrichmentQueueCore";

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

let failedJobSweeperTimer: NodeJS.Timeout | null = null;

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
  failedJobSweeperTimer = timer;
}

/** Stop the failed-job retry sweeper. Used by graceful shutdown. */
export function stopEnrichmentFailedJobRetrySweeper(): void {
  if (failedJobSweeperTimer) {
    clearInterval(failedJobSweeperTimer);
    failedJobSweeperTimer = null;
  }
}

/* ------------------------------------------------------------------ */
/* Worker — claims and processes pending jobs                          */
/* ------------------------------------------------------------------ */
//
// The worker and the failed-job sweeper above CANNOT race the same row: the
// sweeper only ever touches `failed` rows, while the worker claims `pending`
// (or lease-expired `processing`) rows atomically and moves them OFF `pending`
// in the same statement. A claimed job is `processing`, which neither writer
// reopens until it has terminated (`completed`/`failed`) or its lease lapses.

const DEFAULT_CLAIM_LEASE_MS = 5 * 60 * 1000;
const DEFAULT_WORKER_POLL_MS = 30 * 1000;
const DEFAULT_WORKER_BATCH = 3;

// The worker runner + its dep/processor types live in the dependency-free core
// (enrichmentQueueCore.ts) so the orchestration is unit-testable without a DB;
// re-exported above. The DB-backed claim/complete/fail primitives stay here.

/** Off by default — opt in per environment so a deploy doesn't start calling the
 *  engine until enrichment is explicitly enabled. */
export function enrichmentWorkerEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test((process.env.ENRICHMENT_WORKER_ENABLED ?? "").trim());
}

/**
 * Master switch for the PRODUCER (enqueue-on-incomplete-detail). Off by default
 * so turning enrichment on is a deliberate, env-gated rollout — with it unset the
 * detail path behaves exactly as before (no extra DB writes, no regression).
 */
export function enrichmentQueueProducerEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test((process.env.ENRICHMENT_QUEUE_ENABLED ?? "").trim());
}

function positiveIntEnv(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function claimLeaseMs(): number {
  return positiveIntEnv(process.env.ENRICHMENT_CLAIM_LEASE_MS, DEFAULT_CLAIM_LEASE_MS);
}
function workerPollMs(): number {
  return positiveIntEnv(process.env.ENRICHMENT_WORKER_POLL_MS, DEFAULT_WORKER_POLL_MS);
}
function workerBatchSize(): number {
  return positiveIntEnv(process.env.ENRICHMENT_WORKER_BATCH, DEFAULT_WORKER_BATCH);
}

/**
 * Atomically claim the next runnable job — the highest-priority `pending` job,
 * or a `processing` job whose lease has expired (i.e. a worker that crashed mid-
 * job). The claim is `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED)`, so
 * concurrent workers never grab the same row, and it flips the row to
 * `processing` in the same statement (never racing the failed-job sweeper).
 * Returns the freshly-claimed row (typed), or null when nothing is runnable.
 */
export async function claimNextEnrichmentJob(opts?: { now?: Date; leaseMs?: number }): Promise<EnrichmentJob | null> {
  const now = opts?.now ?? new Date();
  const claimExpiresAt = new Date(now.getTime() + (opts?.leaseMs ?? claimLeaseMs()));

  // Returning only the id keeps this independent of column-name casing (raw
  // db.execute rows are snake_case); we re-read the row through the typed query
  // builder below. The row is already ours (status=processing) so that read can't race.
  const claimed = await db.execute(sql`
    update ${enrichmentJobsTable} as j
       set status = 'processing',
           claimed_at = ${now},
           claim_expires_at = ${claimExpiresAt},
           updated_at = ${now}
     where j.id = (
       select c.id from ${enrichmentJobsTable} as c
        where c.status = 'pending'
           or (c.status = 'processing' and c.claim_expires_at is not null and c.claim_expires_at < ${now})
        order by c.priority desc, c.last_requested_at asc
        limit 1
        for update skip locked
     )
    returning j.id
  `);

  const rows = (Array.isArray(claimed) ? claimed : (claimed as { rows?: unknown[] }).rows ?? []) as Array<{ id: string }>;
  const claimedId = rows[0]?.id;
  if (!claimedId) return null;

  const [job] = await db
    .select()
    .from(enrichmentJobsTable)
    .where(eq(enrichmentJobsTable.id, claimedId))
    .limit(1);
  return job ?? null;
}

/** Mark a claimed job done. `completed` is terminal — the sweeper never reopens it. */
export async function completeEnrichmentJob(jobKey: string, now: Date = new Date()): Promise<void> {
  await db
    .update(enrichmentJobsTable)
    .set({
      status: "completed",
      completedAt: now,
      updatedAt: now,
      claimedAt: null,
      claimExpiresAt: null,
      lastError: null,
    })
    .where(eq(enrichmentJobsTable.jobKey, jobKey));
}

/** Mark a claimed job failed. The sweeper reopens it to `pending` after backoff. */
export async function failEnrichmentJob(jobKey: string, error: string, now: Date = new Date()): Promise<void> {
  await db
    .update(enrichmentJobsTable)
    .set({
      status: "failed",
      failedAt: now,
      updatedAt: now,
      claimedAt: null,
      claimExpiresAt: null,
      lastError: error.slice(0, 500),
    })
    .where(eq(enrichmentJobsTable.jobKey, jobKey));
}

/**
 * Mark a claimed job terminally `ignored` — used when enrichment is still
 * incomplete after the attempt budget (or the job has no usable identity).
 * Like `completed`, this is in TERMINAL_SKIP_STATUSES, so the failed-job sweeper
 * never reopens it and the curation pending-list never reports it `ready`. This
 * is what stops a permanently-thin fragrance from re-polling the engine forever.
 */
export async function ignoreEnrichmentJob(jobKey: string, reason: string, now: Date = new Date()): Promise<void> {
  await db
    .update(enrichmentJobsTable)
    .set({
      status: "ignored",
      ignoredAt: now,
      updatedAt: now,
      claimedAt: null,
      claimExpiresAt: null,
      lastError: reason.slice(0, 500),
    })
    .where(eq(enrichmentJobsTable.jobKey, jobKey));
}

/**
 * Merge a small progress patch into `enrichment_jobs.metadata_json` without
 * clobbering the existing keys (source/userId/runId/notify stay intact). Used by
 * the processor to persist the running `enrichAttempts` counter and the latest
 * `enrichLevel` so the bounded-retry budget survives across worker passes and the
 * pending-list can report the real completeness. Atomic jsonb concat; best-effort.
 */
export async function stampEnrichmentProgress(
  jobKey: string,
  patch: Record<string, unknown>,
  now: Date = new Date(),
): Promise<void> {
  await db
    .update(enrichmentJobsTable)
    .set({
      metadataJson: sql`coalesce(${enrichmentJobsTable.metadataJson}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
      updatedAt: now,
    })
    .where(eq(enrichmentJobsTable.jobKey, jobKey));
}

function defaultWorkerDeps(process: EnrichmentWorkerProcessor<EnrichmentJob>): EnrichmentWorkerDeps<EnrichmentJob> {
  return {
    claim: () => claimNextEnrichmentJob(),
    complete: (jobKey) => completeEnrichmentJob(jobKey),
    fail: (jobKey, error) => failEnrichmentJob(jobKey, error),
    ignore: (jobKey, reason) => ignoreEnrichmentJob(jobKey, reason),
    process,
  };
}

let enrichmentWorkerStarted = false;
let enrichmentWorkerTimer: NodeJS.Timeout | null = null;

/**
 * Start the background worker; no-op unless ENRICHMENT_WORKER_ENABLED is set, and
 * idempotent so a double-call can't spin two loops. The interval is `unref()`d so
 * it never holds the process open. Pass the concrete processor from app.ts (where
 * the engine/scent-engine deps are already in scope) to keep this module free of
 * that heavy import graph.
 */
export function startEnrichmentWorker(process: EnrichmentWorkerProcessor<EnrichmentJob>): void {
  if (enrichmentWorkerStarted) return;
  if (!enrichmentWorkerEnabled()) return;
  enrichmentWorkerStarted = true;

  const deps = defaultWorkerDeps(process);
  const pollMs = workerPollMs();
  const batch = workerBatchSize();
  // Reentrancy guard: if a tick's batch (claim + engine round-trips) runs longer
  // than pollMs, the next interval fires while the prior is still in flight. Row
  // claiming uses FOR UPDATE SKIP LOCKED so overlapping ticks can't double-claim,
  // but they would still stack engine calls beyond the intended batch size. Skip
  // a tick while the previous one is still running.
  let tickRunning = false;
  const timer = setInterval(() => {
    if (tickRunning) return;
    tickRunning = true;
    runEnrichmentWorkerOnce(deps, batch)
      .catch((err) => logger.error({ err }, "enrichment worker tick error"))
      .finally(() => {
        tickRunning = false;
      });
  }, pollMs);
  timer.unref();
  enrichmentWorkerTimer = timer;
  logger.info({ pollMs, batch }, "enrichment worker started");
}

/** Stop the enrichment worker loop. Used by graceful shutdown. */
export function stopEnrichmentWorker(): void {
  if (enrichmentWorkerTimer) {
    clearInterval(enrichmentWorkerTimer);
    enrichmentWorkerTimer = null;
  }
  enrichmentWorkerStarted = false;
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
