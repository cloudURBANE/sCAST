import * as Sentry from "@sentry/node";
import { logger } from "./logger";

let enabled = false;

/** Keys scrubbed from outgoing events — mirrors pino's redact list (logger.ts). */
const SCRUBBED_HEADERS = ["authorization", "cookie", "set-cookie"];

export function scrubEvent<T extends Sentry.ErrorEvent>(event: T): T {
  const headers = event.request?.headers;
  if (headers) {
    for (const key of Object.keys(headers)) {
      if (SCRUBBED_HEADERS.includes(key.toLowerCase())) delete headers[key];
    }
  }
  if (event.request?.cookies) delete event.request.cookies;
  // Query strings can carry the legacy oauth_token / oauth_code params — drop
  // them wholesale rather than trying to enumerate sensitive keys.
  if (event.request?.query_string) delete event.request.query_string;
  return event;
}

/**
 * Initialize Sentry error tracking. No-op unless SENTRY_DSN is set, keeping the
 * degrade-gracefully doctrine: an unset DSN changes nothing. Errors only —
 * tracing stays off (tracesSampleRate 0) until there's a question errors can't
 * answer.
 */
export function initSentry(): void {
  const dsn = process.env["SENTRY_DSN"]?.trim();
  if (!dsn) {
    logger.info("SENTRY_DSN unset — server error tracking disabled");
    return;
  }
  Sentry.init({
    dsn,
    environment: process.env["NODE_ENV"] ?? "development",
    // Railway exposes the deployed commit; harmless undefined elsewhere.
    release: process.env["RAILWAY_GIT_COMMIT_SHA"]?.trim() || undefined,
    tracesSampleRate: 0,
    beforeSend: (event) => scrubEvent(event),
  });
  enabled = true;
  logger.info("Sentry error tracking enabled");
}

export function isSentryEnabled(): boolean {
  return enabled;
}

/** Report an exception. Safe to call whether or not Sentry is configured. */
export function captureException(err: unknown, extra?: Record<string, unknown>): void {
  if (!enabled) return;
  try {
    Sentry.captureException(err, extra ? { extra } : undefined);
  } catch {
    // Never let telemetry break the caller.
  }
}

/** Best-effort flush before process exit; resolves quickly when disabled. */
export async function flushSentry(timeoutMs = 2_000): Promise<void> {
  if (!enabled) return;
  try {
    await Sentry.flush(timeoutMs);
  } catch {
    // Exiting anyway.
  }
}
