import React, { useEffect, useRef } from 'react';
import {
  getThreadTravelSize,
  THREAD_LINES,
  threadGradientToCss,
  threadShadowToCss,
  type ThreadLine,
} from './threadLines';
import './ThreadBackground.css';

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
  const travelSize = getThreadTravelSize(thread);
  return randomBetween(-travelSize, limit + travelSize);
}

function getLaneOffset(thread: ThreadLine, lanePercent: number): number {
  const limit = thread.axis === 'x' ? window.innerHeight : window.innerWidth;
  return (limit * lanePercent) / 100;
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
    const x = thread.direction === 1 ? position : position - boxW;
    return { x, y: lane };
  }

  const y = thread.direction === 1 ? position : position - boxH;
  return { x: lane, y };
}

function computeOpacity(thread: ThreadLine, position: number): number {
  const { direction, fade } = thread;
  if (fade == null) return thread.presence;

  const limit = getTravelLimit(thread);
  let fadeOpacity = 1;

  if (direction === 1) {
    if (position < fade) fadeOpacity = Math.max(0, position / fade);
    else if (position > limit - fade) fadeOpacity = Math.max(0, (limit + fade - position) / fade);
  } else {
    if (position > limit - fade) fadeOpacity = Math.max(0, (limit - position) / fade);
    else if (position < fade) fadeOpacity = Math.max(0, position / fade);
  }

  return fadeOpacity * thread.presence;
}

function shouldWrap(thread: ThreadLine, position: number): boolean {
  const limit = getTravelLimit(thread);
  const travelSize = getThreadTravelSize(thread);
  if (thread.direction === 1) return position > limit + travelSize;
  return position < -travelSize;
}

function resetPosition(thread: ThreadLine): number {
  const travelSize = getThreadTravelSize(thread);
  if (thread.direction === 1) return randomBetween(-travelSize * 3, -travelSize);
  return getTravelLimit(thread) + randomBetween(travelSize, travelSize * 3);
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

type ThreadLineStyle = React.CSSProperties & {
  '--thread-core': string;
  '--thread-shadow': string;
  '--thread-filter': string;
};

function getThreadClassName(thread: ThreadLine): string {
  return [
    'scent-thread-line',
    `scent-thread-line--axis-${thread.axis}`,
    `scent-thread-line--tone-${thread.tone}`,
    `scent-thread-line--depth-${thread.depth}`,
  ].join(' ');
}

function getThreadStyle(thread: ThreadLine): ThreadLineStyle {
  return {
    width: `${thread.width}px`,
    height: `${thread.height}px`,
    '--thread-core': threadGradientToCss(thread.axis, thread.coreStops),
    '--thread-shadow': thread.shadowLayers.length ? threadShadowToCss(thread.shadowLayers) : 'none',
    '--thread-filter': thread.filter ?? 'none',
  };
}

function createThreadState(thread: ThreadLine, now: number): ThreadState {
  return {
    thread,
    element: null,
    position: getInitialPosition(thread),
    speed: thread.speed * randomBetween(MIN_SPEED_FACTOR, MAX_SPEED_FACTOR),
    startAt: now + randomBetween(0, MAX_START_DELAY),
    lanePercent: randomizeThreadLane(),
    boxW: thread.width,
    boxH: thread.height,
  };
}

function resetMotionState(state: ThreadState, now: number) {
  state.position = getInitialPosition(state.thread);
  state.speed = state.thread.speed * randomBetween(MIN_SPEED_FACTOR, MAX_SPEED_FACTOR);
  state.startAt = now + randomBetween(0, MAX_START_DELAY);
  state.lanePercent = randomizeThreadLane();
}

function applyReducedMotionComposition(states: ThreadState[]) {
  for (const state of states) {
    state.position = (getTravelLimit(state.thread) * state.thread.stillPositionPercent) / 100;
    state.lanePercent = state.thread.stillLanePercent;
    state.speed = state.thread.speed;
    state.startAt = 0;
  }
}

function applyThreadStyle(state: ThreadState): ThreadBackgroundFrameMetrics['sample'] {
  const { element, thread } = state;
  if (!element) return null;

  const opacity = computeOpacity(thread, state.position);
  const { x, y } = computeTopLeft(thread, state.position, state.lanePercent, state.boxW, state.boxH);

  element.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  element.style.opacity = opacity.toFixed(3);

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
    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const states = THREAD_LINES.map((thread) => createThreadState(thread, performance.now()));
    states.forEach((state) => {
      state.element = elementRefs.current.get(state.thread.id) ?? null;
    });
    if (motionQuery.matches) applyReducedMotionComposition(states);

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
      if (motionQuery.matches) {
        applyReducedMotionComposition(states);
        draw();
        return;
      }
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
        applyReducedMotionComposition(states);
        draw();
        return;
      }
      const now = performance.now();
      states.forEach((state) => resetMotionState(state, now));
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
    <div className="scent-thread-field" aria-hidden="true">
      {THREAD_LINES.map((thread) => (
        <div
          key={thread.id}
          className={getThreadClassName(thread)}
          ref={(node) => {
            if (node) elementRefs.current.set(thread.id, node);
            else elementRefs.current.delete(thread.id);
          }}
          style={getThreadStyle(thread)}
        />
      ))}
    </div>
  );
});

ThreadBackground.displayName = 'ThreadBackground';

export default ThreadBackground;
