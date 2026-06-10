import test from "node:test";
import assert from "node:assert/strict";
import { createBoundedLimiter, LimiterQueueFullError } from "./boundedLimiter.ts";

type Deferred = { promise: Promise<void>; resolve: () => void; reject: (err: Error) => void };

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("runs at most maxConcurrent tasks at once and drains the queue in order", async () => {
  const run = createBoundedLimiter(1, 5);
  const gates = [deferred(), deferred(), deferred()];
  const started: number[] = [];

  const jobs = gates.map((gate, i) =>
    run(async () => {
      started.push(i);
      await gate.promise;
      return i;
    }),
  );

  // Only the first task may start; the rest are queued.
  await Promise.resolve();
  assert.deepEqual(started, [0]);

  gates[0].resolve();
  assert.equal(await jobs[0], 0);
  gates[1].resolve();
  assert.equal(await jobs[1], 1);
  gates[2].resolve();
  assert.equal(await jobs[2], 2);
  assert.deepEqual(started, [0, 1, 2]);
});

test("rejects with LimiterQueueFullError before the task runs once the queue is full", async () => {
  const run = createBoundedLimiter(1, 1);
  const gate = deferred();
  let overflowRan = false;

  const running = run(() => gate.promise);
  const queued = run(async () => {});
  const overflow = run(async () => {
    overflowRan = true;
  });

  await assert.rejects(overflow, LimiterQueueFullError);
  assert.equal(overflowRan, false);

  gate.resolve();
  await running;
  await queued;
});

test("releases the slot when a task throws", async () => {
  const run = createBoundedLimiter(1, 0);
  await assert.rejects(
    run(async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  // The slot must be free again — a follow-up task runs instead of rejecting.
  assert.equal(
    await run(async () => "ok"),
    "ok",
  );
});

test("never exceeds maxConcurrent under interleaved load", async () => {
  const run = createBoundedLimiter(2, 10);
  let active = 0;
  let peak = 0;

  const jobs = Array.from({ length: 10 }, () =>
    run(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
    }),
  );

  await Promise.all(jobs);
  assert.equal(active, 0);
  assert.equal(peak <= 2, true);
});
