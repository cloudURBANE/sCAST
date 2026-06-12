import type { Metric } from 'web-vitals';

export type WebVitalContext = {
  route: string;
  appVersion?: string;
  deviceClass: 'mobile' | 'tablet' | 'desktop';
  connectionType?: string;
  authState: 'authenticated' | 'guest';
  vaultSizeBucket: '0' | '1-2' | '3-9' | '10-24' | '25-49' | '50+';
};

export type WebVitalMetric = WebVitalContext & {
  name: Metric['name'];
  value: number;
  rating: Metric['rating'];
  delta: number;
  id: string;
  navigationType: Metric['navigationType'];
  timestamp: number;
};

const METRICS_URL = (import.meta.env?.VITE_WEB_VITALS_URL as string | undefined)?.trim();
const APP_VERSION = (
  (import.meta.env?.VITE_APP_VERSION as string | undefined) ||
  (import.meta.env?.VITE_VERCEL_GIT_COMMIT_SHA as string | undefined) ||
  (import.meta.env?.VITE_GIT_SHA as string | undefined)
)?.trim();
const IS_DEV = Boolean(import.meta.env?.DEV);

function currentDeviceClass(): WebVitalContext['deviceClass'] {
  if (typeof window === 'undefined') return 'desktop';
  const coarse = window.matchMedia?.('(pointer: coarse)').matches;
  const shortSide = Math.min(window.innerWidth, window.innerHeight);
  if (coarse && shortSide < 768) return 'mobile';
  if (coarse) return 'tablet';
  return 'desktop';
}

function currentConnectionType(): string | undefined {
  const nav = navigator as Navigator & {
    connection?: { effectiveType?: string; type?: string };
  };
  return nav.connection?.effectiveType ?? nav.connection?.type;
}

export function vaultSizeBucket(count: number): WebVitalContext['vaultSizeBucket'] {
  if (count <= 0) return '0';
  if (count <= 2) return '1-2';
  if (count <= 9) return '3-9';
  if (count <= 24) return '10-24';
  if (count <= 49) return '25-49';
  return '50+';
}

export function reportWebVital(metric: Metric, context: Omit<WebVitalContext, 'appVersion' | 'deviceClass' | 'connectionType'>): void {
  if (typeof window === 'undefined') return;

  const payload: WebVitalMetric = {
    ...context,
    appVersion: APP_VERSION,
    deviceClass: currentDeviceClass(),
    connectionType: currentConnectionType(),
    name: metric.name,
    value: metric.value,
    rating: metric.rating,
    delta: metric.delta,
    id: metric.id,
    navigationType: metric.navigationType,
    timestamp: Date.now(),
  };

  try {
    window.dispatchEvent(new CustomEvent<WebVitalMetric>('scentbeam:web-vital', { detail: payload }));

    if (METRICS_URL && typeof navigator.sendBeacon === 'function') {
      navigator.sendBeacon(METRICS_URL, new Blob([JSON.stringify(payload)], { type: 'application/json' }));
    }

    if (IS_DEV) {
      // eslint-disable-next-line no-console
      console.debug(`[web-vital] ${payload.name}=${payload.value.toFixed(2)} ${payload.rating}`, payload);
    }
  } catch {
    // Telemetry must never affect rendering.
  }
}

export async function initWebVitals(getContext: () => Omit<WebVitalContext, 'appVersion' | 'deviceClass' | 'connectionType'>): Promise<void> {
  const { onCLS, onFCP, onINP, onLCP } = await import('web-vitals');
  const handler = (metric: Metric) => reportWebVital(metric, getContext());

  onCLS(handler);
  onFCP(handler);
  onINP(handler);
  onLCP(handler);
}
