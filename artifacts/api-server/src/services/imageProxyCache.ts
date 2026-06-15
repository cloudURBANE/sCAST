/**
 * In-process caching layer for `GET /api/image-proxy` (Phase 2).
 *
 * After Phase 1 the proxy only serves genuinely third-party hotlink sources
 * (search candidates, raw Fragrantica/Basenotes thumbnails) — our own processed
 * objects render straight from the CDN-backed bucket and never reach this route.
 * This module makes those *remaining* proxy fetches cheap and safe:
 *
 *   - **LRU byte cache** keyed by the normalized `url + trim`, bounded by a total
 *     byte budget and a TTL. Avoids re-fetching (and re-trimming) the same image.
 *   - **In-flight dedup**: a burst of identical requests collapses to a single
 *     upstream fetch (mirrors the pipeline's `Map<string, Promise>` pattern in
 *     `imagePipeline.ts`).
 *   - **Global concurrency limiter** around the (network + `sharp`, event-loop
 *     bound) loader so a flood of distinct URLs can't exhaust sockets/CPU.
 *
 * Memory note: this is a process-local cache and the Railway box has a documented
 * OOM history, so the byte budget defaults conservatively and every knob is
 * env-tunable. Correctness never depends on the cache — it is a pure latency
 * optimization that degrades to the old behavior at size 0.
 */

export type ImageProxyPayload = {
  body: Buffer;
  contentType: string;
};

type CacheRecord = ImageProxyPayload & {
  byteLength: number;
  expiresAt: number;
};

const MB = 1024 * 1024;

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export class ImageProxyAbortedError extends Error {
  constructor(message = "Image proxy request aborted") {
    super(message);
    this.name = "ImageProxyAbortedError";
  }
}

export class ImageProxyQueueFullError extends Error {
  constructor(message = "Image proxy queue is full") {
    super(message);
    this.name = "ImageProxyQueueFullError";
  }
}

function abortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  return new ImageProxyAbortedError();
}

