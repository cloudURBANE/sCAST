/**
 * measure-wardrobe-image-load.ts
 *
 * End-to-end load-timing harness for wardrobe bottle images. Answers the
 * question: "By the time a real user lands on the site, how long do the
 * wardrobe images actually take to load, and do any of them fail?"
 *
 * It reproduces exactly what the browser does:
 *   1. GET <base>/api/wardrobe with the user's bearer token.
 *   2. For each fragrance, build the SAME proxied URL the SPA builds
 *      (see artifacts/scent-cast/src/lib/imageProxy.ts -> proxiedImageUrl).
 *   3. Fetch every image with the browser's real concurrency cap (6),
 *      caches disabled, measuring TTFB, full-body time, status and bytes.
 *   4. Optionally also fetch the underlying storage URL DIRECTLY (bypassing
 *      /api/image-proxy) so you can see how much latency the proxy hop adds.
 *   5. Print p50/p95/p99/max, failure rate, total wall-clock, and a
 *      proxy-vs-direct comparison. Exits non-zero if it breaches the SLO
 *      thresholds so it can gate CI / a pre-deploy check.
 *
 * No browser and no extra deps required (Node >= 20 global fetch + tsx).
 *
 * Usage (PowerShell):
 *   $env:TARGET_BASE="https://scentbeam.com"; $env:SCENT_TOKEN="<users.token uuid>"; \
 *     pnpm --filter @workspace/scripts run measure:image-load
 *
 * Useful env vars:
 *   TARGET_BASE     base origin to hit (default http://localhost:3000)
 *   SCENT_TOKEN     opaque users.token UUID (Authorization: Bearer ...). Required
 *                   unless IMAGE_URLS is provided.
 *   IMAGE_URLS      comma-separated raw image URLs to test directly, skipping the
 *                   /api/wardrobe call (handy when you can't get a token).
 *   CONCURRENCY     parallel requests (default 6, matches Chrome's per-origin cap)
 *   RUNS            how many cold passes to average (default 1)
 *   COMPARE_DIRECT  "1" to also time the underlying storage URL directly
 *   IMAGE_CDN_BASES comma-separated CDN bases we control (mirrors the SPA's
 *                   VITE_IMAGE_CDN_BASES); processed objects under these or under
 *                   images/processed/ are fetched directly, bypassing the proxy.
 *   SLO_P95_MS      fail threshold for p95 total load (default 1500)
 *   SLO_FAIL_RATE   fail threshold for image failure rate 0..1 (default 0.02)
 *   TIMEOUT_MS      per-request timeout (default 15000)
 */

type Stat = {
  label: string;
  url: string;
  status: number;
  ok: boolean;
  ttfbMs: number;
  totalMs: number;
  bytes: number;
  error?: string;
};

const TARGET_BASE = (process.env.TARGET_BASE || "http://localhost:3000").replace(/\/+$/, "");
const SCENT_TOKEN = process.env.SCENT_TOKEN?.trim();
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 6));
const RUNS = Math.max(1, Number(process.env.RUNS || 1));
const COMPARE_DIRECT = process.env.COMPARE_DIRECT === "1";
const SLO_P95_MS = Number(process.env.SLO_P95_MS || 1500);
const SLO_FAIL_RATE = Number(process.env.SLO_FAIL_RATE || 0.02);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 15000);
// Mirror of the SPA's VITE_IMAGE_CDN_BASES allowlist (see proxiedImageUrl below).
const IMAGE_CDN_BASES = (process.env.IMAGE_CDN_BASES || "")
  .split(",")
  .map((s) => s.trim().replace(/\/+$/, ""))
  .filter(Boolean);

/**
 * Mirror of artifacts/scent-cast/src/lib/imageProxy.ts:isProcessedStorageImageUrl.
 * Our processed objects live under images/processed/ (Supabase/local keep it
 * literal; Firebase alt=media percent-encodes it).
 */
function isProcessedStorageImageUrl(url: string): boolean {
  if (url.includes("/images/processed/") || /images%2[fF]processed%2[fF]/.test(url)) return true;
  return IMAGE_CDN_BASES.some((base) => url === base || url.startsWith(`${base}/`));
}

