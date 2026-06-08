/**
 * Lightweight client-side image-load telemetry (Phase 4).
 *
 * Goal: make wardrobe image regressions visible in *production*, not just in the
 * offline timing harness. Every bottle image reports one terminal outcome —
 * loaded, recovered via the proxy fallback, or failed — with how long it took
 * and how many attempts it needed.
 *
 * This is deliberately dependency-free and best-effort:
 *   - dispatches a `scentbeam:image-metric` CustomEvent on `window` so a future
 *     dashboard / RUM listener can consume it with zero coupling here;
 *   - POSTs a `navigator.sendBeacon` to `VITE_IMAGE_METRICS_URL` when that env is
 *     set (non-blocking, fire-and-forget);
 *   - logs to `console.debug` in dev only.
 * It never throws and is a no-op during SSR / non-browser environments.
 */

export type ImageOutcome = "load" | "error" | "proxy-fallback";

export type ImageMetric = {
  /** Terminal outcome for this image slot. */
  outcome: ImageOutcome;
  /** Milliseconds from the first attempt to this outcome. */
  ms: number;
  /** How many `onError` events fired before this outcome (0 on a clean load). */
  attempts: number;
  /** Whether the bytes that ultimately resolved came via the proxy fallback. */
  usedProxyFallback: boolean;
  /** The image URL involved (truncated by consumers if needed). */
  url: string;
  /** Bottle image variant, for slicing metrics (hero vs thumb, etc.). */
  variant?: string;
};

const METRICS_URL = (import.meta.env?.VITE_IMAGE_METRICS_URL as string | undefined)?.trim();
const IS_DEV = Boolean(import.meta.env?.DEV);

export function reportImageMetric(metric: ImageMetric): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new CustomEvent<ImageMetric>("scentbeam:image-metric", { detail: metric }));

    if (METRICS_URL && typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      const blob = new Blob([JSON.stringify(metric)], { type: "application/json" });
      navigator.sendBeacon(METRICS_URL, blob);
    }

    if (IS_DEV) {
      const tag = metric.outcome === "load" ? "✓" : metric.outcome === "proxy-fallback" ? "↻" : "✗";
      // eslint-disable-next-line no-console
      console.debug(
        `[image-metric] ${tag} ${metric.outcome} ${Math.round(metric.ms)}ms attempts=${metric.attempts}` +
          `${metric.usedProxyFallback ? " (proxy-fallback)" : ""} ${metric.url.slice(0, 80)}`,
      );
    }
  } catch {
    // Telemetry must never affect rendering.
  }
}
