# Visual Audit Report — ScentCast SPA

**Date:** 2026-05-31
**Scope:** `artifacts/scent-cast` (React 19 + Vite frontend) — visual integrity, state-driven UI, interaction
**Mode:** Read-only diagnosis (no code modified)
**Standard:** Luxury / Apple-tier UI consistency
**Branch at audit time:** `codex/background-performance-pass`
**Pass 2 (2026-05-31):** extended to the community page, public Share page body, chat, weather, cycling tile, brand label, NotePyramid SVG, and the unread Wardrobe spans — see **§IV**.
**Pass 3 (2026-05-31):** extended to the toast system (`use-toast`, `ui/toaster`/`ui/toast`/`ui/sonner`), `main.tsx`, the full `ScentNotesInfographic` render path, the dead `ui/*` surface, and a narrow logic pass (`scentWeatherEngine`, `fragranceApi.isSourceCoverageComplete`) — see **§V**.

---

## I. UI System Map

**Render root → state spine**

```
main.tsx
└─ ErrorBoundary → QueryClientProvider → BrowserRouter → App
   └─ AuthProvider → WeatherProvider → WardrobeProvider        (3 nested context spines)
      └─ <div.scent-app-shell>          ← ::before vignette (z-1), shell stacking
         ├─ ThreadBackground (z-0)       ← animated "nexus" rAF beams (active bg)
         ├─ AppContent
         │  └─ Routes: "/" DashboardView · "/community" · "/share/:userId"
         └─ Toaster (z-100)
      └─ PageTransitionOverlay (z-9999)  ← rendered OUTSIDE the shell
```

**State ownership**

- **AuthContext** — token/email/picture parsed from the OAuth redirect → `localStorage`; drives `isAuthModalOpen` and the guest prompt.
- **WeatherContext** — geolocation → `/api/weather`; `weatherLoading` gates the Atmosphere bar.
- **WardrobeContext** — the heavy spine: `items[]`, modal flags, `activeRecommendation` / `activeEngineRecommendation`, background poll (60 s) + enrichment scheduler (15 s), optimistic add/delete/image-persist. Split into three contexts (`WardrobeContext`, `WardrobeItemsContext`, `WardrobeShareModalActionsContext`) to limit re-render fan-out.

**Compositing ladder (verified)**

threads `z-0` → shell vignette `z-1` → page content/footer `z-10` → topbar `z-50` → toasts + detail overlays `z-100` → recommendation / community overlay `z-110` → lightboxes `z-130` → bespoke modals (Auth/Intent/Share) `z-200` → ErrorBoundary `z-999` → page transition `z-9999`.

**The ladder is internally consistent — no true z-index collisions found.** Defects concentrate in **state sequencing, modal-pattern fragmentation, safe-area handling, and `backdrop-filter` cost.**

**Cross-cutting style system** — Tailwind v4 `@theme` tokens + a large hand-authored `index.css` "museum-case" system (`.scent-fragrance-card` + `.scent-card-frame` with ~12-layer box-shadows, `::before`/`::after` panels, `mix-blend-mode: screen` caustics). Marquees use a `data-marquee-ready` gate to prevent pre-measurement FOUC. Reduced-motion and `@media (hover:hover)` are respected in most — but not all — places.

---

## II. Critical UX/UI Bug Ledger

### 🔴 HIGH

#### H-1 · 800 ms dead gap in the primary conversion flow
- **Location:** `context/WardrobeContext.tsx:952–962` (`handleIntentComplete`); overlay gated at `App.tsx:517–520`.
- **Visual impact:** User taps **"Find My Match"** → the intent modal closes immediately → **0.8 s of nothing** (no spinner, no transition) → the "You should wear X" overlay pops in. On the app's single most important moment this reads as an unresponsive button / dropped tap.
- **Technical root cause:** `setActiveEngineRecommendation` is set synchronously, but `setActiveRecommendation(winner.item)` — the value the overlay's `AnimatePresence` gates on — is deferred via a bare `setTimeout(..., 800)` with no interim loading state and no cleanup. The 800 ms is a hard-coded dramatic pause with zero feedback during the gap.
- **Severity:** High.

#### H-2 · No focus containment in most bespoke modals
- **Location:** `AuthModal.tsx:23`, `ScentIntentModal.tsx:60`, `ShareModal.tsx:178`, recommendation overlay `App.tsx:523`. **In-repo template that does it right:** the community `BottleMarquee` overlay implements a full focus trap, Escape-to-close, and focus **restoration** to the triggering element (`BottleMarquee.tsx:112–160`) plus `role="dialog"`/`aria-modal`/`aria-labelledby` (`:240–242`) — see the §IV calibration note. (The Wardrobe detail modal `Wardrobe.tsx:1656–1659` also sets `role="dialog"`/`aria-modal`/`aria-labelledby` but no trap; the unused Radix `ui/dialog.tsx` provides full trapping as well.)
- **Visual impact:** With a full-screen opaque overlay open (e.g. `AuthModal` is `bg-black`, fully opaque), keyboard `Tab` walks focus into the **invisible page behind** the overlay. The focus ring disappears; keyboard / screen-reader users are stranded. Fails the Apple-tier bar.
- **Technical root cause:** The offending overlays are hand-rolled `fixed inset-0` divs with no focus trap, no initial-focus assignment, and no `inert`/`aria-hidden` on the background. The correct pattern already exists in-repo (`BottleMarquee`) — it simply was not reused by these four.
- **Severity:** High (accessibility / luxury standard). *(Softened from the Pass 1 "any" — `BottleMarquee` is a compliant exception and the reference implementation the rest should adopt.)*

