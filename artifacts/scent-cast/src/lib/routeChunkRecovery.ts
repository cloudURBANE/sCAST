import type { ComponentType } from 'react';

const ROUTE_CHUNK_RELOAD_KEY = 'scent_route_chunk_reload_attempted';

export function isRouteChunkLoadError(error: unknown): boolean {
  const name = error && typeof error === 'object' ? String((error as { name?: unknown }).name ?? '') : '';
  const message = error instanceof Error ? error.message : String(error ?? '');
  // Covers every engine's stale-chunk failure shape:
  //  - webpack/rollup "ChunkLoadError" / "Loading chunk N failed"
  //  - Chrome "Failed to fetch dynamically imported module" /
  //    "Failed to load module script"
  //  - Firefox "error loading dynamically imported module" /
  //    "disallowed MIME type"
  //  - Safari "Importing a module script failed" and — when a deleted hashed
  //    chunk gets rewritten to index.html by the SPA fallback — the TypeError
  //    "'text/html' is not a valid JavaScript MIME type", plus its generic
  //    network-failure TypeError "Load failed"
  //  - Vite "Unable to preload CSS"
  return /ChunkLoadError|Loading chunk [\w-]+ failed|Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|is not a valid JavaScript MIME type|disallowed MIME type|Failed to load module script|Module script load failed|^(TypeError:?\s*)?Load failed\.?$/i
    .test(`${name} ${message}`.trim());
}

/**
 * Reload into a fresh app shell, first nudging the service worker: check for a
 * new build and, if one is already installed and waiting, activate it before
 * navigating. Without this, a plain reload on an installed PWA is served the
 * SAME stale precached shell that just failed, and recovery loops uselessly.
 * Every step is best-effort and time-bounded so the reload always happens.
 */
export function reloadThroughFreshServiceWorker(): void {
  const reload = () => window.location.reload();

  if (!('serviceWorker' in navigator)) {
    reload();
    return;
  }

  const timeBox = <T,>(promise: Promise<T>, ms: number): Promise<T | undefined> =>
    Promise.race([promise, new Promise<undefined>((resolve) => setTimeout(resolve, ms))]);

  void (async () => {
    try {
      const registration = await timeBox(navigator.serviceWorker.getRegistration(), 1000);
      if (registration) {
        // Fetch the latest sw.js so a new build starts installing now instead
        // of at the next scheduled check.
        await timeBox(registration.update().catch(() => undefined), 2500);
        const waiting = registration.waiting;
        if (waiting) {
          // sw.ts handles SKIP_WAITING + clientsClaim, so the reload below is
          // served by the NEW precache instead of the stale one.
          waiting.postMessage({ type: 'SKIP_WAITING' });
          await new Promise((resolve) => setTimeout(resolve, 350));
        }
      }
    } catch {
      /* best-effort — fall through to the reload */
    }
    reload();
  })();
}

export function reloadForStaleRouteChunk(error: unknown): boolean {
  if (typeof window === 'undefined' || !isRouteChunkLoadError(error)) return false;
  return reloadOnceForStaleChunk();
}

/**
 * Guarded single reload for a stale-chunk failure. Split from the error-shape
 * check so callers that already KNOW a chunk failed to load (e.g. Vite's
 * `vite:preloadError` event) can trigger recovery without re-matching messages.
 */
export function reloadOnceForStaleChunk(): boolean {
  if (typeof window === 'undefined') return false;

  try {
    const attemptedFor = window.sessionStorage.getItem(ROUTE_CHUNK_RELOAD_KEY);
    const route = `${window.location.pathname}${window.location.search}`;
    if (attemptedFor === route) return false;
    window.sessionStorage.setItem(ROUTE_CHUNK_RELOAD_KEY, route);
  } catch {
    // Storage can be unavailable in private mode. A single browser reload is
    // still better than stranding the user on the global crash panel.
  }

  reloadThroughFreshServiceWorker();
  return true;
}

export async function loadRouteChunk<T extends ComponentType<unknown>>(
  loader: () => Promise<{ default: T }>,
): Promise<{ default: T }> {
  try {
    const mod = await loader();
    if (typeof window !== 'undefined') {
      try {
        window.sessionStorage.removeItem(ROUTE_CHUNK_RELOAD_KEY);
      } catch {
        /* ignore unavailable storage */
      }
    }
    return mod;
  } catch (error) {
    if (isRouteChunkLoadError(error)) {
      try {
        return await loader();
      } catch (retryError) {
        if (reloadForStaleRouteChunk(retryError)) {
          return new Promise(() => undefined);
        }
        throw retryError;
      }
    }
    throw error;
  }
}
