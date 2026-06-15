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

export function setupPwa(callbacks: PwaCallbacks = {}): void {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
  // Guard against double registration (e.g. React 18 StrictMode double-effects).
  if (updateSW) return;

  updateSW = registerSW({
    immediate: true,
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

/**
 * Drop cached authenticated API responses. Call on sign-out so a shared device
 * never serves the previous user's vault from the `api-data` runtime cache.
 */
export function clearPwaApiCache(): void {
  navigator.serviceWorker?.controller?.postMessage({ type: "CLEAR_API_CACHE" });
}
