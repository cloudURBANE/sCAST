# Handoff: PageTransitionOverlay — continuation brief

**Branch:** `codex/luxury-review-card`
**Repo:** `huge_monorepo/` (pnpm monorepo, React 19 + Vite SPA at `artifacts/scent-cast/`)
**What exists today:** A full-screen emblem transition overlay that fires on every React Router v7 route change. The ScentBeam logo spins 360°, an amber glow blooms and dissolves, and two orbit rings expand outward. Total runtime ~1.18 s.

---

## What was built and where it lives

### Primary file
`artifacts/scent-cast/src/components/PageTransitionOverlay.tsx`

Single self-contained component. No new dependencies — uses Framer Motion 12 (already in the project) and React Router's `useLocation`. Key internals:

- `warmTransitionEmblem()` — preloads the emblem PNG via `<link rel="preload">` + `new Image().decode()` so the first transition never flickers with a blank frame
- `prevPath` ref — compares previous vs current pathname to avoid firing on initial mount
- `animKey` state — increments on every nav so `AnimatePresence` gets a new `key`, restarting the animation cleanly even during rapid navigation
- `useReducedMotion()` — bails out entirely for users with `prefers-reduced-motion: reduce`

### Wired into the app
`artifacts/scent-cast/src/App.tsx` — `PageTransitionOverlay` is rendered **outside** the `.scent-app-shell` div, as a direct child of `<WardrobeProvider>`. This placement is intentional and critical — do not move it inside the app shell.

```tsx
export default function App() {
  return (
    <AuthProvider>
      <WeatherProvider>
        <WardrobeProvider>
          <div className="scent-app-shell ...">   {/* ← do NOT put overlay in here */}
            <ThreadBackground />
            <AppContent />
            <Toaster />
          </div>
          <PageTransitionOverlay />               {/* ← lives here, outside the shell */}
        </WardrobeProvider>
      </WeatherProvider>
    </AuthProvider>
  );
}
```

**Why it must stay outside the shell:** `ThreadBackground` (`artifacts/scent-cast/src/components/threads/ThreadBackground.tsx`) renders thread elements with `will-change: transform` + `perspective: 1000px`. Combined with the shell's `position: relative` + `overflow-x: hidden`, this creates a CSS containing block that traps `position: fixed` descendants. Anything `position: fixed` inside the shell becomes positioned relative to the shell, not the viewport — visually broken.

### Asset used
`/icons/transparent-emblem/scentbeam-emblem-192x192.png` (served from `artifacts/scent-cast/public/icons/transparent-emblem/`). The full transparent-emblem set lives at `scentbeam_asset_pack/icons/transparent-emblem/` with sizes from 16×16 up to 1024×1024.

### Design tokens
- Background: `rgba(3, 2, 1, 0.98)` — matches `--color-scent-bg: #030201`
- Accent/glow: `rgba(212, 175, 55, …)` — warm gold (slightly richer than `--color-scent-accent: #c98b2c`)
- Wordmark typography: `Georgia, serif`, italic, bold, 10px, `letter-spacing: 0.34em`, `text-transform: uppercase`

---

## Animation breakdown (current state)

| Layer | What it does | Duration |
|---|---|---|
| Outer overlay | `opacity 0 → 1`, fade out on exit | 260 ms in / 260 ms out |
| Gold bloom div | `scale 0.05 → 3.2`, `opacity 0 → 0.32 → 0` | 1180 ms |
| Inner orbit ring | `scale 0.18 → 1.55`, rotates, fades | 1100 ms |
| Outer orbit ring | `scale 0.25 → 2.0`, fades, 60 ms delay | 1100 ms |
| Emblem | `scale 0.65 → 1.06 → 1.0`, `rotate 0 → 360`, `opacity 0 → 1` | 1050 ms |
| Wordmark | `opacity 0 → 0.5`, `y 6 → 0` | 380 ms, 280 ms delay |

Easing on the spin: `[0.18, 0.82, 0.28, 1]` — starts with inertia, decelerates into rest.

---

## Ideas for improvement (pick any or all)

### 1. Route-aware emblem behavior
Right now every transition looks identical. You could vary the animation by destination:
- Going **to `/community`**: current spin — social, expansive
- Going **to `/`** (home/wardrobe): reverse spin (`rotate: [360, 0]`) or a "collapse inward" variant
- Going **to `/share/:userId`**: subtle shimmer instead of full spin — it's a lighter, sharing context

The `location.pathname` and the previous path are both available inside the effect. Derive a `transitionVariant: 'forward' | 'back' | 'share'` and branch the Framer Motion `animate` props.

### 2. Particle burst on emblem appear
At the moment the emblem reaches full opacity (~190 ms in), spawn 6–10 tiny gold particle divs that scatter outward and fade. These would be absolutely positioned, generated via `Array.from({ length: 8 })`, each with a random `angle` and `distance` driven by CSS custom properties or inline Framer Motion keyframes. This makes the reveal feel like the emblem is "arriving" rather than just appearing.

