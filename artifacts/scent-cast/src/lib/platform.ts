// Runtime platform / device-class detection.
//
// iPad and coarse-pointer mobile browsers are the proven bottleneck for the
// heavy thread background, full route transition overlay, and duplicated
// bottle-image surfaces. These helpers centralize the device/render-budget
// checks so components do not scatter their own ad-hoc sniffing.

function hasWindow(): boolean {
  return typeof window !== "undefined" && typeof navigator !== "undefined";
}

/**
 * True for iPadOS, including modern iPads, which report a desktop "Macintosh"
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

/** Installed iPad PWA. */
export function isIpadStandalone(): boolean {
  return isIpadDevice() && isStandalonePwa();
}

/** True for narrow touch devices where compositor budget is usually limited. */
export function isConstrainedTouchDevice(): boolean {
  if (!hasWindow()) return false;
  if (isIpadDevice()) return true;

  const coarsePointer =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches;
  const touchPoints = navigator.maxTouchPoints || 0;
  if (!coarsePointer && touchPoints <= 1) return false;

  const shortestViewportSide = Math.min(window.innerWidth || 0, window.innerHeight || 0);
  return shortestViewportSide > 0 && shortestViewportSide <= 920;
}

/** Honors the OS "reduce motion" accessibility preference. */
export function prefersReducedMotion(): boolean {
  if (!hasWindow() || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Low-render-budget signal. Components use this to drop per-frame backgrounds,
 * use cheaper route-transition motion, and avoid duplicated image/video surfaces
 * that fast touch scrolling cannot keep up with.
 */
export function isLowRenderBudget(): boolean {
  return prefersReducedMotion() || isConstrainedTouchDevice();
}
