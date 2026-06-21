// Cookie & privacy consent store for the ScentBeam SPA.
//
// ScentBeam uses two storage tiers, and only two — we deliberately model exactly
// what the app actually does rather than inventing categories:
//
//   - Essential: the opaque auth token, saved wardrobe / UI preferences, and this
//     consent record itself. Always on; the product cannot function without them.
//   - Analytics: anonymous performance measurement only (Core Web Vitals beacons
//     to VITE_WEB_VITALS_URL, see lib/webVitalsTelemetry.ts). Optional, and OFF
//     until the user explicitly opts in.
//
// There are no advertising, marketing, or cross-site tracking cookies, so there
// is no third tier to toggle. The choice is explicit, stored in localStorage,
// and reversible at any time from the footer or the Cookie Policy page.
//
// Mirrors the repo's existing storage conventions (PushPrompt's DISMISS_KEY,
// AuthContext's token persistence): a single namespaced key + quiet try/catch so
// private-mode / quota failures degrade to an in-memory choice instead of throwing.

export interface ConsentState {
  /** Schema version — a bump invalidates a stale record so the banner re-prompts. */
  version: number;
  /** Has the user made an explicit choice yet? */
  decided: boolean;
  /** Opted into optional performance analytics? */
  analytics: boolean;
  /** Epoch ms of the last decision (0 when never decided). */
  updatedAt: number;
}

const STORAGE_KEY = "scent_cookie_consent";
const CONSENT_VERSION = 1;

/** Fired (with the new ConsentState as detail) whenever a choice is saved. */
export const CONSENT_CHANGED_EVENT = "scent:consent-changed";
/** Fired to ask the banner to re-open its preferences manager from anywhere. */
export const CONSENT_OPEN_EVENT = "scent:consent-open";

const DEFAULT_STATE: ConsentState = {
  version: CONSENT_VERSION,
  decided: false,
  analytics: false,
  updatedAt: 0,
};

export function readConsent(): ConsentState {
  if (typeof window === "undefined") return { ...DEFAULT_STATE };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_STATE };
    const parsed = JSON.parse(raw) as Partial<ConsentState>;
    // A version mismatch means the categories changed since the user decided —
    // treat it as undecided so we re-ask rather than honoring a stale choice.
    if (parsed.version !== CONSENT_VERSION) return { ...DEFAULT_STATE };
    return {
      version: CONSENT_VERSION,
      decided: Boolean(parsed.decided),
      analytics: Boolean(parsed.analytics),
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function hasDecidedConsent(): boolean {
  return readConsent().decided;
}

export function hasAnalyticsConsent(): boolean {
  const state = readConsent();
  return state.decided && state.analytics;
}

export function writeConsent(patch: { analytics: boolean }): ConsentState {
  const next: ConsentState = {
    version: CONSENT_VERSION,
    decided: true,
    analytics: Boolean(patch.analytics),
    updatedAt: Date.now(),
  };
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* private mode / quota — the choice stays in-memory for this session */
    }
    try {
      window.dispatchEvent(new CustomEvent<ConsentState>(CONSENT_CHANGED_EVENT, { detail: next }));
    } catch {
      /* CustomEvent unsupported — listeners just won't refresh this tick */
    }
  }
  return next;
}

/** Accept everything (essential + analytics). */
export function acceptAllConsent(): ConsentState {
  return writeConsent({ analytics: true });
}

/** Essential only — decline optional analytics. Never auto-called; user-driven. */
export function rejectNonEssentialConsent(): ConsentState {
  return writeConsent({ analytics: false });
}

/** Ask the banner to re-open its preferences UI (footer link / Cookie page). */
export function openConsentManager(): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new Event(CONSENT_OPEN_EVENT));
  } catch {
    /* ignore */
  }
}

/** Subscribe to consent changes; returns an unsubscribe fn. */
export function onConsentChange(listener: (state: ConsentState) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<ConsentState>).detail;
    listener(detail ?? readConsent());
  };
  window.addEventListener(CONSENT_CHANGED_EVENT, handler);
  return () => window.removeEventListener(CONSENT_CHANGED_EVENT, handler);
}