#### H-3 · `backdrop-filter` re-blur cost over the animated background
- **Location:** `index.css:512` (`.scent-fragrance-card { backdrop-filter: blur(6px) }`, applied to *every* grid card), `.glass` `:96–99` (blur 18px, persistent at the top of the page via FragranceCapture), `.glass-acrylic` `:107–110` (blur 26px), `.scent-atmosphere-strip` `:1035` (blur 16px); plus full-screen `backdrop-blur-3xl` (≈64px) on `App.tsx:523`, `ScentIntentModal.tsx:60`, `Wardrobe.tsx:1661`, and `backdrop-blur-2xl` on `ShareModal.tsx:184`.
- **Visual impact:** Scroll/animation jank — frame drops while scrolling a populated vault, and a hitch when any full-screen modal mounts its 64px backdrop blur. Precisely the symptom the team already diagnosed and *removed* from the topbar.
- **Technical root cause:** The codebase's own note at `index.css:287–296` states the topbar's `backdrop-filter` was deleted because it forced "a full-width re-blur on every scroll/animation frame (the dominant scroll-jank source over the animated nexus background)." That same mechanism is still live on every fragrance card (sampling the moving threads beneath) and on every full-screen overlay. On the `background-performance-pass` branch this is the highest-leverage remaining cost.
- **Severity:** High (performance).

### 🟠 MEDIUM

#### M-1 · Bottom-pinned bar uses the *top* safe-area inset
- **Location:** `App.tsx:605` — recommendation overlay's pinned footer: `paddingBottom: 'max(1.25rem, env(safe-area-inset-top))'`.
- **Visual impact:** On notched iOS the "Confirm Alignment" bar is padded by the **notch** inset (~47px), not the home-indicator inset (~34px), so it floats inconsistently high off the bottom edge — and adds spurious bottom padding in any orientation where `inset-top > 0, inset-bottom = 0`.
- **Technical root cause:** Copy-paste from the header (`App.tsx:528` correctly uses `inset-top`). The sibling `ScentIntentModal.tsx:205` proves the intended pattern: its footer uses `env(safe-area-inset-bottom)`. Wrong variable.
- **Severity:** Medium.

#### M-2 · ScentIntentModal close animation never plays
- **Location:** `ScentIntentModal.tsx:50` — `if (!isOpen) return null;` sits **above** the `<AnimatePresence>` at line 53.
- **Visual impact:** Closing the discovery modal **snaps to gone instantly**; the authored `exit={{ opacity: 0 }}` (line 58) is dead. Inconsistent with `ShareModal`, which gates `{isOpen && …}` *inside* `AnimatePresence` and fades correctly.
- **Technical root cause:** `AnimatePresence` can only animate an exit if it stays mounted while its child unmounts. The early `return null` removes the whole subtree before `AnimatePresence` can run the exit.
- **Severity:** Medium.

#### M-3 · Escape-key collision between nested dismissables
- **Location:** `NotePyramid.tsx:551–573` (window `keydown` → clears active layer) and `Wardrobe.tsx:1002–1012` (document `keydown` → `closeDetail`).
- **Visual impact:** Inside the detail modal, with a note layer expanded, **one Escape press closes both the note tooltip *and* the entire modal.** Expected luxury behavior: first Escape dismisses the layer, second closes the modal.
- **Technical root cause:** Two independent listeners on `window`/`document`; neither uses `stopImmediatePropagation`, so both fire on the same event. (Separately, the recommendation overlay `App.tsx:517` registers **no** Escape handler at all, so Escape there only clears a NotePyramid layer and never closes the overlay — inconsistent dismissal across overlays.)
- **Severity:** Medium.

#### M-4 · Beta `<video>` bottle has no poster and no failure fallback
- **Location:** `BottleImage.tsx:120–122` and `:150–161`.
- **Visual impact:** When `videoSrc` is set, `showPlaceholder`/`showSkeleton` are both forced `false` and the `<video>` has **no `poster`**. A slow or failed video load shows an **empty transparent slot** — no skeleton, no "Unavailable" card, no fallback to the still image.
- **Technical root cause:** The inline comment claims "poster handles visual feedback," but no `poster` attribute is rendered and there is no `onError` → `<img>` downgrade path.
- **Severity:** Medium.

