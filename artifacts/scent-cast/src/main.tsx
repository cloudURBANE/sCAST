import { createRoot } from "react-dom/client";
import { HelmetProvider } from "react-helmet-async";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { CrashDiag } from "./components/CrashDiag";
import { PwaUpdater } from "./components/pwa/PwaUpdater";
import { initCrashTrace } from "./lib/crashTrace";
import App from "./App";
import "./index.css";

// Invisible iOS detail-modal crash tracer. Writes crash-surviving localStorage
// breadcrumbs; surfaces nothing unless the URL carries `?__mcdiag`. Temporary.
initCrashTrace();

const queryClient = new QueryClient();

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <HelmetProvider>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </QueryClientProvider>
    </HelmetProvider>
    <CrashDiag />
    <PwaUpdater />
  </ErrorBoundary>,
);
