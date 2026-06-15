/**
 * Unit tests for the enrichment worker's pure orchestration (no DB, no engine).
 * The claim/complete/fail seams are faked so we can assert batch-bounding,
 * complete-vs-fail routing, drain-on-empty, and per-job isolation.
 *
 *   node --experimental-strip-types --test src/services/enrichmentWorker.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runEnrichmentWorkerOnce, type EnrichmentWorkerDeps } from "./enrichmentQueueCore.ts";

type Job = { jobKey: string };

/** A claim() that hands out the given jobs in order, then null forever. */
function claimQueue(jobs: Job[]): () => Promise<Job | null> {
  let i = 0;
  return async () => jobs[i++] ?? null;
}

test("runEnrichmentWorkerOnce processes a job and marks it completed", async () => {
  const completed: string[] = [];
  const failed: string[] = [];
  const deps: EnrichmentWorkerDeps<Job> = {
    claim: claimQueue([{ jobKey: "a" }]),
    complete: async (k) => void completed.push(k),
    fail: async (k) => void failed.push(k),
    process: async () => "completed",
  };

  const handled = await runEnrichmentWorkerOnce(deps, 5);

  assert.equal(handled, 1);
  assert.deepEqual(completed, ["a"]);
  assert.deepEqual(failed, []);
});

test("a 'failed' processor result routes to fail(), not complete()", async () => {
  const completed: string[] = [];
  const failed: Array<[string, string]> = [];
  const deps: EnrichmentWorkerDeps<Job> = {
    claim: claimQueue([{ jobKey: "b" }]),
    complete: async (k) => void completed.push(k),
    fail: async (k, e) => void failed.push([k, e]),
    process: async () => "failed",
  };

  await runEnrichmentWorkerOnce(deps, 5);

  assert.deepEqual(completed, []);
  assert.equal(failed[0][0], "b");
});

test("a throwing processor fails just that job and the loop continues", async () => {
  const completed: string[] = [];
  const failed: Array<[string, string]> = [];
  const deps: EnrichmentWorkerDeps<Job> = {
    claim: claimQueue([{ jobKey: "boom" }, { jobKey: "ok" }]),
    complete: async (k) => void completed.push(k),
    fail: async (k, e) => void failed.push([k, e]),
    process: async (job) => {
      if (job.jobKey === "boom") throw new Error("kaboom");
      return "completed";
    },
  };

  const handled = await runEnrichmentWorkerOnce(deps, 5);

  assert.equal(handled, 2);
  assert.deepEqual(completed, ["ok"]);
  assert.equal(failed[0][0], "boom");
  assert.match(failed[0][1], /kaboom/);
});

test("the batch size bounds how many jobs a single pass claims", async () => {
  let claims = 0;
  const deps: EnrichmentWorkerDeps<Job> = {
    claim: async () => {
      claims++;
      return { jobKey: `j${claims}` };
    },
    complete: async () => {},
    fail: async () => {},
    process: async () => "completed",
  };

  const handled = await runEnrichmentWorkerOnce(deps, 2);

  assert.equal(handled, 2);
  assert.equal(claims, 2, "must not claim more than the batch size");
});

test("an empty queue drains immediately and reports zero handled", async () => {
  let completes = 0;
  const deps: EnrichmentWorkerDeps<Job> = {
    claim: async () => null,
    complete: async () => void completes++,
    fail: async () => {},
    process: async () => "completed",
  };

  const handled = await runEnrichmentWorkerOnce(deps, 5);

  assert.equal(handled, 0);
  assert.equal(completes, 0);
});
