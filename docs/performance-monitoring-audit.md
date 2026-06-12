# ScentCast Frontend Performance Audit

Date: 2026-06-12
App audited: `artifacts/scent-cast`
Local target: `http://127.0.0.1:5177` served with `vite preview` after a production build

## Executive Summary

The app is functional, but the current mobile lab results are not ready for a high-confidence production performance target. The main risk is client-side main-thread pressure: the initial app chunk is large, Lighthouse attributes long tasks to `assets/index-C7j2G1um.js`, and measured Total Blocking Time is high on all tested routes.

The local static preview handled 50 concurrent connections without HTTP errors, so the tested static shell did not show local serving failures. That does not prove production readiness for multiple concurrent real users because backend/API capacity, CDN behavior, authenticated data volume, and real-device INP require staging or production field data.

## Test Scope And Limits

Measured with:

- `corepack pnpm --filter @workspace/scent-cast run build`
- `npx --yes lighthouse@latest <route> --only-categories=performance --output=json`
- `npx --yes autocannon@latest -c 50 -d 15 --json http://127.0.0.1:5177/`
- Vite sourcemap build for local bundle attribution

Not proven by this audit:

- Real-user INP. Lighthouse navigation mode does not accurately measure field INP. INP must be collected with Web Vitals from real sessions or a controlled interaction test suite.
- Production PageSpeed Insights. PSI cannot audit `localhost`; it should be run against the deployed public URL after changes.
- Backend concurrency. The local static preview does not exercise authenticated API write paths, database locks, upstream image/search providers, or rate limits.
- Authenticated large-vault performance. The Lighthouse runs used unauthenticated route loads.

## Measured Lighthouse Results

Mobile Lighthouse performance-only runs:

| Route | Score | FCP | LCP | TBT | CLS | TTI | Main-thread work |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `/` | 55 | 4.0 s | 4.7 s | 760 ms | 0.027 | 7.7 s | 9.0 s |
| `/community` | 41 | 3.9 s | 5.2 s | 3,140 ms | 0.023 | 14.8 s | 15.1 s |
| `/arena` | 36 | 4.3 s | 6.2 s | 1,150 ms | 0.147 | 10.4 s | 10.9 s |

Key Lighthouse diagnostics:

- Initial JS: `assets/index-C7j2G1um.js`, 906.87 kB minified, 284.63 kB gzip.
- Initial CSS: `assets/index-FIzilqeZ.css`, 255.40 kB minified, 38.59 kB gzip.
- Unused initial JS estimate: 144-173 KiB wasted across tested routes.
- Long tasks: 20 long tasks found on each audited route, mostly attributed to `assets/index-C7j2G1um.js`.
- Main-thread breakdown is dominated by Style & Layout:
  - `/`: 5.95 s style/layout
  - `/community`: 8.59 s style/layout
  - `/arena`: 7.71 s style/layout

## Static Concurrency Check

`autocannon` against the local preview root with 50 concurrent connections for 15 seconds:

| Metric | Result |
| --- | ---: |
| Total requests | 11,093 |
| Average requests/sec | 739.54 |
| Average latency | 67.44 ms |
| p50 latency | 64 ms |
| p99 latency | 119 ms |
| Errors | 0 |
| Timeouts | 0 |
| Non-2xx | 0 |

Interpretation: local static HTML serving is not the immediate bottleneck. The bigger measured issue is each user's browser doing too much work after the shell arrives.

## Bundle Attribution

Sourcemap attribution for the initial chunk shows these large contributors by source content size:

| Source/package | Approx source content |
| --- | ---: |
| app code | 632.1 KiB |
| `react-dom` | 512.1 KiB |
| `react-router` | 361.1 KiB |
| `motion-dom` | 325.7 KiB |
| `framer-motion` | 117.1 KiB |
| `axios` | 117.5 KiB |
| `tailwind-merge` | 100.2 KiB |
| `@tanstack/query-core` | 59.2 KiB |

Largest app modules in the initial chunk:

| Module | Approx source content |
| --- | ---: |
| `src/components/Wardrobe.tsx` | 138.9 KiB |
| `src/components/NotePyramid.tsx` | 90.1 KiB |
| `src/context/WardrobeContext.tsx` | 68.2 KiB |
| `src/components/FragranceCapture.tsx` | 66.4 KiB |
| `src/lib/fragranceApi.ts` | 53.1 KiB |
| `src/App.tsx` | 45.2 KiB |

## Highest-Priority Improvements

### 1. Reduce Initial Main-Thread Work

Priority: P0
Confidence: high, based on Lighthouse long tasks, TBT, and bundle size.

Recommended actions:

- Lazily load below-the-fold and modal-heavy dashboard code. `App.tsx` statically imports `Wardrobe`, `FragranceCapture`, `ScentIntentModal`, `ScentNotesInfographic`, `ShareModal`, and `ProfileSettingsModal`. Keep the first interactive search shell fast, but move detail-heavy surfaces into dynamic chunks.
- Split the heavy `Wardrobe.tsx` detail overlay path from the initial vault grid. `NotePyramid.tsx`, `ReviewsPanel.tsx`, bottle image tooling, and recommendation detail UI should not all be required before the first route becomes responsive.
- Replace simple `framer-motion` transitions on always-loaded shell UI with CSS transitions where practical. `framer-motion` is imported in `App.tsx`, `Wardrobe.tsx`, `FragranceCapture.tsx`, `NotePyramid.tsx`, and multiple modal/loader components, pulling animation runtime into early execution.
- Add `build.rollupOptions.output.manualChunks` so stable vendor code can be cached separately. This will not by itself remove TBT, but it will reduce repeated update cost and make bundle ownership clearer.

