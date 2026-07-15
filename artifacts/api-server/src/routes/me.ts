import { Router } from "express";
import { AuthRequest, isUndefinedColumnError, requireAuth } from "../middlewares/auth";
import { getTenantId } from "../middlewares/tenant";
import { meWriteRateLimit } from "../middlewares/writeRateLimit";
import { db } from "@workspace/db";
import {
  usersTable,
  userFragrancesTable,
  userSettingsTable,
  pushSubscriptionsTable,
  inAppNotificationsTable,
  communityPostsTable,
  communityCommentsTable,
  communityReactionsTable,
  communityVotesTable,
  arenaCrowdPredictionsTable,
} from "@workspace/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { deriveAppState } from "../services/appStateCore";
import { isAdminUser } from "../lib/adminAccess";
import { logger } from "../lib/logger";
import { SCENT_FAMILIES } from "@workspace/scent-weather-engine";

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

  let onboardingCompletedFlag = false;
  try {
    const [settings] = await db
      .select({ completed: userSettingsTable.wardrobeOnboardingCompleted })
      .from(userSettingsTable)
      .where(eq(userSettingsTable.userId, user.id))
      .limit(1);
    onboardingCompletedFlag = settings?.completed ?? false;
  } catch (err) {
    if (!isUndefinedColumnError(err)) throw err;
    logger.warn({ userId: user.id }, "user_settings onboarding columns not yet migrated — deriving state from wardrobe count only");
  }

  const { state, shouldPersistCompletion } = deriveAppState({
    authenticated: true,
    wardrobeCount,
    onboardingCompletedFlag,
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
    if (!isUndefinedColumnError(err)) throw err;
    logger.warn({ userId: user.id }, "user_settings.username not yet migrated — reporting null");
  }
  res.json({ username, email: user.email });
});

type WeatherLocationResponse = {
  lat: number;
  lon: number;
  label: string | null;
  updatedAt: string | null;
};

function finiteCoordinate(value: unknown, min: number, max: number): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function cleanWeatherLocationLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 80) : null;
}

function weatherLocationDto(row: {
  weatherLatitude: number | null;
  weatherLongitude: number | null;
  weatherLocationLabel: string | null;
  weatherLocationUpdatedAt: Date | null;
}): WeatherLocationResponse | null {
  if (typeof row.weatherLatitude !== "number" || typeof row.weatherLongitude !== "number") return null;
  return {
    lat: row.weatherLatitude,
    lon: row.weatherLongitude,
    label: row.weatherLocationLabel ?? null,
    updatedAt: row.weatherLocationUpdatedAt?.toISOString() ?? null,
  };
}

router.get("/me/weather-location", requireAuth, async (req: AuthRequest, res) => {
  const user = req.user!;
  try {
    const [row] = await db
      .select({
        weatherLatitude: userSettingsTable.weatherLatitude,
        weatherLongitude: userSettingsTable.weatherLongitude,
        weatherLocationLabel: userSettingsTable.weatherLocationLabel,
        weatherLocationUpdatedAt: userSettingsTable.weatherLocationUpdatedAt,
      })
      .from(userSettingsTable)
      .where(eq(userSettingsTable.userId, user.id))
      .limit(1);
    res.json({ location: row ? weatherLocationDto(row) : null, persistenceAvailable: true });
  } catch (err) {
    if (!isUndefinedColumnError(err)) throw err;
    logger.warn({ userId: user.id }, "user_settings weather location columns not yet migrated");
    res.json({ location: null, persistenceAvailable: false });
  }
});