Reference for the particle pattern: look at how `BottleMarquee.tsx` (`artifacts/scent-cast/src/components/community/BottleMarquee.tsx`) handles stagger — same idea, just radial instead of linear.

### 3. Destination label
Below the "SCENTBEAM" wordmark, fade in a small secondary label like `"Community"` or `"Wardrobe"` based on where the user is navigating to. Use a `useRef` that captures the new pathname at the time the transition fires, then map it:

```ts
const ROUTE_LABELS: Record<string, string> = {
  '/': 'Wardrobe',
  '/community': 'Community',
};
const label = ROUTE_LABELS[location.pathname] ?? '';
```

Style it at 9px, `letter-spacing: 0.22em`, `opacity: 0.35` — very subtle, just enough to orient the user mid-transition.

### 4. Haptic-style stagger on the rings
The two orbit rings currently animate independently with a hard-coded 60 ms delay. Replace this with a Framer Motion `staggerChildren` variant so adding more rings in the future is just an array push. Wrap the rings in a `motion.div` with `variants={{ animate: { transition: { staggerChildren: 0.06 } } }}` and give each ring the same `variants` shape.

### 5. Progress indicator
The overlay currently has no concept of whether the new page's data has loaded. For the community page specifically (`/community` → `useCommunityFragrances()` from `artifacts/scent-cast/src/components/community/communityData.ts`), the real loading time is the API fetch. Consider:
- Keeping the overlay visible until `isLoading === false` on the destination page, with a max cap of ~3 s
- OR adding a subtle thin progress bar at the bottom of the overlay (like a `motion.div` that animates `scaleX: 0 → 1` on a spring, then completes when loading resolves)

To wire this, you'd need a shared signal between the community page and the overlay — a simple React context (`TransitionContext`) with `{ isNavigating, setNavigating }` would work. The overlay reads `isNavigating`; the page's `useEffect` calls `setNavigating(false)` when data is ready.

### 6. Exit animation refinement
Currently the exit is just `opacity: 0` over 260 ms. A more cinematic exit would be: emblem scales down slightly (`scale 1 → 0.9`) AND the backdrop opacity drops — giving the sense that the emblem is "absorbed" back into the page rather than just fading out.

In Framer Motion, add an `exit` prop directly to the `motion.img`:
```tsx
exit={{ opacity: 0, scale: 0.88, transition: { duration: 0.28, ease: [0.4, 0, 1, 1] } }}
```

### 7. Sound design (optional / low priority)
A very short, tasteful audio cue (40–80 ms) on transition start — like a soft chime or air-release sound. Keep it opt-in via a user preference. The `AudioContext` API can synthesize this without any audio file.

---

## Pitfalls to avoid

- **Do not move `PageTransitionOverlay` back inside `.scent-app-shell`** — it will be clipped by the stacking context. See reasoning above.
- **Do not set `pointer-events: auto`** on the overlay — it must stay non-interactive so in-flight scroll or click events pass through to the incoming page.
- **The `animKey` increment is load-bearing** — it forces `AnimatePresence` to dismount the old overlay and mount a fresh one even during rapid navigation. If you refactor the key logic, make sure rapid back/forward nav still restarts the animation cleanly.
- **`useLocation()` requires Router context** — the component must remain inside the tree that `BrowserRouter` wraps (i.e., inside `App`). It does not need AuthProvider, WeatherProvider, or WardrobeProvider — if you ever restructure providers, you only need the Router ancestor.
- **Framer Motion keyframe `times` arrays must have the same length as the keyframe value arrays** — a mismatch silently drops the timing and falls back to evenly-spaced keyframes.

---

## Relevant files at a glance

```
artifacts/scent-cast/src/
  components/
    PageTransitionOverlay.tsx        ← THE file to edit
    threads/ThreadBackground.tsx     ← reason overlay must live outside shell
    community/
      BottleMarquee.tsx              ← stagger animation reference
      communityData.ts               ← useCommunityFragrances() — for progress indicator idea
  pages/
    community.tsx                    ← destination page (isLoading state lives here)
  App.tsx                            ← mounting point (outside app-shell div)
  index.css                          ← --color-scent-bg, --color-scent-accent tokens

public/
  icons/transparent-emblem/          ← emblem PNGs 16px–1024px
  nav/                               ← full wordmark logos if needed

scentbeam_asset_pack/
  source/scentbeam-emblem-master-transparent.png   ← master source file (highest res)
  icons/transparent-emblem/                        ← production-ready set
```

---

## Quick start for the next agent

1. Read `PageTransitionOverlay.tsx` in full — it's ~215 lines, self-contained
2. Read the "Ideas for improvement" section above and pick a direction
3. Run typechecks with: `node_modules\.bin\tsc.CMD --noEmit` from `artifacts/scent-cast/`
4. The dev server: `pnpm --filter @workspace/scent-cast run dev` (navigate between `/` and `/community` to test transitions)
5. All changes go on branch `codex/luxury-review-card` — push when done
