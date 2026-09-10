# TheScentBeam paid-launch record — September 9, 2026

Status: **not cleared for a paid launch**. The local billing/allowance implementation is disabled by default and has not been deployed. No customers have been charged or contacted.

## Current production evidence

Read-only checks on September 9, 2026:

- `https://scentbeam.com/`: HTTP 200.
- `/api/healthz`: HTTP 200, `status=ok`.
- `/api/readyz`: HTTP 200, database and Redis both `ok`.
- `/api/wardrobe` without credentials: HTTP 401.
- `/api/me` is not a registered route. Production returns HTML/200 for it. The current checkout already has a JSON API-404 fallback, so this is deployment drift, not a newly introduced source fix.
- Railway `sCAST` active deployment: `e5b18bfc-7381-4af7-ae95-f1e246e11b97`, August 11, 2026, commit `ade631e981cdb13d0af03e39c77b66af57dde5a3`.
- Local starting commit: `ceeee10617e51d3741069b39d73feb1458ad1c6d`, September 4, 2026. A current build is not evidence that production runs this commit.
- Railway server and client Sentry DSNs are configured. Delivery of a fresh error to the Sentry dashboard is **unverified**.
- No Stripe configuration found on `sCAST`.
- Application database was verified as `scast_api_restored` using the Postgres service's public transport and the application's configured database name. Only aggregate SELECTs inside a read-only transaction were used; no customer records were printed or modified.
- Registered accounts: **5**. Accounts with session `last_used_at` within 30 days: **1**. This is an activity proxy, not a complete analytics count.
- Saved fragrance rows: **24**, belonging to **4** collectors.
- Last 30 days' existing usage ledger: **2 Beam runs, $0.006793 estimated total**. No other provider/operation rows in that window. This is incomplete instrumentation, not proof that other costs were zero.

Still required: one current Google sign-in/logout round trip with a consenting test account, save/reload/export of a test collection, two-account live isolation checks, a staging restore from a current production backup, and a confirmed Sentry test-event receipt. July reports are historical only. Automated SQL authentication/isolation checks passed locally against the migrated schema; they do not substitute for these live checks.

## Implemented locally

- Hosted Stripe checkout with a server-selected, validated $9 USD/month price; customer portal for cancellation and payment-method recovery.
- Bearer-authenticated, tenant-scoped billing state. Checkout redirects never grant access.
- Signed raw-body webhooks. Current subscription state is fetched while holding the billing-account row lock; event IDs and access changes commit together. Failed transactions remain retryable. Duplicate deliveries do not repeat access changes.
- Paid access requires an active subscription, the configured price, a paid latest invoice, and an unexpired period. Trials, delinquency, incomplete payments, paused or canceled subscriptions do not grant paid allowances. Scheduled end-of-period cancellation retains access until the paid period ends.
- Duplicate checkout protection uses the account lock, existing-subscription check, reuse of open checkout sessions, and Stripe idempotency keys.
- Account deletion expires open checkout sessions and cancels subscriptions before deleting its customer mapping. A provider failure keeps the account intact. Stripe cancellation cannot be rolled back if the subsequent database deletion fails; retrying deletion remains necessary in that case.
- Monthly per-account allowances and a shared cross-tenant reservation budget use integer microdollars and a database transaction lock. Missing/invalid reservation configuration fails closed when enabled.
- A web-request spending pause leaves saved collections and billing cancellation available. An enforced-budget response prevents the normal client from falling back directly to the engine after that response.
- Billing page shows current allowance use, paid-plan allowances, enrollment status, and cancellation access. Session headers are attached only to the app API, never to the external engine.
- `/api/version` exposes the deployed commit and non-secret configuration status for future baseline checks.

## Cost controls: what they do and do not prove

Default proposed monthly allowances (tunable, **not established as profitable**):

| Plan | AI requests | Search/profile requests | Image requests |
|---|---:|---:|---:|
| Free signed-in | 5 | 20 | 0 |
| $9 collector | 40 | 200 | 2 |

Enabling limits changes cost-bearing guest requests to require sign-in. Preserve existing guest behavior until this rollout decision is accepted. Multiple API calls from one user action can consume multiple allowances; cached/in-flight coalescing can reduce calls. Failed requests remain reserved because provider work may already have happened. Calendar-month UTC resets are separate from Stripe renewal dates.

All cost reservations and the global dollar budget default to **zero/unconfigured**, not made-up prices. Before enabling, measure provider invoice deltas for representative and worst-case requests, including image input tokens, retries, search fan-out, cache misses, background work, and hosting/storage/egress. Configure per-feature conservative reservations only after this measurement.

**The reservation budget is not a hard cap on total provider invoices.** Existing background workers, Beam MCP, the public external Python engine, direct-engine clients, weather, image serving, and hosting charges can operate outside this gate. Existing daily Beam limits remain in place. Lock down the external engine and set independent provider/project hard caps or prepaid credits; add the same durable reservation contract to worker/MCP entrypoints before claiming a service-wide automatic spending stop. The external Python engine source is outside this checkout.

