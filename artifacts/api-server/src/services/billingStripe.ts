import Stripe from "stripe";
import { allowance, nonnegativeInteger, reservationCost } from "./launchPolicy.ts";

export function stripeClient(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) throw new Error("Stripe is not configured");
  return new Stripe(key, { timeout: 15_000, maxNetworkRetries: 1 });
}
export function billingOrigin(): string {
  const url = new URL(
    process.env.BILLING_PUBLIC_ORIGIN || "https://scentbeam.com",
  );
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("Invalid billing origin");
  return url.origin;
}
export function checkoutEnabled(): boolean {
  const enabled = (
    process.env.BILLING_CHECKOUT_ENABLED === "true" &&
    process.env.LAUNCH_TERMS_CONFIRMED === "true" &&
    process.env.LAUNCH_LIMITS_ENABLED === "true" &&
    process.env.LAUNCH_SPENDING_STOP !== "true" &&
    !!process.env.STRIPE_SECRET_KEY?.trim() &&
    !!process.env.STRIPE_PRICE_ID?.trim() &&
    !!process.env.STRIPE_WEBHOOK_SECRET?.trim()
  );
  if (!enabled) return false;
  try {
    billingOrigin();
    if (!nonnegativeInteger(process.env.LAUNCH_MONTHLY_RESERVE_MICROUSD, 0))
      return false;
    for (const feature of ["ai", "search", "image"] as const) {
      reservationCost(feature);
      allowance(feature, true);
      allowance(feature, false);
    }
    return true;
  } catch {
    return false;
  }
}

export function subscriptionAccess(
  subscription: Stripe.Subscription,
  priceId: string,
) {
  const item = subscription.items.data.find((i) => i.price.id === priceId);
  const invoice = subscription.latest_invoice;
  // A redirect, checkout completion, free trial, or merely "active" is not proof
  // of payment. Reconciliation requests expand latest_invoice from Stripe.
  const paid =
    typeof invoice === "object" &&
    invoice !== null &&
    invoice.status === "paid";
  const end = item?.current_period_end;
  return {
    status:
      subscription.status === "active" && paid && item
        ? "active"
        : subscription.status === "active"
          ? "payment_pending"
          : subscription.status,
    accessUntil: end && paid && item ? new Date(end * 1000) : null,
  };
}
