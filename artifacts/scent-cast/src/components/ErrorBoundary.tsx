import React, { Component, ErrorInfo, ReactNode } from 'react';
import { AlertOctagon, RotateCcw } from 'lucide-react';

interface Props {
  children: ReactNode;
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

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Uncaught error in boundary:', error, errorInfo);
  }

  private handleReset = () => {
    this.setState({ hasError: false, error: null });
    window.location.href = '/';
  };

  public render() {
    if (this.state.hasError) {
      return (
        <div className="fixed inset-0 z-[999] flex items-center justify-center p-6 bg-[#080808]/90 backdrop-blur-2xl text-white font-sans">
          <div className="relative w-full max-w-lg overflow-hidden border border-white/10 rounded-[var(--radius-scent)] bg-black/40 backdrop-blur-xl p-8 sm:p-12 shadow-2xl space-y-8">
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
                <p className="text-sm text-white/40 max-w-sm mx-auto leading-relaxed">
                  An unexpected exception halted the interface. Let's restore the environmental parameters.
                </p>
              </div>

              {this.state.error && (
                <div className="w-full p-4 rounded-xl bg-white/[0.03] border border-white/5 text-left text-xs text-white/50 font-mono overflow-auto max-h-32 scrollbar-thin">
                  <span className="text-red-400 font-bold">Error:</span> {this.state.error.message}
                </div>
              )}

              <button
                onClick={this.handleReset}
                className="scent-primary-button w-full h-14 flex items-center justify-center gap-3 transition-all rounded-[var(--radius-scent)] hover:opacity-90 font-serif italic text-lg text-black bg-scent-accent"
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
