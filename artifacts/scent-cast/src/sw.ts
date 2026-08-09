/// <reference lib="webworker" />
//
// ScentBeam service worker (Workbox `injectManifest` source).
//
// Hand-authored — not the `generateSW` output — so we can run Web Push and
// notification-click handling next to Workbox precache + runtime caching. The
// build replaces `self.__WB_MANIFEST` with the revisioned app-shell file list.
//
// Update model: `registerType: "prompt"`. A new build installs a waiting SW and
// the SPA (src/lib/pwa/registerPwa.ts) surfaces a "refresh" toast; accepting it
// posts `SKIP_WAITING` (handled below) so the new shell takes over.
import { clientsClaim } from "workbox-core";
import { createHandlerBoundToURL, precacheAndRoute } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { CacheFirst, NetworkFirst, StaleWhileRevalidate } from "workbox-strategies";
import { ExpirationPlugin } from "workbox-expiration";
import { CacheableResponsePlugin } from "workbox-cacheable-response";

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};

// ---------------------------------------------------------------------------
// Precache + SPA navigation fallback
// ---------------------------------------------------------------------------

precacheAndRoute(self.__WB_MANIFEST);

// Every SPA route renders from the same index.html shell, so navigations resolve
// to the precached shell — deep links and offline reloads always boot. `/api`,
// the OAuth callback, and any path that looks like a static file (has a `.ext`)
// must reach the network / their own cache route instead.
const appShellHandler = createHandlerBoundToURL("index.html");
registerRoute(
  new NavigationRoute(appShellHandler, {
    denylist: [/^\/api\//, /^\/auth\//, /\/[^/?]+\.[^/?]+$/],
  }),
);

// ---------------------------------------------------------------------------
// Runtime caching
// ---------------------------------------------------------------------------

// Google Fonts stylesheet: serve instantly from cache, refresh in background.
registerRoute(
  ({ url }) => url.origin === "https://fonts.googleapis.com",
  new StaleWhileRevalidate({ cacheName: "google-fonts-stylesheets" }),
);

// Google Fonts files: effectively immutable — cache for a year.
registerRoute(
  ({ url }) => url.origin === "https://fonts.gstatic.com",
  new CacheFirst({
    cacheName: "google-fonts-webfonts",
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({ maxEntries: 30, maxAgeSeconds: 60 * 60 * 24 * 365, purgeOnQuotaError: true }),
    ],
  }),
);

// Same-origin static imagery (app icons, nav logos, OG art).
registerRoute(
  ({ request, url }) => url.origin === self.location.origin && request.destination === "image",
  new CacheFirst({
    cacheName: "static-images",
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({ maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 30, purgeOnQuotaError: true }),
    ],
  }),
);

// Cross-origin processed bottle imagery (image proxy + object-storage CDNs).
// Registered after the same-origin rule so only off-origin images land here.
registerRoute(
  ({ request }) => request.destination === "image",
  new CacheFirst({
    cacheName: "fragrance-images",
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({ maxEntries: 400, maxAgeSeconds: 60 * 60 * 24 * 14, purgeOnQuotaError: true }),
    ],
  }),
);

// Fragrance engine search (GET, usually the cross-origin Python engine): the
// last results survive going offline. Detail lookups are POST and intentionally
// never cached.
registerRoute(
  ({ url, request }) => request.method === "GET" && /\/api\/fragrances\/search/.test(url.pathname),
  new NetworkFirst({
    cacheName: "fragrance-search",
    networkTimeoutSeconds: 6,
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({ maxEntries: 60, maxAgeSeconds: 60 * 60 * 24, purgeOnQuotaError: true }),
    ],
  }),
);

// Authenticated app data (wardrobe, profile, app-state). NetworkFirst keeps the
// vault renderable from the last successful sync while offline; online it always
// fetches fresh. Auth endpoints and every non-GET request bypass the cache. The
// `api-data` cache is wiped on sign-out via the CLEAR_API_CACHE message below.
registerRoute(
  ({ url, request }) =>
    request.method === "GET" &&
    (url.origin === self.location.origin ||
      url.hostname.endsWith("railway.app") ||
      url.hostname.endsWith("scentbeam.com") ||
      url.hostname.endsWith("sentientbeam.com")) &&
    url.pathname.startsWith("/api/") &&
    !url.pathname.startsWith("/api/auth"),
  new NetworkFirst({
    cacheName: "api-data",
    networkTimeoutSeconds: 6,
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({ maxEntries: 100, maxAgeSeconds: 60 * 60 * 24, purgeOnQuotaError: true }),
    ],
  }),
);

// ---------------------------------------------------------------------------
// Web Push
// ---------------------------------------------------------------------------

