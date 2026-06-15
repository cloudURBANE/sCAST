import { Router } from "express";
import { AuthRequest, requireAuth } from "../middlewares/auth";
import { getTenantId } from "../middlewares/tenant";
import {
  clearBadge,
  deleteSubscription,
  getBadgeCount,
  getPushPreferences,
  getVapidPublicKey,
  isPushConfigured,
  rotateSubscription,
  saveSubscription,
  setPushPreferences,
} from "../services/pushService";

const router = Router();

// Public: the browser needs the VAPID public key to call pushManager.subscribe.
// `configured: false` lets the SPA hide the notifications toggle when the server
// has no VAPID keys, rather than offering a control that can't work.
router.get("/push/public-key", (_req, res) => {
  res.json({ key: getVapidPublicKey(), configured: isPushConfigured() });
});

router.post("/push/subscribe", requireAuth, async (req: AuthRequest, res) => {
  if (!isPushConfigured()) {
    res.status(503).json({ error: "Push notifications are not configured on this server." });
    return;
  }

  const body = (req.body ?? {}) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  const endpoint = typeof body.endpoint === "string" ? body.endpoint.trim() : "";
  const p256dh = typeof body.keys?.p256dh === "string" ? body.keys.p256dh : "";
  const auth = typeof body.keys?.auth === "string" ? body.keys.auth : "";
  if (!endpoint || !p256dh || !auth) {
    res.status(400).json({ error: "A valid push subscription (endpoint + keys) is required." });
    return;
  }

  const { provisioned } = await saveSubscription({
    tenantId: getTenantId(req),
    userId: req.user!.id,
    endpoint,
    p256dh,
    auth,
    userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null,
  });
  if (!provisioned) {
    res.status(503).json({ error: "Push storage is temporarily unavailable." });
    return;
  }
  res.json({ ok: true });
});

router.post("/push/unsubscribe", requireAuth, async (req: AuthRequest, res) => {
  const body = (req.body ?? {}) as { endpoint?: unknown };
  const endpoint = typeof body.endpoint === "string" ? body.endpoint.trim() : "";
  if (endpoint) await deleteSubscription(endpoint);
  res.json({ ok: true });
});

// Per-category notification opt-ins + current app-icon badge count. The SPA's
// settings UI reads/writes these; both toggles default true server-side.
router.get("/push/preferences", requireAuth, async (req: AuthRequest, res) => {
  const [preferences, badgeCount] = await Promise.all([
    getPushPreferences(req.user!.id),
    getBadgeCount(req.user!.id),
  ]);
  res.json({ preferences, badgeCount });
});

router.put("/push/preferences", requireAuth, async (req: AuthRequest, res) => {
  const body = (req.body ?? {}) as { weather?: unknown; community?: unknown };
  const patch: { weather?: boolean; community?: boolean } = {};
  if (typeof body.weather === "boolean") patch.weather = body.weather;
  if (typeof body.community === "boolean") patch.community = body.community;
  if (patch.weather === undefined && patch.community === undefined) {
    res.status(400).json({ error: "Provide at least one of `weather` or `community` (boolean)." });
    return;
  }
  const preferences = await setPushPreferences(req.user!.id, patch);
  res.json({ preferences });
});

// Clearing the badge: the SPA calls this when the app gains focus, then mirrors
// it on the client with navigator.clearAppBadge(). Server stays the source of
// truth so other devices pick up the cleared count on their next push.
router.post("/push/badge/clear", requireAuth, async (req: AuthRequest, res) => {
  await clearBadge(req.user!.id);
  res.json({ ok: true, badgeCount: 0 });
});

// Tokenless subscription rotation for the service worker's `pushsubscriptionchange`
// event (the SW has no bearer token). Authorized by possession of the OLD
// endpoint, which is unguessable and uniquely maps to one stored row.
router.post("/push/rotate", async (req, res) => {
  const body = (req.body ?? {}) as {
    oldEndpoint?: unknown;
    endpoint?: unknown;
    keys?: { p256dh?: unknown; auth?: unknown };
  };
  const oldEndpoint = typeof body.oldEndpoint === "string" ? body.oldEndpoint.trim() : "";
  const endpoint = typeof body.endpoint === "string" ? body.endpoint.trim() : "";
  const p256dh = typeof body.keys?.p256dh === "string" ? body.keys.p256dh : "";
  const auth = typeof body.keys?.auth === "string" ? body.keys.auth : "";
  if (!oldEndpoint || !endpoint || !p256dh || !auth) {
    res.status(400).json({ error: "oldEndpoint and a full new subscription (endpoint + keys) are required." });
    return;
  }
  const { rotated } = await rotateSubscription(oldEndpoint, {
    endpoint,
    p256dh,
    auth,
    userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null,
  });
  // 200 either way: an unknown old endpoint just means "nothing to rotate" (the
  // SW will re-subscribe fresh on next app open), not a client error.
  res.json({ ok: true, rotated });
});

export default router;