/**
 * Mirror of artifacts/scent-cast/src/lib/imageProxy.ts:proxiedImageUrl.
 * Keep in sync if the SPA's proxy logic changes — the whole point is that the
 * harness exercises the *exact* URL the browser requests.
 */
function proxiedImageUrl(raw: string, packshot = true): string {
  if (!raw) return "";
  let u = raw.trim();
  if (u.startsWith("data:")) return u;
  if (u.startsWith("//")) u = `https:${u}`;
  if (u.startsWith("/api/image-objects/")) return `${TARGET_BASE}${u}`;
  if (!/^https?:\/\//i.test(u)) {
    // Relative same-origin path (rare) — resolve against base.
    return u.startsWith("/") ? `${TARGET_BASE}${u}` : u;
  }
  // Phase 1: our processed CDN objects render directly, bypassing the proxy.
  if (isProcessedStorageImageUrl(u)) return u;
  let version: string | null = null;
  try {
    version = new URL(u).searchParams.get("v");
  } catch {
    /* malformed: encode as-is */
  }
  const base = `${TARGET_BASE}/api/image-proxy?url=${encodeURIComponent(u)}${
    version !== null ? `&v=${encodeURIComponent(version)}` : ""
  }`;
  return packshot ? `${base}&trim=1` : base;
}

