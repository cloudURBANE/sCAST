import { useEffect, type RefObject } from 'react';

/**
 * Adds mouse / trackpad click-drag scrolling to a native `overflow-x-auto`
 * strip (e.g. a horizontal chip lane). Touch is left entirely to the
 * browser's own momentum scrolling — this hook only augments pointer devices
 * that have no fling gesture of their own.
 *
 * This is deliberately distinct from `useMarqueeSwipe`, which drives an
 * auto-cruising CSS-keyframe marquee; here the track is a plain scroll
 * container and a committed drag just nudges `scrollLeft`.
 *
 * Gesture etiquette mirrors the marquee hook: a drag commits only past a
 * small horizontal slop and only when horizontal intent beats vertical (so
 * the page can still scroll up/down), and the click that ends a committed
 * drag is swallowed so a chip doesn't fire at the end of a swipe. A
 * grab/grabbing cursor signals the affordance on pointer devices.
 */
const DRAG_COMMIT_PX = 6; // horizontal slop before a mouse drag is committed

export function useDragToScroll(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let pointerId: number | null = null;
    let pending = false;
    let dragging = false;
    let suppressClick = false;
    let startX = 0;
    let startY = 0;
    let lastX = 0;

    el.style.cursor = 'grab';

    const onPointerDown = (event: PointerEvent) => {
      // Touch and pen keep their native scrolling/momentum; only augment the
      // mouse and trackpad, which otherwise can't drag a horizontal strip.
      if (event.pointerType !== 'mouse' || event.button !== 0 || !event.isPrimary) return;
      suppressClick = false;
      pointerId = event.pointerId;
      startX = lastX = event.clientX;
      startY = event.clientY;
      pending = true;
      dragging = false;
    };

    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      if (!dragging) {
        if (!pending) return;
        const dx = event.clientX - startX;
        const dy = event.clientY - startY;
        // Commit only on clear horizontal intent so vertical page scroll wins.
        if (Math.abs(dx) < DRAG_COMMIT_PX || Math.abs(dx) <= Math.abs(dy)) return;
        pending = false;
        dragging = true;
        suppressClick = true;
        el.style.cursor = 'grabbing';
        try {
          el.setPointerCapture(event.pointerId);
        } catch {
          /* pointer may already be gone */
        }
        lastX = event.clientX;
        return;
      }
      const dx = event.clientX - lastX;
      lastX = event.clientX;
      el.scrollLeft -= dx;
    };

    const finishPointer = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      pointerId = null;
      pending = false;
      if (!dragging) return;
      dragging = false;
      el.style.cursor = 'grab';
    };

    const onClickCapture = (event: MouseEvent) => {
      if (!suppressClick) return;
      suppressClick = false;
      event.preventDefault();
      event.stopPropagation();
    };

    const onDragStart = (event: DragEvent) => {
      if (dragging) event.preventDefault();
    };

    el.addEventListener('pointerdown', onPointerDown, { passive: true });
    el.addEventListener('pointermove', onPointerMove, { passive: true });
    el.addEventListener('pointerup', finishPointer, { passive: true });
    el.addEventListener('pointercancel', finishPointer, { passive: true });
    el.addEventListener('click', onClickCapture, true);
    el.addEventListener('dragstart', onDragStart);

    return () => {
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', finishPointer);
      el.removeEventListener('pointercancel', finishPointer);
      el.removeEventListener('click', onClickCapture, true);
      el.removeEventListener('dragstart', onDragStart);
      el.style.cursor = '';
    };
  }, [ref]);
}
