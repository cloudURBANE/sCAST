import React, { useEffect, useRef } from 'react';
import { THREAD_LINES, type ThreadLine } from './threadLines';

const SHARED_STYLE: React.CSSProperties = {
  position: 'fixed',
  zIndex: 0,
  willChange: 'transform',
  backfaceVisibility: 'hidden',
  perspective: '1000px',
};

const MIN_RANDOM_PERCENT = 8;
const MAX_RANDOM_PERCENT = 92;
const MIN_SPEED_FACTOR = 0.75;
const MAX_SPEED_FACTOR = 1.35;
const MAX_START_DELAY = 2200;

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function randomizeThreadLane(el: HTMLElement, thread: ThreadLine): void {
  const offset = `${randomBetween(MIN_RANDOM_PERCENT, MAX_RANDOM_PERCENT).toFixed(2)}%`;

  if (thread.axis === 'x') {
    el.style.top = offset;
    el.style.bottom = '';
    return;
  }

  if (thread.left != null) {
    el.style.left = offset;
    el.style.right = '';
  } else {
    el.style.right = offset;
    el.style.left = '';
  }
}

function getTravelLimit(thread: ThreadLine): number {
  return thread.axis === 'x' ? window.innerWidth : window.innerHeight;
}

function getInitialPosition(thread: ThreadLine): number {
  const limit = getTravelLimit(thread);
  return randomBetween(-thread.wrap, limit + thread.wrap);
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

  const limit = getTravelLimit(thread);

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
  const { direction, wrap } = thread;
  const limit = getTravelLimit(thread);

  if (direction === 1) return position > limit + wrap;
  return position < -wrap;
}

function resetPosition(thread: ThreadLine): number {
  const { direction, wrap } = thread;
  if (direction === 1) return randomBetween(-wrap * 3, -wrap);
  return getTravelLimit(thread) + randomBetween(wrap, wrap * 3);
}

function startThreadAnimation(
  el: HTMLElement,
  thread: ThreadLine,
  activeRef: React.MutableRefObject<boolean>,
): () => void {
  randomizeThreadLane(el, thread);

  let position = getInitialPosition(thread);
  let speed = thread.speed * randomBetween(MIN_SPEED_FACTOR, MAX_SPEED_FACTOR);

  el.style.transform = computeTransform(thread, position);

  if (thread.fade != null) {
    el.style.opacity = String(computeOpacity(thread, position));
  }

  const tick = () => {
    if (!activeRef.current) return;

    position += speed * thread.direction;

    if (shouldWrap(thread, position)) {
      randomizeThreadLane(el, thread);
      speed = thread.speed * randomBetween(MIN_SPEED_FACTOR, MAX_SPEED_FACTOR);
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
      const delay = randomBetween(0, MAX_START_DELAY);

      if (delay < 16) {
        requestAnimationFrame(tick);
      } else {
        timeouts.push(setTimeout(() => requestAnimationFrame(tick), delay));
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
        const {
          id,
          top,
          bottom,
          left,
          right,
          width,
          height,
          background,
          boxShadow,
          filter,
          axis,
          direction,
          wrap,
        } = thread;

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
