import React, { Component, ErrorInfo, ReactNode } from 'react';
import { AlertOctagon, RotateCcw } from 'lucide-react';
import {
  isRouteChunkLoadError,
  reloadForStaleRouteChunk,
  reloadThroughFreshServiceWorker,
} from '@/lib/routeChunkRecovery';
import { crumb } from '@/lib/crashTrace';
import { reportCaughtError } from '@/lib/errorReporting';

interface Props {
  children: ReactNode;
  // When provided, render this instead of the full-screen "system disruption"
  // overlay. Used by route-scoped boundaries so a secondary-feature crash
  // degrades to a localized panel while the app shell (nav) stays mounted,
  // rather than blanking the whole SPA and hard-navigating to "/".
  fallback?: (error: Error, reset: () => void) => ReactNode;
  // Short label so a caught render error is attributable to its subtree in the
  // crashTrace breadcrumb trail.
  scope?: string;
  // When any value in this array changes between renders, a currently-caught
  // error is cleared automatically. Route-scoped boundaries pass the current
  // pathname so navigating away from a crashed view soft-recovers it in place —
  // no full-page reload, and the boundary is ready for the next route. Compared
  // shallowly (===) in declaration order.
  resetKeys?: unknown[];
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  // Auto-clear a caught error when a watched reset key changes (e.g. the route
  // pathname). This makes a route-scoped crash recover the moment the user
  // navigates away, instead of the localized fallback sticking until manual retry.
  public componentDidUpdate(prevProps: Props) {
    if (!this.state.hasError) return;
    const prev = prevProps.resetKeys;
    const next = this.props.resetKeys;
    if (!prev || !next) return;
    const changed =
      prev.length !== next.length || next.some((value, index) => !Object.is(value, prev[index]));
    if (changed) {
      this.setState({ hasError: false, error: null });
    }
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    if (reloadForStaleRouteChunk(error)) return;
    // Persist a breadcrumb so caught React exceptions — the most diagnosable
    // failures — leave a trail in crashTrace alongside the iOS WebContent-kill
    // case it already records, instead of only an ephemeral console line.
    crumb(`react-error${this.props.scope ? `:${this.props.scope}` : ''}: ${error.message}`);
    // Ship the caught render error to the error tracker (no-op without a DSN;
    // queued if Sentry's lazy chunk hasn't loaded yet).
    reportCaughtError(error, this.props.scope);
    console.error('Uncaught error in boundary:', error, errorInfo);
  }

  private handleReset = () => {
    this.setState({ hasError: false, error: null });
    window.location.href = '/';
  };

  // Clear the error without leaving the current route. Used by the localized
  // fallback so the user can retry the failed subtree in place.
  private handleResetLocal = () => {
    this.setState({ hasError: false, error: null });
  };

  public render() {
    if (this.state.hasError) {
      if (this.props.fallback && this.state.error) {
        return this.props.fallback(this.state.error, this.handleResetLocal);
      }
      return (
        <div role="alert" className="fixed inset-0 z-[999] flex items-center justify-center p-6 bg-[#080808]/90 backdrop-blur-sm text-white font-sans">
          <div className="relative w-full max-w-lg overflow-hidden border border-white/10 rounded-[var(--radius-scent)] bg-black/70 backdrop-blur-sm p-8 sm:p-12 shadow-2xl space-y-8">
            <div className="absolute top-0 left-0 w-full h-[3px] bg-gradient-to-r from-red-500/70 via-orange-500/70 to-red-500/70" />
            
            <div className="flex flex-col items-center text-center space-y-6">
              <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-full text-red-400">
                <AlertOctagon size={32} strokeWidth={1.5} />
              </div>
              
              <div className="space-y-3">
                <p className="text-[10px] uppercase tracking-[0.4em] text-red-400/80 font-bold">
                  System Disruption
                </p>
                <h1 className="font-serif italic text-3xl sm:text-4xl text-[#fff7ec] tracking-tight leading-tight">
                  Olfactory Feed Interrupted
                </h1>
                <p className="text-sm text-white/55 max-w-sm mx-auto leading-relaxed">
                  An unexpected exception halted the interface. Let's restore the environmental parameters.
                </p>
              </div>

              {this.state.error && (
                <div className="w-full p-4 rounded-xl bg-white/[0.03] border border-white/5 text-left text-xs text-white/50 font-mono overflow-auto max-h-32 scrollbar-thin">
                  <span className="text-red-400 font-bold">Error:</span> {this.state.error.message}
                </div>
              )}

              <button
                type="button"
                onClick={this.handleReset}
                className="scent-primary-button w-full h-14 flex items-center justify-center gap-3 transition-opacity rounded-[var(--radius-scent)] hover:opacity-90 font-serif italic text-lg text-black bg-scent-accent"
              >
                <RotateCcw size={18} className="shrink-0" />
                <span>Calibrate Matrix & Reload</span>
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

// Localized fallback for route-scoped boundaries: a compact in-flow panel that
// keeps the app shell (nav/footer) interactive so the user can navigate away or
// retry the failed view in place, instead of the full-screen root overlay.
export function RouteErrorFallback({
  label,
  error,
  onRetry,
}: {
  label: string;
  error: Error;
  onRetry: () => void;
}) {
  // A stale-chunk failure (old hashed asset deleted by a new deploy) can never
  // be fixed by re-rendering: React.lazy has cached the rejection. The only
  // real retry is a reload through a fresh service-worker shell.
  const staleChunk = isRouteChunkLoadError(error);
  const handleRetry = () => {
    if (staleChunk) {
      reloadThroughFreshServiceWorker();
      return;
    }
    onRetry();
  };
  return (
    <div role="alert" className="mx-auto my-16 w-full max-w-md px-6 text-center text-foreground">
      <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-red-500/10 border border-red-500/20 text-destructive">
        <AlertOctagon size={26} strokeWidth={1.5} />
      </div>
      <h2 className="font-serif italic text-2xl text-foreground tracking-tight">
        {label} couldn't load
      </h2>
      <p className="mt-2 text-sm text-scent-text-muted leading-relaxed">
        {staleChunk
          ? 'A new version of ScentBeam is available — reload to pick it up.'
          : 'Something went wrong rendering this view. The rest of the app is still here.'}
      </p>
      {!staleChunk && (
        <p className="mt-3 text-xs text-scent-text-subtle/80 font-mono break-words">{error.message}</p>
      )}
      <button
        type="button"
        onClick={handleRetry}
        className="mt-6 inline-flex items-center justify-center gap-2 rounded-[var(--radius-scent)] border border-scent-text-subtle/30 px-5 h-11 text-sm text-scent-text-muted hover:bg-scent-text-subtle/10 transition-colors"
      >
        <RotateCcw size={16} className="shrink-0" />
        <span>{staleChunk ? 'Reload app' : 'Try again'}</span>
      </button>
    </div>
  );
}