Target after this work:

- Mobile TBT under 200 ms on `/`
- Initial gzip JS under 170 KiB for first route shell
- No route should show 20 Lighthouse long tasks on first load

### 2. Attack Style/Layout Cost

Priority: P0
Confidence: high, based on 5.95-8.59 s style/layout in Lighthouse.

Recommended actions:

- Reduce always-running marquee/background measurement work before first interaction. Current code uses repeated `getBoundingClientRect`, `ResizeObserver`, `requestAnimationFrame`, and animated thread backgrounds in `App.tsx`, `useMarqueeSwipe.ts`, `ThreadBackground.tsx`, and `BottleMarquee.tsx`.
- Gate decorative motion by viewport and route criticality. The global `ThreadBackground` renders for every non-debug route from `AppShell`; defer it until after first content has painted or disable it during mobile initial load.
- Add `content-visibility: auto` with `contain-intrinsic-size` to large below-the-fold sections such as the vault grid and community feed cards. This should reduce initial layout work without changing UX.
- Audit broad CSS selectors and large generated utility output. The CSS file is 255.40 kB minified. Even though gzip is moderate, style recalculation is showing up as the dominant CPU cost.

### 3. Fix Route-Specific Hotspots

Priority: P0/P1

`/community`:

- Worst measured TBT: 3,140 ms.
- Loads the initial chunk plus `community-BGSHGisk.js` and `communityPosts-DgZsV774.js`.
- Defer composer, filters, overlays, and reaction/comment mutation code until visible or needed. Keep the first feed read path lean.

`/arena`:

- Worst measured CLS: 0.147.
- Reserve stable dimensions for arena battle assets and result areas before async data/image load.
- Audit any initial animation/layout transitions that move content after first paint.

`/`:

- Dashboard TBT is still 760 ms before authenticated vault data is loaded.
- Defer `Wardrobe` below the hero/search surface, or render a lightweight vault shell first and hydrate the full grid after idle/visibility.

### 4. Remove Avoidable Initial Dependencies

Priority: P1
Confidence: medium-high from sourcemap attribution; exact savings should be verified after each change.

Recommended actions:

- Replace `axios` usage in `WeatherContext.tsx` with `fetch` plus abort handling. The app uses `axios` only for weather fetches, but sourcemap attribution shows `axios` in the initial bundle.
- Check whether `react-router` can be trimmed through import patterns and route structure. It is expected to be present, but it is large enough to keep visible in bundle tracking.
- Keep `recharts`, `cmdk`, `vaul`, carousel, and heavy Radix components out of initial imports unless a currently rendered component needs them.

### 5. Add Real Web Vitals Monitoring

Priority: P0 before launch
Confidence: high; lab INP is not enough.

Recommended implementation:

- Add the `web-vitals` package and report `onFCP`, `onLCP`, `onCLS`, and `onINP`.
- Include route, app version/build SHA, device class, connection type, auth/guest status, and coarse vault size bucket.
- Send metrics with `navigator.sendBeacon` to an ingestion endpoint, or to an analytics provider that can preserve p75 by route.
- Track p75 and p95, not averages. Production target should be p75 INP under 200 ms.
- Add alert thresholds:
  - p75 FCP > 1.8 s
  - p75 LCP > 2.5 s
  - p75 INP > 200 ms
  - p75 CLS > 0.1
  - JS error rate > 0.5% of sessions

### 6. Add Performance Budgets To CI

Priority: P1

Recommended actions:

- Add Lighthouse CI against production build preview for `/`, `/community`, and `/arena`.
- Fail CI when initial route JS exceeds the agreed budget or TBT regresses by more than a small threshold.
- Persist Lighthouse JSON artifacts so regressions can be compared over time.
- Keep the route list targeted; do not add broad browser scenario tests unless a specific regression needs them.

### 7. Validate Multi-User Readiness In Staging

Priority: P0 before launch
Confidence: local frontend checks cannot prove this alone.

Recommended staging tests:

- Use `k6`, `artillery`, or `autocannon` against a staging deployment, not production, with realistic authenticated flows.
- Cover read-heavy and write-heavy paths separately:
  - initial shell and static assets
  - `/api/me/app-state`
  - `/api/wardrobe`
  - `/api/share-settings`
  - community feed reads
  - community reactions/comments/votes
  - image backfill/cache endpoints
- Test with realistic concurrency ramps, not just a flat spike.
- Confirm backend returns no cross-user cached data. Client-side community query keys include `authToken` in read keys, which is good, but backend cache headers and API authorization still need staging validation.
- Verify rate-limit behavior for upstream fragrance/image providers so one user's expensive operation does not degrade other users.

## Suggested Implementation Order

1. Add Web Vitals field collection so future changes can be evaluated against real INP.
2. Split the initial dashboard chunk: defer `Wardrobe` detail-heavy code, modals, and animation-heavy surfaces.
3. Reduce global motion/layout work before first paint.
4. Replace single-use `axios` with `fetch`.
5. Add Lighthouse CI budgets for the three measured routes.
6. Run authenticated staging load tests for backend and API concurrency.

## Audit Artifacts

Local artifacts produced during this audit:

- `.local/performance-audit/lighthouse-dashboard-mobile.json`
- `.local/performance-audit/lighthouse-community-mobile.json`
- `.local/performance-audit/lighthouse-arena-mobile.json`
- `.local/performance-audit/autocannon-dashboard-50c.json`

These files are local audit evidence and are not currently tracked by git.
