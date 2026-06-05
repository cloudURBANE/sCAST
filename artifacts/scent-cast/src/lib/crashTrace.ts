/**
 * Invisible crash tracer for the iOS "A problem repeatedly occurred" WebContent
 * crash on repeated fragrance-detail open/close.
 *
 * That message is a WebContent *process* kill — not a JS exception — so React
 * state is gone and an ErrorBoundary never renders. localStorage is disk-backed
 * and survives the kill + auto-reload, so we write a synchronous breadcrumb at
 * each phase of the open/close cycle. After a crash, the *previous* page load's
 * final breadcrumb names the exact phase that was executing when the process
 * died, which tells us whether the kill happens during the heavy mount, during
 * teardown, or only after N cumulative cycles (memory) vs a fixed cycle
 * (deterministic).
 *
 * IMPORTANT — this is INVISIBLE by default. Nothing renders on the live site.
 * The trail is only surfaced by <CrashDiag/> when the URL carries the secret
 * `?__mcdiag` param (see CrashDiag.tsx). No badge, no prod UI. Temporary; remove
 * once the crash is root-caused.
 */

const CURRENT_KEY = "sb_trace_current";
const PREVIOUS_KEY = "sb_trace_previous";
const MAX_CRUMBS = 64;

export interface Crumb {
  /** Milliseconds since this page load started. */
  t: number;
  label: string;
}

export interface TraceSession {
  startedAt: number;
  /** One-time device/budget facts — confirms which render path the device takes. */
  facts: Record<string, unknown>;
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

function collectFacts(): Record<string, unknown> {
  if (typeof window === "undefined" || typeof navigator === "undefined") return {};
  const nav = navigator as Navigator & { deviceMemory?: number; standalone?: boolean };
  let reducedMotion = false;
  let coarsePointer = false;
  let standaloneMedia = false;
  try {
    reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    coarsePointer = window.matchMedia("(pointer: coarse)").matches;
    standaloneMedia = window.matchMedia("(display-mode: standalone)").matches;
  } catch {
    /* matchMedia unavailable */
  }
  return {
    ua: nav.userAgent,
    vw: window.innerWidth,
    vh: window.innerHeight,
    dpr: window.devicePixelRatio,
    maxTouchPoints: nav.maxTouchPoints || 0,
    deviceMemory: nav.deviceMemory ?? null,
    reducedMotion,
    coarsePointer,
    standalonePwa: Boolean(standaloneMedia || nav.standalone === true),
  };
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
  session = { startedAt: startEpoch, facts: collectFacts(), crumbs: [] };
  write(CURRENT_KEY, session);
  crumb("boot");

  // pagehide is the reliable teardown signal on iOS Safari (beforeunload is not).
  window.addEventListener("pagehide", () => crumb("unload"));
}

/**
 * Cheap DOM census for breadcrumbs. If these counts GROW per open/close cycle,
 * the crash is a JS/DOM leak (nodes not released); if they stay flat while the
 * tab still dies, it's iOS decoded-image / GPU-surface cache pressure, not a
 * leak — different fixes. iOS Safari exposes no `performance.memory`, so this
 * delta is the closest proxy we have.
 */
export function domSnapshot(): string {
  if (typeof document === "undefined") return "";
  try {
    const imgs = document.getElementsByTagName("img").length;
    const nodes = document.getElementsByTagName("*").length;
    const canvas = document.getElementsByTagName("canvas").length;
    return `imgs=${imgs} nodes=${nodes} canvas=${canvas}`;
  } catch {
    return "";
  }
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
export function previousLoadLooksLikeCrash(s: TraceSession | null): boolean {
  if (!s || s.crumbs.length === 0) return false;
  const last = s.crumbs[s.crumbs.length - 1];
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