type SemaphoreWaiter = {
  resolve: () => void;
  reject: (err: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
};

/**
 * A minimal fair semaphore. `acquire()` resolves immediately while slots are
 * free, otherwise queues FIFO until a `release()` frees one. Queueing is bounded
 * and abortable so disconnected clients do not pile up behind the proxy loader.
 */
export class Semaphore {
  private active = 0;
  private readonly waiters: SemaphoreWaiter[] = [];
  private readonly max: number;
  private readonly maxQueue: number;

  constructor(max: number, maxQueue = Number.POSITIVE_INFINITY) {
    this.max = max;
    this.maxQueue = Math.max(0, maxQueue);
  }

  acquire(options: { signal?: AbortSignal } = {}): Promise<void> {
    const { signal } = options;
    if (signal?.aborted) return Promise.reject(abortError(signal));

    if (this.active < this.max) {
      this.active += 1;
      return Promise.resolve();
    }

    if (this.waiters.length >= this.maxQueue) {
      return Promise.reject(new ImageProxyQueueFullError());
    }

    return new Promise<void>((resolve, reject) => {
      const waiter: SemaphoreWaiter = {
        resolve: () => {
          if (waiter.signal && waiter.onAbort) {
            waiter.signal.removeEventListener("abort", waiter.onAbort);
          }
          this.active += 1;
          resolve();
        },
        reject,
        signal,
      };
      waiter.onAbort = () => {
        const idx = this.waiters.indexOf(waiter);
        if (idx >= 0) this.waiters.splice(idx, 1);
        waiter.reject(abortError(signal));
      };
      if (signal) signal.addEventListener("abort", waiter.onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  release(): void {
    this.active -= 1;
    if (this.active < 0) this.active = 0;
    const next = this.waiters.shift();
    if (next) next.resolve();
  }

  /** Test/introspection helper. */
  get inUse(): number {
    return this.active;
  }
  get queueLength(): number {
    return this.waiters.length;
  }
}

export type ImageProxyCacheOptions = {
  maxBytes?: number;
  ttlMs?: number;
  maxConcurrency?: number;
  maxQueue?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
};

type InFlightEntry = {
  controller: AbortController;
  consumers: number;
  promise: Promise<ImageProxyPayload>;
  settled: boolean;
};

export class ImageProxyCache {
  // Insertion order == LRU order: least-recently-used is the first key. A `get`
  // hit re-inserts the key to move it to the most-recently-used end.
  private readonly store = new Map<string, CacheRecord>();
  private readonly inFlightEntries = new Map<string, InFlightEntry>();
  private readonly limiter: Semaphore;
  private readonly maxBytes: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private totalBytes = 0;

  constructor(options: ImageProxyCacheOptions = {}) {
    this.maxBytes = options.maxBytes ?? parsePositiveInt(process.env.IMAGE_PROXY_CACHE_MAX_BYTES, 64 * MB);
    this.ttlMs = options.ttlMs ?? parsePositiveInt(process.env.IMAGE_PROXY_CACHE_TTL_MS, 60 * 60 * 1000);
    this.now = options.now ?? Date.now;
    const concurrency = options.maxConcurrency ?? parsePositiveInt(process.env.IMAGE_PROXY_MAX_CONCURRENCY, 8);
    const maxQueue = options.maxQueue ?? parsePositiveInt(process.env.IMAGE_PROXY_MAX_QUEUE, 256);
    this.limiter = new Semaphore(Math.max(1, concurrency), maxQueue);
  }

  private get(key: string): ImageProxyPayload | undefined {
    const record = this.store.get(key);
    if (!record) return undefined;
    if (record.expiresAt <= this.now()) {
      this.store.delete(key);
      this.totalBytes -= record.byteLength;
      return undefined;
    }
    // Mark most-recently-used.
    this.store.delete(key);
    this.store.set(key, record);
    return { body: record.body, contentType: record.contentType };
  }

  private set(key: string, payload: ImageProxyPayload): void {
    if (this.maxBytes <= 0) return;
    const byteLength = payload.body.byteLength;
    // Never let a single oversized object blow the whole budget or wedge eviction.
    if (byteLength > this.maxBytes) return;

    const existing = this.store.get(key);
    if (existing) {
      this.totalBytes -= existing.byteLength;
      this.store.delete(key);
    }

    this.store.set(key, { ...payload, byteLength, expiresAt: this.now() + this.ttlMs });
    this.totalBytes += byteLength;

    // Evict least-recently-used until back within budget.
    while (this.totalBytes > this.maxBytes) {
      const oldestKey = this.store.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      const oldest = this.store.get(oldestKey)!;
      this.store.delete(oldestKey);
      this.totalBytes -= oldest.byteLength;
    }
  }

  /**
   * Return the cached payload for `key`, or run `loader` (under the global
   * concurrency cap, deduped against concurrent identical keys) and cache the
   * successful result. Loader rejections are never cached and propagate to all
   * waiters so the route still returns its error status.
   */
  async getOrLoad(
    key: string,
    loader: (signal: AbortSignal) => Promise<ImageProxyPayload>,
    options: { signal?: AbortSignal } = {},
  ): Promise<ImageProxyPayload> {
    if (options.signal?.aborted) throw abortError(options.signal);

    const cached = this.get(key);
    if (cached) return cached;

    const existing = this.inFlightEntries.get(key);
    if (existing) return this.attachConsumer(existing, options.signal);

    const controller = new AbortController();
    const entry: InFlightEntry = {
      controller,
      consumers: 0,
      promise: undefined as unknown as Promise<ImageProxyPayload>,
      settled: false,
    };
    const task = (async () => {
      let acquired = false;
      try {
        await this.limiter.acquire({ signal: controller.signal });
        acquired = true;
        if (controller.signal.aborted) throw abortError(controller.signal);
        const payload = await loader(controller.signal);
        if (controller.signal.aborted) throw abortError(controller.signal);
        this.set(key, payload);
        return payload;
      } finally {
        if (acquired) this.limiter.release();
        entry.settled = true;
        this.inFlightEntries.delete(key);
      }
    })();
    entry.promise = task;

    this.inFlightEntries.set(key, entry);
    return this.attachConsumer(entry, options.signal);
  }

  private attachConsumer(entry: InFlightEntry, signal?: AbortSignal): Promise<ImageProxyPayload> {
    if (signal?.aborted) return Promise.reject(abortError(signal));

    entry.consumers += 1;
    let released = false;
    let onAbort: (() => void) | undefined;

    const releaseConsumer = () => {
      if (released) return;
      released = true;
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      entry.consumers -= 1;
      if (entry.consumers <= 0 && !entry.settled) {
        entry.controller.abort(new ImageProxyAbortedError("Image proxy request abandoned"));
      }
    };

    return new Promise<ImageProxyPayload>((resolve, reject) => {
      onAbort = () => {
        releaseConsumer();
        reject(abortError(signal));
      };
      if (signal) signal.addEventListener("abort", onAbort, { once: true });

      entry.promise.then(
        (payload) => {
          releaseConsumer();
          resolve(payload);
        },
        (err: unknown) => {
          releaseConsumer();
          reject(err);
        },
      );
    });
  }

  /** Test/introspection helpers. */
  get sizeBytes(): number {
    return this.totalBytes;
  }
  get entryCount(): number {
    return this.store.size;
  }
  get inFlightCount(): number {
    return this.inFlightEntries.size;
  }
}

/**
 * Build the cache key. Two requests collapse only when they fetch the exact same
 * normalized upstream URL with the same trim flag (trim changes the bytes).
 */
export function imageProxyCacheKey(normalizedUrl: string, trim: boolean): string {
  return `${normalizedUrl} trim=${trim ? 1 : 0}`;
}

/**
 * Differentiated downstream `Cache-Control`:
 *   - content-addressed / versioned objects (path under `images/processed/`, or a
 *     `v=` cache-buster present) are effectively immutable → cache for a year.
 *   - everything else is a volatile third-party hotlink → cache for a day.
 */
export function isImmutableImageTarget(target: URL): boolean {
  const href = target.toString();
  if (href.includes("/images/processed/") || /images%2[fF]processed%2[fF]/.test(href)) return true;
  return target.searchParams.get("v") !== null;
}

export function cacheControlForImageTarget(target: URL): string {
  // `s-maxage` mirrors `max-age` per tier so shared CDNs (Vercel edge / Railway
  // proxy) cache the proxied image as long as the browser does, instead of
  // treating it as private. Image responses carry no Set-Cookie, so the
  // middleware's cookie-stripping safety net leaves these directives intact.
  return isImmutableImageTarget(target)
    ? "public, max-age=31536000, s-maxage=31536000, immutable"
    : "public, max-age=86400, s-maxage=86400, stale-while-revalidate=86400";
}

/** Process-wide singleton used by the route. */
export const imageProxyCache = new ImageProxyCache();
