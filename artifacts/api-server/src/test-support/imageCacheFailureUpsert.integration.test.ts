// Integration coverage for the image_cache negative-cache upsert guards
// (recordImageFailure in services/imageCacheService.ts), against a real
// Postgres engine (pglite) with the versioned migrations applied — including
// the provider-split partial unique indexes the ON CONFLICT targets.
//
// The SQL below is the parameterized mirror of the Drizzle upsert that
// recordImageFailure emits (the harness cannot import the service directly:
// its import chain uses extensionless relative imports that `node --test`
// cannot resolve — see pgliteHarness.ts). Keep the CASE expressions in
// lockstep with recordImageFailure.
//
// Invariants proven here:
//   1. A failure upsert NEVER downgrades an existing "ready" row — the row is
//      backed by an already-uploaded object that stays servable even when the
//      source URL later rots or a bypassSourceCache re-run fails.
//   2. A repeat failure of an already-"failed" row keeps the original
//      updated_at so the 6h retry TTL can actually elapse (BE-5).
//   3. A first failure with no existing row records a "failed" row.
import test from "node:test";
import assert from "node:assert/strict";
import { createTestDb, type Harness } from "./pgliteHarness.ts";

const PIPELINE_VERSION = "bg-v4-alpha-safe";

async function insertRow(
  h: Harness,
  input: {
    lookupKey: string;
    sourceProvider: string;
    sourceUrlHash: string;
    backgroundRemoved: boolean;
    processingStatus: "ready" | "failed";
    failureReason?: string | null;
    updatedAt: string;
  },
): Promise<string> {
  const rows = await h.query<{ id: string }>(
    `INSERT INTO image_cache (
       lookup_key, source_provider, source_url, source_url_hash, pipeline_version,
       background_removed, storage_provider, storage_path, public_url,
       processing_status, failure_reason, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, 'supabase', $7, $8, $9, $10, $11)
     RETURNING id`,
    [
      input.lookupKey,
      input.sourceProvider,
      `https://example.com/${input.sourceUrlHash}.jpg`,
      input.sourceUrlHash,
      PIPELINE_VERSION,
      input.backgroundRemoved,
      input.processingStatus === "ready" ? `images/processed/serper/${input.lookupKey}/${input.sourceUrlHash}.webp` : "",
      input.processingStatus === "ready" ? `https://cdn.example.com/${input.sourceUrlHash}.webp` : null,
      input.processingStatus,
      input.failureReason ?? null,
      input.updatedAt,
    ],
  );
  return rows[0]!.id;
}

// Mirror of recordImageFailure's upsert for a SERPER row (conflict target =
// the serper partial unique index; CASE guards identical to the service).
async function runFailureUpsert(
  h: Harness,
  input: {
    lookupKey: string;
    sourceUrlHash: string;
    backgroundRemoved: boolean;
    failureReason: string;
  },
): Promise<void> {
  await h.query(
    `INSERT INTO image_cache (
       lookup_key, source_provider, source_url, source_url_hash, pipeline_version,
       background_removed, storage_provider, storage_path,
       processing_status, failure_reason, updated_at
     ) VALUES ($1, 'serper', $2, $3, $4, $5, 'local', '', 'failed', $6, now())
     ON CONFLICT (source_url_hash, pipeline_version, background_removed, lookup_key)
       WHERE source_provider = 'serper'
     DO UPDATE SET
       processing_status = case when image_cache.processing_status = 'ready'
         then image_cache.processing_status else 'failed' end,
       failure_reason = case when image_cache.processing_status = 'ready'
         then image_cache.failure_reason else excluded.failure_reason end,
       updated_at = case when image_cache.processing_status in ('ready', 'failed')
         then image_cache.updated_at else now() end`,
    [
      input.lookupKey,
      `https://example.com/${input.sourceUrlHash}.jpg`,
      input.sourceUrlHash,
      PIPELINE_VERSION,
      input.backgroundRemoved,
      input.failureReason,
    ],
  );
}

async function readRow(h: Harness, id: string) {
  const rows = await h.query<{
    processing_status: string;
    failure_reason: string | null;
    public_url: string | null;
    updated_at: string;
  }>(
    `SELECT processing_status, failure_reason, public_url,
            updated_at::text AS updated_at
       FROM image_cache WHERE id = $1`,
    [id],
  );
  return rows[0]!;
}

