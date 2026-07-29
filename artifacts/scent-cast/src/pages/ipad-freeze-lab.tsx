import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Clipboard, Download, Flag, RotateCcw } from 'lucide-react';
import {
  ThreadBackground,
  type ThreadBackgroundFrameMetrics,
} from '@/components/threads/ThreadBackground';
import {
  getThreadTravelSize,
  THREAD_LINES,
  threadGradientToCss,
  threadShadowToCss,
  type ThreadLine,
} from '@/components/threads/threadLines';

type LabMode = 'production' | 'dom' | 'css' | 'canvas' | 'vanilla';

type ModelSnapshot = {
  mode: LabMode;
  renderer: string;
  sampleId?: string;
  x?: number;
  y?: number;
  position?: number;
  opacity?: number;
  phase?: number;
  drawCount?: number;
  note?: string;
};

type ProbeLogEntry = {
  t: number;
  kind: string;
  detail: string;
  data?: unknown;
};

type ViewportSnapshot = {
  innerWidth: number;
  innerHeight: number;
  outerWidth: number;
  outerHeight: number;
  screenWidth: number;
  screenHeight: number;
  dpr: number;
  orientation: string;
  visualViewport?: {
    width: number;
    height: number;
    offsetLeft: number;
    offsetTop: number;
    scale: number;
    pageLeft: number;
    pageTop: number;
  };
};

type FreezeProbe = ReturnType<typeof createFreezeProbe>;

const LAB_MODES: Array<{ id: LabMode; label: string; description: string }> = [
  {
    id: 'production',
    label: 'Production',
    description: 'Current ThreadBackground component with production frame writes counted.',
  },
  {
    id: 'dom',
    label: 'DOM transform',
    description: 'Same thread model moved by requestAnimationFrame transform writes.',
  },
  {
    id: 'css',
    label: 'CSS animation',
    description: 'Same thread marks animated by CSS keyframes, with JS only observing coordinates.',
  },
  {
    id: 'canvas',
    label: 'Canvas 2D',
    description: 'Diagnostic canvas renderer that counts every explicit draw.',
  },
  {
    id: 'vanilla',
    label: 'Non-React',
    description: 'Imperative DOM renderer mounted once, with no React updates after setup.',
  },
];

const INPUT_EVENTS = [
  'pointerdown',
  'pointermove',
  'pointerup',
  'pointercancel',
  'touchstart',
  'touchmove',
  'touchend',
  'touchcancel',
  'mousedown',
  'mousemove',
  'mouseup',
  'click',
  'wheel',
  'keydown',
] as const;

const LIFECYCLE_EVENTS = [
  'visibilitychange',
  'pageshow',
  'pagehide',
  'focus',
  'blur',
  'resize',
  'orientationchange',
] as const;

const MIN_RANDOM_PERCENT = 8;
const MAX_RANDOM_PERCENT = 92;
const MIN_SPEED_FACTOR = 0.75;
const MAX_SPEED_FACTOR = 1.35;
const MAX_START_DELAY = 2200;
const MAX_DPR = 2;

const LAB_STYLE = `
.ipad-freeze-lab {
  position: relative;
  min-height: 100svh;
  overflow: hidden;
  isolation: isolate;
  background:
    radial-gradient(circle at 28% 18%, rgba(212, 175, 55, 0.12), transparent 32%),
    radial-gradient(circle at 78% 82%, rgba(255, 247, 236, 0.08), transparent 30%),
    #030201;
  color: #fff7ec;
  touch-action: manipulation;
}

.ipad-freeze-lab-stage,
.ipad-freeze-lab-layer {
  position: fixed;
  inset: 0;
  overflow: hidden;
}

.ipad-freeze-lab-layer {
  pointer-events: none;
  z-index: 1;
}

.ipad-freeze-lab-thread {
  position: absolute;
  left: 0;
  top: 0;
  border-radius: 999px;
  pointer-events: none;
  transform: translate3d(0, 0, 0);
}

.ipad-freeze-lab-foreground {
  position: relative;
  z-index: 2;
  min-height: 100svh;
  display: grid;
  place-items: center;
  padding: max(18px, env(safe-area-inset-top)) 18px max(18px, env(safe-area-inset-bottom));
  text-align: center;
  pointer-events: none;
}

.ipad-freeze-lab-title {
  font-family: var(--font-serif);
  font-style: italic;
  font-size: clamp(2.2rem, 9vw, 6.5rem);
  line-height: 0.92;
  max-width: 900px;
  color: #fff7ec;
  text-shadow: 0 16px 46px rgba(0, 0, 0, 0.72);
}

.ipad-freeze-lab-subtitle {
  margin-top: 18px;
  font-size: 11px;
  letter-spacing: 0.24em;
  text-transform: uppercase;
  color: rgba(244, 222, 189, 0.72);
}

.ipad-freeze-overlay {
  position: fixed;
  left: max(10px, env(safe-area-inset-left));
  right: max(10px, env(safe-area-inset-right));
  bottom: max(10px, env(safe-area-inset-bottom));
  z-index: 10050;
  display: grid;
  gap: 8px;
  max-height: min(58svh, 520px);
  padding: 10px;
  border: 1px solid rgba(255, 247, 236, 0.22);
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.84);
  box-shadow: 0 18px 60px rgba(0, 0, 0, 0.7);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}

.ipad-freeze-overlay-controls,
.ipad-freeze-overlay-actions {
  display: flex;
  gap: 6px;
  overflow-x: auto;
  scrollbar-width: none;
}

.ipad-freeze-overlay-controls::-webkit-scrollbar,
.ipad-freeze-overlay-actions::-webkit-scrollbar {
  display: none;
}

.ipad-freeze-overlay button {
  flex: 0 0 auto;
  min-height: 34px;
  border: 1px solid rgba(255, 247, 236, 0.18);
  border-radius: 7px;
  background: rgba(255, 247, 236, 0.06);
  color: #fff7ec;
  padding: 0 10px;
  font: 700 10px/1 var(--font-sans);
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.ipad-freeze-overlay button[aria-pressed="true"] {
  border-color: rgba(212, 175, 55, 0.78);
  background: rgba(212, 175, 55, 0.2);
  color: #ffe6a3;
}

.ipad-freeze-overlay-actions button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.ipad-freeze-overlay-actions svg {
  width: 14px;
  height: 14px;
}

.ipad-freeze-overlay-output {
  min-height: 168px;
  max-height: 265px;
  overflow: auto;
  margin: 0;
  padding: 8px;
  border-radius: 7px;
  background: rgba(255, 247, 236, 0.055);
  color: #d8ffe2;
  font: 11px/1.36 var(--font-mono);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

@keyframes ipad-freeze-lab-line-travel {
  from {
    transform: translate3d(var(--lab-from-x), var(--lab-from-y), 0);
  }
  to {
    transform: translate3d(var(--lab-to-x), var(--lab-to-y), 0);
  }
}

.ipad-freeze-lab-css-thread {
  animation-name: ipad-freeze-lab-line-travel;
  animation-timing-function: linear;
  animation-iteration-count: infinite;
  will-change: transform;
}

@media (min-width: 760px) {
  .ipad-freeze-overlay {
    left: auto;
    width: min(560px, calc(100vw - 28px));
  }
}
`;

