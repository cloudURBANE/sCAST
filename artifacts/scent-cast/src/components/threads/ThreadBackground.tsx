import React, { useEffect, useRef } from 'react';
import { THREAD_LINES, type ThreadLine } from './threadLines';

const SHARED_STYLE: React.CSSProperties = {
  position: 'fixed',
  zIndex: 0,
  willChange: 'transform',
  backfaceVisibility: 'hidden',
  perspective: '1000px',
};

function getInitialPosition(thread: ThreadLine): number {
  const { axis, direction, wrap } = thread;
  if (axis === 'x') {
    return direction === 1 ? -wrap : window.innerWidth;
  }
  return direction === 1 ? -wrap : window.innerHeight;
}

function computeTransform(thread: ThreadLine, position: number): string {
  const { axis, direction } = thread;
  if (axis === 'x') {
    const x = direction === 1 ? position : position - window.innerWidth;
    return `translateX(${x}px)`;
  }
  const y = direction === 1 ? position : position - window.innerHeight;
  return `translateY(${y}px)`;
}

function computeOpacity(thread: ThreadLine, position: number): number {
  const { axis, direction, fade } = thread;
  if (fade == null) return 1;

  const limit = axis === 'x' ? window.innerWidth : window.innerHeight;

  if (direction === 1) {
    if (position < fade) return Math.max(0, position / fade);
    if (position > limit - fade) return Math.max(0, (limit + fade - position) / fade);
  } else {
    if (position > limit - fade) return Math.max(0, (limit - position) / fade);
    if (position < fade) return Math.max(0, position / fade);
  }

  return 1;
}

function shouldWrap(thread: ThreadLine, position: number): boolean {
  const { axis, direction, wrap } = thread;
  const limit = axis === 'x' ? window.innerWidth : window.innerHeight;

  if (direction === 1) return position > limit + wrap;
  return position < -wrap;
}

function resetPosition(thread: ThreadLine): number {
  const { axis, direction, wrap } = thread;
  if (direction === 1) return -wrap;
  return axis === 'x' ? window.innerWidth : window.innerHeight;
}

function startThreadAnimation(
  el: HTMLElement,
  thread: ThreadLine,
  activeRef: React.MutableRefObject<boolean>,
): () => void {
  let position = getInitialPosition(thread);

  const tick = () => {
    if (!activeRef.current) return;

    position += thread.speed * thread.direction;

    if (shouldWrap(thread, position)) {
      position = resetPosition(thread);
    }

    el.style.transform = computeTransform(thread, position);

    if (thread.fade != null) {
      el.style.opacity = String(computeOpacity(thread, position));
    }

    requestAnimationFrame(tick);
  };

  return tick;
}

/**
 * Nexus-style moving thread lines from the ThanksBeam tip page (bundle function a6).
 */
export const ThreadBackground: React.FC = React.memo(() => {
  const containerRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef(true);

  useEffect(() => {
    activeRef.current = true;
    const container = containerRef.current;
    if (!container) return undefined;

    const elements = container.querySelectorAll<HTMLElement>('[data-thread]');
    const timeouts: ReturnType<typeof setTimeout>[] = [];

    elements.forEach((el, index) => {
      const thread = THREAD_LINES[index];
      if (!thread) return;

      const tick = startThreadAnimation(el, thread, activeRef);

      if (thread.delay === 0) {
        requestAnimationFrame(tick);
      } else {
        timeouts.push(setTimeout(() => requestAnimationFrame(tick), thread.delay));
      }
    });

    return () => {
      activeRef.current = false;
      timeouts.forEach(clearTimeout);
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 overflow-hidden pointer-events-none"
      style={{ zIndex: 0 }}
      aria-hidden="true"
    >
      {THREAD_LINES.map((thread) => {
        const { id, top, bottom, left, right, width, height, background, boxShadow, filter, axis, direction, wrap } =
          thread;

        const initialTransform =
          axis === 'x'
            ? direction === 1
              ? `translateX(-${wrap}px)`
              : `translateX(${wrap}px)`
            : direction === 1
              ? `translateY(-${wrap}px)`
              : `translateY(${wrap}px)`;

        return (
          <div
            key={id}
            data-thread={id}
            style={{
              ...SHARED_STYLE,
              top,
              bottom,
              left,
              right,
              width,
              height,
              background,
              boxShadow,
              filter,
              transform: initialTransform,
            }}
          />
        );
      })}
    </div>
  );
});

ThreadBackground.displayName = 'ThreadBackground';

export default ThreadBackground;
