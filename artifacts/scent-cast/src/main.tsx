import { createRoot } from "react-dom/client";
import { LazyMotion } from "framer-motion";
import { HelmetProvider } from "react-helmet-async";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { CrashDiag } from "./components/CrashDiag";
import { PwaUpdater } from "./components/pwa/PwaUpdater";
import { initCrashTrace } from "./lib/crashTrace";
import { initPwaZoomLock } from "./lib/pwaZoomLock";
import { reloadOnceForStaleChunk } from "./lib/routeChunkRecovery";
import { I18nProvider } from "./i18n";
import { ThemeProvider } from "./context/ThemeContext";
import App from "./App";
import "./index.css";

// Vite fires `vite:preloadError` whenever a dynamically imported chunk (or its
// CSS) fails to load — the classic symptom of a client that predates the last
// deploy requesting hashed assets that no longer exist. Reload once (guarded)
// into the fresh shell instead of letting the rejection surface as a dead
// view. This is the safety net for dynamic imports that don't go through
// loadRouteChunk (community feed sub-chunks, framer-motion features, ...).
window.addEventListener("vite:preloadError", (event) => {
  if (reloadOnceForStaleChunk()) {
    event.preventDefault();
  }
});

// Apply the async-loaded Google Fonts stylesheet (index.html ships it with
// media="print" so it never blocks first paint). This flip used to be an
// inline `onload=` attribute, which the enforced CSP (`script-src 'self'`)
// forbids — so it lives here instead. The sheet may already be loaded by the
// time this module runs (module scripts are deferred), hence the sheet check.
const googleFontsLink = document.getElementById(
  "google-fonts-css",
) as HTMLLinkElement | null;
if (googleFontsLink && googleFontsLink.media !== "all") {
  const applyFonts = () => {
    googleFontsLink.media = "all";
  };
  if (googleFontsLink.sheet) {
    applyFonts();
  } else {
    googleFontsLink.addEventListener("load", applyFonts, { once: true });
  }
}

// Native-app viewport behavior for the installed PWA: pinch/double-tap zoom
// and the iOS input-focus auto-zoom are disabled in standalone mode only.
// Browser tabs keep full accessibility zoom (see lib/pwaZoomLock.ts).
initPwaZoomLock();

// Invisible iOS detail-modal crash tracer. Writes crash-surviving localStorage
// breadcrumbs; surfaces nothing unless the URL carries `?__mcdiag`. Temporary.
initCrashTrace();

// Error tracking (production-readiness D1). Dynamic import keeps the Sentry
// SDK in a lazy chunk that is only ever fetched when a DSN is configured;
// errors caught before it loads are queued by lib/errorReporting.
const sentryDsn = (import.meta.env.VITE_SENTRY_DSN as string | undefined)?.trim();
if (sentryDsn) {
  void import("./lib/sentryClient")
    .then((m) => m.initSentry(sentryDsn))
    .catch(() => {
      // Telemetry must never break the app (offline PWA, blocked CDN, ...).
    });
}

// framer-motion runs in LazyMotion strict mode: components must render `m.*`
// (never `motion.*` — strict mode throws on it), and the animation feature set
// (domMax, needed for the wardrobe bottle `layoutId` morphs) loads as an async
// chunk so it stays out of the entry bundle — a real main-thread saving on
// iPhone-class WebKit. See src/lib/motionFeatures.ts.
const loadMotionFeatures = () =>
  import("./lib/motionFeatures").then((mod) => mod.default);

// App-wide React Query defaults act as the safety net so individual hooks are
// the exception, not the rule. Without these, every query inherits v5 defaults
// (staleTime: 0 + refetch-on-focus/reconnect/mount), so any hook that forgets to
// override them refetches aggressively. Per-query options still take precedence.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000, // 1 min baseline; per-query overrides still win
      gcTime: 30 * 60_000, // keep cache across route hops
      refetchOnWindowFocus: false, // matches the explicit choice every hook already makes
      retry: 1,
    },
  },
});

// Tell the index.html boot watchdog the entry module executed. If this line is
// never reached (entry chunk missing/unparseable — the "white screen" case),
// the watchdog reloads once and, failing that, drops the service worker +
// caches and boots clean from the network.
declare global {
  interface Window {
    __SCENT_APP_BOOTED?: boolean;
  }
}
window.__SCENT_APP_BOOTED = true;

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <LazyMotion features={loadMotionFeatures} strict>
      <HelmetProvider>
        <QueryClientProvider client={queryClient}>
          <I18nProvider>
            <ThemeProvider>
              <BrowserRouter>
                <App />
              </BrowserRouter>
            </ThemeProvider>
          </I18nProvider>
        </QueryClientProvider>
      </HelmetProvider>
      <CrashDiag />
      <PwaUpdater />
    </LazyMotion>
  </ErrorBoundary>,
);
