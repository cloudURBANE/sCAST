/**
 * Bounded concurrency limiter with a fixed-size waiting queue.
 *
 * `createBoundedLimiter(maxConcurrent, maxWaiting)` returns a `run(task)`
 * function. At most `maxConcurrent` tasks execute at once; up to `maxWaiting`
 * callers queue behind them (FIFO). Once the queue is full, `run` rejects
 * immediately with `LimiterQueueFullError` *before* the task starts, so
 * callers can refuse work they don't have the resources for instead of
 * accepting it and falling over mid-flight.
 */
export class LimiterQueueFullError extends Error {
  constructor(maxConcurrent: number, maxWaiting: number) {
    super(`Limiter queue full (${maxConcurrent} running, ${maxWaiting} waiting)`);
    this.name = "LimiterQueueFullError";
  }
}

export type BoundedLimiter = <T>(task: () => Promise<T>) => Promise<T>;

export function createBoundedLimiter(maxConcurrent: number, maxWaiting: number): BoundedLimiter {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new Error("maxConcurrent must be a positive integer");
  }
  if (!Number.isInteger(maxWaiting) || maxWaiting < 0) {
    throw new Error("maxWaiting must be a non-negative integer");
  }

  // `active` counts owned slots. On release, a slot is handed directly to the
  // next waiter (count unchanged) rather than decremented-then-reacquired —
  // otherwise a new caller arriving between the decrement and the waiter's
  // microtask resuming could push `active` past `maxConcurrent`.
  let active = 0;
  const waiters: Array<() => void> = [];

  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (active >= maxConcurrent) {
      if (waiters.length >= maxWaiting) {
        throw new LimiterQueueFullError(maxConcurrent, maxWaiting);
      }
      await new Promise<void>((resolve) => waiters.push(resolve));
    } else {
      active += 1;
    }
    try {
      return await task();
    } finally {
      const next = waiters.shift();
      if (next) next();
      else active -= 1;
    }
  };
}
