import React, { useEffect, useRef } from 'react';
import { THREAD_LINES, type ThreadLine } from './threadLines';

/**
 * Ambient "thread" background, rendered on a single <canvas>.
 *
 * NOTE: the canvas rewrite did not resolve the affected iPad freeze. The
 * diagnostic route treats this renderer as one measured mode, not as proof of
 * the root cause.
 *
 * Why canvas instead of 24 GPU-composited <div>s driven by transform writes:
 *  - iPad Safari froze the old approach. A `position: fixed` element with
 *    composited children is rasterized once and only re-rasterized on scroll;
 *    with no scroll path (common on iPad's tall viewport) the rAF loop kept
 *    writing child transforms but WebKit never repainted the snapshot, so the
 *    whole background sat frozen. iPhone happens to have a scroll path and
 *    desktop WebKit/Blink don't have the bug — which is exactly why only iPad
 *    froze while iPhone and desktop animated fine.
 *  - Drawing to a canvas dirties its bitmap every frame, forcing a real repaint
 *    regardless of compositing — immune to that freeze.
 *  - One element + cheap sprite blits replaces 24 layers each re-blurring a
 *    multi-stop box-shadow every frame (the point of this performance pass).
 *
 * Each thread is pre-rendered ONCE into an offscreen sprite (gradient + glow),
 * then every frame we blit the sprite at its new position with a per-thread
 * alpha for the edge fade. The motion math (speed, lanes, wrap, stagger,
 * reduced-motion + visibility pausing) is preserved verbatim from the DOM
 * version so the look is unchanged.
 */

const MIN_RANDOM_PERCENT = 8;
const MAX_RANDOM_PERCENT = 92;
const MIN_SPEED_FACTOR = 0.75;
const MAX_SPEED_FACTOR = 1.35;
const MAX_START_DELAY = 2200;
// Glows are soft, so cap the sprite backing-store resolution to bound memory on
// retina / iPad without any visible loss on the thin lines.
const MAX_DPR = 2;

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function randomizeThreadLane(): number {
  return randomBetween(MIN_RANDOM_PERCENT, MAX_RANDOM_PERCENT);
}

// ── CSS gradient / box-shadow parsing (only the shapes used in threadLines) ──

/** Split on top-level commas, ignoring commas inside rgba()/rgb() parens. */
function splitTopLevel(input: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === ',' && depth === 0) {
      out.push(input.slice(start, i));
      start = i + 1;
    }
  }
  out.push(input.slice(start));
  return out.map((part) => part.trim()).filter(Boolean);
}

type GradientStop = { offset: number; color: string };

/** Parse `linear-gradient(<angle>, <color> <pct>%, …)` into stops. */
function parseGradientStops(css: string): GradientStop[] {
  const inner = css.slice(css.indexOf('(') + 1, css.lastIndexOf(')'));
  const parts = splitTopLevel(inner);
  parts.shift(); // drop the leading angle (always 90deg / 180deg here)
  const stops: GradientStop[] = [];
  for (const part of parts) {
    const match = part.match(/^(.*?)\s+(-?[\d.]+)%$/);
    if (!match) continue;
    stops.push({
      color: match[1].trim(),
      offset: Math.min(1, Math.max(0, parseFloat(match[2]) / 100)),
    });
  }
  return stops;
}

type ShadowLayer = { blur: number; color: string };