router.put("/me/weather-location", requireAuth, meWriteRateLimit, async (req: AuthRequest, res) => {
  const user = req.user!;
  const tenantId = getTenantId(req);
  const body = (req.body ?? {}) as { lat?: unknown; lon?: unknown; label?: unknown };
  const lat = finiteCoordinate(body.lat, -90, 90);
  const lon = finiteCoordinate(body.lon, -180, 180);
  if (lat === null || lon === null) {
    res.status(400).json({ error: "Valid lat and lon are required." });
    return;
  }

  const now = new Date();
  const label = cleanWeatherLocationLabel(body.label);
  try {
    await db
      .insert(userSettingsTable)
      .values({
        tenantId,
        userId: user.id,
        weatherLatitude: lat,
        weatherLongitude: lon,
        weatherLocationLabel: label,
        weatherLocationUpdatedAt: now,
      })
      .onConflictDoUpdate({
        target: userSettingsTable.userId,
        set: {
          tenantId,
          weatherLatitude: lat,
          weatherLongitude: lon,
          weatherLocationLabel: label,
          weatherLocationUpdatedAt: now,
          updatedAt: now,
        },
      });
  } catch (err) {
    if (!isUndefinedColumnError(err)) throw err;
    logger.warn({ userId: user.id }, "Cannot persist weather location before migration is applied");
    res.status(503).json({ error: "Weather location sync is temporarily unavailable." });
    return;
  }

  res.json({
    location: {
      lat,
      lon,
      label,
      updatedAt: now.toISOString(),
    } satisfies WeatherLocationResponse,
  });
});

router.delete("/me/weather-location", requireAuth, meWriteRateLimit, async (req: AuthRequest, res) => {
  const user = req.user!;
  try {
    await db
      .update(userSettingsTable)
      .set({
        weatherLatitude: null,
        weatherLongitude: null,
        weatherLocationLabel: null,
        weatherLocationUpdatedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(userSettingsTable.userId, user.id));
  } catch (err) {
    if (!isUndefinedColumnError(err)) throw err;
    res.status(503).json({ error: "Weather location sync is temporarily unavailable." });
    return;
  }
  res.json({ location: null });
});

router.put("/me/profile", requireAuth, meWriteRateLimit, async (req: AuthRequest, res) => {
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
    let clash: Array<{ userId: string }> = [];
    try {
      clash = await db
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
    } catch (err) {
      if (!isUndefinedColumnError(err)) throw err;
      logger.warn({ userId: user.id }, "Cannot save username before migration is applied");
      res.status(503).json({ error: "Username storage is temporarily unavailable. Please try again soon." });
      return;
    }
    if (clash[0]) {
      res.status(409).json({ error: "That username is already taken." });
      return;
    }
  }

  const now = new Date();
  try {
    await db
      .insert(userSettingsTable)
      .values({ tenantId, userId: user.id, username })
      .onConflictDoUpdate({
        target: userSettingsTable.userId,
        set: { tenantId, username, updatedAt: now },
      });
  } catch (err) {
    if (!isUndefinedColumnError(err)) throw err;
    logger.warn({ userId: user.id }, "Cannot save username before migration is applied");
    res.status(503).json({ error: "Username storage is temporarily unavailable. Please try again soon." });
    return;
  }

  res.json({ username, email: user.email });
});

// ── UI preferences (theme / accent / language) ─────────────────────────────
// Cross-device sync for the appearance + language pickers. The client treats
// localStorage as the source of truth for instant, offline-capable switching;
// this endpoint reconciles that choice across a user's devices. Like every
// other user_settings read here, it tolerates the columns not yet existing in
// the live DB (migration lag) by catching 42703 and reporting nulls, so the
// settings panel never 500s before `drizzle-kit push` lands.

const THEME_VALUES = new Set(["dark", "light"]);
const ACCENT_VALUES = new Set(["gold", "green"]);
const LOCALE_VALUES = new Set(["en", "es", "fr", "de"]);

type PreferencesDto = {
  theme: string | null;
  accent: string | null;
  locale: string | null;
};

function pickEnum(value: unknown, allowed: Set<string>): string | null | undefined {
  // undefined  → caller omitted the field (leave unchanged)
  // null/""     → explicit clear (revert to app default)
  // valid enum  → set it
  // anything else → undefined (ignored), so a bad value can't wipe a good one
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value === "string" && allowed.has(value)) return value;
  return undefined;
}

