import React, { useEffect, useState } from "react";
import { Link } from "react-router";
import { useAuth } from "@/context/AuthContext";
import { AppFooter } from "@/components/AppFooter";

type Billing = {
  checkoutEnabled: boolean;
  canManage: boolean;
  paid: boolean;
  status: string;
  accessUntil: string | null;
  limitsEnabled: boolean;
  paidAllowances: Record<string, number>;
  allowances: Record<string, { limit: number; used: number }>;
};
const apiBase = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/+$/, "");

export default function BillingPage() {
  const { authToken, setIsAuthModalOpen } = useAuth();
  const [billing, setBilling] = useState<Billing | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"checkout" | "portal" | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setBilling(null);
    setError("");
    if (authToken) {
      fetch(`${apiBase}/api/billing`, {
        headers: { Authorization: `Bearer ${authToken}` },
        signal: controller.signal,
      })
        .then(async (r) => {
          if (!r.ok)
            throw new Error("Billing could not be loaded. Please try again.");
          return r.json();
        })
        .then(setBilling)
        .catch((e) => {
          if (!controller.signal.aborted) setError(e.message);
        });
    }
    return () => controller.abort();
  }, [authToken, refresh]);
  async function openBilling(action: "checkout" | "portal") {
    if (busy || !authToken) return;
    setBusy(action);
    setError("");
    try {
      const r = await fetch(`${apiBase}/api/billing/${action}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${authToken}` },
      });
      const data = await r.json();
      if (!r.ok)
        throw new Error(data.error || "Billing is temporarily unavailable.");
      const url = new URL(data.url);
      if (
        url.protocol !== "https:" ||
        !["checkout.stripe.com", "billing.stripe.com"].includes(url.hostname)
      )
        throw new Error("Could not open secure billing.");
      window.location.assign(url.href);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Billing is temporarily unavailable.",
      );
    } finally {
      setBusy(null);
    }
  }
  const button =
    "scent-primary-button inline-flex min-h-11 items-center justify-center rounded-full px-6 disabled:opacity-50";
  return (
    <>
      <main className="relative z-10 mx-auto min-h-[70svh] max-w-3xl px-6 pb-16 pt-[calc(var(--topbar-h)+2rem)] text-foreground">
        <Link to="/" className="text-scent-accent">
          Back to collection
        </Link>
        <h1 className="mt-8 font-serif text-4xl">Billing</h1>
        {!authToken ? (
          <button
            className={`${button} mt-8`}
            onClick={() => setIsAuthModalOpen(true)}
          >
            Sign in to view your plan
          </button>
        ) : (
          <>
            {!billing && !error && (
              <p className="mt-6" role="status">
                Loading your plan…
              </p>
            )}
            {billing && (
              <div className="mt-6 space-y-6">
                <p>
                  {billing.paid
                    ? "Collector membership is active."
                    : billing.status === "free"
                      ? "You are on the free plan."
                      : `Subscription status: ${billing.status.replace(/_/g, " ")}.`}
                </p>
                {billing.accessUntil && billing.paid && (
                  <p>
                    Current access ends{" "}
                    {new Date(billing.accessUntil).toLocaleDateString()} unless
                    renewed.
                  </p>
                )}
                {billing.limitsEnabled && (
                  <>
                    <p>
                      Monthly allowances reset on the first day of each month
                      (UTC). Requests can use allowance even if they fail after
                      work begins.
                    </p>
                    <ul className="space-y-2">
                      {Object.entries(billing.allowances).map(([f, a]) => (
                        <li key={f}>
                          {f === "ai"
                            ? "AI recommendations and enrichments"
                            : f === "image"
                              ? "Image requests"
                              : "Search and profile requests"}
                          : {a.used} of {a.limit} used
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {billing.checkoutEnabled && !billing.paid && (
                  <p>
                    The $9/month plan includes {billing.paidAllowances.ai} AI
                    requests, {billing.paidAllowances.search} search/profile
                    requests, and {billing.paidAllowances.image} image requests
                    per calendar month.
                  </p>
                )}
                {billing.checkoutEnabled && !billing.paid && (
                  <>
                    <p>
                      Collector membership is $9 USD per month, billed monthly
                      until canceled. Review the{" "}
                      <Link to="/terms" className="text-scent-accent underline">
                        terms
                      </Link>{" "}
                      before subscribing.
                    </p>
                    <button
                      disabled={busy !== null}
                      aria-busy={busy === "checkout"}
                      className={button}
                      onClick={() => void openBilling("checkout")}
                    >
                      {busy === "checkout" ? "Opening secure checkout…" : "Subscribe for $9/month"}
                    </button>
                  </>
                )}
                {billing.canManage && (
                  <button
                    disabled={busy !== null}
                    aria-busy={busy === "portal"}
                    className={button}
                    onClick={() => void openBilling("portal")}
                  >
                    {busy === "portal" ? "Opening billing…" : "Manage billing or cancel"}
                  </button>
                )}
                {!billing.checkoutEnabled && !billing.paid && (
                  <p>Paid enrollment is not open yet.</p>
                )}
                <p>
                  After payment, access updates when confirmation arrives.{" "}
                  <button
                    className="text-scent-accent underline"
                    onClick={() => setRefresh((n) => n + 1)}
                  >
                    Refresh status
                  </button>
                </p>
              </div>
            )}
          </>
        )}
        {error && (
          <div role="alert" className="mt-6">
            <p>{error}</p>
            <button
              className="mt-3 text-scent-accent underline"
              onClick={() => setRefresh((n) => n + 1)}
            >
              Try again
            </button>
          </div>
        )}
      </main>
      <AppFooter />
    </>
  );
}
