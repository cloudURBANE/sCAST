import React, { useEffect, useRef } from 'react';
import { THREAD_LINES, type ThreadLine } from './threadLines';

const MIN_RANDOM_PERCENT = 8;
const MAX_RANDOM_PERCENT = 92;
const MIN_SPEED_FACTOR = 0.75;
const MAX_SPEED_FACTOR = 1.35;
const MAX_START_DELAY = 2200;

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function randomizeThreadLane(): number {
  return randomBetween(MIN_RANDOM_PERCENT, MAX_RANDOM_PERCENT);
}

function getTravelLimit(thread: ThreadLine): number {
  return thread.axis === 'x' ? window.innerWidth : window.innerHeight;
}

function getInitialPosition(thread: ThreadLine): number {
  const limit = getTravelLimit(thread);
  return randomBetween(-thread.wrap, limit + thread.wrap);
}

function getLaneOffset(thread: ThreadLine, lanePercent: number): number {
  const limit = thread.axis === 'x' ? window.innerHeight : window.innerWidth;
  const offset = (limit * lanePercent) / 100;
  if (thread.axis === 'y' && thread.left == null) return -offset;
  return offset;
}

function computeTopLeft(
  thread: ThreadLine,
  position: number,
  lanePercent: number,
  boxW: number,
  boxH: number,
): { x: number; y: number } {
  const lane = getLaneOffset(thread, lanePercent);

  if (thread.axis === 'x') {
    const baseLeft = thread.left != null ? 0 : window.innerWidth - boxW;
    const tx = thread.direction === 1 ? position : position - window.innerWidth;
    return { x: baseLeft + tx, y: lane };
  }

  const baseTop = thread.top != null ? 0 : window.innerHeight - boxH;
  const baseLeft = thread.left != null ? 0 : window.innerWidth - boxW;
  const ty = thread.direction === 1 ? position : position - window.innerHeight;
  return { x: baseLeft + lane, y: baseTop + ty };
}

function computeOpacity(thread: ThreadLine, position: number): number {
  const { direction, fade } = thread;
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
  const limit = getTravelLimit(thread);
  if (thread.direction === 1) return position > limit + thread.wrap;
  return position < -thread.wrap;
}

function resetPosition(thread: ThreadLine): number {
  if (thread.direction === 1) return randomBetween(-thread.wrap * 3, -thread.wrap);
  return getTravelLimit(thread) + randomBetween(thread.wrap, thread.wrap * 3);
}

type ThreadState = {
  thread: ThreadLine;
  element: HTMLDivElement | null;
  position: number;
  speed: number;
  startAt: number;
  lanePercent: number;
  boxW: number;
  boxH: number;
};

export type ThreadBackgroundFrameMetrics = {
  drawCount: number;
  now: number;
  sample: {
    id: string;
    x: number;
    y: number;
    position: number;
    opacity: number;
  } | null;
  viewport: {
    width: number;
    height: number;
    dpr: number;
  };
};

type ThreadBackgroundProps = {
  onFrame?: (metrics: ThreadBackgroundFrameMetrics) => void;
};

function createThreadState(thread: ThreadLine, now: number): ThreadState {
  return {
    thread,
    element: null,
    position: getInitialPosition(thread),
    speed: thread.speed * randomBetween(MIN_SPEED_FACTOR, MAX_SPEED_FACTOR),
    startAt: now + randomBetween(0, MAX_START_DELAY),
    lanePercent: randomizeThreadLane(),
    boxW: parseFloat(thread.width),
    boxH: parseFloat(thread.height),
  };
}

function applyThreadStyle(state: ThreadState): ThreadBackgroundFrameMetrics['sample'] {
  const { element, thread } = state;
  if (!element) return null;

  const opacity = thread.fade == null ? 1 : computeOpacity(thread, state.position);
  const { x, y } = computeTopLeft(thread, state.position, state.lanePercent, state.boxW, state.boxH);

  element.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  element.style.opacity = `${opacity}`;

  if (opacity <= 0) return null;
  return {
    id: thread.id,
    x,
    y,
    position: state.position,
    opacity,
  };
}