router.get("/me/preferences", requireAuth, async (req: AuthRequest, res) => {
  const user = req.user!;
  let prefs: PreferencesDto = { theme: null, accent: null, locale: null };
  try {
    const [row] = await db
      .select({
        theme: userSettingsTable.themePreference,
        accent: userSettingsTable.accentPreference,
        locale: userSettingsTable.localePreference,
      })
      .from(userSettingsTable)
      .where(eq(userSettingsTable.userId, user.id))
      .limit(1);
    if (row) {
      prefs = {
        theme: row.theme ?? null,
        accent: row.accent ?? null,
        locale: row.locale ?? null,
      };
    }
  } catch (err) {
    if (!isUndefinedColumnError(err)) throw err;
    logger.warn({ userId: user.id }, "user_settings preference columns not yet migrated — reporting nulls");
  }
  res.json({ preferences: prefs });
});

router.put("/me/preferences", requireAuth, meWriteRateLimit, async (req: AuthRequest, res) => {
  const user = req.user!;
  const tenantId = getTenantId(req);
  const body = (req.body ?? {}) as { theme?: unknown; accent?: unknown; locale?: unknown };

  const theme = pickEnum(body.theme, THEME_VALUES);
  const accent = pickEnum(body.accent, ACCENT_VALUES);
  const locale = pickEnum(body.locale, LOCALE_VALUES);

  if (theme === undefined && accent === undefined && locale === undefined) {
    res.status(400).json({ error: "Provide at least one of theme, accent, or locale." });
    return;
  }

  // Only the explicitly-provided fields land in the update set, so a partial
  // PUT (e.g. just the language) never clobbers the other two preferences.
  const now = new Date();
  const updates: Record<string, unknown> = { updatedAt: now };
  if (theme !== undefined) updates.themePreference = theme;
  if (accent !== undefined) updates.accentPreference = accent;
  if (locale !== undefined) updates.localePreference = locale;

  try {
    await db
      .insert(userSettingsTable)
      .values({
        tenantId,
        userId: user.id,
        themePreference: theme === undefined ? null : theme,
        accentPreference: accent === undefined ? null : accent,
        localePreference: locale === undefined ? null : locale,
      })
      .onConflictDoUpdate({
        target: userSettingsTable.userId,
        set: { tenantId, ...updates },
      });
  } catch (err) {
    if (!isUndefinedColumnError(err)) throw err;
    logger.warn({ userId: user.id }, "Cannot save UI preferences before migration is applied");
    res.status(503).json({ error: "Preference sync is temporarily unavailable." });
    return;
  }

  res.json({
    preferences: {
      theme: theme === undefined ? null : theme,
      accent: accent === undefined ? null : accent,
      locale: locale === undefined ? null : locale,
    } satisfies PreferencesDto,
  });
});

// ── Scent-taste profile (Phase 4 personalization spine) ────────────────────
// The persisted per-user preference profile: liked/disliked families plus the
// two engine `userPreference` axes (skin longevity, projection). Captured at
// onboarding, refined by the feedback loop, and read by the recommendation
// scorer. Same migration-lag tolerance as /me/preferences (catches 42703).

const SCENT_FAMILY_SET = new Set<string>(SCENT_FAMILIES as readonly string[]);
const SCENT_LASTS_VALUES = new Set(["short", "normal", "long"]);
const PROJECTION_PREF_VALUES = new Set(["subtle", "noticeable"]);
const MAX_PREFERRED_FAMILIES = 15;

type ScentPreferencesDto = {
  preferredFamilies: string[];
  dislikedFamilies: string[];
  scentLastsOnMe: string | null;
  projectionPreference: string | null;
};

// Coerce an untrusted families payload into a bounded, de-duplicated list of
// canonical ScentFamily names. Returns undefined when the field was omitted (so
// a partial PUT leaves it unchanged) and [] for an explicit clear.
function pickFamilies(value: unknown): string[] | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return [];
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const family = entry.trim().toLowerCase();
    if (!SCENT_FAMILY_SET.has(family) || seen.has(family)) continue;
    seen.add(family);
    out.push(family);
    if (out.length >= MAX_PREFERRED_FAMILIES) break;
  }
  return out;
}

