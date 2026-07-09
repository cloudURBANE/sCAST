/**
 * Sentry for the SPA (production-readiness D1). Loaded ONLY via dynamic import
 * from main.tsx when VITE_SENTRY_DSN is set, so the Sentry SDK lives in its own
 * lazy chunk and the main bundle (and the LHCI budget) is untouched for
 * deployments that don't configure it. Errors only: sessions/replays/tracing
 * stay off until there's a question errors can't answer.
 */
import * as Sentry from "@sentry/react";
import { registerErrorSink } from "./errorReporting";

export function initSentry(dsn: string): void {
  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    tracesSampleRate: 0,
    // The bearer token never appears in URLs since the one-time-code handoff,
    // but scrub breadcrumbs' query strings anyway as defense-in-depth.
    beforeBreadcrumb(breadcrumb) {
      if (typeof breadcrumb.data?.["url"] === "string") {
        breadcrumb.data["url"] = (breadcrumb.data["url"] as string).split("?")[0] ?? "";
      }
      return breadcrumb;
    },
  });
  registerErrorSink((error, scope) => {
    Sentry.captureException(error, scope ? { tags: { scope } } : undefined);
  });
}
