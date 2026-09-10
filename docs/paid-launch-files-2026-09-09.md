# Paid-launch implementation manifest

All paths below are relative to `C:/Users/urban/my_project_workspace/huge_monorepo`. Existing untracked work was left untouched. No commit, deployment, live database migration, customer message, or payment was made.

| Changed file | Purpose |
|---|---|
| `.env.example` | Disabled-by-default enrollment, confirmed-terms flag, Stripe setup, zero/unconfigured cost reservations, free/paid allowance settings. |
| `artifacts/api-server/package.json` | Official Stripe SDK dependency. |
| `pnpm-lock.yaml` | Locked Stripe 22.6.1; no unrelated package upgrades. |
| `lib/db/src/schema/billing.ts` | Billing accounts, durable event IDs, monthly reservation counters. |
| `lib/db/src/schema/index.ts` | Export new schema to runtime and migration generator. |
| `lib/db/migrations/0006_perfect_juggernaut.sql` | Generated additive tables, foreign keys, unique customer index. Reviewed: no drops or destructive updates. |
| `lib/db/migrations/meta/0006_snapshot.json` | Generated schema snapshot. |
| `lib/db/migrations/meta/_journal.json` | Register migration 0006. |
| `artifacts/api-server/src/services/launchPolicy.ts` | Cost-bearing route classification, allowances, reservation validation, access expiration. |
| `artifacts/api-server/src/services/launchUsageCore.ts` | Transactional global/per-user reservation SQL; integer currency units. |
| `artifacts/api-server/src/services/billingStripe.ts` | Stripe client, fixed-origin redirects, checkout gate, paid-invoice access rules. |
| `artifacts/api-server/src/services/billingEventCore.ts` | Actual duplicate-safe, locked webhook update logic shared with integration tests. |
| `artifacts/api-server/src/middlewares/launchGate.ts` | Optional authenticated monthly limits and web-request spending pause; fail-closed accounting. |
| `artifacts/api-server/src/routes/billing.ts` | Status, hosted checkout, customer portal, signature verification and reconciliation. |
| `artifacts/api-server/src/routes/health.ts` | Non-secret version/configuration endpoint. |
| `artifacts/api-server/src/routes/me.ts` | Lock account deletion against checkout, expire pending checkout, cancel subscriptions before removing customer mapping. |
| `artifacts/api-server/src/app.ts` | Raw webhook parsing before JSON, billing routes before cost gate, expose budget-control response header. |
| `artifacts/api-server/src/services/launchPolicy.test.ts` | Access expiry/status/price, malformed configuration, route coverage, signature tampering/replay tests. |
| `artifacts/api-server/src/test-support/launchUsage.integration.test.ts` | Migrated SQL quota and rollback tests; actual webhook processor failure, duplicate, stale-delivery tests. |
| `artifacts/scent-cast/src/pages/billing.tsx` | Plan/allowance display, hosted checkout, billing management/cancellation, refresh/error states. |
| `artifacts/scent-cast/src/App.tsx` | Lazy billing route. |
| `artifacts/scent-cast/src/components/AppFooter.tsx` | Reachable billing link. |
| `artifacts/scent-cast/src/lib/launchFetch.ts` | App-origin-only session headers for newly metered requests. |
| `artifacts/scent-cast/src/lib/launchFetch.test.ts` | Prevent credentials reaching external engine/assets; preserve explicit authorization. |
| `artifacts/scent-cast/src/lib/fragranceApi.ts` | Use session-aware requests and stop direct-engine fallback after enforced accounting responses. |
| `artifacts/scent-cast/src/lib/fragranceApi.test.ts` | Regression for budget-stop fallback bypass. |
| `artifacts/scent-cast/src/components/FragranceCapture.tsx` | Import scoped session-aware request helper. |
| `artifacts/scent-cast/src/components/Wardrobe.tsx` | Import scoped session-aware request helper for image requests. |
| `artifacts/scent-cast/src/context/WardrobeContext.tsx` | Import scoped session-aware request helper for profile requests. |
| `docs/paid-launch-2026-09-09.md` | Current evidence, cost caveats, external blockers, activation steps, pilot invitation and measurement plan. |
| `docs/paid-launch-files-2026-09-09.md` | This file manifest and verification record. |

## Commands and outcomes