router.get("/me/scent-preferences", requireAuth, async (req: AuthRequest, res) => {
  const user = req.user!;
  let prefs: ScentPreferencesDto = {
    preferredFamilies: [],
    dislikedFamilies: [],
    scentLastsOnMe: null,
    projectionPreference: null,
  };
  try {
    const [row] = await db
      .select({
        preferred: userSettingsTable.preferredFamilies,
        disliked: userSettingsTable.dislikedFamilies,
        lasts: userSettingsTable.scentLastsOnMe,
        projection: userSettingsTable.projectionPreference,
      })
      .from(userSettingsTable)
      .where(eq(userSettingsTable.userId, user.id))
      .limit(1);
    if (row) {
      prefs = {
        preferredFamilies: Array.isArray(row.preferred) ? row.preferred : [],
        dislikedFamilies: Array.isArray(row.disliked) ? row.disliked : [],
        scentLastsOnMe: row.lasts ?? null,
        projectionPreference: row.projection ?? null,
      };
    }
  } catch (err) {
    if (!isUndefinedColumnError(err)) throw err;
    logger.warn({ userId: user.id }, "user_settings scent-preference columns not yet migrated — reporting empties");
  }
  res.json({ scentPreferences: prefs });
});

router.put("/me/scent-preferences", requireAuth, meWriteRateLimit, async (req: AuthRequest, res) => {
  const user = req.user!;
  const tenantId = getTenantId(req);
  const body = (req.body ?? {}) as {
    preferredFamilies?: unknown;
    dislikedFamilies?: unknown;
    scentLastsOnMe?: unknown;
    projectionPreference?: unknown;
  };

  const preferred = pickFamilies(body.preferredFamilies);
  const disliked = pickFamilies(body.dislikedFamilies);
  const lasts = pickEnum(body.scentLastsOnMe, SCENT_LASTS_VALUES);
  const projection = pickEnum(body.projectionPreference, PROJECTION_PREF_VALUES);

  if (
    preferred === undefined &&
    disliked === undefined &&
    lasts === undefined &&
    projection === undefined
  ) {
    res.status(400).json({
      error: "Provide at least one of preferredFamilies, dislikedFamilies, scentLastsOnMe, projectionPreference.",
    });
    return;
  }

  const now = new Date();
  const updates: Record<string, unknown> = { updatedAt: now };
  if (preferred !== undefined) updates.preferredFamilies = preferred;
  if (disliked !== undefined) updates.dislikedFamilies = disliked;
  if (lasts !== undefined) updates.scentLastsOnMe = lasts;
  if (projection !== undefined) updates.projectionPreference = projection;

  try {
    await db
      .insert(userSettingsTable)
      .values({
        tenantId,
        userId: user.id,
        preferredFamilies: preferred === undefined ? null : preferred,
        dislikedFamilies: disliked === undefined ? null : disliked,
        scentLastsOnMe: lasts === undefined ? null : lasts,
        projectionPreference: projection === undefined ? null : projection,
      })
      .onConflictDoUpdate({
        target: userSettingsTable.userId,
        set: { tenantId, ...updates },
      });
  } catch (err) {
    if (!isUndefinedColumnError(err)) throw err;
    logger.warn({ userId: user.id }, "Cannot save scent preferences before migration is applied");
    res.status(503).json({ error: "Scent-preference sync is temporarily unavailable." });
    return;
  }

  res.json({
    scentPreferences: {
      preferredFamilies: preferred ?? [],
      dislikedFamilies: disliked ?? [],
      scentLastsOnMe: lasts === undefined ? null : lasts,
      projectionPreference: projection === undefined ? null : projection,
    } satisfies ScentPreferencesDto,
  });
});

// ── Account data export + deletion (production-readiness: public-launch P0) ──
// GDPR/CCPA-shaped self-service: a signed-in user can download everything we
// hold for them and irreversibly delete their account. Both are strictly
// user-scoped (keyed on req.user.id, populated by requireAuth).

