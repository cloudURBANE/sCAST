import { Router } from "express";
import { AuthRequest, requireAuth } from "../middlewares/auth";
import { getTenantId } from "../middlewares/tenant";
import { db } from "@workspace/db";
import { userFragrancesTable, userSettingsTable } from "@workspace/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { deriveAppState } from "../services/appStateCore";
import { isAdminUser } from "../lib/adminAccess";
import { logger } from "../lib/logger";

const router = Router();

/**
 * Additive app-state endpoint. Returns durable onboarding/discovery state for
 * the authenticated user without changing the `/api/wardrobe` contract.
 *
 * The frontend uses this to gate the dashboard CTA so a completed user never
 * sees the add-3 flow again because of a slow/empty/401 wardrobe load.
 */
router.get("/me/app-state", requireAuth, async (req: AuthRequest, res) => {
  const user = req.user!;
  const tenantId = getTenantId(req);

  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(userFragrancesTable)
    .where(and(eq(userFragrancesTable.tenantId, tenantId), eq(userFragrancesTable.userId, user.id)));
  const wardrobeCount = countRow?.count ?? 0;

  const [settings] = await db
    .select({ completed: userSettingsTable.wardrobeOnboardingCompleted })
    .from(userSettingsTable)
    .where(eq(userSettingsTable.userId, user.id))
    .limit(1);

  const { state, shouldPersistCompletion } = deriveAppState({
    authenticated: true,
    wardrobeCount,
    onboardingCompletedFlag: settings?.completed ?? false,
  });

  if (shouldPersistCompletion) {
    const now = new Date();
    try {
      await db
        .insert(userSettingsTable)
        .values({
          tenantId,
          userId: user.id,
          wardrobeOnboardingCompleted: true,
          wardrobeOnboardingCompletedAt: now,
        })
        .onConflictDoUpdate({
          target: userSettingsTable.userId,
          set: {
            wardrobeOnboardingCompleted: true,
            wardrobeOnboardingCompletedAt: now,
            updatedAt: now,
          },
        });
    } catch (err) {
      // Non-fatal: the response is already correct; persistence retries on the
      // next call once the wardrobe count is still >= the threshold.
      logger.warn({ err, userId: user.id }, "Failed to persist wardrobe onboarding completion");
    }
  }

  // Additive: lets the SPA show admin-only controls (e.g. the bottle-image
  // uploader) without a separate round-trip. The upload route still enforces
  // admin access server-side; this flag is only a UI hint.
  res.json({ ...state, isAdmin: isAdminUser(user) });
});

// Public-facing community display name. 3–20 chars, letters/numbers and a few
// separators — no leading/trailing separator, no '@' (so it never reads as an
// email or a share handle). Empty/whitespace clears the username.
const USERNAME_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9_.\-]{1,18}[a-zA-Z0-9])$/;

function normalizeUsername(value: unknown): { username: string | null } | { error: string } {
  if (value === null || value === undefined) return { username: null };
  if (typeof value !== "string") return { error: "username must be a string" };
  const trimmed = value.trim();
  if (!trimmed) return { username: null };
  if (!USERNAME_RE.test(trimmed)) {
    return {
      error:
        "Username must be 3–20 characters: letters, numbers, and . _ - only (not at the start or end).",
    };
  }
  return { username: trimmed };
}

// Returns the caller's chosen username (null when unset). Tolerant of the column
// not yet existing in the live DB (migration lag): mirrors the auth-layer 42703
// fallback so a fresh deploy never 500s the settings panel before the migration
// lands — it simply reports "no username set" until then.
router.get("/me/profile", requireAuth, async (req: AuthRequest, res) => {
  const user = req.user!;
  let username: string | null = null;
  try {
    const [row] = await db
      .select({ username: userSettingsTable.username })
      .from(userSettingsTable)
      .where(eq(userSettingsTable.userId, user.id))
      .limit(1);
    username = row?.username ?? null;
  } catch (err) {
    if ((err as { code?: string } | null)?.code !== "42703") throw err;
    logger.warn({ userId: user.id }, "user_settings.username not yet migrated — reporting null");
  }
  res.json({ username, email: user.email });
});

router.put("/me/profile", requireAuth, async (req: AuthRequest, res) => {
  const user = req.user!;
  const tenantId = getTenantId(req);

  const body = (req.body ?? {}) as { username?: unknown };
  const result = normalizeUsername(body.username);
  if ("error" in result) {
    res.status(400).json({ error: result.error });
    return;
  }
  const { username } = result;

  // Per-tenant, case-insensitive uniqueness. A unique DB index would need a
  // partial/expression constraint (and a riskier migration); an app-level check
  // keeps the schema additive while still preventing two members from claiming
  // the same handle on the same tenant.
  if (username) {
    const clash = await db
      .select({ userId: userSettingsTable.userId })
      .from(userSettingsTable)
      .where(
        and(
          eq(userSettingsTable.tenantId, tenantId),
          sql`lower(${userSettingsTable.username}) = lower(${username})`,
          sql`${userSettingsTable.userId} <> ${user.id}`,
        ),
      )
      .limit(1);
    if (clash[0]) {
      res.status(409).json({ error: "That username is already taken." });
      return;
    }
  }

  const now = new Date();
  await db
    .insert(userSettingsTable)
    .values({ tenantId, userId: user.id, username })
    .onConflictDoUpdate({
      target: userSettingsTable.userId,
      set: { tenantId, username, updatedAt: now },
    });

  res.json({ username, email: user.email });
});

export default router;
