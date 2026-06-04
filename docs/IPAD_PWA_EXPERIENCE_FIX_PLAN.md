# iPad PWA Experience Fix Plan

Date: 2026-06-04

## Purpose

Make the installed iPad PWA feel like a grounded app instead of a heavy website, while avoiding broad rewrites or risky payload changes.

This plan covers three observed failures:

1. Signed-in users who already completed the "Add 3" flow can still see the add-3 onboarding prompt.
2. Fast iPad scrolling can show black or late-painted content, plus intermittent yellow/blur artifacts around the Add to Vault area.
3. The Community button feels broken or painfully slow on iPad because the destination route is expensive to mount.

## Current Diagnosis

### Account and onboarding state

The dashboard currently uses live wardrobe count as the main gate:

- `artifacts/scent-cast/src/App.tsx`
  - `DashboardView`
  - add-3 prompt around `items.length === 0`
  - discover CTA around `items.length >= 3`
- `artifacts/scent-cast/src/context/WardrobeContext.tsx`
  - starts with `items = []`
  - loads `/api/wardrobe`
  - sets `wardrobeLoaded` after the request finishes
- `artifacts/scent-cast/src/context/AuthContext.tsx`
  - restores `scent_token`, `scent_email`, and `scent_picture` from local storage
- `artifacts/api-server/src/routes/wardrobe.ts`
  - `/api/wardrobe` returns rows owned by the bearer token user
- `artifacts/api-server/src/middlewares/auth.ts`
  - maps bearer token to `public.users.token`
- `docs/AUTH_FLOW_MAP.md`
  - documents why old `public.users.id` and `public.users.token` must be preserved

Risk: a signed-in user can briefly or permanently see the wrong onboarding state if wardrobe loading is pending, slow, unauthorized, or returns an empty array. There is no durable "this user already completed onboarding" state separate from the current item count.

### iPad rendering and scroll behavior

The app has several layers that are individually reasonable but heavy together on iPad Safari:

- `artifacts/scent-cast/src/components/BottleImage.tsx`
  - lazy image loading
  - async decode
  - packshot proxy/direct URL normalization
  - image opacity transition after load
- `artifacts/scent-cast/src/components/Wardrobe.tsx`
  - lower shelves lazy-load images
  - scroll-revealed card motion
- `artifacts/scent-cast/src/components/threads/ThreadBackground.tsx`
  - global fixed animated background
  - requestAnimationFrame writes to many DOM thread elements
- `artifacts/scent-cast/src/components/threads/ThreadBackground.css`
  - fixed full-screen paint layer
  - blurred pseudo-elements
  - transform and opacity compositing hints
- `artifacts/scent-cast/src/index.css`
  - remaining `backdrop-filter` glass layers
  - layered gold CTA styles
  - button filters, gradients, pseudo-elements, and transitions
- `artifacts/scent-cast/src/components/FragranceCapture.tsx`
  - Add to Vault/search UI combines glass panels, gradients, and the gold CTA
- `docs/IPAD_FREEZE_DEVICE_TEST_PROTOCOL.md`
  - existing device test protocol for iPad freeze behavior
- `docs/THREAD_BACKGROUND_VISUAL_HANDOFF.md`
  - prior handoff documenting unresolved iPad thread background concerns

Risk: fast iPad scroll can outrun paint/decode/compositing. The black flashes are likely late-painted tiles or dropped presentation frames. The yellow blur is likely a partially presented gradient/filter/glass layer around the CTA before the final content catches up.

### Community route behavior

The Community nav is simple, but the target route is heavy:

- `artifacts/scent-cast/src/components/AppTopNav.tsx`
  - Community is a normal `NavLink`
- `artifacts/scent-cast/src/App.tsx`
  - `/community` route
  - global `ThreadBackground`
  - global `PageTransitionOverlay`
- `artifacts/scent-cast/src/pages/community.tsx`
  - fetches community fragrances
  - renders marquee plus featured grid
- `artifacts/scent-cast/src/components/community/communityData.ts`
  - React Query fetch for `/api/community/fragrances`
- `artifacts/api-server/src/routes/community.ts`
  - default limit is 48
  - backend aggregates recent visible/shared wardrobe rows
- `artifacts/scent-cast/src/components/community/BottleMarquee.tsx`
  - `COMMUNITY_TRACK_COPIES = 3`
  - 48 API items can become 144 marquee card instances
- `artifacts/scent-cast/src/components/community/FeaturedCaseGrid.tsx`
  - renders more cards/images from the same data
- `artifacts/scent-cast/src/components/community/CommunityFragranceCard.tsx`
  - individual card render surface
