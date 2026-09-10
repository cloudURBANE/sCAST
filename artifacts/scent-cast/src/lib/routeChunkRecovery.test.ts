import assert from 'node:assert/strict';
import test from 'node:test';
import { isRouteChunkLoadError, loadRouteChunk, reloadOnceForStaleChunk } from './routeChunkRecovery.ts';

function browser(t: Parameters<Parameters<typeof test>[1]>[0], options: { offline?: boolean; blockedStorage?: boolean } = {}) {
  const values = new Map<string, string>();
  let reloads = 0;
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { pathname: '/community', search: '', reload: () => { reloads++; } },
      sessionStorage: {
        getItem(key: string) {
          if (options.blockedStorage) throw new Error('Storage unavailable');
          return values.get(key) ?? null;
        },
        setItem: (key: string, value: string) => { values.set(key, value); },
        removeItem: (key: string) => { values.delete(key); },
      },
    },
  });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { onLine: !options.offline },
  });
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
  });
  return { reloads: () => reloads };
}

test('offline chunk failures preserve the current page', (t) => {
  const state = browser(t, { offline: true });
  assert.equal(reloadOnceForStaleChunk(), false);
  assert.equal(state.reloads(), 0);
});

test('unavailable storage does not start an unguarded reload loop', (t) => {
  const state = browser(t, { blockedStorage: true });
  assert.equal(reloadOnceForStaleChunk(), false);
  assert.equal(state.reloads(), 0);
});

test('loading a sibling chunk cannot rearm a failed route reload', async (t) => {
  const state = browser(t);
  assert.equal(reloadOnceForStaleChunk(), true);
  await loadRouteChunk(async () => ({ default: () => null }));
  assert.equal(reloadOnceForStaleChunk(), false);
  assert.equal(state.reloads(), 1);
});

test('transient chunk failures retry without reloading', async (t) => {
  const state = browser(t);
  let attempts = 0;
  const module = { default: () => null };
  const result = await loadRouteChunk(async () => {
    if (++attempts === 1) throw new Error('Failed to fetch dynamically imported module');
    return module;
  });
  assert.equal(result, module);
  assert.equal(attempts, 2);
  assert.equal(state.reloads(), 0);
});

test('ordinary application errors are not treated as deployment failures', async () => {
  const error = new Error('Invalid profile');
  assert.equal(isRouteChunkLoadError(error), false);
  await assert.rejects(loadRouteChunk(async () => { throw error; }), error);
});
