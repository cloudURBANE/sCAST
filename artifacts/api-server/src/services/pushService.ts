import webpush, { type PushSubscription as WebPushSubscription } from "web-push";
import { eq, sql, inArray } from "drizzle-orm";
import { db } from "@workspace/db";
import { pushSubscriptionsTable, userSettingsTable } from "@workspace/db/schema";
import { logger } from "../lib/logger";

/** Notification categories the user can independently opt out of (see user_settings). */
export type PushCategory = "weather" | "community" | "curation";

// VAPID keys identify this application server to the push services. Generate a
// pair once with `npx web-push generate-vapid-keys` and set them in the env.
// Absent or malformed keys disable push entirely (the routes degrade to 503),
// matching the rest of the server's "integrations degrade gracefully" stance.
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY?.trim() || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY?.trim() || "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT?.trim() || "mailto:support@scentbeam.com";

let configured = false;
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  try {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    configured = true;
  } catch (err) {
    logger.warn({ err }, "[push] invalid VAPID configuration — web push disabled");
  }
}

export function isPushConfigured(): boolean {
  return configured;
}

/** The public VAPID key the browser needs to subscribe, or null when disabled. */
export function getVapidPublicKey(): string | null {
  return configured ? VAPID_PUBLIC_KEY : null;
}