const OLD_TIMESTAMP = "2026-01-01 00:00:00+00";

test("negative-cache upsert never downgrades a ready row (fix: ready-row guard)", async () => {
  const h = await createTestDb();
  try {
    const id = await insertRow(h, {
      lookupKey: "dior|sauvage",
      sourceProvider: "serper",
      sourceUrlHash: "hash-ready",
      backgroundRemoved: true,
      processingStatus: "ready",
      updatedAt: OLD_TIMESTAMP,
    });

    // A later bypassSourceCache re-run of the same source fails
    // deterministically (e.g. the source URL now 404s).
    await runFailureUpsert(h, {
      lookupKey: "dior|sauvage",
      sourceUrlHash: "hash-ready",
      backgroundRemoved: true,
      failureReason: "Image fetch failed with HTTP 404",
    });

    const row = await readRow(h, id);
    // The already-uploaded processed object is still perfectly servable; the
    // ready row must survive untouched — status, reason, and TTL anchor.
    assert.equal(row.processing_status, "ready");
    assert.equal(row.failure_reason, null);
    assert.equal(row.public_url, "https://cdn.example.com/hash-ready.webp");
    assert.ok(new Date(row.updated_at).toISOString().startsWith("2026-01-01"));
  } finally {
    await h.close();
  }
});

test("repeat failure keeps the first failure's updated_at so the retry TTL elapses (BE-5)", async () => {
  const h = await createTestDb();
  try {
    const id = await insertRow(h, {
      lookupKey: "dior|sauvage",
      sourceProvider: "serper",
      sourceUrlHash: "hash-failed",
      backgroundRemoved: true,
      processingStatus: "failed",
      failureReason: "Invalid data image",
      updatedAt: OLD_TIMESTAMP,
    });

    await runFailureUpsert(h, {
      lookupKey: "dior|sauvage",
      sourceUrlHash: "hash-failed",
      backgroundRemoved: true,
      failureReason: "Image fetch failed with HTTP 410",
    });

    const row = await readRow(h, id);
    assert.equal(row.processing_status, "failed");
    // The reason may refresh, but the TTL anchor must not.
    assert.equal(row.failure_reason, "Image fetch failed with HTTP 410");
    assert.ok(new Date(row.updated_at).toISOString().startsWith("2026-01-01"));
  } finally {
    await h.close();
  }
});

test("first failure with no existing row records a failed row for that variant only", async () => {
  const h = await createTestDb();
  try {
    await runFailureUpsert(h, {
      lookupKey: "dior|sauvage",
      sourceUrlHash: "hash-new",
      backgroundRemoved: true,
      failureReason: "Optimized image below minimum edge: 120x96 (min 200px)",
    });

    const rows = await h.query<{ processing_status: string; background_removed: boolean }>(
      `SELECT processing_status, background_removed FROM image_cache WHERE source_url_hash = $1`,
      ["hash-new"],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.processing_status, "failed");
    assert.equal(rows[0]!.background_removed, true);
  } finally {
    await h.close();
  }
});

test("serper failure rows stay scoped per fragrance (H1/H3 partial index)", async () => {
  const h = await createTestDb();
  try {
    // Fragrance A holds a ready row for this source; fragrance B's failure for
    // the SAME source must create its own row, not touch A's.
    const readyId = await insertRow(h, {
      lookupKey: "dior|sauvage",
      sourceProvider: "serper",
      sourceUrlHash: "hash-shared",
      backgroundRemoved: true,
      processingStatus: "ready",
      updatedAt: OLD_TIMESTAMP,
    });

    await runFailureUpsert(h, {
      lookupKey: "chanel|bleu",
      sourceUrlHash: "hash-shared",
      backgroundRemoved: true,
      failureReason: "Image fetch failed with HTTP 404",
    });

    const readyRow = await readRow(h, readyId);
    assert.equal(readyRow.processing_status, "ready");

    const rows = await h.query<{ lookup_key: string; processing_status: string }>(
      `SELECT lookup_key, processing_status FROM image_cache
        WHERE source_url_hash = $1 ORDER BY lookup_key`,
      ["hash-shared"],
    );
    assert.deepEqual(
      rows.map((r) => `${r.lookup_key}:${r.processing_status}`),
      ["chanel|bleu:failed", "dior|sauvage:ready"],
    );
  } finally {
    await h.close();
  }
});