interface PushPayload {
  title?: string;
  body?: string;
  url?: string;
  icon?: string;
  badge?: string;
  tag?: string;
  /** App-icon badge number for navigator.setAppBadge. 0 clears it. */
  badgeCount?: number;
}

// The App Badge API lives on the navigator in supporting browsers (iOS 16.4+
// standalone, Chromium). Absent elsewhere — guard every call.
type BadgeCapableNavigator = Navigator & {
  setAppBadge?: (count?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

function applyAppBadge(count: number | undefined): Promise<void> {
  if (typeof count !== "number" || !Number.isFinite(count)) return Promise.resolve();
  const nav = self.navigator as BadgeCapableNavigator;
  try {
    if (count <= 0) return nav.clearAppBadge?.() ?? Promise.resolve();
    return nav.setAppBadge?.(count) ?? Promise.resolve();
  } catch {
    return Promise.resolve();
  }
}

self.addEventListener("push", (event: PushEvent) => {
  if (!event.data) return;
  let payload: PushPayload = {};
  try {
    payload = event.data.json() as PushPayload;
  } catch {
    payload = { body: event.data.text() };
  }

  const title = payload.title || "ScentBeam";
  const options: NotificationOptions = {
    body: payload.body,
    icon: payload.icon || "/icons/app-icon-black/android-chrome-192x192.png",
    badge: payload.badge || "/icons/transparent-emblem/favicon-32x32.png",
    tag: payload.tag,
    data: { url: payload.url || "/" },
  };
  event.waitUntil(
    Promise.all([self.registration.showNotification(title, options), applyAppBadge(payload.badgeCount)]),
  );
});

// Subscription rotation. Push services periodically expire/rotate endpoints; if
// we don't re-register, delivery silently stops. We have no bearer token in the
// SW, so we fetch the public VAPID key, re-subscribe, and hand the server the
// OLD endpoint as proof-of-ownership to swap the stored row (POST /api/push/rotate).
self.addEventListener("pushsubscriptionchange", (event: Event) => {
  const changeEvent = event as Event & {
    oldSubscription?: PushSubscription | null;
    newSubscription?: PushSubscription | null;
  };
  event.waitUntil(
    (async () => {
      const oldEndpoint = changeEvent.oldSubscription?.endpoint;
      if (!oldEndpoint) return;
      try {
        let next = changeEvent.newSubscription ?? null;
        if (!next) {
          // The browser didn't hand us a replacement — re-subscribe ourselves.
          const res = await fetch("/api/push/public-key");
          if (!res.ok) return;
          const { key, configured } = (await res.json()) as { key: string | null; configured: boolean };
          if (!configured || !key) return;
          next = await self.registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(key),
          });
        }
        const json = next.toJSON();
        await fetch("/api/push/rotate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ oldEndpoint, endpoint: json.endpoint, keys: json.keys }),
        });
      } catch {
        /* best-effort — a fresh subscribe happens on next app open */
      }
    })(),
  );
});

// VAPID public keys are URL-safe base64; PushManager.subscribe wants a
// BufferSource. (Mirrors lib/pushNotifications.ts.)
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

self.addEventListener("notificationclick", (event: NotificationEvent) => {
  event.notification.close();
  const data = event.notification.data as { url?: string } | undefined;
  const targetUrl = new URL(data?.url || "/", self.location.origin).href;
  
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      // 1. Search for a window already matching targetUrl exactly
      for (const client of clientList) {
        const clientUrl = new URL(client.url, self.location.origin).href;
        if (clientUrl === targetUrl && "focus" in client) {
          return (client as WindowClient).focus();
        }
      }
      
      // 2. If no exact match, navigate the first client we can focus. The
      // navigate promise is part of the waitUntil chain — dropping it lets the
      // browser suspend the SW mid-navigation. If navigation is refused (e.g.
      // the client went away), fall back to opening a fresh window.
      for (const client of clientList) {
        if ("focus" in client && "navigate" in client) {
          const win = client as WindowClient;
          return win
            .navigate(targetUrl)
            .then(() => win.focus())
            .catch(() => self.clients.openWindow(targetUrl));
        }
      }
      
      // 3. Fallback: open a new window
      return self.clients.openWindow(targetUrl);
    }),
  );
});

// ---------------------------------------------------------------------------
// Lifecycle messages
// ---------------------------------------------------------------------------

self.addEventListener("message", (event: ExtendableMessageEvent) => {
  const data = event.data as { type?: string } | undefined;
  if (data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
  if (data?.type === "CLEAR_API_CACHE") {
    event.waitUntil(
      Promise.all(["api-data", "fragrance-search"].map((cacheName) => caches.delete(cacheName))),
    );
  }
});

// Take control of open clients as soon as this SW activates (paired with the
// SKIP_WAITING prompt) so the refreshed shell is served without a second reload.
clientsClaim();
