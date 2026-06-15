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
    url.origin === self.location.origin &&
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
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event: NotificationEvent) => {
  event.notification.close();
  const data = event.notification.data as { url?: string } | undefined;
  const targetUrl = data?.url || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) {
          (client as WindowClient).navigate?.(targetUrl);
          return (client as WindowClient).focus();
        }
      }
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