For a $9 subscription, contribution before fixed costs is:

`9 - actual payment fees - AI/search/image variable cost - variable hosting/support cost`

`break-even subscribers = ceil((fixed costs + free-user costs) / positive per-paid-user contribution)`

100 subscribers provide $900 gross monthly revenue. Obtain actual Stripe fee terms, Railway, AWS, database, image, search, and model bills before estimating profit. Do not substitute the $0.006793 partial ledger for those bills.

## Payment activation checklist

1. Confirm the business, support inbox, refund/cancellation policy, data/image rights, and final legal text. Set `LAUNCH_TERMS_CONFIRMED=true` only after those facts are resolved.
2. Configure Stripe in test mode: secret key, matching webhook secret, and an active USD 900-cent recurring monthly price. Configure the customer portal to permit cancellation and payment-method updates; configure Stripe's required public terms URL.
3. Register `/api/billing/webhook` for subscription lifecycle events, `invoice.paid`, `invoice.payment_failed`, `invoice.payment_action_required`, and `checkout.session.completed`. The SDK version installed is recorded in the lockfile; align the webhook endpoint API version with it.
4. Run a test checkout, required payment authentication, renewal, payment failure/recovery, immediate and end-of-period cancellation, duplicate/out-of-order events, and account deletion. Verify webhook delivery and database access status. These live Stripe scenarios are outstanding because no Stripe account configuration was available.
5. Apply the reviewed additive migration through the existing migration runner to an explicitly verified staging target; deploy the API and frontend together there. Do not use schema push/force. Verify the new `/api/version` against the release commit.
6. Measure/configure reservation values and provider caps. Run one representative production smoke test after deployment; keep checkout closed during baseline verification.
7. Switch to matching live credentials/webhook/price only after the test evidence passes. Set `BILLING_CHECKOUT_ENABLED=true` last. `LAUNCH_LIMITS_ENABLED=true` is required for checkout. Do not activate with unknown legal or cost inputs.

## Customer-facing facts still needed

The legal source remains explicitly provisional; its warning was not removed to manufacture clearance. Needed: actual contracting entity and location/jurisdiction, monitored support/privacy contact, retention specifics, cancellation timing, refund terms, and commercial licenses/permissions for every fragrance data/image source. Existing text such as `privacy@scentbeam.com` and the footer name is not proof that the mailbox or legal entity is correct. A citation or accessible image URL is not a commercial license.

## First 10–20 paying collectors

Start with 10 consenting collectors, then expand to 20 after the first week's findings. The four accounts with collections are potential discovery contacts, not automatically approved marketing recipients. No outreach has been sent and no contact list has been supplied.

For each demonstration: ask for three owned fragrances and an upcoming occasion; save their actual collection with consent; generate one recommendation; ask whether it is useful and why; explain price and limits; invite payment only after launch clearance. Follow up after seven days to ask whether they returned and what prevented use. Record cancellation reasons without pressuring anyone to stay.

Draft invitation (personalize before sending):

> Hi [name] — I'm inviting a small group of fragrance collectors to try TheScentBeam. I'd like to show you recommendations using fragrances you already own and hear what works or misses. Once the paid pilot opens, membership will be $9/month with clear usage limits and cancellation through your account. Would you be interested in a short collection walkthrough?

Track with participant codes rather than sensitive collection details:

| Collector | Invited | Demo | First useful recommendation / minutes | Returned in days 7–13 | Paid/date | Canceled/date/reason | 30-day attributable cost |
|---|---|---|---|---|---|---|---|
| P01–P20, one row each | pending | | | | | | |

Definitions: first useful recommendation = collector explicitly confirms usefulness; weekly return = authenticated activity on a different day in days 7–13 after demo; conversion = confirmed first paid invoice divided by demonstrated collectors; cancellation = recorded cancellation request with effective date and optional reason; cost/customer = attributable provider costs plus a stated allocation of shared costs. Report sample sizes alongside percentages. Defer ads until recurring use and positive contribution are demonstrated; this is a validation criterion, not a forecast.

## Verification and handoff

See `paid-launch-files-2026-09-09.md` for every changed file and its purpose. Final test/build results are recorded there. No extra browser scenario suite was run, per the user's instruction. Live sign-in, provider bills, backup restore, Stripe lifecycle tests, legal facts, commercial rights, external-engine protections, and recruiting remain unverified or blocked on external input. This record is not a launch approval.

Implementation references: [Stripe subscription events](https://docs.stripe.com/billing/subscriptions/webhooks), [signed webhooks and delivery behavior](https://docs.stripe.com/webhooks), [hosted checkout](https://docs.stripe.com/api/checkout/sessions/create), [customer portal](https://docs.stripe.com/api/customer_portal/sessions/create).
