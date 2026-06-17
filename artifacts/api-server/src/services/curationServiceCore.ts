/**
 * Pure, dependency-free core of the Beam curation service.
 *
 * Nothing here imports the database, the push layer, or any runtime config, so
 * it can be unit tested in isolation (see curationServiceCore.test.ts). The
 * DB-backed wrappers live in curationService.ts and delegate the payload/row
 * shaping to this file — mirroring the enrichmentQueueCore.ts ↔ enrichmentQueue.ts
 * split.
 *
 * "Curation" = the Beam Agent recommends a fragrance that is NOT yet in our
 * catalog. We enqueue an enrichment job tagged to the requesting user, and when
 * the worker completes it we push the user a "ready to add" nudge. The metadata
 * we stamp onto the enrichment_jobs row is what ties an otherwise-shared job back
 * to the user who asked for it, and what the pending-list endpoint reads back.
 */

/** Marker stored on `enrichment_jobs.metadata_json.source` for beam-curation jobs. */
export const BEAM_CURATION_SOURCE = "beam" as const;

/** Caller-supplied identity for a curation request. user/tenant come from the
 * authenticated context, never from model args. */
export type BeamCurationInput = {
  userId: string;
  tenantId?: string | null;
  name: string;
  brand?: string | null;
};

/**
 * The metadata payload stamped onto the enrichment_jobs row for a beam-curation
 * job. `source: "beam"` + `userId` are what `listPendingCurationForUser` filters
 * on; `name`/`brand` echo the recommendation so the pending list and the push
 * can render it without a second lookup.
 */
export type BeamCurationMetadata = {
  source: typeof BEAM_CURATION_SOURCE;
  userId: string;
  tenantId?: string;
  name: string;
  brand?: string;
};

function cleanString(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * Build the `{ source, userId, tenantId?, name, brand? }` metadata for a beam
 * curation job. Optional fields are omitted (not set to null/"") so the stored
 * JSON stays compact and the `metadata_json->>'userId'` filter matches exactly.
 */
export function buildCurationMetadata(input: BeamCurationInput): BeamCurationMetadata {
  const metadata: BeamCurationMetadata = {
    source: BEAM_CURATION_SOURCE,
    userId: input.userId,
    name: input.name,
  };
  const tenantId = cleanString(input.tenantId);
  if (tenantId) metadata.tenantId = tenantId;
  const brand = cleanString(input.brand);
  if (brand) metadata.brand = brand;
  return metadata;
}

/** Subset of an enrichment_jobs row the pending-list mapping needs. */
export type CurationJobRow = {
  jobKey: string;
  status: string;
  name: string | null;
  house: string | null;
  lastRequestedAt: Date;
  metadataJson: Record<string, unknown> | null;
};

/** One item in the `GET /api/beam-agent/curation/pending` response. */
export type PendingCurationItem = {
  jobKey: string;
  status: string;
  name: string;
  brand: string | null;
  /** Convenience flag — true once the enrichment finished and the fragrance is addable. */
  ready: boolean;
  lastRequestedAt: string;
};

/**
 * Map an enrichment_jobs row → the pending-list item shape.
 *
 * The display `name`/`brand` prefer the values we stamped into metadata at
 * enqueue time (the model's exact recommendation), falling back to the row's own
 * `name`/`house` columns (which the worker may have refined). `ready` is derived
 * purely from the status so the client never re-implements that rule.
 */
export function pendingCurationItemFromRow(row: CurationJobRow): PendingCurationItem {
  const metadata = (row.metadataJson ?? {}) as Partial<BeamCurationMetadata>;
  const name = cleanString(metadata.name) ?? cleanString(row.name) ?? "";
  const brand = cleanString(metadata.brand) ?? cleanString(row.house);
  return {
    jobKey: row.jobKey,
    status: row.status,
    name,
    brand,
    ready: row.status === "completed",
    lastRequestedAt: row.lastRequestedAt.toISOString(),
  };
}

/** Title/body for the "your recommendation is ready to add" completion push. */
export function curationPushCopy(item: { name: string; brand: string | null }): {
  title: string;
  body: string;
} {
  const label = item.brand ? `${item.brand} ${item.name}`.trim() : item.name;
  return {
    title: "Ready to add to your vault",
    body: label
      ? `${label} is ready — open Scentbeam to add it and continue curating.`
      : "A recommendation is ready — open Scentbeam to add it and continue curating.",
  };
}
