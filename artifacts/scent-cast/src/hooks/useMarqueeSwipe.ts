import { useEffect, type RefObject } from 'react';

/**
 * Adds swipe/drag control to a CSS-keyframe marquee track.
 *
 * While idle the marquee stays on its compositor-driven CSS animation. On a
 * committed horizontal drag the hook reads the live transform, switches the
 * track to a JS-driven transform that follows the pointer, applies momentum on
 * release, and hands the track back to the CSS animation at the matching loop
 * position via a negative animation-delay — so the marquee resumes its gentle
 * cruise exactly where the finger left it, in either drag direction.
 *
 * Gesture rules keep the marquee polite on touch devices: vertical movement is
 * left to page scroll (pair with `touch-action: pan-y` on the track), and taps
 * pass through untouched — a drag is only committed past a horizontal slop,
 * after which the next click on the track is suppressed so card buttons inside
 * the marquee don't fire at the end of a swipe.
 */
interface MarqueeSwipeOptions {
  /** CSS custom property holding the loop distance in px (width of one copy). */
  distanceVar: string;
  /** CSS custom property holding the loop duration in seconds. */
  durationVar: string;
  /** Changes whenever the track DOM node is recreated (e.g. a keyed track). */
  resetKey?: unknown;
}

const DRAG_COMMIT_PX = 7; // horizontal slop before a drag is committed
const SCROLL_CANCEL_PX = 12; // vertical slop that hands the gesture to page scroll
const MAX_FLING_PX_PER_S = 3200;
const CRUISE_BLEND_TAU_S = 0.55; // momentum eases toward cruise speed on this time constant
const CRUISE_RESUME_EPSILON_PX_PER_S = 14; // close enough to hand back to CSS

const normalizeLoop = (value: number, distance: number): number =>
  distance > 0 ? ((value % distance) + distance) % distance : 0;

const readTranslateX = (track: HTMLElement): number => {
  const transform = getComputedStyle(track).transform;
  if (!transform || transform === 'none') return 0;
  try {
    return new DOMMatrixReadOnly(transform).m41;
  } catch {
    return 0;
  }
};