- `artifacts/scent-cast/src/components/PageTransitionOverlay.tsx`
  - full-screen transition overlay for every path change

Risk: a Community tap triggers navigation, route transition animation, global background animation, API fetch, many bottle cards, many image decodes, marquee animation, and grid layout at the same time. On iPad that can look like the button failed even if routing started.

## Guardrails

- Do not change `/api/wardrobe` response shape unless every caller and test is updated in the same change.
- Preserve existing `public.users.id` and `public.users.token` behavior.
- Keep feature changes small and separately testable.
- Prefer additive backend fields/endpoints before changing existing contracts.
- Use iPad-specific fallbacks only where the browser/device class is the proven bottleneck.
- Keep visual identity, but reduce real-time filters, fixed layers, and duplicated image surfaces on iPad PWA.

## Phase 0: Measurement and Safety Harness

Goal: capture baseline behavior before fixes and make future regressions obvious.

Tasks:

- Run the existing iPad freeze protocol on the installed PWA:
  - `/debug/ipad-freeze?mode=production`
  - `/debug/ipad-freeze?mode=dom`
  - `/debug/ipad-freeze?mode=canvas`
- In the installed iPad PWA, capture the authenticated result of:
  - `/api/wardrobe`
  - `/api/community/fragrances`
  - any new app-state endpoint added in Phase 1
- Add a temporary debug-only session panel or console trace for:
  - has auth token
  - wardrobe request status
  - wardrobe item count
  - onboarding completed state
  - discovery ready state
- Record baseline route timings:
  - first dashboard paint after PWA open
  - first correct CTA state
  - Community tap to first stable content
  - Community tap to route fully idle
- Add tests before behavior changes where practical.

Primary file refs:

- `artifacts/scent-cast/src/pages/ipad-freeze-lab.tsx`
- `artifacts/scent-cast/src/App.tsx`
- `artifacts/scent-cast/src/context/AuthContext.tsx`
- `artifacts/scent-cast/src/context/WardrobeContext.tsx`
- `artifacts/scent-cast/src/components/PageTransitionOverlay.tsx`
- `docs/IPAD_FREEZE_DEVICE_TEST_PROTOCOL.md`

Definition of done:

- A short baseline note exists with iPadOS version, PWA or Safari context, route timings, and whether `/api/wardrobe` returns `401`, `200 []`, or `200 [items]` in the installed PWA.

## Phase 1: Fix Account and Onboarding Correctness

Goal: a signed-in user who completed onboarding never sees the add-3 ordeal again because of a loading race or temporary empty wardrobe state.

Recommended approach:

1. Add durable user progress state.
   - Prefer `public.user_settings` over `public.users` so auth identity remains stable and progress belongs with user preferences.
   - Add fields such as:
     - `wardrobe_onboarding_completed boolean not null default false`
     - `wardrobe_onboarding_completed_at timestamptz null`
   - Backfill to `true` for users with at least 3 `user_fragrances` rows.

2. Add an additive app-state endpoint.
   - Example: `GET /api/me/app-state`
   - Return:
     - `authenticated`
     - `wardrobeCount`
     - `wardrobeLoaded`
     - `wardrobeOnboardingCompleted`
     - `discoveryReady`
   - Keep `/api/wardrobe` returning the existing wardrobe array.

3. Mark onboarding complete when the user reaches 3 saved fragrances.
   - Backend should be the source of truth.
   - Frontend can optimistically hide onboarding after successful save, then reconcile with server.

4. Split UI states.
   - `loading`: do not show add-3 or discover yet; show stable app shell.
   - `new user`: show add-3 flow only when authenticated state is known and onboarding is false.
   - `completed user`: show Discover Your Signature Scent CTA even if wardrobe data is still hydrating.
   - `auth invalid`: show a clear sign-in recovery state rather than silently dropping to onboarding.

5. Add fallback local marker only as a temporary UX guard.
   - Example local key: `scent_onboarding_completed`.
   - Use it only to prevent flicker while server state loads.
   - Server state wins once available.

Primary file refs:

- `supabase/migrations/`
- `lib/db/src/schema/userSettings.ts`
- `lib/db/src/schema/index.ts`
- `artifacts/api-server/src/routes/wardrobe.ts`
- `artifacts/api-server/src/routes/oauth.ts`
- `artifacts/api-server/src/middlewares/auth.ts`
- `artifacts/scent-cast/src/context/AuthContext.tsx`
- `artifacts/scent-cast/src/context/WardrobeContext.tsx`
- `artifacts/scent-cast/src/App.tsx`
- `artifacts/scent-cast/src/components/FragranceCapture.tsx`
- `docs/AUTH_FLOW_MAP.md`
- `docs/DATABASE_USAGE_MAP.md`

