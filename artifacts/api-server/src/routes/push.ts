import { Router } from "express";
import { AuthRequest, requireAuth } from "../middlewares/auth";
import { getTenantId } from "../middlewares/tenant";
import {
  deleteSubscription,
  getVapidPublicKey,
  isPushConfigured,
  saveSubscription,
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

export default router;
