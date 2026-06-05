import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { CrashDiag } from "./components/CrashDiag";
import { initCrashTrace } from "./lib/crashTrace";
import App from "./App";
import "./index.css";

// Invisible iOS detail-modal crash tracer. Writes crash-surviving localStorage
// breadcrumbs; surfaces nothing unless the URL carries `?__mcdiag`. Temporary.
initCrashTrace();

const queryClient = new QueryClient();

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
    <CrashDiag />
  </ErrorBoundary>,
);