// Postgres "undefined_table" (42P01): the push_subscriptions migration hasn't
// been applied yet. Walk the cause chain like the auth layer's 42703 check —
// drizzle wraps driver errors and moves `code` onto `cause`.
function isMissingTableError(err: unknown): boolean {
  for (let current = err, depth = 0; typeof current === "object" && current !== null && depth < 5; depth++) {
    if ((current as { code?: string }).code === "42P01") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export interface PushPayload {
  title?: string;
  body?: string;
  url?: string;
  icon?: string;
  /** Status-bar icon URL (NOT a count). The numeric app-icon badge is `badgeCount`. */
  badge?: string;
  tag?: string;
  /** App-icon badge number for `navigator.setAppBadge`. 0 clears it. */
  badgeCount?: number;
}

interface SaveSubscriptionArgs {
  tenantId: string | null;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string | null;
}

/**
 * Upsert a subscription keyed on its endpoint. `provisioned: false` signals the
 * table doesn't exist yet so the route can return a clean 503 instead of a 500.
 */
export async function saveSubscription(
  args: SaveSubscriptionArgs,
): Promise<{ provisioned: boolean }> {
  const now = new Date();
  try {
    await db
      .insert(pushSubscriptionsTable)
      .values({
        tenantId: args.tenantId ?? undefined,
        userId: args.userId,
        endpoint: args.endpoint,
        p256dh: args.p256dh,
        auth: args.auth,
        userAgent: args.userAgent ?? null,
      })
      .onConflictDoUpdate({
        target: pushSubscriptionsTable.endpoint,
        set: {
          tenantId: args.tenantId ?? undefined,
          userId: args.userId,
          p256dh: args.p256dh,
          auth: args.auth,
          userAgent: args.userAgent ?? null,
          updatedAt: now,
        },
      });
    return { provisioned: true };
  } catch (err) {
    if (isMissingTableError(err)) {
      logger.warn("[push] push_subscriptions table not provisioned yet — run drizzle push");
      return { provisioned: false };
    }
    throw err;
  }
}

export async function deleteSubscription(endpoint: string): Promise<void> {
  try {
    await db.delete(pushSubscriptionsTable).where(eq(pushSubscriptionsTable.endpoint, endpoint));
  } catch (err) {
    if (!isMissingTableError(err)) throw err;
  }
}

/**
 * Re-point an existing subscription to a rotated endpoint/keys. Used by the
 * service worker's `pushsubscriptionchange` flow, which has no bearer token —
 * the *old* endpoint is the unguessable identity that authorizes the swap, so
 * the row's owning user is preserved. Returns false when the old endpoint is
 * unknown (already pruned, or never ours) so the caller can fall through.
 */
export async function rotateSubscription(
  oldEndpoint: string,
  next: { endpoint: string; p256dh: string; auth: string; userAgent?: string | null },
): Promise<{ rotated: boolean }> {
  try {
    const updated = await db
      .update(pushSubscriptionsTable)
      .set({
        endpoint: next.endpoint,
        p256dh: next.p256dh,
        auth: next.auth,
        userAgent: next.userAgent ?? null,
        updatedAt: new Date(),
      })
      .where(eq(pushSubscriptionsTable.endpoint, oldEndpoint))
      .returning({ id: pushSubscriptionsTable.id });
    return { rotated: updated.length > 0 };
  } catch (err) {
    if (isMissingTableError(err)) return { rotated: false };
    
    // Catch unique violation error code '23505' (collision with another registered session)
    const code = (err as { code?: string })?.code;
    if (code === "23505") {
      logger.info({ oldEndpoint, nextEndpoint: next.endpoint }, "[push] rotation endpoint collision, silently deleting old endpoint");
      try {
        await db.delete(pushSubscriptionsTable).where(eq(pushSubscriptionsTable.endpoint, oldEndpoint));
      } catch (delErr) {
        // ignore
      }
      return { rotated: true };
    }
    
    throw err;
  }
}

interface SubscriptionRow {
  endpoint: string;
  p256dh: string;
  auth: string;
}

async function sendToRows(rows: SubscriptionRow[], payload: PushPayload): Promise<{ sent: number; pruned: number }> {
  if (rows.length === 0) return { sent: 0, pruned: 0 };
  const body = JSON.stringify(payload);
  
  const promises = rows.map(async (row) => {
    const subscription: WebPushSubscription = {
      endpoint: row.endpoint,
      keys: { p256dh: row.p256dh, auth: row.auth },
    };
    try {
      await webpush.sendNotification(subscription, body);
      return { success: true, endpoint: row.endpoint };
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode;
      return { 
        success: false, 
        endpoint: row.endpoint, 
        isExpired: statusCode === 404 || statusCode === 410, 
        err, 
        statusCode 
      };
    }
  });

  const results = await Promise.allSettled(promises);
  
  let sent = 0;
  const expiredEndpoints: string[] = [];

  for (const result of results) {
    if (result.status === "fulfilled") {
      const val = result.value;
      if (val.success) {
        sent += 1;
      } else {
        if (val.isExpired) {
          expiredEndpoints.push(val.endpoint);
        } else {
          logger.warn({ err: val.err, statusCode: val.statusCode }, "[push] sendNotification failed");
        }
      }
    }
  }

  if (expiredEndpoints.length > 0) {
    try {
      await db.delete(pushSubscriptionsTable).where(inArray(pushSubscriptionsTable.endpoint, expiredEndpoints));
    } catch (err) {
      if (!isMissingTableError(err)) throw err;
    }
  }

  return { sent, pruned: expiredEndpoints.length };
}

const SUBSCRIPTION_COLUMNS = {
  endpoint: pushSubscriptionsTable.endpoint,
  p256dh: pushSubscriptionsTable.p256dh,
  auth: pushSubscriptionsTable.auth,
} as const;

export async function sendPushToUser(userId: string, payload: PushPayload): Promise<{ sent: number; pruned: number }> {
  if (!configured) return { sent: 0, pruned: 0 };
  let rows: SubscriptionRow[];
  try {
    rows = await db.select(SUBSCRIPTION_COLUMNS).from(pushSubscriptionsTable).where(eq(pushSubscriptionsTable.userId, userId));
  } catch (err) {
    if (isMissingTableError(err)) return { sent: 0, pruned: 0 };
    throw err;
  }
  return sendToRows(rows, payload);
}

export async function sendPushToAll(payload: PushPayload, limit = 1000): Promise<{ sent: number; pruned: number }> {
  if (!configured) return { sent: 0, pruned: 0 };
  let rows: SubscriptionRow[];
  try {
    rows = await db.select(SUBSCRIPTION_COLUMNS).from(pushSubscriptionsTable).limit(limit);
  } catch (err) {
    if (isMissingTableError(err)) return { sent: 0, pruned: 0 };
    throw err;
  }
  return sendToRows(rows, payload);
}

// ---------------------------------------------------------------------------
// Per-category preferences + app-icon badge (stored on user_settings)
// ---------------------------------------------------------------------------
//
// Every read tolerates a missing column/table the same way the rest of this
// module tolerates an unprovisioned push_subscriptions table — so a deploy that
// hasn't run `drizzle-kit push` yet degrades to "no preferences, badge 0"
// instead of 500ing the push endpoints.

export interface PushPreferences {
  weather: boolean;
  community: boolean;
  /** Beam curation: "your recommendation finished enriching, add it now". */
  curation: boolean;
}

const DEFAULT_PREFERENCES: PushPreferences = { weather: true, community: true, curation: true };

function isMissingColumnOrTable(err: unknown): boolean {
  // 42P01 undefined_table (handled above) or 42703 undefined_column — either
  // means the migration hasn't landed; fall back to defaults rather than throw.
  for (let current = err, depth = 0; typeof current === "object" && current !== null && depth < 5; depth++) {
    const code = (current as { code?: string }).code;
    if (code === "42P01" || code === "42703") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export async function getPushPreferences(userId: string): Promise<PushPreferences> {
  try {
    const [row] = await db
      .select({
        weather: userSettingsTable.notifyWeather,
        community: userSettingsTable.notifyCommunity,
        curation: userSettingsTable.notifyCuration,
      })
      .from(userSettingsTable)
      .where(eq(userSettingsTable.userId, userId))
      .limit(1);
    if (!row) return { ...DEFAULT_PREFERENCES };
    return { weather: row.weather, community: row.community, curation: row.curation };
  } catch (err) {
    if (isMissingColumnOrTable(err)) return { ...DEFAULT_PREFERENCES };
    throw err;
  }
}

export async function setPushPreferences(
  userId: string,
  prefs: Partial<PushPreferences>,
): Promise<PushPreferences> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (typeof prefs.weather === "boolean") set.notifyWeather = prefs.weather;
  if (typeof prefs.community === "boolean") set.notifyCommunity = prefs.community;
  if (typeof prefs.curation === "boolean") set.notifyCuration = prefs.curation;
  try {
    // Upsert: a user may not have a settings row yet. tenant_id stays null —
    // notification prefs aren't tenant-scoped and the column is nullable.
    await db
      .insert(userSettingsTable)
      .values({
        userId,
        notifyWeather: prefs.weather ?? DEFAULT_PREFERENCES.weather,
        notifyCommunity: prefs.community ?? DEFAULT_PREFERENCES.community,
        notifyCuration: prefs.curation ?? DEFAULT_PREFERENCES.curation,
      })
      .onConflictDoUpdate({ target: userSettingsTable.userId, set });
  } catch (err) {
    if (!isMissingColumnOrTable(err)) throw err;
  }
  return getPushPreferences(userId);
}

export async function getBadgeCount(userId: string): Promise<number> {
  try {
    const [row] = await db
      .select({ count: userSettingsTable.notificationBadgeCount })
      .from(userSettingsTable)
      .where(eq(userSettingsTable.userId, userId))
      .limit(1);
    return row?.count ?? 0;
  } catch (err) {
    if (isMissingColumnOrTable(err)) return 0;
    throw err;
  }
}

export async function clearBadge(userId: string): Promise<void> {
  try {
    await db
      .update(userSettingsTable)
      .set({ notificationBadgeCount: 0, updatedAt: new Date() })
      .where(eq(userSettingsTable.userId, userId));
  } catch (err) {
    if (!isMissingColumnOrTable(err)) throw err;
  }
}

/** Atomically increment and return the new badge count (best-effort; 0 on failure). */
async function bumpBadge(userId: string): Promise<number> {
  try {
    const [row] = await db
      .update(userSettingsTable)
      .set({
        notificationBadgeCount: sql`${userSettingsTable.notificationBadgeCount} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(userSettingsTable.userId, userId))
      .returning({ count: userSettingsTable.notificationBadgeCount });
    if (row) return row.count;
    // No settings row yet — create one already at the incremented value.
    await db
      .insert(userSettingsTable)
      .values({ userId, notificationBadgeCount: 1 })
      .onConflictDoUpdate({
        target: userSettingsTable.userId,
        set: { notificationBadgeCount: sql`${userSettingsTable.notificationBadgeCount} + 1`, updatedAt: new Date() },
      });
    return getBadgeCount(userId);
  } catch (err) {
    if (isMissingColumnOrTable(err)) return 0;
    throw err;
  }
}

/**
 * Send a push that respects the user's per-category opt-in and carries the
 * incremented app-icon badge count. Use this for all product-triggered pushes
 * (weather nudges, community replies); the raw `sendPushToUser` stays for
 * category-agnostic ops/admin sends.
 */
export async function sendCategoryPushToUser(
  userId: string,
  category: PushCategory,
  payload: PushPayload,
): Promise<{ sent: number; pruned: number; skipped?: boolean }> {
  if (!configured) return { sent: 0, pruned: 0 };
  const prefs = await getPushPreferences(userId);
  const allowed = prefs[category];
  if (!allowed) return { sent: 0, pruned: 0, skipped: true };

  const badgeCount = await bumpBadge(userId);

  // Write to the database inAppNotificationsTable
  let tenantId: string | null = null;
  try {
    const [sub] = await db
      .select({ tenantId: pushSubscriptionsTable.tenantId })
      .from(pushSubscriptionsTable)
      .where(eq(pushSubscriptionsTable.userId, userId))
      .limit(1);
    if (sub) {
      tenantId = sub.tenantId;
    }
  } catch (err) {
    // ignore
  }

  try {
    const { inAppNotificationsTable } = await import("@workspace/db/schema");
    await db.insert(inAppNotificationsTable).values({
      tenantId,
      userId,
      title: payload.title || "ScentBeam",
      body: payload.body || "",
      url: payload.url || null,
      category,
      read: false,
    });
  } catch (err) {
    logger.warn({ err }, "[push] failed to write to in_app_notifications");
  }

  return sendPushToUser(userId, { ...payload, badgeCount });
}
