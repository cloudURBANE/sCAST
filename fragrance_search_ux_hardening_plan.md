# Fragrance Search UX Hardening & Optimization Plan

This document outlines the findings, root causes, and step-by-step instructions for fixing visual and functional bugs in the ScentCast fragrance search and sync interface. It contains all code references and code diff suggestions to facilitate hand-off to the developer who will apply the fixes.

---

## 1. Summary of Issues & Resolution Actions

| Issue | Description | Core Target | Action |
|---|---|---|---|
| **1. Search Navigation Buttons** | Redundant "New search" and "X" buttons in the search results panel. | `FragranceCapture.tsx` | Remove both button elements from the JSX structure. |
| **2. Card Right-Edge Jitter** | Selectable result cards blink, jitter, or glitch on their right edge during hover/transitions. | `FragranceCapture.tsx`<br>`index.css` | Fix the parent flex container layout direction; add stable scrollbar gutters; restrict `transition-all` on cards to specific properties. |
| **3. Duplicate Search Labels** | Overlap of "Researching Fragrance..." (status) and "Searching fragrances..." (substatus) in the loader. | `FragranceCapture.tsx` | Remove the redundant `substatus` prop from the search `ScentIntelligenceLoader`. |
| **4. Loading Animations Audit** | Assessment of visual loading elements to retain premium ones and clean up noise. | All Loaders | Retain the premium orbital `ScentIntelligenceLoader` and `PageTransitionOverlay`; streamline texts. |
| **5. Sync Overlay Transparency** | The "Add to Vault" syncing veil is semi-transparent, allowing background content to show through. | `FragranceCapture.tsx` | Make the overlay background fully opaque using the primary dark background color `#030201`; omit the `substatus` label. |

---

## 2. Reference Files & Code Mapping

