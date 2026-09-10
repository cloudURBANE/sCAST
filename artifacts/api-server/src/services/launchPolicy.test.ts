import test from "node:test";
import assert from "node:assert/strict";
import {
  allowance,
  costFeature,
  hasPaidAccess,
  reservationCost,
  nonnegativeInteger,
} from "./launchPolicy.ts";
import { checkoutEnabled, subscriptionAccess } from "./billingStripe.ts";
import Stripe from "stripe";

test("enrollment stays closed until local billing and spending configuration is valid", () => {
  const original = process.env;
  const configured = {
    BILLING_CHECKOUT_ENABLED: "true",
    LAUNCH_TERMS_CONFIRMED: "true",
    LAUNCH_LIMITS_ENABLED: "true",
    STRIPE_SECRET_KEY: "sk_test_placeholder",
    STRIPE_PRICE_ID: "price_placeholder",
    STRIPE_WEBHOOK_SECRET: "whsec_placeholder",
    LAUNCH_MONTHLY_RESERVE_MICROUSD: "1000000",
    LAUNCH_AI_RESERVE_MICROUSD: "100",
    LAUNCH_SEARCH_RESERVE_MICROUSD: "100",
    LAUNCH_IMAGE_RESERVE_MICROUSD: "100",
  };
  try {
    process.env = { ...configured };
    assert.equal(checkoutEnabled(), true);
    for (const [key, value] of Object.entries({
      LAUNCH_MONTHLY_RESERVE_MICROUSD: "0",
      LAUNCH_AI_RESERVE_MICROUSD: "",
      LAUNCH_SEARCH_RESERVE_MICROUSD: "-1",
      LAUNCH_IMAGE_RESERVE_MICROUSD: "NaN",
      LAUNCH_PAID_AI_MONTHLY: "0.5",
      LAUNCH_FREE_SEARCH_MONTHLY: "invalid",
      STRIPE_SECRET_KEY: " ",
      STRIPE_PRICE_ID: " ",
      STRIPE_WEBHOOK_SECRET: " ",
      BILLING_PUBLIC_ORIGIN: "https://scentbeam.com/invalid",
      LAUNCH_SPENDING_STOP: "true",
      LAUNCH_TERMS_CONFIRMED: "false",
    })) {
      process.env = { ...configured, [key]: value };
      assert.equal(checkoutEnabled(), false, key);
    }
  } finally {
    process.env = original;
  }
});

test("paid access requires active status and an unexpired paid period", () => {
  const future = new Date(Date.now() + 60_000);
  assert.equal(hasPaidAccess("active", future), true);
  for (const status of [
    "past_due",
    "unpaid",
    "canceled",
    "incomplete",
    "trialing",
    "paused",
    "payment_pending",
  ])
    assert.equal(hasPaidAccess(status, future), false);
  for (const end of [null, "invalid", new Date(0)])
    assert.equal(hasPaidAccess("active", end), false);
});
test("configured zero blocks usage; invalid budgets fail closed", () => {
  assert.equal(allowance("image", false, {}), 0);
  assert.equal(allowance("ai", true, { LAUNCH_PAID_AI_MONTHLY: "0" }), 0);
  for (const value of ["-1", "Infinity", "NaN", "0.5", "2000000001"])
    assert.throws(() => nonnegativeInteger(value, 5));
  assert.throws(() => reservationCost("ai", {}));
});
test("cost gates cover aliases while keeping collection and cancellation available", () => {
  for (const path of [
    "/engine/search",
    "/ENGINE/search/",
    "/fragrances/search",
  ])
    assert.equal(costFeature("GET", path), "search");
  assert.equal(costFeature("HEAD", "/fragrances/search"), "search");
  for (const path of ["/scent-profile", "/search-scent", "/fragrances/details"])
    assert.equal(costFeature("POST", path), "search");
  assert.equal(costFeature("POST", "/beam-agent/runs/"), "ai");
  assert.equal(costFeature("POST", "/reimagine-bottle-image"), "image");
  for (const path of [
    "/wardrobe",
    "/me/export",
    "/billing/portal",
    "/beam-agent/runs/id/stop",
  ])
    assert.equal(costFeature("POST", path), null);
});
test("Stripe access requires the approved price and a paid invoice", () => {
  const s = {
    status: "active",
    items: {
      data: [
        { price: { id: "price_pilot" }, current_period_end: 2_000_000_000 },
      ],
    },
    latest_invoice: { status: "paid" },
  } as unknown as Stripe.Subscription;
  assert.equal(subscriptionAccess(s, "price_pilot").status, "active");
  assert.equal(subscriptionAccess(s, "other").accessUntil, null);
  assert.equal(
    subscriptionAccess({ ...s, latest_invoice: "in_pending" }, "price_pilot")
      .status,
    "payment_pending",
  );
  assert.equal(
    subscriptionAccess({ ...s, status: "past_due" }, "price_pilot").status,
    "past_due",
  );
});
test("Stripe signatures reject tampering and stale replay", () => {
  const stripe = new Stripe("sk_test_test");
  const payload = JSON.stringify({ id: "evt_test", object: "event" });
  const secret = "whsec_test";
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret });
  assert.equal(
    stripe.webhooks.constructEvent(payload, header, secret).id,
    "evt_test",
  );
  assert.throws(() =>
    stripe.webhooks.constructEvent(payload + " ", header, secret),
  );
  const stale = stripe.webhooks.generateTestHeaderString({
    payload,
    secret,
    timestamp: 1,
  });
  assert.throws(() => stripe.webhooks.constructEvent(payload, stale, secret));
});