async function timedFetch(label: string, url: string): Promise<Stat> {
  const start = performance.now();
  try {
    const res = await fetch(url, {
      // Defeat any client cache so every pass is a true cold load.
      cache: "no-store",
      headers: { Accept: "image/avif,image/webp,image/png,image/jpeg,*/*" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const ttfbMs = performance.now() - start;
    const buf = await res.arrayBuffer();
    const totalMs = performance.now() - start;
    return {
      label,
      url,
      status: res.status,
      ok: res.ok,
      ttfbMs,
      totalMs,
      bytes: buf.byteLength,
    };
  } catch (err: any) {
    return {
      label,
      url,
      status: 0,
      ok: false,
      ttfbMs: performance.now() - start,
      totalMs: performance.now() - start,
      bytes: 0,
      error: err?.message || String(err),
    };
  }
}

/** Run tasks with a fixed concurrency cap; returns results in completion order. */
async function runPool<T>(items: T[], limit: number, worker: (item: T) => Promise<Stat>): Promise<Stat[]> {
  const results: Stat[] = [];
  let cursor = 0;
  async function next(): Promise<void> {
    const idx = cursor++;
    if (idx >= items.length) return;
    results.push(await worker(items[idx]!));
    await next();
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => next()));
  return results;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

function summarize(label: string, stats: Stat[]) {
  const oks = stats.filter((s) => s.ok);
  const totals = oks.map((s) => s.totalMs).sort((a, b) => a - b);
  const ttfbs = oks.map((s) => s.ttfbMs).sort((a, b) => a - b);
  const failRate = stats.length ? (stats.length - oks.length) / stats.length : 0;
  return {
    label,
    count: stats.length,
    failures: stats.length - oks.length,
    failRate,
    ttfb_p50: Math.round(percentile(ttfbs, 50)),
    total_p50: Math.round(percentile(totals, 50)),
    total_p95: Math.round(percentile(totals, 95)),
    total_p99: Math.round(percentile(totals, 99)),
    total_max: Math.round(totals.at(-1) ?? 0),
    avgKB: oks.length ? Math.round(oks.reduce((a, s) => a + s.bytes, 0) / oks.length / 1024) : 0,
  };
}

async function collectImageUrls(): Promise<string[]> {
  const fromEnv = process.env.IMAGE_URLS?.split(",").map((s) => s.trim()).filter(Boolean);
  if (fromEnv && fromEnv.length) return fromEnv;

  if (!SCENT_TOKEN) {
    throw new Error(
      "Provide SCENT_TOKEN (a users.token UUID) to load /api/wardrobe, or IMAGE_URLS to test raw URLs directly.",
    );
  }
  const res = await fetch(`${TARGET_BASE}/api/wardrobe`, {
    headers: { Authorization: `Bearer ${SCENT_TOKEN}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`GET /api/wardrobe -> HTTP ${res.status}. (401 = stale/invalid token; see WARDROBE_SYNC_FAILED_PC_DIAGNOSIS.md)`);
  }
  const body = (await res.json()) as Array<Record<string, unknown>>;
  const urls = body
    .map((f) => (typeof f.imageUrl === "string" ? f.imageUrl : ""))
    .filter(Boolean);
  return urls;
}

async function main() {
  console.log(`\n=== Wardrobe image-load timing ===`);
  console.log(`target=${TARGET_BASE} concurrency=${CONCURRENCY} runs=${RUNS} compareDirect=${COMPARE_DIRECT}`);

  const rawUrls = await collectImageUrls();
  if (rawUrls.length === 0) {
    console.error("No wardrobe images found. Wardrobe is empty or the response shape changed.");
    process.exit(2);
  }
  console.log(`Found ${rawUrls.length} wardrobe image(s).\n`);

  const proxyStats: Stat[] = [];
  const directStats: Stat[] = [];

  for (let run = 1; run <= RUNS; run++) {
    const proxyTargets = rawUrls.map((u) => ({ label: "proxy", proxied: proxiedImageUrl(u), raw: u }));

    const wallStart = performance.now();
    const r = await runPool(proxyTargets, CONCURRENCY, (t) => timedFetch("proxy", t.proxied));
    const wallMs = Math.round(performance.now() - wallStart);
    proxyStats.push(...r);
    console.log(`[run ${run}] proxy path: ${r.length} images, wall-clock to load all = ${wallMs}ms`);

    if (COMPARE_DIRECT) {
      const directTargets = rawUrls.filter((u) => /^https?:\/\//i.test(u));
      const dStart = performance.now();
      const dr = await runPool(directTargets, CONCURRENCY, (u) => timedFetch("direct", u));
      const dWall = Math.round(performance.now() - dStart);
      directStats.push(...dr);
      console.log(`[run ${run}] direct CDN path: ${dr.length} images, wall-clock to load all = ${dWall}ms`);
    }
  }

  const proxySummary = summarize("proxy (/api/image-proxy)", proxyStats);
  console.log(`\n${JSON.stringify(proxySummary, null, 2)}`);

  if (COMPARE_DIRECT && directStats.length) {
    const directSummary = summarize("direct CDN (bypass proxy)", directStats);
    console.log(`\n${JSON.stringify(directSummary, null, 2)}`);
    const delta = proxySummary.total_p95 - directSummary.total_p95;
    console.log(`\n>> Proxy adds ~${delta}ms at p95 vs hitting storage directly.`);
  }

  // Show the worst offenders to make slow/broken images actionable.
  const worst = [...proxyStats].sort((a, b) => b.totalMs - a.totalMs).slice(0, 5);
  console.log(`\nSlowest / failed images:`);
  for (const s of worst) {
    console.log(`  ${s.ok ? "OK " : "ERR"} ${Math.round(s.totalMs)}ms  ${s.status}  ${s.error ?? ""}  ${s.url.slice(0, 110)}`);
  }

  // SLO gate.
  let failed = false;
  if (proxySummary.total_p95 > SLO_P95_MS) {
    console.error(`\nSLO BREACH: p95 ${proxySummary.total_p95}ms > ${SLO_P95_MS}ms`);
    failed = true;
  }
  if (proxySummary.failRate > SLO_FAIL_RATE) {
    console.error(`SLO BREACH: failure rate ${(proxySummary.failRate * 100).toFixed(1)}% > ${(SLO_FAIL_RATE * 100).toFixed(1)}%`);
    failed = true;
  }
  console.log(failed ? "\nRESULT: FAIL\n" : "\nRESULT: PASS\n");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(2);
});

// Mark this file as an ES module so its top-level helpers (main, etc.) get module
// scope instead of leaking into the shared global script scope alongside sibling
// one-off scripts (which otherwise collide as duplicate implementations).
export {};