Test refs:

- `artifacts/api-server/src/test-db.ts`
- `artifacts/scent-cast/src/lib/wardrobeReconcile.test.ts`
- add or extend frontend tests for dashboard CTA state if the test harness supports React component tests

Definition of done:

- Existing signed-in users with 3 or more saved fragrances go straight to the completed/discover state.
- A slow `/api/wardrobe` response does not flash the add-3 prompt.
- A `401` wardrobe response produces an auth recovery state, not misleading onboarding.
- New users still see the add-3 flow.

## Phase 2: Reduce iPad Scroll Paint Pressure

Goal: make fast scrolling on iPad PWA stop exposing black tiles, late image paint, or blurred CTA artifacts.

Recommended approach:

1. Add a runtime platform/render-budget helper.
   - Detect installed iPad PWA and reduced-motion conditions.
   - Expose a conservative `lowMotionRenderMode` or `isIpadStandalone` flag.
   - Avoid scattering user-agent checks through components.

2. Make the global background cheaper on iPad PWA.
   - Disable `ThreadBackground` on known-problem paths or in iPad standalone mode.
   - Or render a static background instead of per-frame DOM transforms.
   - Pause animation while high-velocity scrolling.

3. Reduce expensive filters in scrolling surfaces.
   - Remove or lower `backdrop-filter` on sticky/top/search surfaces for iPad PWA.
   - Avoid blur/filter/drop-shadow transitions on the Add to Vault CTA while scrolling.
   - Keep solid fallback backgrounds so late image paint does not reveal black.

4. Make image loading less bursty.
   - Eager-load the first visible shelf and prefetch the next shelf with `IntersectionObserver`.
   - Use larger root margins for iPad so images begin decoding before they enter view.
   - Keep async decoding where safe, but avoid opacity-only reveal over black placeholders.
   - Audit `clip-path` and `will-change` on bottle images. Keep them only where they measurably help.

5. Reduce motion during scroll.
   - Avoid `whileInView` card motion on iPad PWA or while scroll velocity is high.
   - Do not run route transition, marquee, and thread animation at the same time on iPad.

Primary file refs:

- `artifacts/scent-cast/src/components/threads/ThreadBackground.tsx`
- `artifacts/scent-cast/src/components/threads/ThreadBackground.css`
- `artifacts/scent-cast/src/components/BottleImage.tsx`
- `artifacts/scent-cast/src/components/Wardrobe.tsx`
- `artifacts/scent-cast/src/components/FragranceCapture.tsx`
- `artifacts/scent-cast/src/components/PageTransitionOverlay.tsx`
- `artifacts/scent-cast/src/index.css`
- `artifacts/scent-cast/src/App.tsx`
- suggested new helper: `artifacts/scent-cast/src/lib/platform.ts`
- suggested new helper: `artifacts/scent-cast/src/hooks/useRenderBudget.ts`

Definition of done:

- Fast fling-scroll on the installed iPad PWA no longer shows full black frames.
- Add to Vault/search area does not smear into a yellow/blurred placeholder while returning upward.
- The app still looks like ScentBeam, just with fewer real-time effects on constrained iPad rendering.

## Phase 3: Make Community Navigation Feel Immediate

Goal: tapping Community should feel responsive, and the route should not mount hundreds of image surfaces at once.

Recommended approach:

1. Make navigation acknowledge immediately.
   - Keep `NavLink`, but ensure the active state or route shell appears right away.
   - Consider disabling the full-screen transition overlay for `/community` on iPad PWA.

2. Shrink initial Community payload and render count.
   - Request a smaller initial limit, such as 12 or 16.
   - Add "load more" or lazy continuation after the first stable paint.
   - Keep backend max limits for desktop if useful, but avoid 48 as the first iPad render.

3. Reduce marquee duplication.
   - Change `COMMUNITY_TRACK_COPIES = 3` to a responsive value.
   - On iPad PWA, render fewer items or a static carousel row first.
   - Start marquee animation after images are decoded or after idle.

4. Defer non-critical content.
   - Render page shell and first row first.
   - Defer grid cards below the fold.
   - Lazy-load overlays and detail content.

5. Improve server and client caching.
   - Add short CDN caching for public community data where safe.
   - Example: `s-maxage=60, stale-while-revalidate=300`
   - Keep React Query stale time aligned with backend cache.

Primary file refs:

