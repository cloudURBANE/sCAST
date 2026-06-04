import { Router } from "express";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { requireAdminSecret } from "../middlewares/adminSecret";
import { rebuildWardrobeForUser } from "../services/wardrobeRebuild";
import { getBuyLinkFreshnessStats } from "../services/buyLinks";
import { getDefaultTenantId } from "../services/tenants";
import { getKeyPool, listKeyPools, parseKeyList } from "../lib/keyPool";
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

export default router;
