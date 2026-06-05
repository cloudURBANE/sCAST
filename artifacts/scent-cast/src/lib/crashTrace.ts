/**
 * Crash tracer for the iOS "A problem repeatedly occurred" WebContent crash.
 *
 * That message is a WebContent *process* kill (memory pressure), not a JS
 * exception — so in-memory React state is gone and a styled ErrorBoundary never
 * gets a chance to render. localStorage, however, is disk-backed and survives
 * the kill + auto-reload. We write a synchronous breadcrumb at each phase of the
 * fragrance-detail open/close cycle; after a crash the *previous* page load's
 * trail tells us the exact step that was executing when the process died.
 *
 * A visible build stamp (CrashTraceBadge) also proves which bundle the device is
 * actually running — iOS caches installed PWAs aggressively, so a "fix" can look
 * ineffective simply because the device never loaded it.
 *
 * This is temporary diagnostic instrumentation. Remove once the crash is fixed.
 */

// Replaced at build time by Vite `define` (see vite.config.ts).
declare const __BUILD_ID__: string;

export const BUILD_ID: string =
  typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "dev";

const CURRENT_KEY = "sb_trace_current";
const PREVIOUS_KEY = "sb_trace_previous";
const MAX_CRUMBS = 48;

export interface Crumb {
  /** Milliseconds since this page load started. */
  t: number;
  label: string;
}

export interface TraceSession {
  buildId: string;
  startedAt: number;
  crumbs: Crumb[];
}

let session: TraceSession | null = null;
let startEpoch = 0;

function read(key: string): TraceSession | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as TraceSession;
    if (!parsed || !Array.isArray(parsed.crumbs)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function write(key: string, value: TraceSession): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or disabled — tracing is best-effort */
  }
}

/**
 * Begin tracing for this page load. The prior load's in-progress trail (which a
 * crash would have left mid-cycle) is moved into the "previous" slot, then a
 * fresh trail starts. A `pagehide` breadcrumb marks clean teardown, so a
 * previous trail whose last crumb is NOT `unload` indicates an abnormal kill.
 */
export function initCrashTrace(): void {
  if (typeof window === "undefined" || typeof localStorage === "undefined") return;
  if (session) return;

  const prior = read(CURRENT_KEY);
  if (prior && prior.crumbs.length > 0) {
    write(PREVIOUS_KEY, prior);
  }

  startEpoch = Date.now();
  session = { buildId: BUILD_ID, startedAt: startEpoch, crumbs: [] };
  write(CURRENT_KEY, session);
  crumb("boot");

  // pagehide is the reliable teardown signal on iOS Safari (beforeunload is not).
  window.addEventListener("pagehide", () => crumb("unload"));
}

/** Append a synchronous, crash-surviving breadcrumb. */
export function crumb(label: string): void {
  if (!session) return;
  session.crumbs.push({ t: Date.now() - startEpoch, label });
  if (session.crumbs.length > MAX_CRUMBS) {
    session.crumbs.splice(0, session.crumbs.length - MAX_CRUMBS);
  }
  write(CURRENT_KEY, session);
}

/** The trail left by the prior page load (present after a crash + reload). */
export function getPreviousSession(): TraceSession | null {
  if (typeof localStorage === "undefined") return null;
  return read(PREVIOUS_KEY);
}

/** True when the previous load ended without a clean `unload` — i.e. a kill. */
export function previousLoadLooksLikeCrash(session: TraceSession | null): boolean {
  if (!session || session.crumbs.length === 0) return false;
  const last = session.crumbs[session.crumbs.length - 1];
  return last.label !== "unload";
}

export function clearTrace(): void {
  try {
    localStorage.removeItem(CURRENT_KEY);
    localStorage.removeItem(PREVIOUS_KEY);
  } catch {
    /* ignore */
  }
}