#### M-5 · Client-side query→name leak (garbled result cards)
- **Location:** `FragranceCapture.tsx:358` — `name: firstString(result.name) ?? targetQuery.trim()`.
- **Visual impact:** When the engine returns a result row without a clean name, the card renders the **user's raw typed query** as the fragrance name (the "and gabana Q / DOLCE" class of artifact). This is the SPA-side twin of the backend issue in `docs/SEARCH_RESULT_BUGS_DIAGNOSIS.md`; even after the Python fixes, the SPA can still stamp the query string into the title.
- **Technical root cause:** Fallback substitutes the query verbatim with no validity guard (no conjunction-prefix / single-char rejection).
- **Severity:** Medium.

#### M-6 · Public Share page nav ignores the notch
- **Location:** `SharePage.tsx:651` — standalone `fixed top-0 … h-16 sm:h-[72px]` nav, **without** the `env(safe-area-inset-top)` baked into `--topbar-h` (`index.css:28`, `:297`).
- **Visual impact:** On notched iPhones the **shared-link landing page** (the app's outward-facing first impression) renders its logo/nav under the status bar. Dashboard and Community don't, because they use `AppTopNav` + the `--topbar-h` spacer.
- **Technical root cause:** SharePage re-implements its own chrome instead of reusing `AppTopNav`, dropping the safe-area handling.
- **Severity:** Medium.

#### M-7 · 60 s wholesale poll can remount every bottle image
- **Location:** `WardrobeContext.tsx:481–511` (`loadWardrobe` → `setItems(data)`), scheduled at `:559–579`.
- **Visual impact:** Latent per-minute flicker risk. Every 60 s `items` is replaced with brand-new object identities (no deep-equal / reconcile). Cards are keyed by `item.id` so they don't remount, **but** `BottleImage` remounts its `<img>` whenever the `url` changes (`BottleImage.tsx:88`, `key` at `:164`). If the server payload returns cache-busted/re-signed image URLs (the app *does* append `?v=` hashes elsewhere — `WardrobeContext.tsx:697`), every bottle reloads each minute → visible vault-wide flicker.
- **Technical root cause:** Poll overwrites the whole array unconditionally; no diff against current state before `setItems`.
- **Severity:** Medium (conditional on URL stability).

#### M-8 · Up to 10 s of "—" placeholders in the Atmosphere bar
- **Location:** `WeatherContext.tsx:66–76` (geolocation `timeout: 10000`); consumed at `App.tsx:272–283`.
- **Visual impact:** If the user neither accepts nor dismisses the location prompt, `weatherLoading` stays `true` and 4 of 5 Atmosphere cells render literal **"—"** for up to ten seconds before the IP fallback. A bare em-dash for 10 s undercuts the premium feel; a shimmer/skeleton would read better.
- **Technical root cause:** A single long geolocation timeout gates the only loading signal; no progressive fallback while awaiting permission.
- **Severity:** Medium.

### 🟡 LOW

- **L-1 · Side effects inside a `useState` initializer** — `AuthContext.tsx:24–41`: the token initializer calls `localStorage.setItem` *and* `window.history.replaceState` during render, and `authEmail`/`authPictureUrl` initializers depend on that having run first. Works, but render-phase side effects double-fire under StrictMode and are order-fragile.
- **L-2 · Logout doesn't clear overlay state** — `WardrobeContext.tsx:970–978` empties `items` but leaves `activeRecommendation`/`activeEngineRecommendation`/modal flags. Signing out while the recommendation overlay is open leaves a stale fragrance card floating over an empty vault.
- **L-3 · Sticky `:hover` on touch** — `Wardrobe.tsx:1592` lifts cards via `group-hover:-translate-y-1.5` (not gated by `@media (hover:hover)`), so a tapped card can stay translated until the next tap on iOS. (Marquee pause `index.css:1390` and brand shimmer `:1478` *are* correctly hover-gated — apply the same here.)
- **L-4 · `AppTopNav` asymmetric grid floors** — `AppTopNav.tsx:134`: `grid-cols-[minmax(54px,1fr)_auto_minmax(84px,1fr)]`. Unequal min floors (54 vs 84) mean the centered logo drifts left if the right column clamps to its floor. Not reproducible at ≥375px viewports, but a latent centering asymmetry.
- **L-5 · Dead code / cruft** — `APP_BACKGROUND` is a compile-time const `'threads'`, so the `LavaBackground` branch (`App.tsx:13,726`) and its import (`:9`) are unreachable; `ProfileScorePanel section="score"` (`Wardrobe.tsx:531–543`) is never mounted (only `section="tiles"` is used at `:1690`); `PageTransitionOverlay.tsx:9` `ROUTE_LABELS` is an empty unused map; `AuthModal`'s `onAuth` prop is declared but never used.
- **L-6 · Cached-image skeleton edge** — `BottleImage.tsx:85` initializes `isLoading` from `!!url` but never checks `img.complete`. For an instantly-cached image whose `onLoad` doesn't fire, the pulse skeleton can persist. Rare on modern browsers; a defensive `complete` check would close it.

---

## III. Architectural Friction Points

1. **Modal-pattern fragmentation (root cause of H-2, M-1, M-2, M-3 and the scroll-lock/Escape inconsistencies).** There are *five+* independent overlay implementations — `AuthModal`, `ScentIntentModal`, `ShareModal`, the recommendation overlay (`App.tsx`), and the Wardrobe detail modal — each re-deriving backdrop, scroll-lock, Escape, focus, safe-area, and exit-animation behavior differently. Only the detail modal locks scroll + handles Escape + sets dialog ARIA; only ShareModal animates its exit correctly; only some use the safe-area insets correctly. A Radix-based `components/ui/dialog.tsx` already exists in the tree, **unused**. Until these consolidate onto one primitive, every new modal will re-roll the same four bugs.

2. **`backdrop-filter` as the default "glass" mechanism over a live rAF background (root of H-3).** The design language leans on real-time backdrop blur (`.glass`, `.glass-acrylic`, `.scent-fragrance-card`, full-screen `backdrop-blur-3xl`). Over the animated ThreadBackground this is the dominant compositing cost — and the team already conceded the point for the topbar. Any new "glass" surface inherits the jank.

3. **Magic-number `setTimeout` sequencing instead of event/animation completion.** UI ordering is timed by literals scattered across the app: `800ms` (H-1), `300ms` reset (`ScentIntentModal.tsx:43`), `150ms` focus (`ShareModal.tsx:55`), `420/620ms` post-save (`FragranceCapture.tsx:434,627`), `360ms` focus (`WardrobeContext.tsx:476`). These are timing races waiting to desync from the animations they shadow.

4. **Background poll replaces the entire `items` array with no reconciliation (root of M-7).** Every 60 s and on every mutation, `setItems(serverData)` invalidates the whole context value. Stable keys + primitive memo-keys absorb most of it today, but it is a standing invitation for image-remount flicker and wasted full-tree reconciliation; a deep-equal/merge guard before `setItems` would neutralize it.

5. **`weather: any` threaded through the data-driven chrome** (`App.tsx:78`, `WardrobeContext.tsx:67–77, 298–328`). The component that fans weather into the Atmosphere bar and the recommendation engine is untyped, so field-name drift (`temperature_f` vs `temperature` vs `temp`) is "handled" by runtime fallbacks rather than the type system — fragile for a surface whose correctness is purely visual.

6. **Heavy hand-authored decoration is expensive to evolve.** `.scent-card-frame` (`index.css:573–698`) carries ~12 stacked box-shadow layers plus two pseudo-elements (one `mix-blend-mode: screen`) and negative-z panels inside an `isolation: isolate` card. It looks superb but is brittle: small token tweaks ripple across hover/focus variants, and it multiplies the per-card paint already flagged in H-3.

---

## Calibration — things done right

So the bar is clear, the following are already at standard:

- **ThreadBackground** (`components/threads/ThreadBackground.tsx`) is a careful perf pass: per-thread compositing, an opacity write-threshold, `visibilitychange` + reduced-motion gating, and a documented iOS `contain:paint` caveat.
- Marquees gate on `data-marquee-ready` to avoid pre-measurement FOUC.
- The Wardrobe detail modal re-binds to the latest `items` row so background enrichment doesn't show stale metrics (`Wardrobe.tsx:895–905`).
- `ReviewsPanel` and `ScentNotesInfographic` have complete loading / empty / error states; the cross-column note↔accord highlight uses a module-level store + `useSyncExternalStore` and cleans up on unmount.
- Optimistic add/delete correctly roll back on failure (`WardrobeContext.tsx:618–639`, `:904–950`).

---

## IV. Pass 2 — Extended Component Audit

**Scope added:** `pages/community.tsx`, `components/community/*` (BottleMarquee, FeaturedCaseGrid, CommunityFragranceCard, CommunityHero, communityData), `SharePage.tsx` body, `chat/ChatInterface.tsx`, `WeatherWidget.tsx`, `CyclingTilePair.tsx`, `BrandGoldLabel.tsx`, the unread Wardrobe spans (search/grid/detail-tools/footer/enlarge), and the NotePyramid SVG render.

**Headline:** the new surfaces are mostly solid — the community marquee overlay is actually the *best* modal in the app (full focus trap), and the data layer degrades cleanly. The defects cluster in **two forked-then-diverged detail modals**, **false interactive affordances on the community grid**, and **two fully orphaned components — one dragging a heavy 3D dependency**.

### 🟠 MEDIUM

#### M-9 · The public Share page detail modal is a downgraded fork of the Wardrobe modal
- **Location:** `SharePage.tsx:786–1029` (detail modal) and `:983–1024` (enlarge lightbox). Compare the canonical twin: `Wardrobe.tsx:998–1019` (Escape + scroll-lock effect) and `:1652–2266` (modal markup).
- **Visual impact:** Three regressions on the app's **outward-facing first impression**:
  1. **The enlarge lightbox tells the user "Tap outside or Esc to close" (`:1020`) but no Escape handler exists in the entire file** (`grep Escape|keydown` → 0 matches). Pressing Esc does nothing; the instruction is a lie. The detail modal itself also can't be dismissed with Esc.
  2. **No background scroll-lock.** SharePage never sets `document.body.style.overflow = 'hidden'`, so the page behind scroll-chains under the open modal. Wardrobe's twin locks it (`Wardrobe.tsx:1013`).
  3. **No focus trap / initial focus / focus restoration** (H-2 family) — on the one page guests are most likely to land on cold.
- **Technical root cause:** SharePage re-implements the Wardrobe detail modal by hand (same panels, same "Esc to close" copy) instead of sharing it, and dropped the `keydown`/`overflow`/enlarge-first logic in the copy. Direct consequence of **Friction #7** below.
- **Severity:** Medium (accessibility + an actively false instruction, on the public surface).

#### M-10 · Community grid cards advertise interactivity they don't have
- **Location:** `CommunityFragranceCard.tsx:17–18` (`<article … className="… group cursor-pointer">` with **no `onClick`/`href`**) and the hover-scale at `:31` (`group-hover:scale-[1.035]`). Used by `FeaturedCaseGrid.tsx:90–93`.
- **Visual impact:** Every card in the **Featured Case Grid** shows a pointer cursor and lifts/scales its bottle on hover — the universal "click me" signal — but clicking does nothing. Worse, it's **inconsistent within the same page**: the smaller `BottleMarquee` bottles directly above *are* clickable and open a detail overlay (`BottleMarquee.tsx:202–207`). Users learn "bottles open" from the marquee, then tap a big grid card and get silence.
- **Technical root cause:** The card was given the hover/cursor affordances of an interactive element without a handler — likely a detail view that was never wired (the marquee's overlay is the obvious target).
- **Severity:** Medium.

#### M-11 · Two fully orphaned components — one drags `three` / `@react-three/fiber` into the tree
- **Location:** `components/WeatherWidget.tsx` and `components/chat/ChatInterface.tsx`. Neither is imported anywhere in `src/` (`grep "import .*(WeatherWidget|ChatInterface)"` → 0 hits; only docs/`replit.md` mention them).
- **Visual impact:** None at runtime (tree-shaken out), but:
  - **WeatherWidget is the *only* consumer of `three`, `@react-three/fiber`, and `@types/three`** (`package.json:42,52,75`; `WeatherWidget.tsx:5–6`). A heavy WebGL stack sits in the dependency graph (install weight, `minimumReleaseAge` catalog surface, audit noise) for a component nothing renders. Deleting WeatherWidget lets all three deps go.
  - WeatherWidget also re-implements weather fetching (`:80–104`, a duplicate of `WeatherContext`) and `getScentProfile` (`:30–42`), and its geolocation call passes **no timeout** (`:95–99`) — so if revived as-is it would spin "Synchronizing telemetry…" indefinitely when the permission prompt is ignored (worse than M-8).
  - ChatInterface is a **mock** — `handleSend` always replies "CRITICAL SYSTEM ALERT: Chat interface is currently offline" (`:45–55`).
- **Technical root cause:** Abandoned features left in the tree (extends **L-5 / dead code**). The dependency cost is the part worth acting on.
- **Severity:** Medium (supply-chain / maintenance, not visual).

### 🟡 LOW

- **L-7 · Divergent brand-sizing buckets across surfaces** — `BrandGoldLabel.brandLengthBucket` uses ≤10/16/24 (`BrandGoldLabel.tsx:7–11`) while `CommunityFragranceCard.brandLengthBucket` uses ≤8/14/22 (`CommunityFragranceCard.tsx:9–14`). Both feed the same `data-len` → `.scent-card-brand` CSS sizing, so a brand like "Dolce & Gabbana" (15 chars) renders one size in the Wardrobe/Share grids (`medium`) and a *smaller* size in the Community grid (`long`). Same brand, two sizes. (Community also skips the `scent-brand-gold-shimmer` that BrandGoldLabel applies.)
- **L-8 · Sticky `:hover` lift on touch — second instance** — `SharePage.tsx:727` lifts cards via `group-hover:-translate-y-1.5` gated only by `motion-reduce`, not `@media (hover:hover)`. Identical mechanism to **L-3** (`Wardrobe.tsx:1592`); a tapped share card can stay lifted on iOS until the next tap.
- **L-9 · CyclingTilePair re-announces itself to screen readers every 4.5 s** — `CyclingTilePair.tsx:73` wraps the auto-cycling tile in `aria-live="polite" aria-atomic="true"`, and it advances every `CYCLE_MS = 4500` (`:7`) forever. A screen reader narrates "Spring… Summer… Autumn…" indefinitely. Better: expose all parts once in a visually-hidden static node and mark the animating layer `aria-hidden`.
- **L-10 · NotePyramid runs continuous infinite SVG-filter animations while the detail modal is open** — multiple `repeat: Infinity` `motion.path`s drive opacity + animated SVG filters (`active-sheen` `:1201–1218`, `groove-gold` `:1243–1258`, `outer-rim` through `edge-glow` `:1282–1296`, `active-edge-gold` `:1298–1321`, apex glow `:1338–1348`), and the active-state swap animates the drop-shadow `filter` itself (`:1151`). It's well-guarded (reduced-motion branches, conditional `willChange` `:1158`) and sits behind an opaque backdrop so it doesn't composite with the live bg — but it's a standing paint cost the whole time a bottle detail is open. Compounds **H-3** in spirit (animated filters), localized to the modal.
- **L-11 · FeaturedCaseGrid skeleton ≠ real card layout** — the loading skeleton (`FeaturedCaseGrid.tsx:79–89`) lays out brand/title blocks differently from the real `CommunityFragranceCard` (curator top-right, brand above title, optional family line), so cards visibly reflow when data resolves rather than swapping in place.
- **L-12 · Hyphen used as a sentence dash on a luxury surface** — `CommunityHero.tsx:9`: "olfactory explorers **-** drifting through…" uses a hyphen where an em/en dash belongs. Small, but it's the headline of the Community landing.

### Friction points (continued)

7. **Two hand-maintained copies of the fragrance detail modal (root of M-9).** `Wardrobe.tsx` and `SharePage.tsx` each carry their own full detail overlay **and** their own copies of `FragrancePanel`, `ProfileScorePanel`, `DetailMetaStrip`, and the numeric/format helpers (`entryName`, `formatScore100`, `hasDerivedMetricsContent`, `formatWearProfile`, `percentFromMetricValue`, …). They render the same UI from the same engine shape, but have already diverged — SharePage's copy lost Escape, scroll-lock, and the enlarge-first dismissal that Wardrobe's has. This is **Friction #1 (modal fragmentation)** in its most expensive form: not just bespoke chrome, but a duplicated ~400-line modal that must be fixed twice and silently drifts. A shared `<FragranceDetailModal>` (or porting both onto the unused Radix `ui/dialog.tsx`) collapses M-9, H-2-on-share, and this duplication at once.

### Calibration — also done right (Pass 2)

- **`BottleMarquee`'s overlay is the reference modal the others should copy** — it implements a real focus trap (`:128–160`), Escape-to-close (`:131–136`), focus **restoration** to the triggering bottle (`:112–121`), and full `role="dialog"`/`aria-modal`/`aria-labelledby` (`:240–242`), with correct safe-area insets on **both** ends (`:247`, `:290`). It is the in-repo proof that the H-2 fix is already understood — it just wasn't reused.
- **Community data layer degrades cleanly** — `communityData.ts` falls back to `SEED` only in DEV (`:116–122`); in production it surfaces real empty (`FeaturedCaseGrid.tsx:60–68`) and error+retry (`:40–57`) states, and the marquee has its own error/empty guard (`BottleMarquee.tsx:162–172`).
- **`CyclingTilePair` is otherwise careful** — opacity/transform only (documents the iOS Safari `filter` pitfall, `:57`), reduced-motion variants, and an invisible sizer to keep tile height stable during crossfade (`:74–77`).
- **`WeatherWidget` (dead) and `ThreadBackground` (live) share a good instinct** — both gate their continuous render loops on `IntersectionObserver`/visibility (`WeatherWidget.tsx:112–121` pauses the WebGL `frameloop` off-screen). The pattern is sound; it's just attached to a component nothing mounts.

---

## V. Pass 3 — Toast System, Dead UI Surface, Infographic Render & State Logic

**Scope added:** `hooks/use-toast.ts` and the live toast render path (`components/ui/toaster.tsx` + `ui/toast.tsx`; plus the dead `ui/sonner.tsx`), `main.tsx`, `pages/not-found.tsx`, `components/ErrorBoundary.tsx`, the full render path of `components/ScentNotesInfographic.tsx` (accord-bar chart + the `NotePyramid` host), the `components/ui/*` dead-boilerplate surface, and a narrow "logic that drives visible state" pass over `lib/scentWeatherEngine.ts` and `lib/fragranceApi.ts:isSourceCoverageComplete`.

**Headline:** The toast layer is unmodified shadcn boilerplate — one toast on screen at a time (a new toast silently evicts the previous one) and a ~16-minute removal delay — and its viewport ignores the safe-area the rest of the app honours. `ScentNotesInfographic` is well-built but **re-plays its reveal animation whenever the accord data changes** (so a background-enrichment update flashes the chart) and runs in-modal `repeat:Infinity` pulses. The logic pass surfaced one Medium — a coverage predicate that can show a **"Complete" badge over "Sources 1 of 2."** And the shadcn `ui/*` folder is ~90% dead, which **de-risks the report's recurring "consolidate onto `ui/dialog.tsx`" recommendation** (that primitive is present and unused).

### 🟠 MEDIUM

#### M-12 · "Complete / Verified" status can render over "Sources 1 of 2"
- **Location:** `lib/fragranceApi.ts:707–710` (the early-return branch in `isSourceCoverageComplete`), consumed by `resolveSourceStatus` `:750–789` (badge / summary / source-count).
- **Visual impact:** A fragrance whose Fragrantica side resolved (`fragrantica_metrics_complete`) but whose **Basenotes side did not** is labelled **"Complete"**, with summary **"Verified community-source profile available."** and **"Metrics ready"** — while the *same* panel shows **"Sources 1 of 2."** The trust badge and the source counter contradict each other on the detail panel.
- **Technical root cause:** `isSourceCoverageComplete` carries a short-circuit — `coverage.fragrantica === true && coverage.fragrantica_metrics_complete === true → true` — that **drops the `basenotes === true` requirement** spelled out in the `source_coverage` contract (see CLAUDE.md and the doc comment on `SourceCoverage`). `resolveSourceStatus` still computes `sourceCount` from `basenotes + fragrantica` independently (`:757–758`), so the two readouts disagree.
- **Severity:** Medium (trust / correctness on the public-facing detail panel; conditional on the engine emitting `fragrantica_metrics_complete` without `basenotes`).

### 🟡 LOW

- **L-13 · Toast system ships unmodified shadcn defaults** — `hooks/use-toast.ts:8–9`: `TOAST_LIMIT = 1` and `TOAST_REMOVE_DELAY = 1_000_000`. Two real, user-visible behaviours: (1) only **one** toast is ever on screen — `ADD_TOAST` does `[new, ...old].slice(0, 1)` (`:79`), so a second toast fired close behind a first **instantly replaces it** (a success toast can be eaten by a following error toast across the app's several toast call-sites); (2) a dismissed toast is only purged from state after **~16.7 minutes** (`:63–69`, `:115–125`), so the reducer's `toasts` array retains the closed entry long after it animates out. Latent rather than catastrophic, but stock copy-paste rather than tuned choices.
- **L-14 · Toast viewport ignores the safe-area on mobile** — `components/ui/toast.tsx:16–19`: the `ToastViewport` is `fixed top-0 … p-4` on small screens (only `sm:` and up move it to `bottom-0 right-0`). On notched phones a toast renders **under the status bar / over the topbar** (toasts are `z-[100]`, above the `z-50` nav) with no `env(safe-area-inset-top)` — the same notch problem flagged in M-1/M-6, here on the transient toast layer.
- **L-15 · The accord chart re-animates on live data change, and runs infinite in-modal pulses** — `components/ScentNotesInfographic.tsx:167–169`: `useAccordPanelReveal` resets `revealed` to `false` whenever `contentKey` (accord labels + percentages) changes, so when background enrichment swaps in richer `main_accords` **while the detail modal is open**, every bar collapses to ~2% and re-grows (`:393–408`) — a visible flash rather than an in-place update. Separately, pyramid-linked accord rows drive `repeat:Infinity` box-shadow/`filter`/marker pulses (`:410–419`, `:449–452`) the whole time a note is active — a localized paint cost that **compounds L-10** inside the same modal.
- **L-16 · `spray_count` can resolve to 0 in the recommendation overlay** — `lib/scentWeatherEngine.ts:635–662`: a low-concentration base (parfum/extrait = 1) minus the stacked penalties (hot-humid, indoor/work, close-contact, strong sillage, fatigue ≥ 70, "subtle" preference) clamps to `recommended: 0, min: 0`. Paired with a non-avoid `wear_window` (e.g. `daytime_safe`) the overlay can read **"0 sprays" for a fragrance it otherwise calls safe to wear** — a contradictory instruction. (Visible only where the overlay renders the raw count.)
- **L-17 · The 404 page is off-brand (light-themed, dev placeholder copy)** — `pages/not-found.tsx` renders a **light** card (`bg-gray-50`, `text-gray-900`/`text-gray-600`, a white `Card`) with the stock scaffold copy *"404 Page Not Found / Did you forget to add the page to the router?"* — jarringly off-brand in an otherwise all-dark luxury app, and the polished opposite of the on-brand `ErrorBoundary` fallback. It is also not among the routes enumerated in §I (`/`, `/community`, `/share/:userId`), so absent a catch-all it is additionally dead code (extends **L-5**). `not-found.tsx` is the lone reachable consumer of `ui/card` (Friction #8).

### Friction points (continued)

8. **The shadcn `ui/*` directory is ~90% dead — which de-risks the modal-consolidation fix (Friction #1 / #7).** Of the **55** generated primitives under `components/ui/`, only a handful are reachable from app code (verified prior pass: `toaster` → `toast`; `avatar` + `dropdown-menu` in the topbar; `card` in `not-found.tsx`); the other ~50 are imported only by each other or by nothing. Two specifics matter: (a) **`ui/dialog.tsx` — the report's proposed modal-consolidation target — is dead-but-intact** (only `ui/command.tsx` imports it), so adopting it to collapse H-2 / M-9 / Friction #1+#7 is low-risk; (b) **`ui/sonner.tsx` exports a *second* `Toaster`** (importing `next-themes`) that is **never mounted** — the app mounts `ui/toaster.tsx` instead — so Sonner and its `next-themes` import are pure dead code (extends **L-5 / M-11**). Quantified, not audited file-by-file.

### Calibration — also done right (Pass 3)

- **`use-toast` lifecycle is clean** — listeners are registered and **removed on unmount** (`hooks/use-toast.ts:174–182`); the singleton store pattern itself is fine — it's only the two constants that are untuned.
- **`ScentNotesInfographic` reveal is otherwise careful** — the IntersectionObserver is armed inside a `requestAnimationFrame` with an 1100 ms fallback timer (`:205–211`), a reduced-motion short-circuit, `contain: layout paint` on the body (`:339`), and the note↔accord highlight store is wired through `useSyncExternalStore` with unmount cleanup (`:81–116`).
- **`scentWeatherEngine` is a clean pure function** — deterministic, every score `clampScore`-bounded to 0–100, finite-number guards on all weather inputs, and confidence is *reduced* (not faked) when inputs are sparse (`:761–782`).
- **The `ErrorBoundary` fallback is on-brand and complete** — `components/ErrorBoundary.tsx` pairs `getDerivedStateFromError` + `componentDidCatch` (`:19–25`) with a dark, blurred crash screen that surfaces `error.message` and a "Calibrate Matrix & Reload" full reset (`:27–30`, `:32–72`) — the polished counterpart to the L-17 404.

**Also applied this pass:** H-2 softened from "any" to "most" bespoke modals — `BottleMarquee` is now cited as the in-repo template (full focus trap + Escape + focus restoration), not another offender.

---

## Severity index

| ID | Severity | One-line |
|----|----------|----------|
| H-1 | High | 800 ms feedback-less gap before the recommendation overlay |
| H-2 | High | No focus trap in *most* bespoke modals (BottleMarquee is the compliant in-repo template) |
| H-3 | High | `backdrop-filter` blur on every card + full-screen overlays over the animated bg |
| M-1 | Medium | Recommendation footer uses `safe-area-inset-top` for bottom padding |
| M-2 | Medium | ScentIntentModal exit animation dead (`return null` outside `AnimatePresence`) |
| M-3 | Medium | Escape closes note layer *and* detail modal in one press |
| M-4 | Medium | Beta `<video>` bottle: no poster, no error fallback |
| M-5 | Medium | Search fallback stamps raw query as the fragrance name |
| M-6 | Medium | Share page nav omits `safe-area-inset-top` (notch collision) |
| M-7 | Medium | 60 s poll can remount every bottle image if URLs are cache-busted |
| M-8 | Medium | Up to 10 s of "—" placeholders while awaiting geolocation |
| L-1 | Low | Side effects in `useState` initializer (StrictMode double-run) |
| L-2 | Low | Logout leaves stale recommendation/overlay state |
| L-3 | Low | Sticky `:hover` lift on touch devices |
| L-4 | Low | Asymmetric topbar grid floors (latent off-center) |
| L-5 | Low | Dead code: Lava branch, `section="score"`, `ROUTE_LABELS`, `onAuth` |
| L-6 | Low | Cached-image skeleton can persist without `img.complete` check |
| M-9 | Medium | Share-page detail/enlarge modal forks Wardrobe's but drops Escape (hint lies), scroll-lock, focus trap |
| M-10 | Medium | Community grid cards show pointer + hover-scale but have no click handler (marquee bottles are clickable) |
| M-11 | Medium | Orphaned WeatherWidget + ChatInterface; WeatherWidget alone pulls in `three` / `@react-three/fiber` |
| L-7 | Low | Divergent `brandLengthBucket` thresholds size the same brand differently (Wardrobe/Share vs Community) |
| L-8 | Low | Sticky `:hover` card lift on touch — second instance, `SharePage.tsx:727` (L-3 twin) |
| L-9 | Low | `CyclingTilePair` `aria-live` re-announces the cycling tile to screen readers every 4.5 s |
| L-10 | Low | NotePyramid runs continuous `repeat:Infinity` SVG-filter/opacity anims while detail modal open |
| L-11 | Low | FeaturedCaseGrid skeleton layout ≠ real card → content reflow on load |
| L-12 | Low | CommunityHero uses a hyphen as a sentence dash on the Community headline |
| M-12 | Medium | `isSourceCoverageComplete` fragrantica-only branch flashes a "Complete"/"Verified" badge over "Sources 1 of 2" |
| L-13 | Low | Stock `use-toast` defaults: `TOAST_LIMIT=1` (new toast evicts old), `TOAST_REMOVE_DELAY`≈16 min retention |
| L-14 | Low | Toast viewport is `top-0` with no `safe-area-inset-top` on mobile → notch/topbar overlap |
| L-15 | Low | Accord chart replays its full reveal anim on live data change; in-modal `repeat:Infinity` accord pulses (compounds L-10) |
| L-16 | Low | `scentWeatherEngine` spray_count can resolve to 0 (e.g. "0 sprays" alongside `daytime_safe`) |
| L-17 | Low | Off-brand light-themed 404 (`not-found.tsx`) with dev placeholder copy; possibly unrouted (dead) |
