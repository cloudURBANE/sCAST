// Runtime platform / device-class detection.
//
// iPad PWA Safari is the proven bottleneck for the heavy thread background,
// route transition overlay, and duplicated bottle-image surfaces (see
// docs/IPAD_PWA_EXPERIENCE_FIX_PLAN.md). These helpers centralize the
// user-agent/display-mode sniffing so components don't scatter their own ad-hoc
// checks. Detection is deliberately conservative: we only treat a session as a
// constrained iPad PWA when we are confident, so desktop/regular-mobile behavior
// is never altered.

function hasWindow(): boolean {
  return typeof window !== "undefined" && typeof navigator !== "undefined";
}

/**
 * True for iPadOS — including modern iPads, which report a desktop "Macintosh"
 * user-agent and must be distinguished by their touch capability.
 */
export function isIpadDevice(): boolean {
  if (!hasWindow()) return false;
  const ua = navigator.userAgent || "";
  if (/iPad/i.test(ua)) return true;
  const maxTouchPoints = navigator.maxTouchPoints || 0;
  // iPadOS 13+ masquerades as macOS Safari; a Mac with a touch screen does not
  // exist, so Macintosh + touch is an iPad.
  return /Macintosh/i.test(ua) && maxTouchPoints > 1;
}

/** True when the page is running as an installed/standalone PWA. */
export function isStandalonePwa(): boolean {
  if (!hasWindow()) return false;
  const standaloneMedia =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(display-mode: standalone)").matches;
  // iOS Safari exposes the legacy non-standard navigator.standalone flag.
  const iosStandalone = (navigator as { standalone?: boolean }).standalone === true;
  return Boolean(standaloneMedia || iosStandalone);
}

/** Installed iPad PWA — the specific class the render-budget reductions target. */
export function isIpadStandalone(): boolean {
  return isIpadDevice() && isStandalonePwa();
}

/** Honors the OS "reduce motion" accessibility preference. */
export function prefersReducedMotion(): boolean {
  if (!hasWindow() || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Conservative low-render-budget signal: an installed iPad PWA, or any device
 * where the user has asked for reduced motion. Components use this to drop
 * per-frame backgrounds, route-transition animations, and duplicated image
 * surfaces that fast iPad scrolling cannot keep up with.
 */
export function isLowRenderBudget(): boolean {
  return isIpadStandalone() || prefersReducedMotion();
}
