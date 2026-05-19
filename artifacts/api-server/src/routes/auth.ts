import { Router } from "express";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

const router = Router();

router.post("/auth/login", async (req, res) => {
  const adminSecret = process.env.ADMIN_SECRET;
  const providedSecret = req.headers["x-admin-secret"];

  if (!adminSecret || providedSecret !== adminSecret) {
    res.status(401).json({ error: "Unauthorized: Admin secret required for legacy login" });
    return;
  }

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

  if (existing.length > 0) {
    res.json({ token: existing[0].token, email: existing[0].email });
    return;
  }

  const [newUser] = await db
    .insert(usersTable)
    .values({ email: normalizedEmail })
    .returning();

  res.json({ token: newUser.token, email: newUser.email });
});

export default router;