/** Parse `0 0 <blur>px <color>, …` glow layers. */
function parseBoxShadow(css?: string): ShadowLayer[] {
  if (!css) return [];
  const layers: ShadowLayer[] = [];
  for (const part of splitTopLevel(css)) {
    const colorMatch = part.match(/(rgba?\([^)]*\)|#[0-9a-fA-F]{3,8}|transparent)\s*$/);
    if (!colorMatch || colorMatch.index == null) continue;
    const lengths = part.slice(0, colorMatch.index).trim().split(/\s+/);
    const blur = parseFloat(lengths[2] ?? '0');
    layers.push({ blur: Number.isFinite(blur) ? blur : 0, color: colorMatch[1] });
  }
  return layers;
}

// ── sprites ──

type ThreadSprite = {
  canvas: HTMLCanvasElement;
  pad: number; // CSS px of glow padding around the line, on every side
  boxW: number; // CSS px line box (matches the old <div> width/height)
  boxH: number;
};

/** Pre-rasterize one thread (gradient + every glow layer) into an offscreen canvas. */
function buildSprite(thread: ThreadLine, dpr: number): ThreadSprite {
  const boxW = parseFloat(thread.width);
  const boxH = parseFloat(thread.height);
  const shadows = parseBoxShadow(thread.boxShadow);
  const maxBlur = shadows.reduce((acc, shadow) => Math.max(acc, shadow.blur), 0);
  const pad = Math.ceil(maxBlur + 2);

  const cssW = boxW + pad * 2;
  const cssH = boxH + pad * 2;
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(cssW * dpr);
  canvas.height = Math.ceil(cssH * dpr);

  const ctx = canvas.getContext('2d');
  if (ctx) {
    // Work directly in device pixels (no ctx.scale) so shadowBlur is predictable
    // across browsers — it scales with dpr the same way the line geometry does.
    const x0 = pad * dpr;
    const y0 = pad * dpr;
    const w = boxW * dpr;
    const h = boxH * dpr;

    const stops = parseGradientStops(thread.background);
    const grad =
      thread.axis === 'x'
        ? ctx.createLinearGradient(x0, 0, x0 + w, 0)
        : ctx.createLinearGradient(0, y0, 0, y0 + h);
    for (const stop of stops) grad.addColorStop(stop.offset, stop.color);
    ctx.fillStyle = grad;

    // Glow layers first (blurred copies of the line), then the crisp line on top.
    for (const shadow of shadows) {
      ctx.save();
      ctx.shadowBlur = shadow.blur * dpr;
      ctx.shadowColor = shadow.color;
      ctx.fillRect(x0, y0, w, h);
      ctx.restore();
    }
    ctx.fillRect(x0, y0, w, h);
  }

  return { canvas, pad, boxW, boxH };
}

// ── motion math (ported verbatim from the DOM version) ──

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

/**
 * Top-left of the thread box in viewport CSS px — the old CSS anchor (top/left
 * vs bottom/right) folded into the same translate the rAF loop used to write.
 */
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
  sprite: ThreadSprite;
  position: number;
  speed: number;
  startAt: number;
  lanePercent: number;
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

function createThreadState(thread: ThreadLine, sprite: ThreadSprite, now: number): ThreadState {
  return {
    thread,
    sprite,
    position: getInitialPosition(thread),
    speed: thread.speed * randomBetween(MIN_SPEED_FACTOR, MAX_SPEED_FACTOR),
    startAt: now + randomBetween(0, MAX_START_DELAY),
    lanePercent: randomizeThreadLane(),
  };
}

/**
 * Nexus-style moving thread lines from the ThanksBeam tip page (bundle function
 * a6), re-implemented on a canvas in the current production build.
 */
export const ThreadBackground: React.FC<ThreadBackgroundProps> = React.memo(({ onFrame }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const onFrameRef = useRef(onFrame);

  useEffect(() => {
    onFrameRef.current = onFrame;
  }, [onFrame]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;

    let dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    let sprites = THREAD_LINES.map((thread) => buildSprite(thread, dpr));
    const states: ThreadState[] = THREAD_LINES.map((thread, index) =>
      createThreadState(thread, sprites[index], performance.now()),
    );

    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    let animationFrame = 0;
    let lastTime: number | null = null;
    let cancelled = false;
    let drawCount = 0;

    const sizeCanvas = () => {
      canvas.width = Math.round(window.innerWidth * dpr);
      canvas.height = Math.round(window.innerHeight * dpr);
      canvas.style.width = `${window.innerWidth}px`;
      canvas.style.height = `${window.innerHeight}px`;
    };

    const draw = () => {
      let sample: ThreadBackgroundFrameMetrics['sample'] = null;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const state of states) {
        const opacity = state.thread.fade == null ? 1 : computeOpacity(state.thread, state.position);
        if (opacity <= 0) continue;
        const { x, y } = computeTopLeft(
          state.thread,
          state.position,
          state.lanePercent,
          state.sprite.boxW,
          state.sprite.boxH,
        );
        if (!sample) {
          sample = { id: state.thread.id, x, y, position: state.position, opacity };
        }
        ctx.globalAlpha = opacity;
        ctx.drawImage(state.sprite.canvas, (x - state.sprite.pad) * dpr, (y - state.sprite.pad) * dpr);
      }
      ctx.globalAlpha = 1;
      drawCount += 1;
      onFrameRef.current?.({
        drawCount,
        now: performance.now(),
        sample,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
          dpr,
        },
      });
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

      draw();
      animationFrame = window.requestAnimationFrame(tick);
    };

    const startLoop = () => {
      if (cancelled || animationFrame || motionQuery.matches || document.visibilityState === 'hidden') return;
      lastTime = null;
      animationFrame = window.requestAnimationFrame(tick);
    };

    const handleResize = () => {
      const nextDpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      if (nextDpr !== dpr) {
        dpr = nextDpr;
        sprites = THREAD_LINES.map((thread) => buildSprite(thread, dpr));
        states.forEach((state, index) => {
          state.sprite = sprites[index];
        });
      }
      sizeCanvas();
      if (!animationFrame) draw(); // keep the static frame correct while paused
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
        draw(); // freeze on a clean static frame
        return;
      }
      startLoop();
    };

    sizeCanvas();
    draw(); // initial paint — also the reduced-motion static frame
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
    <canvas
      ref={canvasRef}
      className="fixed inset-0 pointer-events-none"
      style={{ zIndex: 0 }}
      aria-hidden="true"
    />
  );
});

ThreadBackground.displayName = 'ThreadBackground';

export default ThreadBackground;
