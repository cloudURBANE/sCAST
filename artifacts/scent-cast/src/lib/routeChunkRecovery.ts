import type { ComponentType } from 'react';

const ROUTE_CHUNK_RELOAD_KEY = 'scent_route_chunk_reload_attempted';

export function isRouteChunkLoadError(error: unknown): boolean {
  const name = error && typeof error === 'object' ? String((error as { name?: unknown }).name ?? '') : '';
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /ChunkLoadError|Loading chunk \d+ failed|Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS/i
    .test(`${name} ${message}`);
}

export function reloadForStaleRouteChunk(error: unknown): boolean {
  if (typeof window === 'undefined' || !isRouteChunkLoadError(error)) return false;

  try {
    const attemptedFor = window.sessionStorage.getItem(ROUTE_CHUNK_RELOAD_KEY);
    const route = `${window.location.pathname}${window.location.search}`;
    if (attemptedFor === route) return false;
    window.sessionStorage.setItem(ROUTE_CHUNK_RELOAD_KEY, route);
  } catch {
    // Storage can be unavailable in private mode. A single browser reload is
    // still better than stranding the user on the global crash panel.
  }

  window.location.reload();
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
