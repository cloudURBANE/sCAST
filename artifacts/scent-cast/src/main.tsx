import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { CrashTraceBadge } from "./components/CrashTraceBadge";
import { initCrashTrace } from "./lib/crashTrace";
import App from "./App";
import "./index.css";

initCrashTrace();

const queryClient = new QueryClient();

createRoot(document.getElementById("root")!).render(
  <>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
    <CrashTraceBadge />
  </>,
);

