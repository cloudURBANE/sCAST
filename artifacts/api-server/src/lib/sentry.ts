// Server-side error tracking (production-readiness D1). Disabled by default —
// degrade-gracefully like every other optional integration (env.ts logs its
// on/off state in the boot integration summary). Dynamically imported so an
// unconfigured deploy never even loads the SDK's dependency graph
// (@sentry/node pulls in @opentelemetry/* packages that are deliberately
// esbuild-external per build.mjs — a static top-level import would eagerly
// resolve them at MODULE LOAD time and crash the boot on any transitive
// package pnpm didn't happen to hoist, even with Sentry off entirely; this
// was caught by an actual boot smoke, not by reading the code).
//
// `initSentry()` is called at the very top of index.ts, before the
// uncaughtException/unhandledRejection handlers are registered, so those
// handlers can report to Sentry from the moment they exist. `captureException`
// and `flushSentry` are thin, always-safe wrappers: call sites don't need to
// check whether Sentry is configured.
type SentryModule = typeof import("@sentry/node");

let sentry: SentryModule | undefined;

export async function initSentry(): Promise<void> {
  const dsn = process.env.SENTRY_DSN?.trim();
  if (!dsn) return;

  const Sentry = await import("@sentry/node");
  Sentry.init({
    dsn,
    // Errors first, tracing later — keep quota spend predictable until
    // there's a concrete reason to sample traces.
    tracesSampleRate: 0,
    environment: process.env.NODE_ENV,
    beforeSend(event) {
      // Mirror pino's own redaction list (lib/logger.ts) so a captured
      // request never carries a bearer token or session cookie.
      const headers = event.request?.headers;
      if (headers) {
        for (const key of Object.keys(headers)) {
          if (key.toLowerCase() === "authorization" || key.toLowerCase() === "cookie") {
            delete headers[key];
          }
        }
      }
      if (event.request?.cookies) {
        delete event.request.cookies;
      }
      return event;
    },
  });
  sentry = Sentry;
}

/** Always-safe: no-ops when Sentry isn't configured/loaded, so call sites never branch on it. */
export function captureException(err: unknown): void {
  sentry?.captureException(err);
}

/**
 * Wait for Sentry's transport to send whatever's queued, up to `timeoutMs`.
 * Resolves immediately when Sentry isn't configured. Use before a deliberate
 * process.exit() (e.g. the uncaughtException/unhandledRejection handlers) —
 * captureException() only queues the event; without this the process can
 * exit before the network send ever happens.
 */
export async function flushSentry(timeoutMs: number): Promise<void> {
  if (!sentry) return;
  await sentry.flush(timeoutMs);
}
