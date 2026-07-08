/**
 * Decoupled error-reporting sink. ErrorBoundary (and anything else that
 * catches) calls `reportCaughtError` unconditionally; whether the report goes
 * anywhere depends on whether a sink was registered (sentryClient.ts registers
 * one when VITE_SENTRY_DSN is set). Errors caught before the async Sentry init
 * completes are queued and delivered on registration, so nothing is lost to
 * the load race and the SPA carries zero Sentry bytes when the DSN is unset.
 */
type ErrorSink = (error: unknown, scope?: string) => void;

let sink: ErrorSink | null = null;
const pending: Array<[unknown, string | undefined]> = [];
const MAX_PENDING = 20;

export function reportCaughtError(error: unknown, scope?: string): void {
  if (sink) {
    sink(error, scope);
    return;
  }
  if (pending.length < MAX_PENDING) pending.push([error, scope]);
}

export function registerErrorSink(fn: ErrorSink): void {
  sink = fn;
  for (const [error, scope] of pending.splice(0)) fn(error, scope);
}
