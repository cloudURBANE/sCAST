import React, { useEffect, useRef } from 'react';
import { THREAD_LINES, type ThreadLine } from './threadLines';

const SHARED_STYLE: React.CSSProperties = {
  position: 'fixed',
  zIndex: 0,
  willChange: 'transform',
  backfaceVisibility: 'hidden',
  perspective: '1000px',
  contain: 'paint style',
};

const MIN_RANDOM_PERCENT = 8;
const MAX_RANDOM_PERCENT = 92;
const MIN_SPEED_FACTOR = 0.75;
const MAX_SPEED_FACTOR = 1.35;
const MAX_START_DELAY = 2200;
const OPACITY_WRITE_THRESHOLD = 0.025;

type ThreadAnimationState = {
  el: HTMLElement;
  thread: ThreadLine;
  position: number;
  speed: number;
  startAt: number;
  lastOpacity: number | null;
};

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

function createThreadState(el: HTMLElement, thread: ThreadLine, now: number): ThreadAnimationState {
  randomizeThreadLane(el, thread);

  const state: ThreadAnimationState = {
    el,
    thread,
    position: getInitialPosition(thread),
    speed: thread.speed * randomBetween(MIN_SPEED_FACTOR, MAX_SPEED_FACTOR),
    startAt: now + randomBetween(0, MAX_START_DELAY),
    lastOpacity: null,
  };

  writeThreadState(state, true);
  return state;
}

function writeThreadState(state: ThreadAnimationState, forceOpacity = false): void {
  const { el, thread, position } = state;
  el.style.transform = computeTransform(thread, position);

  if (thread.fade == null) return;

  const opacity = computeOpacity(thread, position);
  if (
    forceOpacity ||
    state.lastOpacity == null ||
    Math.abs(opacity - state.lastOpacity) >= OPACITY_WRITE_THRESHOLD ||
    opacity === 0 ||
    opacity === 1
  ) {
    el.style.opacity = opacity.toFixed(3);
    state.lastOpacity = opacity;
  }
}

/**
 * Nexus-style moving thread lines from the ThanksBeam tip page (bundle function a6).
 */
export const ThreadBackground: React.FC = React.memo(() => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    const elements = container.querySelectorAll<HTMLElement>('[data-thread]');
    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const states: ThreadAnimationState[] = [];
    let animationFrame = 0;
    let lastTime: number | null = null;
    let cancelled = false;

    elements.forEach((el, index) => {
      const thread = THREAD_LINES[index];
      if (!thread) return;
      states.push(createThreadState(el, thread, performance.now()));
    });

    const stopLoop = () => {
      if (animationFrame) {
        window.cancelAnimationFrame(animationFrame);
        animationFrame = 0;
      }
      lastTime = null;
    };

    const tick = (now: number) => {
      if (cancelled || motionQuery.matches || document.visibilityState === 'hidden') {
        stopLoop();
        return;
      }

      const elapsedFrames = lastTime == null ? 1 : Math.min(2, ((now - lastTime) * 60) / 1000);
      lastTime = now;

      states.forEach((state) => {
        if (now < state.startAt) return;

        state.position += state.speed * state.thread.direction * elapsedFrames;

        if (shouldWrap(state.thread, state.position)) {
          randomizeThreadLane(state.el, state.thread);
          state.speed = state.thread.speed * randomBetween(MIN_SPEED_FACTOR, MAX_SPEED_FACTOR);
          state.position = resetPosition(state.thread);
          state.lastOpacity = null;
        }

        writeThreadState(state);
      });

      animationFrame = window.requestAnimationFrame(tick);
    };

    const startLoop = () => {
      if (cancelled || animationFrame || motionQuery.matches || document.visibilityState === 'hidden') return;
      lastTime = null;
      animationFrame = window.requestAnimationFrame(tick);
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        stopLoop();
        return;
      }
      startLoop();
    };

    const handleMotionPreferenceChange = () => {
      if (motionQuery.matches) {
        stopLoop();
        return;
      }
      startLoop();
    };

    startLoop();
    document.addEventListener('visibilitychange', handleVisibilityChange);
    motionQuery.addEventListener('change', handleMotionPreferenceChange);

    return () => {
      cancelled = true;
      stopLoop();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      motionQuery.removeEventListener('change', handleMotionPreferenceChange);
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
