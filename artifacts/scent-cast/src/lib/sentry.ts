// Client-side error tracking (production-readiness D1). Disabled by default —
// degrades gracefully like every other optional integration when
// VITE_SENTRY_DSN is unset. Dynamically imported so the SDK is never fetched
// or parsed by the browser unless it's actually configured — a static import
// would ship its bytes to every user even with Sentry off.
type SentryModule = typeof import("@sentry/react");

let sentry: SentryModule | undefined;

export async function initSentry(): Promise<void> {
  const dsn = import.meta.env.VITE_SENTRY_DSN?.trim();
  if (!dsn) return;

  const Sentry = await import("@sentry/react");
  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    // Errors only — no performance/session-replay sampling until there's a
    // concrete reason to spend the quota on it.
    tracesSampleRate: 0,
    integrations: [],
  });
  sentry = Sentry;
}

/** Always-safe: no-ops when Sentry isn't configured/loaded, so call sites never branch on it. */
export function captureException(error: unknown, extra?: Record<string, unknown>): void {
  sentry?.captureException(error, extra ? { extra } : undefined);
}
