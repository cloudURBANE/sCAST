import { Router, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { requireAuth, type AuthRequest } from "../middlewares/auth";
import { getTenantId } from "../middlewares/tenant";
import { rateLimitMiddleware } from "../lib/rateLimit.ts";
import {
  allowance,
  hasPaidAccess,
  reservationCost,
  nonnegativeInteger,
} from "../services/launchPolicy.ts";
import {
  billingOrigin,
  checkoutEnabled,
  stripeClient,
  subscriptionAccess,
} from "../services/billingStripe.ts";
import { applyBillingEvent } from "../services/billingEventCore.ts";

const router = Router();
const billingRate = rateLimitMiddleware({
  name: "billing",
  limit: 15,
  windowMs: 60_000,
});

router.get("/billing", requireAuth, async (req: AuthRequest, res) => {
  const tenant = getTenantId(req);
  const { rows } = await pool.query(
    "SELECT customer_id,status,access_until FROM billing_accounts WHERE user_id=$1 AND tenant_id=$2",
    [req.user!.id, tenant],
  );
  const account = rows[0];
  const paid = !!account && hasPaidAccess(account.status, account.access_until);
  const usage = await pool.query(
    "SELECT feature,calls FROM launch_usage WHERE scope=$1 AND month=to_char(now() AT TIME ZONE 'UTC','YYYY-MM')",
    [`${tenant}:${req.user!.id}`],
  );
  res.json({
    checkoutEnabled: checkoutEnabled(),
    canManage: !!account?.customer_id,
    paid,
    status: account?.status ?? "free",
    accessUntil: account?.access_until ?? null,
    limitsEnabled: process.env.LAUNCH_LIMITS_ENABLED === "true",
    paidAllowances: Object.fromEntries(
      (["ai", "search", "image"] as const).map((f) => [f, allowance(f, true)]),
    ),
    allowances: Object.fromEntries(
      (["ai", "search", "image"] as const).map((f) => [
        f,
        {
          limit: allowance(f, paid),
          used: usage.rows.find((r) => r.feature === f)?.calls ?? 0,
        },
      ]),
    ),
  });
});

router.post(
  "/billing/checkout",
  billingRate,
  requireAuth,
  async (req: AuthRequest, res) => {
    if (!checkoutEnabled()) {
      res.status(503).json({ error: "Paid enrollment is not open yet." });
      return;
    }
    // Reject incomplete cost setup before accepting money.
    for (const feature of ["ai", "search", "image"] as const)
      reservationCost(feature);
    if (!nonnegativeInteger(process.env.LAUNCH_MONTHLY_RESERVE_MICROUSD, 0))
      throw new Error("Launch budget is not configured");
    const stripe = stripeClient();
    const priceId = process.env.STRIPE_PRICE_ID!;
    const price = await stripe.prices.retrieve(priceId);
    if (
      !price.active ||
      price.currency !== "usd" ||
      price.unit_amount !== 900 ||
      price.recurring?.interval !== "month" ||
      price.recurring.interval_count !== 1
    )
      throw new Error("Expected the $9 USD monthly price");
    const tenant = getTenantId(req);
    const user = req.user!;
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(
        "INSERT INTO billing_accounts (user_id,tenant_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
        [user.id, tenant],
      );
      const {
        rows: [account],
      } = await c.query(
        "SELECT * FROM billing_accounts WHERE user_id=$1 AND tenant_id=$2 FOR UPDATE",
        [user.id, tenant],
      );
      if (!account) throw new Error("Billing account mismatch");
      let customer = account.customer_id as string | null;
      if (!customer) {
        customer = (
          await stripe.customers.create(
            {
              email: user.email,
              metadata: { userId: user.id, tenantId: tenant },
            },
            { idempotencyKey: `customer:${tenant}:${user.id}` },
          )
        ).id;
        await c.query(
          "UPDATE billing_accounts SET customer_id=$2 WHERE user_id=$1",
          [user.id, customer],
        );
      }
      const subscriptions = await stripe.subscriptions.list({
        customer,
        status: "all",
        limit: 100,
      });
      if (
        subscriptions.has_more ||
        subscriptions.data.some(
          (s) => !["canceled", "incomplete_expired"].includes(s.status),
        )
      ) {
        await c.query("COMMIT");
        res
          .status(409)
          .json({
            error:
              "A subscription already exists. Use Manage billing to update it.",
          });
        return;
      }
      const sessions = await stripe.checkout.sessions.list({
        customer,
        status: "open",
        limit: 10,
      });
      const existing = sessions.data.find((s) => s.mode === "subscription");
      const session =
        existing ??
        (await stripe.checkout.sessions.create(
          {
            mode: "subscription",
            customer,
            line_items: [{ price: priceId, quantity: 1 }],
            success_url: `${billingOrigin()}/billing?checkout=complete`,
            cancel_url: `${billingOrigin()}/billing`,
            client_reference_id: user.id,
            subscription_data: {
              metadata: { userId: user.id, tenantId: tenant },
            },
            consent_collection: { terms_of_service: "required" },
          },
          {
            idempotencyKey: `checkout:${customer}:${Math.floor(Date.now() / 1_800_000)}`,
          },
        ));
      await c.query("COMMIT");
      res.json({ url: session.url });
    } catch (err) {
      await c.query("ROLLBACK");
      throw err;
    } finally {
      c.release();
    }
  },
);

