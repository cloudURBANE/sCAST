// Installed-PWA viewport zoom lock.
//
// In a normal browser tab, pinch/double-tap zoom is an accessibility feature
// and index.html deliberately ships a viewport meta WITHOUT
// `maximum-scale`/`user-scalable=no` (WCAG 1.4.4). But an installed PWA is
// expected to behave like a native app, where the viewport never scales:
// pinch-zooming the app shell, double-tap zoom on fast taps, and the iOS
// input-focus auto-zoom all read as defects in standalone mode. So the lock
// is applied at runtime, ONLY when the app is running as an installed PWA —
// browser-tab zoom (and OS/browser text scaling) is untouched.
//
// Three layers, because no single one covers every engine:
//  1. Viewport meta upgrade (`maximum-scale=1, user-scalable=no`) — honored by
//     Android Chrome standalone and by iOS home-screen apps; also suppresses
//     the iOS auto-zoom-on-input-focus that leaves the app stuck zoomed-in.
//  2. `touch-action: pan-x pan-y` on <html>/<body> (via the `pwa-standalone`
//     class, rule in index.css) — removes pinch-zoom and double-tap zoom from
//     the touch-action whitelist in modern WebKit/Blink. Child elements that
//     declare their own touch-action (marquee `pan-y` lanes, etc.) still work:
//     effective touch behavior is the intersection along the ancestor chain.
//  3. Non-standard iOS GestureEvents — legacy WebKit fires these for pinch in
//     standalone mode even when (1) and (2) are ignored; preventDefault stops
//     the scale gesture.
import { isStandalonePwa } from "./platform";

export function initPwaZoomLock(): void {
  if (typeof document === "undefined" || !isStandalonePwa()) return;

  document.documentElement.classList.add("pwa-standalone");

  const viewportMeta = document.querySelector<HTMLMetaElement>(
    'meta[name="viewport"]',
  );
  if (viewportMeta && !/maximum-scale/i.test(viewportMeta.content)) {
    viewportMeta.content = `${viewportMeta.content}, maximum-scale=1, user-scalable=no`;
  }

  const blockGesture = (event: Event) => {
    event.preventDefault();
  };
  for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
    document.addEventListener(type, blockGesture, {
      passive: false,
      capture: true,
    });
  }
}
