// Browser Web Push client for the ScentBeam SPA.
//
// Talks to the Express API (same-origin `/api`, exactly like AuthContext's
// `/api/me/profile` call): GET /api/push/public-key, POST /api/push/subscribe,
// POST /api/push/unsubscribe. The service worker (src/sw.ts) handles the actual
// `push` / `notificationclick` events. Everything degrades quietly: unsupported
// browsers and an unconfigured server both resolve to "can't subscribe" rather
// than throwing.

export interface PushSupport {
  supported: boolean;
  permission: NotificationPermission | "unsupported";
}

export type SubscribeFailure = "unsupported" | "not-configured" | "denied" | "no-sw" | "server";

export function getPushSupport(): PushSupport {
  if (typeof window === "undefined") return { supported: false, permission: "unsupported" };
  const supported =
    "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  return { supported, permission: supported ? Notification.permission : "unsupported" };
}

// VAPID public keys are URL-safe base64; PushManager wants a BufferSource.
// Build over an explicit ArrayBuffer so the type is `Uint8Array<ArrayBuffer>`
// (not `ArrayBufferLike`) and satisfies `applicationServerKey`.
function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

async function getRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  return (await navigator.serviceWorker.getRegistration()) ?? (await navigator.serviceWorker.ready);
}

export async function getServerPushConfig(): Promise<{ key: string | null; configured: boolean }> {
  try {
    const res = await fetch("/api/push/public-key");
    if (!res.ok) return { key: null, configured: false };
    return (await res.json()) as { key: string | null; configured: boolean };
  } catch {
    return { key: null, configured: false };
  }
}

export async function isPushSubscribed(): Promise<boolean> {
  const registration = await getRegistration();
  if (!registration) return false;
  return Boolean(await registration.pushManager.getSubscription());
}

export async function subscribeToPush(authToken: string): Promise<{ ok: boolean; reason?: SubscribeFailure }> {
  if (!getPushSupport().supported) return { ok: false, reason: "unsupported" };

  const { key, configured } = await getServerPushConfig();
  if (!configured || !key) return { ok: false, reason: "not-configured" };

  const permission = await Notification.requestPermission();
  if (permission !== "granted") return { ok: false, reason: "denied" };

  const registration = await getRegistration();
  if (!registration) return { ok: false, reason: "no-sw" };

  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key),
    });
  }

  const json = subscription.toJSON();
  try {
    const res = await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
    });
    if (!res.ok) return { ok: false, reason: "server" };
  } catch {
    return { ok: false, reason: "server" };
  }
  return { ok: true };
}

export interface PushPreferences {
  weather: boolean;
  community: boolean;
}

/** Read the user's per-category opt-ins + current server badge count. */
export async function getPushPreferences(
  authToken: string,
): Promise<{ preferences: PushPreferences; badgeCount: number } | null> {
  try {
    const res = await fetch("/api/push/preferences", {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (!res.ok) return null;
    return (await res.json()) as { preferences: PushPreferences; badgeCount: number };
  } catch {
    return null;
  }
}

/** Persist one or both category toggles; returns the saved state or null on failure. */
export async function setPushPreferences(
  authToken: string,
  patch: Partial<PushPreferences>,
): Promise<PushPreferences | null> {
  try {
    const res = await fetch("/api/push/preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
      body: JSON.stringify(patch),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { preferences: PushPreferences };
    return data.preferences;
  } catch {
    return null;
  }
}

// App Badge API on the window/navigator (separate from the SW's copy).
type BadgeCapableNavigator = Navigator & {
  setAppBadge?: (count?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

/**
 * Clear the app-icon badge: zero the server's authoritative count AND the local
 * OS badge. Called when the installed app gains focus — the user has "seen" the
 * nudges by opening the app. Both halves degrade quietly when unsupported.
 */
export async function clearAppBadgeAndServer(authToken: string): Promise<void> {
  const nav = typeof navigator !== "undefined" ? (navigator as BadgeCapableNavigator) : null;
  try {
    await nav?.clearAppBadge?.();
  } catch {
    /* unsupported — ignore */
  }
  try {
    await fetch("/api/push/badge/clear", {
      method: "POST",
      headers: { Authorization: `Bearer ${authToken}` },
    });
  } catch {
    /* best-effort — next focus retries */
  }
}

export async function unsubscribeFromPush(authToken: string): Promise<void> {
  const registration = await getRegistration();
  if (!registration) return;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;

  const { endpoint } = subscription;
  try {
    await subscription.unsubscribe();
  } catch {
    /* already gone — still tell the server to drop it */
  }
  try {
    await fetch("/api/push/unsubscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ endpoint }),
    });
  } catch {
    /* best effort — the server prunes dead endpoints on the next send anyway */
  }
}
