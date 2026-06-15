import { Router } from "express";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { requireAdminSecret } from "../middlewares/adminSecret";
import { rebuildWardrobeForUser } from "../services/wardrobeRebuild";
import { getBuyLinkFreshnessStats } from "../services/buyLinks";
import { getDefaultTenantId } from "../services/tenants";
import { getKeyPool, listKeyPools, parseKeyList } from "../lib/keyPool";
import { isPushConfigured, sendPushToAll, sendPushToUser } from "../services/pushService";
import { logger } from "../lib/logger";

const router = Router();

// Live health of the rotating API-key pools (Serper, Poof background removal).
// Masked keys only. Lets you watch free-tier keys drain and see when a pool is
// running low — without redeploying.
router.get("/admin/key-pools", requireAdminSecret, (_req, res) => {
  res.json({ pools: listKeyPools().map((pool) => pool.snapshot()) });
});

// Hot-add free-tier keys to a pool at runtime (no redeploy). Body: { keys }
// where keys is a comma/space/newline-delimited string or an array of strings.
// Re-adding a retired/cooling key revives it.
router.post("/admin/key-pools/:pool/keys", requireAdminSecret, (req, res) => {
  const poolName = String(req.params.pool ?? "");
  const pool = getKeyPool(poolName);
  if (!pool) {
    res.status(404).json({ error: `Unknown pool '${poolName}'`, pools: listKeyPools().map((p) => p.name) });
    return;
  }
  const rawKeys = (req.body as { keys?: string | string[] })?.keys;
  const list = Array.isArray(rawKeys) ? rawKeys : typeof rawKeys === "string" ? [rawKeys] : [];
  const keys = parseKeyList(...list);
  if (keys.length === 0) {
    res.status(400).json({ error: "Provide one or more keys in the `keys` field" });
    return;
  }
  const added = pool.addKeys(keys);
  logger.info({ pool: poolName, added, size: pool.size }, "[admin] hot-added API keys to pool");
  res.json({ added, snapshot: pool.snapshot() });
});

// Ops-only counters for stale/undateable affiliate buy-link cache rows seen
// while resolving public share buy links. Pairs with the structured
// `affiliate_link_stale` warn logs for alerting.
router.get("/admin/buy-links/freshness", requireAdminSecret, (_req, res) => {
  res.json(getBuyLinkFreshnessStats());
});

router.post("/admin/wardrobe/rebuild", requireAdminSecret, async (req, res) => {
  const { email } = req.body as { email?: string };
  if (!email || !email.trim()) {
    res.status(400).json({ error: "Email is required" });
    return;
  }

  const normalizedEmail = email.trim().toLowerCase();

  const existing = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, normalizedEmail))
    .limit(1);

  if (existing.length === 0) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const tenantId = existing[0].tenantId ?? (await getDefaultTenantId());
  const summary = await rebuildWardrobeForUser(tenantId, existing[0].id);
  res.json(summary);
});

// Ops-only trigger to send a Web Push notification — to one user (by email) or
// to every subscriber when no email is given. This is the manual delivery path
// (e.g. a "scent of the day" nudge); automated scheduling would need a worker,
// which this codebase does not yet run. Body: { email?, title, body, url? }.
router.post("/admin/push/broadcast", requireAdminSecret, async (req, res) => {
  if (!isPushConfigured()) {
    res.status(503).json({ error: "Push notifications are not configured on this server." });
    return;
  }
  const { email, title, body, url } = req.body as {
    email?: string;
    title?: string;
    body?: string;
    url?: string;
  };
  if (!title?.trim() || !body?.trim()) {
    res.status(400).json({ error: "title and body are required" });
    return;
  }
  const payload = { title: title.trim(), body: body.trim(), url: url?.trim() || "/" };

  if (email?.trim()) {
    const normalizedEmail = email.trim().toLowerCase();
    const existing = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.email, normalizedEmail))
      .limit(1);
    if (existing.length === 0) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    const result = await sendPushToUser(existing[0].id, payload);
    logger.info({ email: normalizedEmail, ...result }, "[admin] push sent to user");
    res.json(result);
    return;
  }

  const result = await sendPushToAll(payload);
  logger.info(result, "[admin] push broadcast to all subscribers");
  res.json(result);
});

export default router;