- `artifacts/scent-cast/src/components/AppTopNav.tsx`
- `artifacts/scent-cast/src/App.tsx`
- `artifacts/scent-cast/src/pages/community.tsx`
- `artifacts/scent-cast/src/components/community/communityData.ts`
- `artifacts/scent-cast/src/components/community/BottleMarquee.tsx`
- `artifacts/scent-cast/src/components/community/FeaturedCaseGrid.tsx`
- `artifacts/scent-cast/src/components/community/CommunityFragranceCard.tsx`
- `artifacts/scent-cast/src/components/community/CommunityFragranceOverlay.tsx`
- `artifacts/scent-cast/src/components/PageTransitionOverlay.tsx`
- `artifacts/api-server/src/routes/community.ts`
- `artifacts/scent-cast/src/index.css`

Definition of done:

- Community tap gives visible route feedback in under 100 ms.
- First meaningful Community content appears without waiting for the full marquee/grid to decode.
- iPad PWA does not lock up when going Community to Home or Home to Community.

## Phase 4: PWA Polish and Session Recovery

Goal: make the installed app feel intentionally app-like without adding risky offline behavior too early.

Recommended approach:

1. Keep service worker work separate.
   - The current app appears to be manifest-only.
   - Do not add aggressive caching until auth and rendering fixes are stable.
   - If a service worker is added later, start with app-shell asset caching only. Avoid caching authenticated API responses.

2. Add session-health behavior.
   - On app boot, distinguish:
     - no token
     - token present and valid
     - token present but unauthorized
     - network unavailable
   - Do not silently convert token problems into onboarding.

3. Add route/data prefetch where it is safe.
   - Prefetch Community data on idle after dashboard settles.
   - Prefetch the next shelf of wardrobe images.
   - Do not block the initial dashboard CTA state on non-critical prefetch.

Primary file refs:

- `artifacts/scent-cast/public/site.webmanifest`
- `artifacts/scent-cast/src/main.tsx`
- `artifacts/scent-cast/src/App.tsx`
- `artifacts/scent-cast/vite.config.ts`
- `artifacts/scent-cast/package.json`
- `middleware.js`
- `artifacts/scent-cast/src/lib/apiBase.ts`
- `artifacts/scent-cast/src/components/community/communityData.ts`
- `artifacts/scent-cast/src/context/AuthContext.tsx`
- `artifacts/scent-cast/src/context/WardrobeContext.tsx`

Definition of done:

- Installed PWA boot has stable auth/session semantics.
- The app does not show misleading onboarding during network or auth uncertainty.
- Any service worker change is opt-in, small, and tested separately.

## Phase 5: Validation Checklist

Run these before shipping:

- `pnpm --filter @workspace/scent-cast build`
- `pnpm --filter @workspace/scent-cast test` if available
- `pnpm --filter @workspace/api-server test` if available
- local browser smoke test:
  - `/`
  - `/community`
  - `/debug/ipad-freeze`
  - sign-in restore path
  - add fragrance path
  - delete or empty wardrobe edge case
- physical iPad PWA smoke test:
  - cold open installed app
  - signed-in completed user sees Discover state
  - fast scroll down and back up
  - Add to Vault/search area does not smear
  - Community tap and return Home
  - screen recording for before/after comparison
- production canary after deploy:
  - `/api/wardrobe` authenticated behavior
  - `/api/community/fragrances` latency and item count
  - main JS/CSS asset size

## Suggested Implementation Order

1. Phase 0 baseline capture.
2. Phase 1 backend state migration and app-state endpoint.
3. Phase 1 frontend CTA gating fix.
4. Phase 2 iPad render-budget helper and background/transition reductions.
5. Phase 2 image and scroll paint improvements.
6. Phase 3 Community initial render reduction.
7. Phase 3 Community prefetch/caching.
8. Phase 4 PWA/session polish.
9. Full Phase 5 validation.

## Release Strategy

- Ship account-state fixes first because they correct misleading UX and are easier to test.
- Ship iPad render changes behind a runtime guard or a tiny local feature flag first.
- Ship Community reduction separately so route performance regressions are easy to attribute.
- Avoid bundling service worker changes with these fixes.

## Success Criteria

- Completed users never see the add-3 ordeal because of loading, iPad storage, or empty initial state.
- The dashboard remains visually stable during wardrobe hydration.
- Fast iPad PWA scrolling has no black full-screen flashes.
- The Add to Vault/search area stays visually coherent during upward scroll.
- Community navigation responds immediately and does not make the app feel locked.
- Desktop and mobile behavior remain functionally unchanged except for intentional performance improvements.