// Cancellation and payment-method recovery stay available even while enrollment
// is closed or provider spending is paused.
router.post(
  "/billing/portal",
  billingRate,
  requireAuth,
  async (req: AuthRequest, res) => {
    const {
      rows: [account],
    } = await pool.query(
      "SELECT customer_id FROM billing_accounts WHERE user_id=$1 AND tenant_id=$2",
      [req.user!.id, getTenantId(req)],
    );
    if (!account?.customer_id) {
      res.status(409).json({ error: "No billing account exists yet." });
      return;
    }
    const session = await stripeClient().billingPortal.sessions.create({
      customer: account.customer_id,
      return_url: `${billingOrigin()}/billing`,
    });
    res.json({ url: session.url });
  },
);

export async function stripeWebhook(req: Request, res: Response) {
  if (
    !process.env.STRIPE_WEBHOOK_SECRET ||
    !process.env.STRIPE_SECRET_KEY ||
    !process.env.STRIPE_PRICE_ID
  ) {
    res.sendStatus(503);
    return;
  }
  const stripe = stripeClient();
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers["stripe-signature"] as string,
      process.env.STRIPE_WEBHOOK_SECRET,
    );
  } catch {
    res.status(400).json({ error: "Invalid webhook signature" });
    return;
  }
  if (
    !event.type.startsWith("customer.subscription.") &&
    !event.type.startsWith("invoice.") &&
    event.type !== "checkout.session.completed"
  ) {
    res.json({ received: true });
    return;
  }
  const obj = event.data.object as unknown as {
    customer?: string | { id: string };
  };
  const customer =
    typeof obj.customer === "string" ? obj.customer : obj.customer?.id;
  if (!customer) {
    res.json({ received: true });
    return;
  }
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const applied = await applyBillingEvent(c, event.id, customer, async () => {
      const subscriptions = await stripe.subscriptions.list({
        customer,
        status: "all",
        limit: 100,
        expand: ["data.latest_invoice"],
      });
      if (subscriptions.has_more)
        throw new Error("Subscription reconciliation requires pagination");
      const candidates = subscriptions.data.filter((s) =>
        s.items.data.some((i) => i.price.id === process.env.STRIPE_PRICE_ID),
      );
      const subscription =
        candidates.find((s) => s.status === "active") ??
        candidates.sort((a, b) => b.created - a.created)[0];
      const access = subscription
        ? subscriptionAccess(subscription, process.env.STRIPE_PRICE_ID!)
        : { status: "none", accessUntil: null };
      return { subscriptionId: subscription?.id ?? null, ...access };
    });
    if (!applied) {
      await c.query("ROLLBACK");
      const remote = await stripe.customers.retrieve(customer);
      const userId = !remote.deleted ? remote.metadata.userId : undefined;
      const tenantId = !remote.deleted ? remote.metadata.tenantId : undefined;
      const validUuid = (value: unknown) =>
        typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value);
      const pending =
        validUuid(userId) && validUuid(tenantId)
          ? await c.query("SELECT id FROM users WHERE id=$1 AND tenant_id=$2", [
              userId,
              tenantId,
            ])
          : { rows: [] };
      // Retry a checkout that has not committed its mapping yet. Ignore events
      // for deleted customers/accounts and other products in the Stripe account.
      res
        .status(pending.rows.length ? 503 : 200)
        .json({ received: !pending.rows.length });
      return;
    }
    await c.query("COMMIT");
    res.json({ received: true });
  } catch (err) {
    await c.query("ROLLBACK");
    throw err;
  } finally {
    c.release();
  }
}

export default router;
