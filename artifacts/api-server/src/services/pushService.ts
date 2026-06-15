import webpush, { type PushSubscription as WebPushSubscription } from "web-push";
import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { pushSubscriptionsTable } from "@workspace/db/schema";
import { logger } from "../lib/logger";

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
  badge?: string;
  tag?: string;
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

interface SubscriptionRow {
  endpoint: string;
  p256dh: string;
  auth: string;
}

async function sendToRows(rows: SubscriptionRow[], payload: PushPayload): Promise<{ sent: number; pruned: number }> {
  const body = JSON.stringify(payload);
  let sent = 0;
  let pruned = 0;
  for (const row of rows) {
    const subscription: WebPushSubscription = {
      endpoint: row.endpoint,
      keys: { p256dh: row.p256dh, auth: row.auth },
    };
    try {
      await webpush.sendNotification(subscription, body);
      sent += 1;
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode;
      // 404/410 mean the subscription is gone (browser uninstalled / expired) —
      // prune it so we stop trying. Other errors are transient; just log.
      if (statusCode === 404 || statusCode === 410) {
        await deleteSubscription(row.endpoint);
        pruned += 1;
      } else {
        logger.warn({ err, statusCode }, "[push] sendNotification failed");
      }
    }
  }
  return { sent, pruned };
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