export function useMarqueeSwipe(
  trackRef: RefObject<HTMLElement | null>,
  { distanceVar, durationVar, resetKey }: MarqueeSwipeOptions,
): void {
  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;

    const readVar = (name: string): number => {
      const raw = getComputedStyle(track).getPropertyValue(name);
      const parsed = parseFloat(raw);
      return Number.isFinite(parsed) ? parsed : 0;
    };

    let pointerId: number | null = null;
    let pending = false;
    let dragging = false;
    let suppressClick = false;
    let manual = false;
    let startX = 0;
    let startY = 0;
    let lastX = 0;
    let lastMoveT = 0;
    let lastFrameT = 0;
    let offset = 0; // px the loop has advanced; track sits at translateX(-offset)
    let velocity = 0; // px/s in the loop's forward direction
    let frame = 0;

    const applyTransform = () => {
      track.style.transform = `translate3d(${-offset}px, 0, 0)`;
    };

    const enterManual = () => {
      if (manual) return;
      offset = normalizeLoop(-readTranslateX(track), readVar(distanceVar));
      manual = true;
      track.style.animation = 'none';
      track.dataset.marqueeDragging = 'true';
      applyTransform();
    };

    const resumeCss = () => {
      if (!manual) return;
      manual = false;
      delete track.dataset.marqueeDragging;
      const distance = readVar(distanceVar);
      const duration = readVar(durationVar);
      const progress = distance > 0 ? normalizeLoop(offset, distance) / distance : 0;
      // Clearing the inline shorthand restores the class animation; the
      // negative delay restarts it mid-loop at the current position.
      track.style.animation = '';
      track.style.transform = '';
      track.style.animationDelay = duration > 0 ? `-${(progress * duration).toFixed(3)}s` : '';
    };

    const stepMomentum = (now: number) => {
      frame = 0;
      const distance = readVar(distanceVar);
      if (distance <= 0) {
        resumeCss();
        return;
      }
      const duration = readVar(durationVar);
      const cruise = duration > 0 ? distance / duration : 0;
      const dt = Math.min(Math.max((now - lastFrameT) / 1000, 0), 0.05);
      lastFrameT = now;
      offset = normalizeLoop(offset + velocity * dt, distance);
      applyTransform();
      velocity = cruise + (velocity - cruise) * Math.exp(-dt / CRUISE_BLEND_TAU_S);
      if (Math.abs(velocity - cruise) <= CRUISE_RESUME_EPSILON_PX_PER_S) {
        resumeCss();
        return;
      }
      frame = requestAnimationFrame(stepMomentum);
    };

    const onPointerDown = (event: PointerEvent) => {
      if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
      if (track.dataset.marqueeReady !== 'true') return;
      suppressClick = false;
      pointerId = event.pointerId;
      startX = lastX = event.clientX;
      startY = event.clientY;
      lastMoveT = event.timeStamp;
      if (frame) {
        // Caught mid-momentum: hold the track under the finger immediately.
        cancelAnimationFrame(frame);
        frame = 0;
        velocity = 0;
        dragging = true;
        pending = false;
        suppressClick = true;
        try {
          track.setPointerCapture(event.pointerId);
        } catch {
          /* pointer may already be gone */
        }
      } else {
        pending = true;
        dragging = false;
      }
    };

    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      if (!dragging) {
        if (!pending) return;
        const dx = event.clientX - startX;
        const dy = event.clientY - startY;
        if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > SCROLL_CANCEL_PX) {
          // Vertical intent: let the page scroll own this gesture.
          pending = false;
          pointerId = null;
          return;
        }
        if (Math.abs(dx) < DRAG_COMMIT_PX || Math.abs(dx) <= Math.abs(dy)) return;
        if (readVar(distanceVar) <= 0) {
          pending = false;
          pointerId = null;
          return;
        }
        pending = false;
        dragging = true;
        suppressClick = true;
        try {
          track.setPointerCapture(event.pointerId);
        } catch {
          /* pointer may already be gone */
        }
        enterManual();
        velocity = 0;
        lastX = event.clientX;
        lastMoveT = event.timeStamp;
        return;
      }
      const distance = readVar(distanceVar);
      if (distance <= 0) return;
      const delta = event.clientX - lastX;
      const dt = Math.max((event.timeStamp - lastMoveT) / 1000, 1 / 240);
      // Finger right moves the loop backwards, so the forward velocity is -delta.
      velocity = velocity * 0.7 + (-delta / dt) * 0.3;
      offset = normalizeLoop(offset - delta, distance);
      applyTransform();
      lastX = event.clientX;
      lastMoveT = event.timeStamp;
    };

    const finishPointer = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      pointerId = null;
      pending = false;
      if (!dragging) return;
      dragging = false;
      velocity = Math.max(-MAX_FLING_PX_PER_S, Math.min(MAX_FLING_PX_PER_S, velocity));
      lastFrameT = performance.now();
      frame = requestAnimationFrame(stepMomentum);
    };

    const onTouchMove = (event: TouchEvent) => {
      // iOS Safari fires pointercancel and claims the gesture for page scroll
      // during horizontal pans on a pan-y element unless the touch default is
      // prevented (w3c/pointerevents#303). Pointer events alone never survive
      // long enough to commit a drag, so horizontal intent is detected here
      // and the native scroll suppressed; vertical moves stay untouched so
      // page scrolling keeps working.
      if (dragging) {
        event.preventDefault();
        return;
      }
      if (!pending || event.touches.length !== 1) return;
      const touch = event.touches[0];
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) >= DRAG_COMMIT_PX) {
        event.preventDefault();
      }
    };

    const onClickCapture = (event: MouseEvent) => {
      if (!suppressClick) return;
      suppressClick = false;
      event.preventDefault();
      event.stopPropagation();
    };

    const onDragStart = (event: DragEvent) => {
      event.preventDefault();
    };

    track.addEventListener('pointerdown', onPointerDown);
    track.addEventListener('pointermove', onPointerMove);
    track.addEventListener('pointerup', finishPointer);
    track.addEventListener('pointercancel', finishPointer);
    track.addEventListener('touchmove', onTouchMove, { passive: false });
    track.addEventListener('click', onClickCapture, true);
    track.addEventListener('dragstart', onDragStart);

    return () => {
      if (frame) cancelAnimationFrame(frame);
      resumeCss();
      track.removeEventListener('pointerdown', onPointerDown);
      track.removeEventListener('pointermove', onPointerMove);
      track.removeEventListener('pointerup', finishPointer);
      track.removeEventListener('pointercancel', finishPointer);
      track.removeEventListener('touchmove', onTouchMove);
      track.removeEventListener('click', onClickCapture, true);
      track.removeEventListener('dragstart', onDragStart);
    };
  }, [trackRef, distanceVar, durationVar, resetKey]);
}
