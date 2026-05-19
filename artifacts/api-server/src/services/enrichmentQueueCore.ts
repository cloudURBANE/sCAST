/**
 * Pure, dependency-free core of the enrichment queue.
 *
 * Nothing here imports the database or any runtime config, so it can be unit
 * tested in isolation (see enrichmentQueueCore.test.ts). The DB-backed wrappers
 * live in enrichmentQueue.ts and delegate all decision logic to this file.
 *
 * Pass 1 scope: foundation only. No worker, no automatic enqueue hook.
 * Failed jobs reopen to pending on a fresh enqueue request, on status lookup
 * once backoff has elapsed, or via the background sweeper in enrichmentQueue.ts.
 */

export const ENRICHMENT_JOB_STATUSES = [
  "pending",
  "processing",
  "completed",
  "failed",
  "ignored",
  "cancelled",
] as const;
export type EnrichmentJobStatus = (typeof ENRICHMENT_JOB_STATUSES)[number];

export const ENRICHMENT_JOB_TYPES = [
  "identity_and_detail",
  "detail_only",
  "repair",
] as const;
export type EnrichmentJobType = (typeof ENRICHMENT_JOB_TYPES)[number];

/** Statuses where a fresh request must NOT reopen the job (see Enqueue Skip Rules). */
export const TERMINAL_SKIP_STATUSES: ReadonlySet<EnrichmentJobStatus> = new Set([
  "completed",
  "ignored",
  "cancelled",
]);

export class EnrichmentQueueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnrichmentQueueError";
  }
}

/** Caller-supplied identity for a job. All fields optional, but at least one of
 * `fgUrl` / `query` / `name`+`house` must be present. */
export type EnrichmentJobInput = {
  query?: string | null;
  name?: string | null;
  house?: string | null;
  year?: number | null;
  bnUrl?: string | null;
  fgUrl?: string | null;
  sourceId?: string | null;
  jobType?: EnrichmentJobType;
  priority?: number;
  metadata?: Record<string, unknown> | null;
};

/** Subset of an enrichment_jobs row that the pure merge logic needs. */
export type ExistingJobRow = {
  jobKey: string;
  jobType: string;
  query: string | null;
  normalizedQuery: string | null;
  name: string | null;
  house: string | null;
  year: number | null;
  bnUrl: string | null;
  fgUrl: string | null;
  sourceId: string | null;
  status: string;
  priority: number;
  requestedCount: number;
  metadataJson: Record<string, unknown> | null;
};

export type InsertJobValues = {
  jobKey: string;
  jobType: EnrichmentJobType;
  query: string | null;
  normalizedQuery: string | null;
  name: string | null;
  house: string | null;
  year: number | null;
  bnUrl: string | null;
  fgUrl: string | null;
  sourceId: string | null;
  status: EnrichmentJobStatus;
  priority: number;
  requestedCount: number;
  createdAt: Date;
  updatedAt: Date;
  lastRequestedAt: Date;
  metadataJson: Record<string, unknown> | null;
};

/** Patch applied to an existing row on a duplicate request. */
export type UpdateJobValues = {
  query: string | null;
  normalizedQuery: string | null;
  name: string | null;
  house: string | null;
  year: number | null;
  bnUrl: string | null;
  fgUrl: string | null;
  sourceId: string | null;
  priority: number;
  requestedCount: number;
  updatedAt: Date;
  lastRequestedAt: Date;
  status?: EnrichmentJobStatus;
  failedAt?: Date | null;
  lastError?: string | null;
  claimedAt?: Date | null;
  claimExpiresAt?: Date | null;
  metadataJson: Record<string, unknown> | null;
};

export type EnrichmentUpsertPlan =
  | { action: "insert"; jobKey: string; values: InsertJobValues }
  | { action: "update"; jobKey: string; values: UpdateJobValues };

// --- normalization -----------------------------------------------------------

