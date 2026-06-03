import { Router } from "express";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { requireAdminSecret } from "../middlewares/adminSecret";
import { rebuildWardrobeForUser } from "../services/wardrobeRebuild";
import { getBuyLinkFreshnessStats } from "../services/buyLinks";

const router = Router();

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

  const summary = await rebuildWardrobeForUser(existing[0].id);
  res.json(summary);
});

export default router;
