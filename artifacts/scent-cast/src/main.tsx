import { createRoot } from "react-dom/client";
import { HelmetProvider } from "react-helmet-async";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { CrashDiag } from "./components/CrashDiag";
import { PwaUpdater } from "./components/pwa/PwaUpdater";
import { initCrashTrace } from "./lib/crashTrace";
import { I18nProvider } from "./i18n";
import { ThemeProvider } from "./context/ThemeContext";
import App from "./App";
import "./index.css";

// Invisible iOS detail-modal crash tracer. Writes crash-surviving localStorage
// breadcrumbs; surfaces nothing unless the URL carries `?__mcdiag`. Temporary.
initCrashTrace();

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

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
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
  </ErrorBoundary>,
);