/** lowercase, trim, collapse repeated whitespace. */
export function normalizeText(value: string | null | undefined): string {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

const TRACKING_PARAM_PREFIXES = ["utm_", "ref_"];
const TRACKING_PARAM_KEYS = new Set([
  "ref",
  "fbclid",
  "gclid",
  "gclsrc",
  "dclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "igshid",
  "_ga",
  "yclid",
]);

function isTrackingParam(key: string): boolean {
  const lower = key.toLowerCase();
  if (TRACKING_PARAM_KEYS.has(lower)) return true;
  return TRACKING_PARAM_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/**
 * Canonicalize a Fragrantica (or other source) URL for use as a job key:
 * lowercase host, drop the fragment, strip tracking query params, and drop a
 * trailing slash — while preserving the full path so distinct fragrances never
 * collide. Non-parseable strings fall back to a trimmed/lowercased form.
 */
export function canonicalizeFgUrl(raw: string | null | undefined): string {
  if (typeof raw !== "string" || !raw.trim()) return "";
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return trimmed.toLowerCase().replace(/\/+$/, "");
  }
  url.hostname = url.hostname.toLowerCase();
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (isTrackingParam(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  let out = url.toString();
  // Drop a trailing slash on the path (but never reduce to an empty string).
  out = out.replace(/\/(?=(\?|$))/, "");
  return out.toLowerCase();
}

// --- job identity ------------------------------------------------------------

function cleanString(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * Derive the effective query text. If the caller gave an explicit query we use
 * it; otherwise we synthesize one from house + name so identity-only requests
 * still produce a stable key.
 */
export function resolveQueryText(input: EnrichmentJobInput): string | null {
  const explicit = cleanString(input.query);
  if (explicit) return explicit;
  const synthesized = [cleanString(input.house), cleanString(input.name)]
    .filter(Boolean)
    .join(" ")
    .trim();
  return synthesized ? synthesized : null;
}

/**
 * Canonical job-key generation. Priority:
 *   1. canonical fg_url, when an fg_url is present
 *   2. normalized query + house + name, when available
 *   3. normalized query only, as a last fallback
 * Throws EnrichmentQueueError when none of the above can be formed.
 */
export function buildJobKey(input: EnrichmentJobInput): string {
  const fgUrl = cleanString(input.fgUrl);
  if (fgUrl) {
    const canonical = canonicalizeFgUrl(fgUrl);
    if (canonical) return `fg:${canonical}`;
  }

  const normalizedQuery = normalizeText(resolveQueryText(input));
  if (!normalizedQuery) {
    throw new EnrichmentQueueError(
      "Cannot build a job key: provide fgUrl, query, or name/house.",
    );
  }

  const parts = [
    normalizedQuery,
    normalizeText(input.house),
    normalizeText(input.name),
  ].filter(Boolean);

  // Rule 2 when we have more identity than the bare query, rule 3 otherwise.
  return `q:${parts.join("|")}`;
}

/** detail_only when an fg_url exists, identity_and_detail otherwise. Honors an
 * explicit valid jobType override. */
export function resolveJobType(input: EnrichmentJobInput): EnrichmentJobType {
  if (input.jobType && ENRICHMENT_JOB_TYPES.includes(input.jobType)) {
    return input.jobType;
  }
  return cleanString(input.fgUrl) ? "detail_only" : "identity_and_detail";
}

// --- failed-job reopen -------------------------------------------------------

/** True when a stale `failed` row is eligible for automatic reopen to pending. */
export function shouldReopenFailedEnrichmentJob(
  status: string,
  failedAt: Date | null | undefined,
  updatedAt: Date | null | undefined,
  retryAfterMs: number,
  nowMs = Date.now(),
): boolean {
  if (status !== "failed") return false;
  if (!Number.isFinite(retryAfterMs) || retryAfterMs <= 0) return false;
  const anchor = failedAt ?? updatedAt;
  if (!anchor) return false;
  return nowMs - anchor.getTime() >= retryAfterMs;
}

/** Single source of truth for reopening a failed job (enqueue, sweeper, status poll). */
export function failedJobReopenPatch(now: Date): {
  status: "pending";
  failedAt: null;
  lastError: null;
  claimedAt: null;
  claimExpiresAt: null;
  updatedAt: Date;
} {
  return {
    status: "pending",
    failedAt: null,
    lastError: null,
    claimedAt: null,
    claimExpiresAt: null,
    updatedAt: now,
  };
}

// --- upsert decision ---------------------------------------------------------

/** Fill from the new value only when the existing value is missing — never
 * clobber data already captured on the row. */
function coalesce<T>(existing: T | null | undefined, incoming: T | null): T | null {
  return existing != null && existing !== ("" as unknown as T)
    ? existing
    : incoming;
}

/**
 * Pure upsert planner. Given the existing row (or null) and a fresh request,
 * returns whether to insert a new row or patch the existing one.
 *
 * Duplicate-request behavior on update:
 *   - requested_count += 1
 *   - last_requested_at / updated_at = now
 *   - priority = max(existing + 1, computed priority)
 *   - missing identity fields are filled in; existing values are preserved
 *   - failed rows reopen to pending on a fresh request so the next worker pass
 *     can pick them up again; completed/ignored/cancelled are skipped by
 *     enqueueEnrichmentJob before this planner is applied.
 */
export function computeEnrichmentUpsert(
  existing: ExistingJobRow | null,
  input: EnrichmentJobInput,
  now: Date,
): EnrichmentUpsertPlan {
  const jobKey = buildJobKey(input);
  const computedPriority =
    typeof input.priority === "number" && Number.isFinite(input.priority)
      ? Math.trunc(input.priority)
      : 0;

  const query = cleanString(resolveQueryText(input));
  const normalizedQuery = normalizeText(query) || null;
  const name = cleanString(input.name);
  const house = cleanString(input.house);
  const year =
    typeof input.year === "number" && Number.isFinite(input.year)
      ? Math.trunc(input.year)
      : null;
  const bnUrl = cleanString(input.bnUrl);
  const fgUrl = cleanString(input.fgUrl);
  const sourceId = cleanString(input.sourceId);
  const metadata = input.metadata ?? null;

  if (!existing) {
    return {
      action: "insert",
      jobKey,
      values: {
        jobKey,
        jobType: resolveJobType(input),
        query,
        normalizedQuery,
        name,
        house,
        year,
        bnUrl,
        fgUrl,
        sourceId,
        status: "pending",
        priority: computedPriority,
        requestedCount: 1,
        createdAt: now,
        updatedAt: now,
        lastRequestedAt: now,
        metadataJson: metadata,
      },
    };
  }

  const mergedMetadata =
    existing.metadataJson || metadata
      ? { ...(existing.metadataJson ?? {}), ...(metadata ?? {}) }
      : null;
  const shouldReopenFailed = existing.status === "failed";

  return {
    action: "update",
    jobKey,
    values: {
      query: coalesce(existing.query, query),
      normalizedQuery: coalesce(existing.normalizedQuery, normalizedQuery),
      name: coalesce(existing.name, name),
      house: coalesce(existing.house, house),
      year: existing.year != null ? existing.year : year,
      bnUrl: coalesce(existing.bnUrl, bnUrl),
      fgUrl: coalesce(existing.fgUrl, fgUrl),
      sourceId: coalesce(existing.sourceId, sourceId),
      priority: Math.max(existing.priority + 1, computedPriority),
      requestedCount: existing.requestedCount + 1,
      updatedAt: now,
      lastRequestedAt: now,
      ...(shouldReopenFailed ? failedJobReopenPatch(now) : {}),
      metadataJson: mergedMetadata,
    },
  };
}

// --- status presentation -----------------------------------------------------

const STATUS_MESSAGES: Record<string, string> = {
  pending: "Enhanced metrics queued.",
  processing: "Enhanced metrics are being prepared.",
  completed: "Enhanced metrics are ready.",
  failed: "Enrichment request failed.",
  ignored: "Enrichment request was ignored.",
  cancelled: "Enrichment request was cancelled.",
  not_found: "No enrichment request found.",
};

export function statusMessage(status: string): string {
  return STATUS_MESSAGES[status] ?? "Enrichment status unknown.";
}