function round(value: number | undefined, digits = 1): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function randomizeThreadLane(): number {
  return randomBetween(MIN_RANDOM_PERCENT, MAX_RANDOM_PERCENT);
}

function getInitialMode(): LabMode {
  if (typeof window === 'undefined') return 'production';
  const requested = new URLSearchParams(window.location.search).get('mode');
  if (LAB_MODES.some((mode) => mode.id === requested)) {
    return requested as LabMode;
  }
  return 'production';
}

function getViewportSnapshot(): ViewportSnapshot {
  const legacyWindow = window as Window & { orientation?: number };
  const orientation =
    typeof screen.orientation?.type === 'string'
      ? screen.orientation.type
      : typeof legacyWindow.orientation === 'number'
        ? `${legacyWindow.orientation}deg`
        : 'unknown';

  const snapshot: ViewportSnapshot = {
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    outerWidth: window.outerWidth,
    outerHeight: window.outerHeight,
    screenWidth: window.screen.width,
    screenHeight: window.screen.height,
    dpr: window.devicePixelRatio || 1,
    orientation,
  };

  if (window.visualViewport) {
    snapshot.visualViewport = {
      width: round(window.visualViewport.width) ?? window.visualViewport.width,
      height: round(window.visualViewport.height) ?? window.visualViewport.height,
      offsetLeft: round(window.visualViewport.offsetLeft) ?? window.visualViewport.offsetLeft,
      offsetTop: round(window.visualViewport.offsetTop) ?? window.visualViewport.offsetTop,
      scale: round(window.visualViewport.scale, 3) ?? window.visualViewport.scale,
      pageLeft: round(window.visualViewport.pageLeft) ?? window.visualViewport.pageLeft,
      pageTop: round(window.visualViewport.pageTop) ?? window.visualViewport.pageTop,
    };
  }

  return snapshot;
}

function serializeConsoleArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (arg instanceof Error) return `${arg.name}: ${arg.message}\n${arg.stack ?? ''}`;
      if (typeof arg === 'string') return arg;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(' ');
}

function trimLog(log: ProbeLogEntry[], max = 240): ProbeLogEntry[] {
  if (log.length <= max) return log;
  return log.slice(log.length - max);
}