All fixes are confined to the following files:
1. **[FragranceCapture.tsx](file:///c:/Users/urban/my_project_workspace/huge_monorepo/artifacts/scent-cast/src/components/FragranceCapture.tsx)**: Main search UI component, results card container, loading veil, and button actions.
2. **[index.css](file:///c:/Users/urban/my_project_workspace/huge_monorepo/artifacts/scent-cast/src/index.css)**: Stylesheet holding the CSS definitions for `.scent-vault-result-card`, hover/selected states, and overflow containers.

---

## 3. Step-by-Step Implementation Guide

### A. Remove "New search" and "X" (Close) Buttons
* **File:** [FragranceCapture.tsx](file:///c:/Users/urban/my_project_workspace/huge_monorepo/artifacts/scent-cast/src/components/FragranceCapture.tsx)
* **Lines:** ~1356 - 1372
* **Instruction:** In the search results panel header, delete or comment out the `<button>` for `New search` and the `<button>` for `Close results` (X). This keeps the header clean and focuses the user on selecting a fragrance or typing in the primary input.

**Proposed JSX Diff:**
```diff
                  <div className="mb-4 flex shrink-0 items-center justify-between gap-3 px-1">
                    <p className="min-w-0 truncate whitespace-nowrap scent-type-label text-scent-accent">
                      Search Results
                      <span className="mx-1.5 text-scent-accent/60" aria-hidden>·</span>
                      <span className="tabular-nums tracking-[0.12em] text-scent-accent">
                        {filtersActive
                          ? `${visibleMatches.length} of ${matches.length}`
                          : matches.length}
                      </span>
                    </p>
                    <div className="flex shrink-0 items-center gap-3">
                      <button
                        type="button"
                        onClick={scrollToSearch}
                        className="hidden min-h-[44px] shrink-0 items-center gap-1.5 rounded-full border border-white/30 px-3.5 py-1.5 scent-type-chip text-scent-text-muted transition-colors hover:border-scent-accent/45 hover:text-[#fff7ec] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/35 sm:inline-flex"
                      >
                        ↑ Back to top
                      </button>
-                     <button
-                       type="button"
-                       onClick={handleNewSearch}
-                       className="inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-full border border-white/30 px-3.5 py-1.5 scent-type-chip text-scent-text-muted transition-colors hover:border-scent-accent/45 hover:text-[#fff7ec] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/35"
-                     >
-                       <Search size={12} strokeWidth={2} aria-hidden />
-                       New search
-                     </button>
-                     <button
-                       type="button"
-                       onClick={handleDismissResults}
-                       aria-label="Close results"
-                       title="Close (Esc)"
-                       className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-white/30 text-scent-text-muted transition-colors hover:border-scent-accent/45 hover:text-[#fff7ec] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/35"
-                     >
-                       <X size={16} strokeWidth={2} aria-hidden />
-                     </button>
                    </div>
                  </div>
```

---

### B. Eliminate Selectable Cards Jitter & Glitching
* **Files:** [FragranceCapture.tsx](file:///c:/Users/urban/my_project_workspace/huge_monorepo/artifacts/scent-cast/src/components/FragranceCapture.tsx) and [index.css](file:///c:/Users/urban/my_project_workspace/huge_monorepo/artifacts/scent-cast/src/index.css)
* **Root Cause:** 
  1. The results wrapper `div` uses `flex items-start` but misses `flex-col`, leaving the browser to interpret it as a `row` layout. This layout conflicts with internal `w-full max-w-[39.75rem]` button grid columns, causing layout shifts.
  2. The custom scrollbar hiding mechanism or scrollbar appearance shifts list widths dynamically during actions.
  3. `transition-all` on `.scent-vault-result-card` animates dimensions and `box-shadow` concurrently, leading to hardware-accelerated subpixel anti-aliasing jitter (shaking edges).

* **Instruction:**
  1. Change the results container from `flex` to `flex flex-col` in [FragranceCapture.tsx](file:///c:/Users/urban/my_project_workspace/huge_monorepo/artifacts/scent-cast/src/components/FragranceCapture.tsx) line 1416.
  2. Apply `scrollbar-gutter: stable;` to the scroll list CSS class or inline styling to prevent width adjustments.
  3. Narrow down the card CSS transition in [index.css](file:///c:/Users/urban/my_project_workspace/huge_monorepo/artifacts/scent-cast/src/index.css) to only animate specific properties (like borders, background, shadows) instead of `all`.
  4. Force GPU subpixel stability by adding `backface-visibility: hidden;` and `transform: translate3d(0, 0, 0);` to the cards.

**Proposed JSX Diff:**
```diff
-                 <div className={`flex max-h-[min(54dvh,28rem)] min-h-0 flex-1 overflow-y-auto overscroll-contain scrollbar-hide ${visibleMatches.length === 1 ? 'items-center' : 'items-start'}`}>
+                 <div className={`flex flex-col max-h-[min(54dvh,28rem)] min-h-0 flex-1 overflow-y-auto overscroll-contain scrollbar-hide ${visibleMatches.length === 1 ? 'items-center' : 'items-start'}`} style={{ scrollbarGutter: 'stable' }}>
```

**Proposed CSS Diffs ([index.css](file:///c:/Users/urban/my_project_workspace/huge_monorepo/artifacts/scent-cast/src/index.css)):**
```diff
 .scent-vault-result-card {
   position: relative;
   isolation: isolate;
   overflow: hidden;
   border: 1px solid rgba(232, 181, 90, 0.62);
   border-radius: calc(var(--radius-scent) - 6px);
   color: #fff7ec;
   background:
     radial-gradient(78% 78% at 50% 7%, rgba(255, 247, 225, 0.035), transparent 60%),
     radial-gradient(85% 90% at 50% 105%, rgba(212, 175, 55, 0.035), transparent 68%),
     linear-gradient(180deg, rgba(28, 27, 22, 0.74), rgba(10, 10, 8, 0.9));
   box-shadow:
     inset 0 1px 0 rgba(255, 232, 179, 0.12),
     inset 0 0 34px rgba(212, 175, 55, 0.03),
     0 16px 36px -25px rgba(0, 0, 0, 0.94);
+  /* Hardware acceleration rendering stabilizers to eliminate subpixel jitter */
+  transform: translate3d(0, 0, 0);
+  backface-visibility: hidden;
+  will-change: transform, box-shadow, border-color;
 }
```

In [FragranceCapture.tsx](file:///c:/Users/urban/my_project_workspace/huge_monorepo/artifacts/scent-cast/src/components/FragranceCapture.tsx) line 1439:
```diff
-                              className={`scent-vault-result-card group mx-auto w-full max-w-[39.75rem] min-h-[60px] px-3.5 py-2 text-center transition-all duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/55 sm:min-h-[70px] sm:px-4 sm:py-2.5 ${
+                              className={`scent-vault-result-card group mx-auto w-full max-w-[39.75rem] min-h-[60px] px-3.5 py-2 text-center transition-[border-color,background-color,box-shadow,transform] duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/55 sm:min-h-[70px] sm:px-4 sm:py-2.5 ${
```

---

### C. Remove Redundant Search & Sync Sub-status Labels
* **File:** [FragranceCapture.tsx](file:///c:/Users/urban/my_project_workspace/huge_monorepo/artifacts/scent-cast/src/components/FragranceCapture.tsx)
* **Lines:** ~1074 and ~1108
* **Instruction:** In both `searchVeil` and `syncVeil`, omit or set the `substatus` prop to `undefined` in the `<ScentIntelligenceLoader />`. This ensures only a single premium status message (e.g., "Researching Fragrance...", "Syncing to Vault...") is displayed, removing layout noise.

**Proposed JSX Diff:**
```diff
   /* Sync overlay — full-screen portal, separate from the search overlay. */
   const syncVeil = uploading && loadingSurface === 'sync' ? (
     <motion.div
       ...
     >
       <ScentIntelligenceLoader
         status={loadingStatus}
-        substatus="Adding to your vault…"
         complete={syncComplete}
       />
     </motion.div>
   ) : null;
```

```diff
   const searchVeil = uploading && loadingSurface === 'search' ? (
     <motion.div
       ...
     >
       <ScentIntelligenceLoader
         status={loadingStatus}
-        substatus="Searching fragrances…"
         complete={syncComplete}
       />
```

---

### D. Make Sync & Search Veils Opaque
* **File:** [FragranceCapture.tsx](file:///c:/Users/urban/my_project_workspace/huge_monorepo/artifacts/scent-cast/src/components/FragranceCapture.tsx)
* **Lines:** ~1060 - 1080 and ~1090 - 1107
* **Instruction:** The base of the background radial gradient for the loading veils is semi-transparent (`rgba(3,2,1,0.92)` and `rgba(3,2,1,0.9)`), causing results cards below to bleed through and create visual noise. Change the gradient background styling in both components to end in the solid background token `#030201` (representing `--color-background`) at 100% opacity.

**Proposed JSX Diff:**
```diff
   /* Sync overlay — full-screen portal, separate from the search overlay. */
   const syncVeil = uploading && loadingSurface === 'sync' ? (
     <motion.div
       initial={{ opacity: 0 }}
       animate={{ opacity: 1 }}
       exit={{ opacity: 0 }}
       transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
       className="fixed inset-0 z-[130] flex flex-col items-center justify-center px-6 py-[max(2rem,env(safe-area-inset-top))]"
       style={{
         background:
-          'radial-gradient(ellipse 58% 46% at 50% 36%, rgba(212,175,55,0.08), transparent 64%), radial-gradient(ellipse 88% 62% at 50% 108%, rgba(212,175,55,0.05), transparent 68%), rgba(3,2,1,0.92)',
+          'radial-gradient(ellipse 58% 46% at 50% 36%, rgba(212,175,55,0.08), transparent 64%), radial-gradient(ellipse 88% 62% at 50% 108%, rgba(212,175,55,0.05), transparent 68%), #030201',
         boxShadow:
           'inset 0 1px 0 rgba(255,230,180,0.06), inset 0 0 120px rgba(212,175,55,0.045)',
       }}
     >
```

```diff
   const searchVeil = uploading && loadingSurface === 'search' ? (
     <motion.div
       initial={{ opacity: 0 }}
       animate={{ opacity: 1 }}
       exit={{ opacity: 0 }}
       transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
       className="absolute inset-0 z-50 flex flex-col items-center justify-center p-8"
       style={{
         minHeight: SEARCH_LOADER_MIN_H,
         background:
-          'radial-gradient(ellipse 70% 60% at 50% 16%, rgba(212,175,55,0.06), transparent 60%), radial-gradient(ellipse 85% 55% at 50% 102%, rgba(212,175,55,0.05), transparent 64%), rgba(3,2,1,0.9)',
+          'radial-gradient(ellipse 70% 60% at 50% 16%, rgba(212,175,55,0.06), transparent 60%), radial-gradient(ellipse 85% 55% at 50% 102%, rgba(212,175,55,0.05), transparent 64%), #030201',
         boxShadow:
           'inset 0 1px 0 rgba(255,230,180,0.08), inset 0 0 90px rgba(212,175,55,0.05)',
       }}
     >
```

---

## 4. Verification Plan

After the senior developer implements the changes, they should verify using the following steps:
1. **Search navigation check**: Type a fragrance (e.g. "Chanel") and ensure the results card displays without the "New Search" and "X" close buttons.
2. **Jitter testing**: Hover and select items in the results list on desktop and tap on mobile. The right edges of the cards must remain perfectly stable without blinking or shifting by 1px.
3. **Redundancy label test**: Trigger a search and add-to-vault action. Verify that only the primary label ("Researching Fragrance...", "Syncing to Vault...") appears inside the orbital loader.
4. **Transparency verification**: Confirm that during search and add-to-vault actions, the background elements/selectable cards are completely blacked out by the opaque `#030201` overlay.
