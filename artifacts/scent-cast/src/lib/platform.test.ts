import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isConstrainedTouchDevice,
  isIpadDevice,
  isIpadSafariBrowser,
  isIpadSafariPerformanceMode,
  isLowRenderBudget,
} from './platform.ts';

const originalWindow = globalThis.window;
const originalNavigator = globalThis.navigator;

function setClientEnvironment({
  userAgent,
  maxTouchPoints,
  width,
  height,
  coarsePointer,
  reducedMotion = false,
  standaloneDisplayMode = false,
}: {
  userAgent: string;
  maxTouchPoints: number;
  width: number;
  height: number;
  coarsePointer: boolean;
  reducedMotion?: boolean;
  standaloneDisplayMode?: boolean;
}) {
  const matchMedia = (query: string) => ({
    matches:
      (query === '(pointer: coarse)' && coarsePointer) ||
      (query === '(prefers-reduced-motion: reduce)' && reducedMotion) ||
      (query === '(display-mode: standalone)' && standaloneDisplayMode) ||
      false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  });

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      innerWidth: width,
      innerHeight: height,
      matchMedia,
    },
  });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      userAgent,
      maxTouchPoints,
    },
  });
}

afterEach(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: originalWindow,
  });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: originalNavigator,
  });
});

test('iPadOS Safari is detected but is not downgraded into the phone render budget', () => {
  setClientEnvironment({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    maxTouchPoints: 5,
    width: 1366,
    height: 1024,
    coarsePointer: true,
  });

  assert.equal(isIpadDevice(), true);
  assert.equal(isIpadSafariBrowser(), true);
  assert.equal(isIpadSafariPerformanceMode(), true);
  assert.equal(isConstrainedTouchDevice(), false);
  assert.equal(isLowRenderBudget(), false);
});

test('installed iPad PWA (no Safari UA token) still enters performance mode', () => {
  // Standalone home-screen web apps on iPadOS drop the `Safari/` token.
  setClientEnvironment({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
    maxTouchPoints: 5,
    width: 1366,
    height: 1024,
    coarsePointer: true,
    standaloneDisplayMode: true,
  });

  assert.equal(isIpadDevice(), true);
  assert.equal(isIpadSafariBrowser(), false);
  assert.equal(isIpadSafariPerformanceMode(), true);
  assert.equal(isLowRenderBudget(), false);
});

test('iPad Chrome does not enter Safari-specific performance mode', () => {
  setClientEnvironment({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.0.0 Mobile/15E148 Safari/604.1',
    maxTouchPoints: 5,
    width: 1194,
    height: 834,
    coarsePointer: true,
  });

  assert.equal(isIpadDevice(), true);
  assert.equal(isIpadSafariBrowser(), false);
  assert.equal(isIpadSafariPerformanceMode(), false);
});

test('phone-class coarse pointer devices keep the constrained render budget', () => {
  setClientEnvironment({
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    maxTouchPoints: 5,
    width: 393,
    height: 852,
    coarsePointer: true,
  });

  assert.equal(isIpadDevice(), false);
  assert.equal(isIpadSafariPerformanceMode(), false);
  assert.equal(isConstrainedTouchDevice(), true);
  assert.equal(isLowRenderBudget(), true);
});

test('reduced motion constrains even desktop-class devices', () => {
  setClientEnvironment({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
    maxTouchPoints: 0,
    width: 1440,
    height: 900,
    coarsePointer: false,
    reducedMotion: true,
  });

  assert.equal(isConstrainedTouchDevice(), false);
  assert.equal(isIpadSafariPerformanceMode(), false);
  assert.equal(isLowRenderBudget(), true);
});