- `corepack pnpm --filter @workspace/api-server add stripe`: succeeded. Existing esbuild-plugin-pino peer-version warning was reported; no unrelated dependency upgrade was performed.
- `corepack pnpm --filter @workspace/db run generate`: succeeded using a dummy local URL for generation only, without connecting/migrating production. Generated additive migration reviewed.
- `corepack pnpm run typecheck:libs`: passed.
- `node --experimental-strip-types --test artifacts/api-server/src/services/launchPolicy.test.ts artifacts/api-server/src/test-support/launchUsage.integration.test.ts artifacts/api-server/src/test-support/authQueries.integration.test.ts`: 15 passed, zero failures at that revision.
- `node --experimental-strip-types --test artifacts/scent-cast/src/lib/launchFetch.test.ts artifacts/scent-cast/src/lib/fragranceApi.test.ts artifacts/scent-cast/src/lib/wardrobeImageRecovery.test.ts`: initially caught an incomplete test-window assumption in the new request helper. Fixed; rerun passed 62 tests, zero failures.
- After the real webhook processor and budget-fallback regression were added: `node --experimental-strip-types --test artifacts/api-server/src/services/launchPolicy.test.ts artifacts/api-server/src/test-support/launchUsage.integration.test.ts artifacts/scent-cast/src/lib/launchFetch.test.ts artifacts/scent-cast/src/lib/fragranceApi.test.ts`: 67 passed, zero failures. Counts overlap previous runs; do not add the totals.
- `corepack pnpm --filter @workspace/api-server run typecheck`: passed.
- `corepack pnpm --filter @workspace/scent-cast run typecheck`: passed.
- `corepack pnpm --filter @workspace/api-server run build`: passed.
- `corepack pnpm --filter @workspace/scent-cast run build`: passed, including service worker generation. Existing inlineDynamicImports deprecation warning remains.
- Scoped ESLint on new runtime files: zero errors; one warning that the DB schema path has no matching lint configuration. Schema was covered by typechecking, migration generation, and SQL tests.
- Prettier applied only to newly created TypeScript files. No broad reformat of existing components.
- `git diff --check`: passed.
- Production HTTP health/readiness/unauthenticated wardrobe, Railway deployment metadata/configuration-name checks, and aggregate read-only SQL: findings recorded in the launch record. No private keys/tokens or individual customer records were printed.

## Limits of verification

### Resumed task verification — September 9, 2026

Located the original work in `C:/Users/urban/my_project_workspace/huge_monorepo`, on `main` at `ceeee10`, with uncommitted launch changes. The originating task is “Complete responsible launch sequence”; it ended at a usage limit.

Additional changes:

- `artifacts/api-server/src/services/billingStripe.ts`: enrollment readiness now validates nonblank Stripe settings, billing origin, positive spending reservations/global budget, and valid allowance settings. Incomplete configuration reports enrollment closed to both the billing page and checkout endpoint.
- `artifacts/api-server/src/services/launchPolicy.test.ts`: adds configured enrollment and 12 invalid/disabled configuration cases.
- `artifacts/scent-cast/src/pages/billing.tsx`: keeps subscription enrollment reachable for unpaid customers who already have a Stripe customer mapping, including abandoned checkout. The server still rejects duplicate subscriptions; Manage billing remains available.
- This report records the continuation and verification.

Commands and outcomes for this continuation:

- `node --experimental-strip-types --test artifacts/api-server/src/services/launchPolicy.test.ts artifacts/api-server/src/test-support/launchUsage.integration.test.ts artifacts/scent-cast/src/lib/launchFetch.test.ts artifacts/scent-cast/src/lib/fragranceApi.test.ts`: 68 passed, zero failed.
- `corepack pnpm --filter @workspace/api-server run typecheck` and the equivalent `@workspace/scent-cast` command: both passed.
- `corepack pnpm --filter @workspace/api-server run build` and the equivalent `@workspace/scent-cast` command: both passed, including service worker generation. Node URL parsing and service-worker inlineDynamicImports deprecation warnings remain.
- `git diff --check`: passed.
- Read-only Railway metadata/configuration-presence checks: production remains on deployment `e5b18bfc-7381-4af7-ae95-f1e246e11b97`, August 11 commit `ade631e981cdb13d0af03e39c77b66af57dde5a3`. Stripe key, price, webhook secret, launch-limit flag, and enrollment flag remain absent. No secret values were printed.

No deployment, database migration, charge, invitation, or extra browser scenario suite was performed. The checkout visibility change was checked through source review, typechecking, and the production build; live abandoned-checkout recovery remains unverified. External launch inputs listed in the launch record are still needed.

No browser scenario suite, live Google sign-in, current backup restore, Sentry dashboard event receipt, live Stripe checkout/renewal/cancellation/deletion, provider invoice reconciliation, or external-engine/worker spending-stop verification was completed. Payment and deletion behavior needs end-to-end Stripe test-mode validation before deployment/activation. Postgres tests exercise transactions and shared counters but do not simulate multiple independent production replicas. A server spending pause cannot reverse already-started provider calls or stop unrelated hosting charges.

Legal source text was intentionally left unchanged because its required business facts and licensing rights were not provided. Checkout remains disabled. See the launch record for the specific external inputs required to finish.
