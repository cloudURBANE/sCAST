import assert from "node:assert/strict";
import test from "node:test";
import {
  cacheControlForImageTarget,
  imageProxyCacheKey,
  ImageProxyCache,
  isImmutableImageTarget,
  Semaphore,
  type ImageProxyPayload,
} from "./imageProxyCache.ts";

function payload(bytes: number, contentType = "image/webp"): ImageProxyPayload {
  return { body: Buffer.alloc(bytes, 1), contentType };
}

test("getOrLoad caches the first successful result and serves it without re-running the loader", async () => {
  const cache = new ImageProxyCache({ maxBytes: 1024, ttlMs: 10_000 });
  let calls = 0;
  const loader = async () => {
    calls += 1;
    return payload(100);
  };

  const a = await cache.getOrLoad("k", loader);
  const b = await cache.getOrLoad("k", loader);

  assert.equal(calls, 1, "loader runs once; second call is a cache hit");
  assert.equal(a.body.byteLength, 100);
  assert.equal(b.body.byteLength, 100);
  assert.equal(cache.entryCount, 1);
});

test("in-flight dedup collapses concurrent identical keys to a single loader call", async () => {
  const cache = new ImageProxyCache({ maxBytes: 4096, ttlMs: 10_000 });
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const loader = async () => {
    calls += 1;
    await gate;
    return payload(50);
  };

  const all = Promise.all([
    cache.getOrLoad("same", loader),
    cache.getOrLoad("same", loader),
    cache.getOrLoad("same", loader),
  ]);
  assert.equal(cache.inFlightCount, 1, "all three share one in-flight promise");
  release();
  await all;
  assert.equal(calls, 1);
  assert.equal(cache.inFlightCount, 0, "in-flight entry is cleared after settle");
});

test("loader rejections propagate, are not cached, and clear the in-flight slot", async () => {
  const cache = new ImageProxyCache({ maxBytes: 4096, ttlMs: 10_000 });
  let calls = 0;
  const loader = async () => {
    calls += 1;
    throw new Error("upstream 502");
  };

  await assert.rejects(cache.getOrLoad("bad", loader), /upstream 502/);
  assert.equal(cache.inFlightCount, 0);
  assert.equal(cache.entryCount, 0, "failures are never cached");
  // A subsequent request retries (no negative caching).
  await assert.rejects(cache.getOrLoad("bad", loader), /upstream 502/);
  assert.equal(calls, 2);
});

test("LRU eviction keeps total bytes within the budget, evicting least-recently-used first", async () => {
  const cache = new ImageProxyCache({ maxBytes: 250, ttlMs: 10_000 });
  await cache.getOrLoad("a", async () => payload(100));
  await cache.getOrLoad("b", async () => payload(100));
  // Touch "a" so "b" becomes least-recently-used.
  await cache.getOrLoad("a", async () => payload(100));
  // Adding "c" (100) pushes total to 300 > 250 → evict LRU ("b").
  await cache.getOrLoad("c", async () => payload(100));

  assert.ok(cache.sizeBytes <= 250, `sizeBytes ${cache.sizeBytes} within budget`);
  assert.equal(cache.entryCount, 2);
  let bReloaded = false;
  await cache.getOrLoad("b", async () => {
    bReloaded = true;
    return payload(100);
  });
  assert.equal(bReloaded, true, "b was evicted and had to be reloaded");
});

test("an object larger than the whole budget is served but not retained", async () => {
  const cache = new ImageProxyCache({ maxBytes: 100, ttlMs: 10_000 });
  const result = await cache.getOrLoad("huge", async () => payload(500));
  assert.equal(result.body.byteLength, 500, "still returned to the caller");
  assert.equal(cache.entryCount, 0, "not cached — would blow the budget");
  assert.equal(cache.sizeBytes, 0);
});

