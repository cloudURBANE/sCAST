import type { SqlConnection } from "./launchUsageCore.ts";

// Caller owns the transaction. Fetch current provider state only after acquiring
// the account lock; the event ID is not durable until the access update commits.
export async function applyBillingEvent(
  c: SqlConnection,
  eventId: string,
  customer: string,
  loadCurrent: () => Promise<{
    subscriptionId: string | null;
    status: string;
    accessUntil: Date | null;
  }>,
): Promise<boolean> {
  const {
    rows: [account],
  } = await c.query(
    "SELECT user_id FROM billing_accounts WHERE customer_id=$1 FOR UPDATE",
    [customer],
  );
  if (!account) return false;
  const inserted = await c.query(
    "INSERT INTO billing_events(event_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING event_id",
    [eventId],
  );
  if (inserted.rows.length) {
    const access = await loadCurrent();
    await c.query(
      "UPDATE billing_accounts SET subscription_id=$2,status=$3,access_until=$4,updated_at=now() WHERE user_id=$1",
      [
        account.user_id,
        access.subscriptionId,
        access.status,
        access.accessUntil,
      ],
    );
  }
  return true;
}