/**
 * Ambient moving thread lines.
 *
 * The iPad diagnostic harness showed the canvas production renderer's counters
 * continued while the canvas did not present motion. The DOM-transform harness
 * mode did present correctly on the same device, so production uses that
 * measured path and keeps an optional frame callback for the lab.
 */
export const ThreadBackground: React.FC<ThreadBackgroundProps> = React.memo(({ onFrame }) => {
  const elementRefs = useRef(new Map<string, HTMLDivElement>());
  const onFrameRef = useRef(onFrame);

  useEffect(() => {
    onFrameRef.current = onFrame;
  }, [onFrame]);

  useEffect(() => {
    const states = THREAD_LINES.map((thread) => createThreadState(thread, performance.now()));
    states.forEach((state) => {
      state.element = elementRefs.current.get(state.thread.id) ?? null;
    });

    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    let animationFrame = 0;
    let lastTime: number | null = null;
    let cancelled = false;
    let frameCount = 0;

    const reportFrame = (now: number, sample: ThreadBackgroundFrameMetrics['sample']) => {
      frameCount += 1;
      onFrameRef.current?.({
        drawCount: frameCount,
        now,
        sample,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
          dpr: window.devicePixelRatio || 1,
        },
      });
    };

    const draw = (now = performance.now()) => {
      let sample: ThreadBackgroundFrameMetrics['sample'] = null;
      for (const state of states) {
        const nextSample = applyThreadStyle(state);
        if (!sample && nextSample) sample = nextSample;
      }
      reportFrame(now, sample);
    };

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

      for (const state of states) {
        if (now < state.startAt) continue;

        state.position += state.speed * state.thread.direction * elapsedFrames;

        if (shouldWrap(state.thread, state.position)) {
          state.lanePercent = randomizeThreadLane();
          state.speed = state.thread.speed * randomBetween(MIN_SPEED_FACTOR, MAX_SPEED_FACTOR);
          state.position = resetPosition(state.thread);
        }
      }

      draw(now);
      animationFrame = window.requestAnimationFrame(tick);
    };

    const startLoop = () => {
      if (cancelled || animationFrame || motionQuery.matches || document.visibilityState === 'hidden') return;
      lastTime = null;
      animationFrame = window.requestAnimationFrame(tick);
    };

    const handleResize = () => {
      if (!animationFrame) draw();
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
        draw();
        return;
      }
      startLoop();
    };

    draw();
    startLoop();

    window.addEventListener('resize', handleResize);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    if (typeof motionQuery.addEventListener === 'function') {
      motionQuery.addEventListener('change', handleMotionPreferenceChange);
    } else {
      motionQuery.addListener(handleMotionPreferenceChange);
    }

    return () => {
      cancelled = true;
      stopLoop();
      window.removeEventListener('resize', handleResize);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (typeof motionQuery.removeEventListener === 'function') {
        motionQuery.removeEventListener('change', handleMotionPreferenceChange);
      } else {
        motionQuery.removeListener(handleMotionPreferenceChange);
      }
    };
  }, []);

  return (
    <div className="fixed inset-0 pointer-events-none overflow-hidden" style={{ zIndex: 0 }} aria-hidden="true">
      {THREAD_LINES.map((thread) => (
        <div
          key={thread.id}
          ref={(node) => {
            if (node) elementRefs.current.set(thread.id, node);
            else elementRefs.current.delete(thread.id);
          }}
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: thread.width,
            height: thread.height,
            borderRadius: 999,
            background: thread.background,
            boxShadow: thread.boxShadow,
            filter: thread.filter,
            opacity: 0,
            pointerEvents: 'none',
            transform: 'translate3d(0, 0, 0)',
            willChange: 'transform, opacity',
          }}
        />
      ))}
    </div>
  );
});

ThreadBackground.displayName = 'ThreadBackground';

export default ThreadBackground;