test("entries expire after the TTL using the injected clock", async () => {
  let nowMs = 1_000;
  const cache = new ImageProxyCache({ maxBytes: 1024, ttlMs: 5_000, now: () => nowMs });
  let calls = 0;
  const loader = async () => {
    calls += 1;
    return payload(10);
  };

  await cache.getOrLoad("k", loader);
  nowMs += 4_999;
  await cache.getOrLoad("k", loader);
  assert.equal(calls, 1, "still fresh just before TTL");
  nowMs += 2; // now 1ms past expiry
  await cache.getOrLoad("k", loader);
  assert.equal(calls, 2, "reloaded after TTL elapsed");
});

test("maxBytes=0 disables caching entirely (degrades to passthrough)", async () => {
  const cache = new ImageProxyCache({ maxBytes: 0, ttlMs: 10_000 });
  let calls = 0;
  const loader = async () => {
    calls += 1;
    return payload(10);
  };
  await cache.getOrLoad("k", loader);
  await cache.getOrLoad("k", loader);
  assert.equal(calls, 2, "nothing retained, every call reloads");
  assert.equal(cache.entryCount, 0);
});

test("Semaphore caps concurrent holders and serves waiters FIFO", async () => {
  const sem = new Semaphore(2);
  await sem.acquire();
  await sem.acquire();
  assert.equal(sem.inUse, 2);

  let third = false;
  const pending = sem.acquire().then(() => {
    third = true;
  });
  await Promise.resolve();
  assert.equal(third, false, "third acquire blocks while at capacity");

  sem.release();
  await pending;
  assert.equal(third, true, "released slot hands off to the waiter");
  assert.equal(sem.inUse, 2);
});

test("getOrLoad never runs more loaders concurrently than the limiter allows", async () => {
  const cache = new ImageProxyCache({ maxBytes: 1 << 20, ttlMs: 10_000, maxConcurrency: 2 });
  let active = 0;
  let peak = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const loader = async (): Promise<ImageProxyPayload> => {
    active += 1;
    peak = Math.max(peak, active);
    await gate;
    active -= 1;
    return payload(1);
  };

  const all = Promise.all([0, 1, 2, 3].map((i) => cache.getOrLoad(`k${i}`, loader)));
  // Give the limiter a chance to admit everything it will before any loader finishes.
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(peak, 2, `only the cap (2) may run at once; saw ${peak}`);

  release();
  await all;
  // The remaining two were admitted only after slots freed — peak never grew.
  assert.equal(peak, 2);
});

test("imageProxyCacheKey distinguishes the trim flag", () => {
  assert.notEqual(
    imageProxyCacheKey("https://x/y.jpg", true),
    imageProxyCacheKey("https://x/y.jpg", false),
  );
  assert.equal(
    imageProxyCacheKey("https://x/y.jpg", true),
    imageProxyCacheKey("https://x/y.jpg", true),
  );
});

test("cache-control marks processed and versioned objects immutable, third-party volatile", () => {
  const processed = new URL("https://abc.supabase.co/storage/v1/object/public/images/images/processed/b/h.webp");
  const firebase = new URL(
    "https://firebasestorage.googleapis.com/v0/b/x/o/images%2Fprocessed%2Fb%2Fh.webp?alt=media",
  );
  const versioned = new URL("https://cdn.example.com/bottle.jpg?v=abc123");
  const thirdParty = new URL("https://fimgs.net/mdimg/perfume/375x500.123.jpg");

  assert.equal(isImmutableImageTarget(processed), true);
  assert.equal(isImmutableImageTarget(firebase), true);
  assert.equal(isImmutableImageTarget(versioned), true);
  assert.equal(isImmutableImageTarget(thirdParty), false);

  assert.match(cacheControlForImageTarget(processed), /immutable/);
  assert.match(cacheControlForImageTarget(versioned), /immutable/);
  assert.match(cacheControlForImageTarget(thirdParty), /stale-while-revalidate/);
  assert.doesNotMatch(cacheControlForImageTarget(thirdParty), /immutable/);
});
