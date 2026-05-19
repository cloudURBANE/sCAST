import { Router } from "express";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { requireAdminSecret } from "../middlewares/adminSecret";
import { rebuildWardrobeForUser } from "../services/wardrobeRebuild";

const router = Router();

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