// A newer table (community/arena) may not exist on a lagging live DB. For the
// read-only EXPORT we degrade a missing relation/column to an empty list rather
// than 500 the whole download.
function isMissingRelationOrColumn(err: unknown): boolean {
  for (let cur = err, depth = 0; typeof cur === "object" && cur !== null && depth < 5; depth++) {
    const code = (cur as { code?: string }).code;
    if (code === "42P01" || code === "42703") return true; // undefined_table / undefined_column
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

async function tolerantRows<T>(run: () => Promise<T[]>): Promise<T[]> {
  try {
    return await run();
  } catch (err) {
    if (isMissingRelationOrColumn(err)) return [];
    throw err;
  }
}

router.get("/me/export", requireAuth, async (req: AuthRequest, res) => {
  const user = req.user!;

  const [fragrances, settings, pushSubscriptions, notifications, posts, comments, reactions, votes] =
    await Promise.all([
      tolerantRows(() =>
        db.select().from(userFragrancesTable).where(eq(userFragrancesTable.userId, user.id)),
      ),
      tolerantRows(() =>
        db.select().from(userSettingsTable).where(eq(userSettingsTable.userId, user.id)),
      ),
      tolerantRows(() =>
        db.select().from(pushSubscriptionsTable).where(eq(pushSubscriptionsTable.userId, user.id)),
      ),
      tolerantRows(() =>
        db.select().from(inAppNotificationsTable).where(eq(inAppNotificationsTable.userId, user.id)),
      ),
      tolerantRows(() =>
        db.select().from(communityPostsTable).where(eq(communityPostsTable.userId, user.id)),
      ),
      tolerantRows(() =>
        db.select().from(communityCommentsTable).where(eq(communityCommentsTable.userId, user.id)),
      ),
      tolerantRows(() =>
        db.select().from(communityReactionsTable).where(eq(communityReactionsTable.userId, user.id)),
      ),
      tolerantRows(() =>
        db.select().from(communityVotesTable).where(eq(communityVotesTable.userId, user.id)),
      ),
    ]);

  res.setHeader("Content-Disposition", 'attachment; filename="scentcast-account-export.json"');
  res.json({
    exportedAt: new Date().toISOString(),
    // Deliberately omits token / token_hash — an export must not leak the live
    // bearer credential.
    account: {
      id: user.id,
      email: user.email,
      pictureUrl: user.pictureUrl ?? null,
      createdAt: user.createdAt,
    },
    settings: settings[0] ?? null,
    fragrances,
    pushSubscriptions,
    notifications,
    community: { posts, comments, reactions, votes },
  });
});

router.delete("/me", requireAuth, meWriteRateLimit, async (req: AuthRequest, res) => {
  const user = req.user!;
  try {
    // Atomic: either the whole account is removed or nothing is. Delete this
    // user's rows child→parent, then the account row itself (whose ON DELETE
    // CASCADE / SET NULL FKs clean up anything not explicitly handled, e.g. beam
    // logs and the usage ledger).
    await db.transaction(async (tx) => {
      await tx.delete(communityReactionsTable).where(eq(communityReactionsTable.userId, user.id));
      await tx.delete(communityVotesTable).where(eq(communityVotesTable.userId, user.id));
      await tx.delete(communityCommentsTable).where(eq(communityCommentsTable.userId, user.id));
      await tx
        .delete(arenaCrowdPredictionsTable)
        .where(eq(arenaCrowdPredictionsTable.userId, user.id));
      // Deleting the user's posts cascades any remaining comments/reactions/votes
      // OTHER users left on them (postId FKs).
      await tx.delete(communityPostsTable).where(eq(communityPostsTable.userId, user.id));
      await tx.delete(inAppNotificationsTable).where(eq(inAppNotificationsTable.userId, user.id));
      await tx.delete(pushSubscriptionsTable).where(eq(pushSubscriptionsTable.userId, user.id));
      await tx.delete(userSettingsTable).where(eq(userSettingsTable.userId, user.id));
      await tx.delete(userFragrancesTable).where(eq(userFragrancesTable.userId, user.id));
      await tx.delete(usersTable).where(eq(usersTable.id, user.id));
    });
  } catch (err) {
    req.log.error({ err, userId: user.id }, "Account deletion failed");
    res.status(500).json({ error: "Account deletion failed" });
    return;
  }
  res.json({ ok: true });
});

export default router;
