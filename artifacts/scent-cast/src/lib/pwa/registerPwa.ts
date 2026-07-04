/// <reference types="vite-plugin-pwa/client" />
//
// Service-worker registration + update orchestration for the SPA.
//
// Framework-agnostic on purpose: it only registers the SW and exposes imperative
// helpers. The React surface (components/pwa/PwaUpdater.tsx) decides how to ask
// the user to refresh. Registration uses `registerType: "prompt"` (see
// vite.config.ts), so a new build installs a *waiting* worker and fires
// `onNeedRefresh` instead of silently swapping.
import { registerSW } from "virtual:pwa-register";

type UpdateSW = (reloadPage?: boolean) => Promise<void>;

let updateSW: UpdateSW | null = null;

export interface PwaCallbacks {
  /** A new build is installed and waiting — prompt the user to refresh. */
  onNeedRefresh?: () => void;
  /** The app shell has been cached and is ready to work offline. */
  onOfflineReady?: () => void;
}

// Browsers only re-check the SW script on navigations (plus a ~24h heuristic).
// An installed PWA is resumed, not re-navigated, so without explicit checks it
// can keep serving a build many deploys behind what the same URL shows in a
// browser tab. Re-check on every resume (throttled) and hourly while open so
// the "refresh" prompt appears close to each deploy instead of days later.
const UPDATE_CHECK_MIN_GAP_MS = 15 * 60 * 1000;
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

function scheduleUpdateChecks(registration: ServiceWorkerRegistration): void {
  let lastCheck = Date.now();

  const check = () => {
    if (!navigator.onLine) return;
    lastCheck = Date.now();
    registration.update().catch(() => {
      /* transient network failures are fine — the next check retries */
    });
  };

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (Date.now() - lastCheck < UPDATE_CHECK_MIN_GAP_MS) return;
    check();
  });

  window.setInterval(check, UPDATE_CHECK_INTERVAL_MS);
}

export function setupPwa(callbacks: PwaCallbacks = {}): void {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
  // Guard against double registration (e.g. React 18 StrictMode double-effects).
  if (updateSW) return;

  updateSW = registerSW({
    immediate: true,
    onRegisteredSW(_swUrl, registration) {
      if (registration) scheduleUpdateChecks(registration);
    },
    onNeedRefresh() {
      callbacks.onNeedRefresh?.();
    },
    onOfflineReady() {
      callbacks.onOfflineReady?.();
    },
    onRegisterError(error) {
      // Never fatal: a failed SW registration just means no offline support.
      console.error("[pwa] service worker registration failed", error);
    },
  });
}

/** Activate the waiting worker and reload into the new app shell. */
export function applyPwaUpdate(): void {
  void updateSW?.(true);
}

/** Runtime caches that hold authenticated/per-user API responses. Kept in sync
 *  with the `CLEAR_API_CACHE` handler in `sw.ts`. */
const PWA_API_CACHE_NAMES = ["api-data", "fragrance-search"];

/**
 * Drop cached authenticated API responses. Call on sign-out so a shared device
 * never serves the previous user's vault from the `api-data` runtime cache.
 *
 * Messaging only the active `controller` silently does nothing when the page is
 * not yet controlled by a service worker (first visit, hard reload, or before
 * the SW takes control) — leaving the previous user's wardrobe/profile in the
 * `api-data` cache. So fall back to deleting the caches directly from the page
 * (CacheStorage is available in the window context) whenever there is no
 * controller to receive the message.
 */
export function clearPwaApiCache(): void {
  const controller = navigator.serviceWorker?.controller;
  if (controller) {
    controller.postMessage({ type: "CLEAR_API_CACHE" });
    return;
  }
  if (typeof caches !== "undefined") {
    void Promise.all(PWA_API_CACHE_NAMES.map((name) => caches.delete(name))).catch(() => {
      /* best-effort: a failed eviction must never break sign-out */
    });
  }
}