function createFreezeProbe() {
  let mode: LabMode = 'production';
  let startedAt = performance.now();
  let running = false;
  let outputElement: HTMLElement | null = null;
  let rafId = 0;
  let intervalId: number | null = null;
  let localPersistId: number | null = null;
  let longTaskObserver: PerformanceObserver | null = null;

  let rafCount = 0;
  let intervalCount = 0;
  let overlayWriteCount = 0;
  let reactRenderCount = 0;
  let reactCommitCount = 0;
  let canvasDrawCount = 0;
  let domWriteCount = 0;
  let longTaskCount = 0;
  let longTaskMs = 0;

  let lastRafAt = startedAt;
  let lastRafDelta = 0;
  let maxRafDelta = 0;
  let rafGapCount = 0;
  let lastIntervalAt = startedAt;
  let lastIntervalDelta = 0;
  let maxIntervalDelta = 0;
  let intervalGapCount = 0;
  let lastCanvasDrawAt = 0;
  let lastDomWriteAt = 0;
  let lastOverlayWriteAt = 0;
  let lastInput = 'none';
  let lastReactComponent = 'none';

  let model: ModelSnapshot = { mode, renderer: 'not-started' };
  let lifecycleLog: ProbeLogEntry[] = [];
  let consoleLog: ProbeLogEntry[] = [];
  let resizeLog: ProbeLogEntry[] = [];

  const inputCounts = INPUT_EVENTS.reduce<Record<string, number>>((acc, eventName) => {
    acc[eventName] = 0;
    return acc;
  }, {});

  const originalConsole = {
    warn: console.warn,
    error: console.error,
  };

  const sinceStart = () => round(performance.now() - startedAt) ?? 0;

  const record = (kind: string, detail: string, data?: unknown) => {
    lifecycleLog = trimLog([...lifecycleLog, { t: sinceStart(), kind, detail, data }]);
  };

  const recordConsole = (kind: string, args: unknown[]) => {
    consoleLog = trimLog(
      [...consoleLog, { t: sinceStart(), kind, detail: serializeConsoleArgs(args) }],
      120,
    );
  };

  const captureConsole = () => {
    console.warn = (...args: unknown[]) => {
      recordConsole('warn', args);
      originalConsole.warn.apply(console, args);
    };

    console.error = (...args: unknown[]) => {
      recordConsole('error', args);
      originalConsole.error.apply(console, args);
    };
  };

  const restoreConsole = () => {
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
  };

  const handleInput = (event: Event) => {
    inputCounts[event.type] = (inputCounts[event.type] ?? 0) + 1;
    let point = '';
    if ('clientX' in event && 'clientY' in event) {
      const pointerEvent = event as MouseEvent | PointerEvent;
      point = ` @ ${round(Number(pointerEvent.clientX))},${round(Number(pointerEvent.clientY))}`;
    } else if ('touches' in event && (event as TouchEvent).touches.length > 0) {
      const touchEvent = event as TouchEvent;
      point = ` @ ${round(touchEvent.touches[0].clientX)},${round(touchEvent.touches[0].clientY)}`;
    }
    lastInput = `${event.type}${point}`;
    if (!event.type.includes('move')) {
      record('input', lastInput);
    }
  };

  const handleLifecycle = (event: Event) => {
    const detail =
      event.type === 'visibilitychange'
        ? `visibility=${document.visibilityState}`
        : event.type === 'focus' || event.type === 'blur'
          ? `focus=${document.hasFocus()}`
          : event.type;
    record('lifecycle', detail, getViewportSnapshot());
  };

  const handleResize = (event: Event) => {
    const snapshot = getViewportSnapshot();
    resizeLog = trimLog([...resizeLog, { t: sinceStart(), kind: event.type, detail: 'viewport', data: snapshot }], 80);
    handleLifecycle(event);
  };

  const handleWindowError = (event: ErrorEvent) => {
    recordConsole('window-error', [event.message, event.filename, event.lineno]);
  };

  const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
    recordConsole('unhandledrejection', [event.reason]);
  };

  const writeOutput = (force = false) => {
    if (!outputElement) return;
    const now = performance.now();
    if (!force && now - lastOverlayWriteAt < 100) return;
    outputElement.textContent = formatSnapshot();
    lastOverlayWriteAt = now;
    overlayWriteCount += 1;
  };

  const tickRaf = (now: number) => {
    if (!running) return;
    rafCount += 1;
    lastRafDelta = now - lastRafAt;
    maxRafDelta = Math.max(maxRafDelta, lastRafDelta);
    if (lastRafDelta > 250) rafGapCount += 1;
    lastRafAt = now;
    writeOutput();
    rafId = window.requestAnimationFrame(tickRaf);
  };

  const tickInterval = () => {
    const now = performance.now();
    intervalCount += 1;
    lastIntervalDelta = now - lastIntervalAt;
    maxIntervalDelta = Math.max(maxIntervalDelta, lastIntervalDelta);
    if (lastIntervalDelta > 500) intervalGapCount += 1;
    lastIntervalAt = now;
    writeOutput(true);
  };

  const serialize = () => {
    const memory = (performance as Performance & {
      memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };
    }).memory;

    return JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        location: window.location.href,
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        hardwareConcurrency: navigator.hardwareConcurrency ?? null,
        deviceMemory: (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null,
        snapshot: snapshot(),
        logs: {
          lifecycle: lifecycleLog,
          console: consoleLog,
          resize: resizeLog,
        },
        performance: {
          now: performance.now(),
          timeOrigin: performance.timeOrigin,
          memory: memory
            ? {
                usedJSHeapSize: memory.usedJSHeapSize,
                totalJSHeapSize: memory.totalJSHeapSize,
                jsHeapSizeLimit: memory.jsHeapSizeLimit,
              }
            : null,
        },
      },
      null,
      2,
    );
  };

  const snapshot = () => {
    const now = performance.now();
    const memory = (performance as Performance & {
      memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };
    }).memory;

    return {
      elapsedMs: round(now - startedAt),
      mode,
      visibility: document.visibilityState,
      hasFocus: document.hasFocus(),
      raf: {
        count: rafCount,
        lastDeltaMs: round(lastRafDelta, 2),
        maxDeltaMs: round(maxRafDelta, 2),
        gapsOver250Ms: rafGapCount,
        ageMs: round(now - lastRafAt, 2),
      },
      interval: {
        count: intervalCount,
        lastDeltaMs: round(lastIntervalDelta, 2),
        maxDeltaMs: round(maxIntervalDelta, 2),
        gapsOver500Ms: intervalGapCount,
        ageMs: round(now - lastIntervalAt, 2),
      },
      inputCounts: { ...inputCounts },
      lastInput,
      react: {
        renderCount: reactRenderCount,
        commitCount: reactCommitCount,
        lastComponent: lastReactComponent,
      },
      renderer: {
        canvasDrawCount,
        domWriteCount,
        overlayWriteCount,
        lastCanvasDrawAgeMs: lastCanvasDrawAt ? round(now - lastCanvasDrawAt, 2) : null,
        lastDomWriteAgeMs: lastDomWriteAt ? round(now - lastDomWriteAt, 2) : null,
      },
      model,
      viewport: getViewportSnapshot(),
      consoleCounts: {
        warnings: consoleLog.filter((entry) => entry.kind === 'warn').length,
        errors: consoleLog.filter((entry) => entry.kind === 'error' || entry.kind === 'window-error').length,
      },
      longTasks: {
        count: longTaskCount,
        totalMs: round(longTaskMs, 2),
      },
      memory: memory
        ? {
            usedMB: round(memory.usedJSHeapSize / 1024 / 1024, 2),
            totalMB: round(memory.totalJSHeapSize / 1024 / 1024, 2),
            limitMB: round(memory.jsHeapSizeLimit / 1024 / 1024, 2),
          }
        : null,
    };
  };

  const formatSnapshot = () => {
    const snap = snapshot();
    const vv = snap.viewport.visualViewport;
    const inputSummary = INPUT_EVENTS.map((name) => `${name}:${snap.inputCounts[name] ?? 0}`).join(' ');
    const recentLifecycle = lifecycleLog.slice(-5).map((entry) => `${entry.t} ${entry.kind}:${entry.detail}`);
    const recentConsole = consoleLog.slice(-4).map((entry) => `${entry.t} ${entry.kind}:${entry.detail.slice(0, 140)}`);

    return [
      `iPad Freeze Lab | mode=${snap.mode} | elapsed=${snap.elapsedMs}ms`,
      `RAF count=${snap.raf.count} last=${snap.raf.lastDeltaMs}ms max=${snap.raf.maxDeltaMs}ms gaps>250=${snap.raf.gapsOver250Ms} age=${snap.raf.ageMs}ms`,
      `Interval count=${snap.interval.count} last=${snap.interval.lastDeltaMs}ms max=${snap.interval.maxDeltaMs}ms gaps>500=${snap.interval.gapsOver500Ms} age=${snap.interval.ageMs}ms`,
      `Renderer canvasDraws=${snap.renderer.canvasDrawCount} domWrites=${snap.renderer.domWriteCount} overlayWrites=${snap.renderer.overlayWriteCount}`,
      `React renders=${snap.react.renderCount} commits=${snap.react.commitCount} last=${snap.react.lastComponent}`,
      `Model renderer=${snap.model.renderer} id=${snap.model.sampleId ?? 'n/a'} x=${round(snap.model.x)} y=${round(snap.model.y)} pos=${round(snap.model.position)} opacity=${round(snap.model.opacity, 2)} phase=${round(snap.model.phase, 3)} draws=${snap.model.drawCount ?? 'n/a'}`,
      `Visibility=${snap.visibility} focus=${snap.hasFocus} longTasks=${snap.longTasks.count}/${snap.longTasks.totalMs}ms memory=${snap.memory ? `${snap.memory.usedMB}/${snap.memory.limitMB}MB` : 'n/a'}`,
      `Viewport inner=${snap.viewport.innerWidth}x${snap.viewport.innerHeight} dpr=${snap.viewport.dpr} screen=${snap.viewport.screenWidth}x${snap.viewport.screenHeight} orientation=${snap.viewport.orientation}`,
      `VisualViewport=${vv ? `${vv.width}x${vv.height} scale=${vv.scale} offset=${vv.offsetLeft},${vv.offsetTop}` : 'n/a'}`,
      `Input ${inputSummary}`,
      `Last input ${snap.lastInput}`,
      `Console warn=${snap.consoleCounts.warnings} error=${snap.consoleCounts.errors}`,
      `Recent lifecycle ${recentLifecycle.length ? recentLifecycle.join(' | ') : 'none'}`,
      `Recent console ${recentConsole.length ? recentConsole.join(' | ') : 'none'}`,
    ].join('\n');
  };

  return {
    start(initialMode: LabMode) {
      if (running) return;
      mode = initialMode;
      model = { mode, renderer: 'starting' };
      running = true;
      startedAt = performance.now();
      lastRafAt = startedAt;
      lastIntervalAt = startedAt;
      record('start', 'freeze lab mounted', {
        userAgent: navigator.userAgent,
        viewport: getViewportSnapshot(),
      });
      captureConsole();

      rafId = window.requestAnimationFrame(tickRaf);
      intervalId = window.setInterval(tickInterval, 250);
      localPersistId = window.setInterval(() => {
        try {
          window.localStorage.setItem('ipad-freeze-lab:last-export', serialize());
        } catch {
          // Ignore storage quota or private-mode failures; manual export still works.
        }
      }, 5000);

      INPUT_EVENTS.forEach((eventName) => {
        window.addEventListener(eventName, handleInput, { capture: true, passive: true });
      });
      LIFECYCLE_EVENTS.forEach((eventName) => {
        const target = eventName === 'visibilitychange' ? document : window;
        target.addEventListener(eventName, eventName === 'resize' ? handleResize : handleLifecycle);
      });
      window.visualViewport?.addEventListener('resize', handleResize);
      window.visualViewport?.addEventListener('scroll', handleResize);
      window.addEventListener('error', handleWindowError);
      window.addEventListener('unhandledrejection', handleUnhandledRejection);

      try {
        if (
          typeof PerformanceObserver !== 'undefined' &&
          PerformanceObserver.supportedEntryTypes?.includes('longtask')
        ) {
          longTaskObserver = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              longTaskCount += 1;
              longTaskMs += entry.duration;
            }
          });
          longTaskObserver.observe({ entryTypes: ['longtask'] });
        }
      } catch {
        longTaskObserver = null;
      }

      writeOutput(true);
    },
    stop() {
      running = false;
      if (rafId) window.cancelAnimationFrame(rafId);
      if (intervalId) window.clearInterval(intervalId);
      if (localPersistId) window.clearInterval(localPersistId);
      longTaskObserver?.disconnect();
      restoreConsole();
      INPUT_EVENTS.forEach((eventName) => {
        window.removeEventListener(eventName, handleInput, { capture: true } as EventListenerOptions);
      });
      LIFECYCLE_EVENTS.forEach((eventName) => {
        const target = eventName === 'visibilitychange' ? document : window;
        target.removeEventListener(eventName, eventName === 'resize' ? handleResize : handleLifecycle);
      });
      window.visualViewport?.removeEventListener('resize', handleResize);
      window.visualViewport?.removeEventListener('scroll', handleResize);
      window.removeEventListener('error', handleWindowError);
      window.removeEventListener('unhandledrejection', handleUnhandledRejection);
    },
    setMode(nextMode: LabMode) {
      mode = nextMode;
      model = { mode, renderer: 'mode-switch' };
      record('mode', nextMode);
      writeOutput(true);
    },
    attachOutput(element: HTMLElement | null) {
      outputElement = element;
      writeOutput(true);
      return () => {
        if (outputElement === element) outputElement = null;
      };
    },
    reportReactRender(component: string) {
      reactRenderCount += 1;
      lastReactComponent = component;
    },
    reportReactCommit(component: string) {
      reactCommitCount += 1;
      lastReactComponent = component;
    },
    reportModel(nextModel: ModelSnapshot) {
      model = { ...nextModel, mode };
    },
    reportCanvasFrame(renderer: string, metrics: ThreadBackgroundFrameMetrics) {
      canvasDrawCount += 1;
      lastCanvasDrawAt = performance.now();
      model = {
        mode,
        renderer,
        sampleId: metrics.sample?.id,
        x: metrics.sample?.x,
        y: metrics.sample?.y,
        position: metrics.sample?.position,
        opacity: metrics.sample?.opacity,
        drawCount: metrics.drawCount,
      };
    },
    reportDomWrite(renderer: string, sample: ModelSnapshot) {
      domWriteCount += 1;
      lastDomWriteAt = performance.now();
      model = { ...sample, mode, renderer };
    },
    mark(label = 'manual mark') {
      record('mark', label, snapshot());
      writeOutput(true);
    },
    reset() {
      rafCount = 0;
      intervalCount = 0;
      overlayWriteCount = 0;
      reactRenderCount = 0;
      reactCommitCount = 0;
      canvasDrawCount = 0;
      domWriteCount = 0;
      longTaskCount = 0;
      longTaskMs = 0;
      maxRafDelta = 0;
      maxIntervalDelta = 0;
      rafGapCount = 0;
      intervalGapCount = 0;
      Object.keys(inputCounts).forEach((key) => {
        inputCounts[key] = 0;
      });
      lifecycleLog = [];
      consoleLog = [];
      resizeLog = [];
      startedAt = performance.now();
      lastRafAt = startedAt;
      lastIntervalAt = startedAt;
      record('reset', 'manual reset');
      writeOutput(true);
    },
    downloadLog() {
      const blob = new Blob([serialize()], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `ipad-freeze-lab-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      record('export', 'download json');
    },
    async copyLog() {
      const text = serialize();
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.append(textarea);
        textarea.select();
        document.execCommand('copy');
        textarea.remove();
      }
      record('export', 'copy json');
      writeOutput(true);
    },
    formatSnapshot,
  };
}

function useProbeRender(probe: FreezeProbe, component: string) {
  probe.reportReactRender(component);
  useEffect(() => {
    probe.reportReactCommit(component);
  });
}

type MotionState = {
  thread: ThreadLine;
  position: number;
  speed: number;
  startAt: number;
  lanePercent: number;
};

function getTravelLimit(thread: ThreadLine): number {
  return thread.axis === 'x' ? window.innerWidth : window.innerHeight;
}

function getInitialPosition(thread: ThreadLine): number {
  const limit = getTravelLimit(thread);
  const travelSize = getThreadTravelSize(thread);
  return randomBetween(-travelSize, limit + travelSize);
}

function getLaneOffset(thread: ThreadLine, lanePercent: number): number {
  const limit = thread.axis === 'x' ? window.innerHeight : window.innerWidth;
  return (limit * lanePercent) / 100;
}

function computeTopLeft(
  thread: ThreadLine,
  position: number,
  lanePercent: number,
  boxW: number,
  boxH: number,
): { x: number; y: number } {
  const lane = getLaneOffset(thread, lanePercent);

  if (thread.axis === 'x') {
    const x = thread.direction === 1 ? position : position - boxW;
    return { x, y: lane };
  }

  const y = thread.direction === 1 ? position : position - boxH;
  return { x: lane, y };
}

function computeOpacity(thread: ThreadLine, position: number): number {
  const { direction, fade } = thread;
  if (fade == null) return thread.presence;

  const limit = getTravelLimit(thread);
  let fadeOpacity = 1;

  if (direction === 1) {
    if (position < fade) fadeOpacity = Math.max(0, position / fade);
    else if (position > limit - fade) fadeOpacity = Math.max(0, (limit + fade - position) / fade);
  } else {
    if (position > limit - fade) fadeOpacity = Math.max(0, (limit - position) / fade);
    else if (position < fade) fadeOpacity = Math.max(0, position / fade);
  }

  return fadeOpacity * thread.presence;
}

function shouldWrap(thread: ThreadLine, position: number): boolean {
  const limit = getTravelLimit(thread);
  const travelSize = getThreadTravelSize(thread);
  if (thread.direction === 1) return position > limit + travelSize;
  return position < -travelSize;
}

function resetPosition(thread: ThreadLine): number {
  const travelSize = getThreadTravelSize(thread);
  if (thread.direction === 1) return randomBetween(-travelSize * 3, -travelSize);
  return getTravelLimit(thread) + randomBetween(travelSize, travelSize * 3);
}

function createMotionState(thread: ThreadLine, now: number): MotionState {
  return {
    thread,
    position: getInitialPosition(thread),
    speed: thread.speed * randomBetween(MIN_SPEED_FACTOR, MAX_SPEED_FACTOR),
    startAt: now + randomBetween(0, MAX_START_DELAY),
    lanePercent: randomizeThreadLane(),
  };
}

function advanceMotionStates(states: MotionState[], now: number, elapsedFrames: number) {
  for (const state of states) {
    if (now < state.startAt) continue;
    state.position += state.speed * state.thread.direction * elapsedFrames;
    if (shouldWrap(state.thread, state.position)) {
      state.lanePercent = randomizeThreadLane();
      state.speed = state.thread.speed * randomBetween(MIN_SPEED_FACTOR, MAX_SPEED_FACTOR);
      state.position = resetPosition(state.thread);
    }
  }
}

function threadBox(thread: ThreadLine) {
  return {
    width: thread.width,
    height: thread.height,
  };
}

function baseThreadStyle(thread: ThreadLine): React.CSSProperties {
  return {
    width: `${thread.width}px`,
    height: `${thread.height}px`,
    background: threadGradientToCss(thread.axis, thread.coreStops),
    boxShadow: threadShadowToCss(thread.shadowLayers),
    filter: thread.filter,
  };
}

function drawThread(ctx: CanvasRenderingContext2D, state: MotionState, dpr: number) {
  const { width, height } = threadBox(state.thread);
  const { x, y } = computeTopLeft(state.thread, state.position, state.lanePercent, width, height);
  const opacity = computeOpacity(state.thread, state.position);
  if (opacity <= 0) return null;

  const grad =
    state.thread.axis === 'x'
      ? ctx.createLinearGradient(x * dpr, y * dpr, (x + width) * dpr, y * dpr)
      : ctx.createLinearGradient(x * dpr, y * dpr, x * dpr, (y + height) * dpr);
  for (const stop of state.thread.coreStops) grad.addColorStop(stop.offset, stop.color);

  const shadow = state.thread.shadowLayers.reduce(
    (strongest, layer) => (layer.blur > strongest.blur ? layer : strongest),
    { blur: 0, color: 'transparent' },
  );
  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.shadowBlur = shadow.blur * dpr;
  ctx.shadowColor = shadow.color;
  ctx.fillStyle = grad;
  ctx.fillRect(x * dpr, y * dpr, width * dpr, height * dpr);
  ctx.restore();

  return {
    id: state.thread.id,
    x,
    y,
    position: state.position,
    opacity,
  };
}

function ProductionMode({ probe }: { probe: FreezeProbe }) {
  useProbeRender(probe, 'ProductionMode');
  const handleFrame = useCallback(
    (metrics: ThreadBackgroundFrameMetrics) => {
      probe.reportDomWrite('production-thread-background', {
        mode: 'production',
        renderer: 'production-thread-background',
        sampleId: metrics.sample?.id,
        x: metrics.sample?.x,
        y: metrics.sample?.y,
        position: metrics.sample?.position,
        opacity: metrics.sample?.opacity,
        drawCount: metrics.drawCount,
      });
    },
    [probe],
  );

  return (
    <>
      <ThreadBackground onFrame={handleFrame} />
      <LabForeground subtitle="Current production ThreadBackground component" />
    </>
  );
}

function DomTransformMode({ probe }: { probe: FreezeProbe }) {
  useProbeRender(probe, 'DomTransformMode');
  const lineRefs = useRef(new Map<string, HTMLDivElement>());

  useEffect(() => {
    const states = THREAD_LINES.map((thread) => createMotionState(thread, performance.now()));
    let raf = 0;
    let lastTime: number | null = null;

    const tick = (now: number) => {
      const elapsedFrames = lastTime == null ? 1 : Math.min(2, ((now - lastTime) * 60) / 1000);
      lastTime = now;
      advanceMotionStates(states, now, elapsedFrames);

      let sample: ModelSnapshot | null = null;
      states.forEach((state) => {
        const el = lineRefs.current.get(state.thread.id);
        if (!el) return;
        const { width, height } = threadBox(state.thread);
        const { x, y } = computeTopLeft(state.thread, state.position, state.lanePercent, width, height);
        const opacity = computeOpacity(state.thread, state.position);
        el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
        el.style.opacity = `${opacity}`;
        if (!sample) {
          sample = {
            mode: 'dom',
            renderer: 'dom-transform',
            sampleId: state.thread.id,
            x,
            y,
            position: state.position,
            opacity,
          };
        }
      });

      if (sample) probe.reportDomWrite('dom-transform', sample);
      raf = window.requestAnimationFrame(tick);
    };

    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [probe]);

  return (
    <>
      <div className="ipad-freeze-lab-layer">
        {THREAD_LINES.map((thread) => (
          <div
            key={thread.id}
            ref={(node) => {
              if (node) lineRefs.current.set(thread.id, node);
              else lineRefs.current.delete(thread.id);
            }}
            className="ipad-freeze-lab-thread"
            style={{ ...baseThreadStyle(thread), willChange: 'transform, opacity' }}
          />
        ))}
      </div>
      <LabForeground subtitle="requestAnimationFrame DOM transform writes" />
    </>
  );
}

function CssAnimationMode({ probe }: { probe: FreezeProbe }) {
  useProbeRender(probe, 'CssAnimationMode');
  const firstRef = useRef<HTMLDivElement>(null);

  const threads = useMemo(
    () =>
      THREAD_LINES.map((thread) => {
        const lane = randomizeThreadLane();
        const travelSize = getThreadTravelSize(thread);
        const duration = Math.max(7, Math.min(95, 110 / Math.max(thread.speed, 0.2)));
        const delay = -randomBetween(0, duration);
        const style = {
          ...baseThreadStyle(thread),
          top: thread.axis === 'x' ? `${lane}%` : '0',
          left: thread.axis === 'y' ? `${lane}%` : '0',
          animationDuration: `${duration}s`,
          animationDelay: `${delay}s`,
          '--lab-from-x':
            thread.axis === 'x'
              ? thread.direction === 1
                ? `${-travelSize}px`
                : `calc(100vw + ${travelSize}px)`
              : '0px',
          '--lab-to-x':
            thread.axis === 'x'
              ? thread.direction === 1
                ? `calc(100vw + ${travelSize}px)`
                : `${-travelSize}px`
              : '0px',
          '--lab-from-y':
            thread.axis === 'y'
              ? thread.direction === 1
                ? `${-travelSize}px`
                : `calc(100vh + ${travelSize}px)`
              : '0px',
          '--lab-to-y':
            thread.axis === 'y'
              ? thread.direction === 1
                ? `calc(100vh + ${travelSize}px)`
                : `${-travelSize}px`
              : '0px',
        } as React.CSSProperties & Record<string, string>;
        return { thread, style };
      }),
    [],
  );

  useEffect(() => {
    let raf = 0;
    const tick = (now: number) => {
      const rect = firstRef.current?.getBoundingClientRect();
      if (rect) {
        probe.reportModel({
          mode: 'css',
          renderer: 'css-animation',
          sampleId: THREAD_LINES[0]?.id,
          x: rect.left,
          y: rect.top,
          phase: (now / 1000) % 1,
        });
      }
      raf = window.requestAnimationFrame(tick);
    };

    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [probe]);

  return (
    <>
      <div className="ipad-freeze-lab-layer">
        {threads.map(({ thread, style }, index) => (
          <div
            key={thread.id}
            ref={index === 0 ? firstRef : undefined}
            className="ipad-freeze-lab-thread ipad-freeze-lab-css-thread"
            style={style}
          />
        ))}
      </div>
      <LabForeground subtitle="CSS keyframe animation only" />
    </>
  );
}

function Canvas2DMode({ probe }: { probe: FreezeProbe }) {
  useProbeRender(probe, 'Canvas2DMode');
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return undefined;

    let dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    let raf = 0;
    let drawCount = 0;
    let lastTime: number | null = null;
    const states = THREAD_LINES.map((thread) => createMotionState(thread, performance.now()));

    const sizeCanvas = () => {
      dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      canvas.width = Math.round(window.innerWidth * dpr);
      canvas.height = Math.round(window.innerHeight * dpr);
      canvas.style.width = `${window.innerWidth}px`;
      canvas.style.height = `${window.innerHeight}px`;
    };

    const tick = (now: number) => {
      const elapsedFrames = lastTime == null ? 1 : Math.min(2, ((now - lastTime) * 60) / 1000);
      lastTime = now;
      advanceMotionStates(states, now, elapsedFrames);
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      let sample: NonNullable<ThreadBackgroundFrameMetrics['sample']> | null = null;
      states.forEach((state) => {
        const drawn = drawThread(ctx, state, dpr);
        if (!sample && drawn) sample = drawn;
      });
      drawCount += 1;
      probe.reportCanvasFrame('diagnostic-canvas-2d', {
        drawCount,
        now,
        sample,
        viewport: { width: window.innerWidth, height: window.innerHeight, dpr },
      });
      raf = window.requestAnimationFrame(tick);
    };

    sizeCanvas();
    window.addEventListener('resize', sizeCanvas);
    raf = window.requestAnimationFrame(tick);

    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener('resize', sizeCanvas);
    };
  }, [probe]);

  return (
    <>
      <canvas ref={canvasRef} className="ipad-freeze-lab-layer" aria-hidden="true" />
      <LabForeground subtitle="diagnostic canvas 2D draw loop" />
    </>
  );
}

function VanillaNonReactMode({ probe }: { probe: FreezeProbe }) {
  useProbeRender(probe, 'VanillaNonReactMode');
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    host.textContent = '';
    const states = THREAD_LINES.map((thread) => createMotionState(thread, performance.now()));
    const nodes = new Map<string, HTMLDivElement>();

    THREAD_LINES.forEach((thread) => {
      const node = document.createElement('div');
      node.className = 'ipad-freeze-lab-thread';
      Object.assign(node.style, baseThreadStyle(thread), {
        willChange: 'transform, opacity',
      });
      host.append(node);
      nodes.set(thread.id, node);
    });

    let raf = 0;
    let lastTime: number | null = null;
    const tick = (now: number) => {
      const elapsedFrames = lastTime == null ? 1 : Math.min(2, ((now - lastTime) * 60) / 1000);
      lastTime = now;
      advanceMotionStates(states, now, elapsedFrames);

      let sample: ModelSnapshot | null = null;
      states.forEach((state) => {
        const node = nodes.get(state.thread.id);
        if (!node) return;
        const { width, height } = threadBox(state.thread);
        const { x, y } = computeTopLeft(state.thread, state.position, state.lanePercent, width, height);
        const opacity = computeOpacity(state.thread, state.position);
        node.style.transform = `translate3d(${x}px, ${y}px, 0)`;
        node.style.opacity = `${opacity}`;
        if (!sample) {
          sample = {
            mode: 'vanilla',
            renderer: 'vanilla-dom-transform',
            sampleId: state.thread.id,
            x,
            y,
            position: state.position,
            opacity,
          };
        }
      });

      if (sample) probe.reportDomWrite('vanilla-dom-transform', sample);
      raf = window.requestAnimationFrame(tick);
    };

    raf = window.requestAnimationFrame(tick);

    return () => {
      window.cancelAnimationFrame(raf);
      host.textContent = '';
    };
  }, [probe]);

  return (
    <>
      <div ref={hostRef} className="ipad-freeze-lab-layer" />
      <LabForeground subtitle="imperative non-React DOM renderer" />
    </>
  );
}

function LabForeground({ subtitle }: { subtitle: string }) {
  return (
    <div className="ipad-freeze-lab-foreground" aria-hidden="true">
      <div>
        <div className="ipad-freeze-lab-title">ScentBeam motion probe</div>
        <div className="ipad-freeze-lab-subtitle">{subtitle}</div>
      </div>
    </div>
  );
}

function DebugOverlay({
  mode,
  probe,
  onModeChange,
}: {
  mode: LabMode;
  probe: FreezeProbe;
  onModeChange: (mode: LabMode) => void;
}) {
  useProbeRender(probe, 'DebugOverlay');
  const outputRef = useRef<HTMLPreElement>(null);

  useEffect(() => probe.attachOutput(outputRef.current), [probe]);

  return (
    <aside className="ipad-freeze-overlay" aria-label="iPad freeze diagnostic overlay">
      <div className="ipad-freeze-overlay-controls" role="tablist" aria-label="Render mode">
        {LAB_MODES.map((item) => (
          <button
            key={item.id}
            type="button"
            title={item.description}
            aria-pressed={mode === item.id}
            onClick={() => onModeChange(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="ipad-freeze-overlay-actions">
        <button type="button" onClick={() => probe.mark('manual freeze marker')}>
          <Flag aria-hidden="true" />
          Mark
        </button>
        <button type="button" onClick={() => probe.downloadLog()}>
          <Download aria-hidden="true" />
          Export
        </button>
        <button
          type="button"
          onClick={() => {
            void probe.copyLog();
          }}
        >
          <Clipboard aria-hidden="true" />
          Copy
        </button>
        <button type="button" onClick={() => probe.reset()}>
          <RotateCcw aria-hidden="true" />
          Reset
        </button>
      </div>
      <pre ref={outputRef} className="ipad-freeze-overlay-output">
        Starting instrumentation...
      </pre>
    </aside>
  );
}

export default function IpadFreezeLab() {
  const probeRef = useRef<FreezeProbe | null>(null);
  if (!probeRef.current) {
    probeRef.current = createFreezeProbe();
  }
  const probe = probeRef.current;
  const [mode, setMode] = useState<LabMode>(getInitialMode);
  const initialModeRef = useRef(mode);

  useProbeRender(probe, 'IpadFreezeLab');

  useEffect(() => {
    probe.start(initialModeRef.current);
    return () => probe.stop();
  }, [probe]);

  useEffect(() => {
    probe.setMode(mode);
    const params = new URLSearchParams(window.location.search);
    params.set('mode', mode);
    window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`);
  }, [mode, probe]);

  const modeView = (() => {
    switch (mode) {
      case 'dom':
        return <DomTransformMode probe={probe} />;
      case 'css':
        return <CssAnimationMode probe={probe} />;
      case 'canvas':
        return <Canvas2DMode probe={probe} />;
      case 'vanilla':
        return <VanillaNonReactMode probe={probe} />;
      case 'production':
      default:
        return <ProductionMode probe={probe} />;
    }
  })();

  return (
    <div className="ipad-freeze-lab">
      <style>{LAB_STYLE}</style>
      <div className="ipad-freeze-lab-stage">{modeView}</div>
      <DebugOverlay mode={mode} probe={probe} onModeChange={setMode} />
    </div>
  );
}
