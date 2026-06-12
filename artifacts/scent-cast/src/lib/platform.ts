// Runtime platform / device-class detection.
//
// Phone-class coarse-pointer browsers are the proven bottleneck for the heavy
// thread background, full route transition overlay, and duplicated
// bottle-image surfaces. iPads are deliberately NOT in that class: they carry
// desktop-grade silicon and a large canvas, so they get the full desktop
// experience. iPad-specific WebKit quirks (compositor scheduling, keyframe
// resume) are handled by dedicated `isIpadDevice()` code paths that change the
// implementation, never the richness. These helpers centralize the
// device/render-budget checks so components do not scatter their own ad-hoc
// sniffing.

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

/**
 * True for phone-class touch devices where compositor budget is usually
 * limited. iPads are explicitly excluded — they are desktop-class hardware and
 * must receive the full-fidelity experience (see header comment).
 */
export function isConstrainedTouchDevice(): boolean {
  if (!hasWindow()) return false;
  if (isIpadDevice()) return false;

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
